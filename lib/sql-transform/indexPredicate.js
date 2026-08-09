/**
 * Canonicalize a PARTIAL index predicate for comparison, via a real SQL AST.
 *
 * The problem: the predicate a schema declares and the one the database reports
 * back are almost never textually identical. Postgres re-renders it -- adding
 * parentheses around the whole expression AND around each conjunct, quoting
 * identifiers, casting literals, rewriting `IN (...)` as `= ANY (ARRAY[...])`,
 * and reporting LIKE/NOT LIKE/ILIKE/`!=` as the operators `~~`/`!~~`/`~~*`/`<>`.
 * Comparing raw text means the index is dropped and recreated on EVERY sync,
 * which on a large table takes a metadata lock and stalls writes.
 *
 * The first cut of this normalized text with regexes and, unable to tell which
 * parentheses were Postgres' and which were the author's, dropped ALL of them.
 * That worked for churn but lost real information: `a AND (b OR c)` and
 * `(a AND b) OR c` became indistinguishable, so a predicate change that only
 * re-grouped an expression went undetected.
 *
 * Parsing to an AST removes the guesswork. Grouping lives in the SHAPE of the
 * tree rather than in punctuation, so redundant parentheses vanish for free
 * while genuine structure is preserved exactly. What remains is a small set of
 * deliberate equivalences (casts dropped, operator synonyms folded, `= ANY(...)`
 * folded to `IN`), each of which is a real semantic identity rather than a
 * heuristic.
 *
 * Falls back to the caller's text normalizer if a predicate cannot be parsed, so
 * an exotic dialect-specific expression degrades to the old behavior instead of
 * throwing.
 */

const { Parser } = require('node-sql-parser');

const parser = new Parser();

/** Operator synonyms that mean the same thing but are reported differently. */
const OPERATOR_SYNONYMS = {
	'!=': '<>',
	'~~': 'like',
	'!~~': 'not like',
	'~~*': 'ilike',
	'!~~*': 'not ilike',
};

/**
 * Read a column name out of a `column_ref` node.
 *
 * node-sql-parser has used both `column: 'name'` and
 * `column: { expr: { value: 'name' } }` across versions.
 *
 * @param {object} node a column_ref node
 * @returns {string} the lowercased column name
 */
function columnName(node) {
	const { column } = node;
	if (typeof column === 'string') {
		return column.toLowerCase();
	}
	if (column && column.expr && column.expr.value !== undefined) {
		return `${column.expr.value}`.toLowerCase();
	}
	if (column && column.value !== undefined) {
		return `${column.value}`.toLowerCase();
	}
	return `${column}`.toLowerCase();
}

/**
 * True when this node is Postgres' rendering of `x = ANY (ARRAY[...])`, which is
 * how it reports a predicate the author wrote as `x IN (...)`.
 *
 * @param {object} node a binary_expr node
 * @returns {boolean} whether it is the ANY-array form
 */
function isAnyArrayForm(node) {
	const right = node && node.right;
	return !!(
		node &&
		node.operator === '=' &&
		right &&
		right.type === 'function' &&
		right.name &&
		right.name.name &&
		right.name.name[0] &&
		`${right.name.name[0].value || ''}`.toUpperCase() === 'ANY'
	);
}

/**
 * Collect the element nodes of an ARRAY[...] / expr_list, through any casts.
 *
 * @param {object} node the argument of ANY(...)
 * @returns {object[]} element nodes
 */
function arrayElements(node) {
	let current = node;
	// Unwrap casts, e.g. (ARRAY[...])::text[]
	while (current && current.type === 'cast' && current.expr) {
		current = current.expr;
	}
	if (current && current.expr_list) {
		const inner = current.expr_list;
		return (inner && inner.value) || [];
	}
	if (current && current.type === 'expr_list') {
		return current.value || [];
	}
	if (current && Array.isArray(current.value)) {
		return current.value;
	}
	return current ? [current] : [];
}

/**
 * True for the boolean connectives whose precedence we have to repair.
 *
 * @param {string} operator an AST operator
 * @returns {boolean} whether it is AND/OR
 */
function isBooleanConnective(operator) {
	const op = `${operator || ''}`.toUpperCase();
	return op === 'AND' || op === 'OR';
}

/**
 * Flatten an unparenthesized chain of AND/OR into source order.
 *
 * A node the author parenthesized is an ATOM here -- that grouping is real and
 * must survive. Only the parser's own left-associative chaining is unwound.
 *
 * @param {object} node an AST node
 * @param {object[]} operands collected operand nodes, in order
 * @param {string[]} operators collected operators, in order
 */
function flattenBooleanChain(node, operands, operators) {
	if (
		node &&
		node.type === 'binary_expr' &&
		isBooleanConnective(node.operator) &&
		!node.parentheses
	) {
		flattenBooleanChain(node.left, operands, operators);
		operators.push(`${node.operator}`.toUpperCase());
		flattenBooleanChain(node.right, operands, operators);
		return;
	}
	operands.push(node);
}

/**
 * Rebuild a boolean chain with correct SQL precedence: AND binds tighter than OR.
 *
 * node-sql-parser chains AND/OR purely left-to-right, ignoring precedence -- it
 * parses `a OR b AND c` as `(a OR b) AND c`, which is NOT what SQL means. Left
 * uncorrected, an author who wrote an unparenthesized mixed predicate would never
 * match the database's own (correctly precedence-parenthesized) rendering, and the
 * index would rebuild on every sync -- the very failure this module prevents.
 *
 * Operand order is preserved by the parser's chaining, so flattening in order
 * recovers the original token sequence and it can be regrouped properly.
 *
 * @param {object} node an AST node
 * @returns {object} an equivalent node with precedence applied
 */
function reassociateBooleans(node) {
	if (!node || typeof node !== 'object') {
		return node;
	}

	if (node.type === 'binary_expr' && isBooleanConnective(node.operator)) {
		const operands = [];
		const operators = [];
		// Decompose THIS node's children rather than the node itself. Passing the
		// node in would re-enter with the same node whenever it carried
		// `parentheses: true` (flattenBooleanChain treats a parenthesized node as an
		// atom), recursing until the stack blew -- which the catch below swallowed
		// into a silent fallback. This node's own parentheses are irrelevant anyway,
		// since render() re-parenthesizes every composite.
		flattenBooleanChain(node.left, operands, operators);
		operators.push(`${node.operator}`.toUpperCase());
		flattenBooleanChain(node.right, operands, operators);

		// Recurse into each operand first (they may contain their own chains).
		const parts = operands.map((operand) => reassociateBooleans(operand));

		if (operators.length === 0) {
			return parts[0];
		}

		// Bind every AND, left to right, collapsing them into their operands.
		const orOperands = [parts[0]];
		const orOperators = [];
		for (let i = 0; i < operators.length; i += 1) {
			const operator = operators[i];
			const right = parts[i + 1];
			if (operator === 'AND') {
				orOperands[orOperands.length - 1] = {
					type: 'binary_expr',
					operator: 'AND',
					left: orOperands[orOperands.length - 1],
					right,
				};
			} else {
				orOperators.push(operator);
				orOperands.push(right);
			}
		}

		// Then fold the remaining ORs, left to right.
		let result = orOperands[0];
		for (let i = 0; i < orOperators.length; i += 1) {
			result = {
				type: 'binary_expr',
				operator: orOperators[i],
				left: result,
				right: orOperands[i + 1],
			};
		}
		return result;
	}

	if (node.type === 'binary_expr') {
		return {
			...node,
			left: reassociateBooleans(node.left),
			right: reassociateBooleans(node.right),
		};
	}

	if (node.type === 'unary_expr') {
		return { ...node, expr: reassociateBooleans(node.expr) };
	}

	return node;
}

/**
 * Render an AST node into a canonical, comparison-only string.
 *
 * Every composite node is parenthesized, so grouping is encoded by the tree and
 * redundant source parentheses disappear without losing real structure.
 *
 * @param {object} node an AST node
 * @returns {string} canonical text
 */
function render(node) {
	if (node === null || node === undefined) {
		return '';
	}
	if (Array.isArray(node)) {
		return node.map(render).join(',');
	}

	switch (node.type) {
		case 'cast':
			// Casts are noise here: Postgres adds them (`'a'::text`, `(col)::text`)
			// purely as a rendering artifact of type resolution.
			return render(node.expr);

		case 'column_ref':
			return columnName(node);

		case 'single_quote_string':
		case 'double_quote_string':
		case 'string':
			return `'${node.value}'`;

		case 'number':
			return `${node.value}`;

		case 'bool':
			return node.value ? 'true' : 'false';

		case 'null':
			return 'null';

		case 'expr_list':
			return (node.value || []).map(render).join(',');

		case 'unary_expr': {
			const operator = `${node.operator || ''}`.toLowerCase();
			return `(${operator} ${render(node.expr)})`;
		}

		case 'function': {
			const name = `${
				(node.name && node.name.name && node.name.name[0]
					? node.name.name[0].value
					: node.name) || ''
			}`.toLowerCase();
			const args = node.args ? render(node.args) : '';
			return `${name}(${args})`;
		}

		case 'binary_expr': {
			// `x = ANY (ARRAY[a, b])` IS `x IN (a, b)` -- fold to one spelling.
			if (isAnyArrayForm(node)) {
				const args = node.right.args ? node.right.args.value || [] : [];
				const elements = arrayElements(args[0] !== undefined ? args[0] : args);
				return `(${render(node.left)} in ${elements.map(render).join(',')})`;
			}

			let operator = `${node.operator || ''}`.toLowerCase();
			let { right } = node;

			// `email ~~ 'a%'` parses as operator `~` with the right side wrapped in a
			// unary `~`. Recombine so it folds to LIKE alongside the keyword spelling.
			if (
				(operator === '~' || operator === '!~') &&
				right &&
				right.type === 'unary_expr' &&
				`${right.operator}` === '~'
			) {
				operator = operator === '~' ? '~~' : '!~~';
				right = right.expr;
			}

			operator = OPERATOR_SYNONYMS[operator] || operator;
			return `(${render(node.left)} ${operator} ${render(right)})`;
		}

		default:
			// Anything unmodelled: fall back to a stable stringification so two
			// identical inputs still compare equal.
			if (node.value !== undefined) {
				return `${node.value}`.toLowerCase();
			}
			return JSON.stringify(node);
	}
}

/**
 * Rewrite Postgres' pattern-match OPERATORS into the keyword spellings, outside
 * string literals.
 *
 * node-sql-parser cannot lex `~~*` / `!~~*` at all, and lexes `~~` as `~` with a
 * unary `~` on the right. Postgres reports a partial index's `ILIKE` predicate as
 * `~~*`, so without this the reported form fails to parse, silently falls back to
 * text normalization, never matches the schema's `ILIKE` spelling, and the index
 * rebuilds forever.
 *
 * Only the text OUTSIDE single-quoted literals is touched, so a pattern that
 * itself contains `~~` is left alone.
 *
 * @param {string} predicate a raw predicate
 * @returns {string} the predicate with operators spelled as keywords
 */
function spellPatternOperatorsAsKeywords(predicate) {
	// Split on single-quoted literals, keeping them, and transform only the gaps.
	const segments = `${predicate}`.split(/('(?:[^']|'')*')/g);
	return segments
		.map((segment, index) => {
			// Odd indexes are the captured string literals -- leave verbatim.
			if (index % 2 === 1) {
				return segment;
			}
			return (
				segment
					// Strip `::type` casts FIRST. The parser rejects several positions
					// Postgres actually emits (`'a%'::text` on the right of LIKE,
					// `::text[]`, `::character varying`), and the renderer discards casts
					// anyway -- they are an artifact of type resolution, not meaning.
					//
					// The multi-word types are enumerated deliberately. An earlier version
					// used `[a-zA-Z0-9_ ]*` to cover `character varying`, but that also
					// matched SPACES, so `::text ~~ ` swallowed the operator that followed
					// and the predicate silently stopped parsing.
					.replace(
						/::\s*(character\s+varying|double\s+precision|timestamp(\s+with(out)?\s+time\s+zone)?|time(\s+with(out)?\s+time\s+zone)?|[a-zA-Z_][a-zA-Z0-9_]*)(\s*\[\s*\])?/gi,
						'',
					)
					.replace(/!~~\*/g, ' NOT ILIKE ')
					.replace(/~~\*/g, ' ILIKE ')
					.replace(/!~~/g, ' NOT LIKE ')
					.replace(/~~/g, ' LIKE ')
			);
		})
		.join('');
}

/**
 * Parse a predicate and render it canonically.
 *
 * @param {string} predicate a raw WHERE predicate
 * @param {string} [database] node-sql-parser dialect name
 * @returns {string|null} canonical form, or null when it cannot be parsed
 */
function canonicalizeIndexPredicateViaAst(predicate, database = 'postgresql') {
	if (predicate === undefined || predicate === null || predicate === '') {
		return null;
	}
	const prepared = spellPatternOperatorsAsKeywords(predicate);

	// Try the preferred dialect first, then the other. The two differ in ways that
	// matter here -- Postgres reads `"x"` as an IDENTIFIER while MySQL reads it as a
	// string, and only MySQL accepts backtick identifiers -- so a predicate written
	// in one style must still canonicalize when the active dialect is the other.
	// Comparison is what matters, and one canonical form for both sides is the goal.
	const attempts =
		database === 'mysql' ? ['mysql', 'postgresql'] : ['postgresql', 'mysql'];

	for (let i = 0; i < attempts.length; i += 1) {
		try {
			const ast = parser.astify(`SELECT 1 FROM t WHERE ${prepared}`, {
				database: attempts[i],
			});
			const statement = Array.isArray(ast) ? ast[0] : ast;
			if (statement && statement.where) {
				// Repair AND/OR precedence before rendering (see reassociateBooleans).
				return render(reassociateBooleans(statement.where));
			}
		} catch (err) {
			// Try the next dialect; if none parse, the caller falls back to text
			// normalization rather than failing the sync.
		}
	}
	return null;
}

module.exports = {
	canonicalizeIndexPredicateViaAst,
	renderPredicateAst: render,
};
