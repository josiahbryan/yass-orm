/* eslint-disable no-continue */
const { Parser } = require('node-sql-parser');

const parser = new Parser();

function visitAst(node, visitor) {
	if (!node || typeof node !== 'object') {
		return node;
	}
	const replaced = visitor(node) || node;
	if (Array.isArray(replaced)) {
		return replaced.map((item) => visitAst(item, visitor));
	}
	Object.keys(replaced).forEach((key) => {
		replaced[key] = visitAst(replaced[key], visitor);
	});
	return replaced;
}

function createFunctionNode(name, args) {
	return {
		type: 'function',
		name: {
			name: [{ type: 'default', value: name }],
		},
		args: {
			type: 'expr_list',
			value: args,
		},
		over: null,
	};
}

function transformAstForPostgres(ast) {
	return visitAst(ast, (node) => {
		if (node.type === 'function') {
			const fnName =
				node.name &&
				node.name.name &&
				node.name.name[0] &&
				`${node.name.name[0].value || ''}`.toUpperCase();
			// NOW() is supported natively in PG - no change needed
			if (fnName === 'CURDATE') {
				// CURDATE() -> CURRENT_DATE (keyword, not function call)
				return {
					type: 'column_ref',
					table: null,
					column: 'CURRENT_DATE',
				};
			}
			if (fnName === 'IFNULL') {
				// IFNULL(a, b) -> COALESCE(a, b)
				return createFunctionNode('COALESCE', node.args.value);
			}
			// CONCAT is supported natively in PG - no change needed
		}

		// JSON operators: convert $.path to simple key
		if (
			node.type === 'binary_expr' &&
			(node.operator === '->>' || node.operator === '->')
		) {
			if (
				node.right &&
				typeof node.right.value === 'string' &&
				node.right.value.startsWith('$.')
			) {
				return {
					...node,
					right: {
						...node.right,
						value: node.right.value.replace(/^\$\./, ''),
						type: 'single_quote_string',
					},
				};
			}
		}

		return node;
	});
}

/**
 * Tokenizes SQL into segments: { type: 'code'|'string'|'comment'|'backtick', value }.
 * This allows us to selectively transform code segments while handling
 * backtick and string content separately.
 */
function tokenizeSql(sql) {
	const tokens = [];
	let idx = 0;
	while (idx < sql.length) {
		const ch = sql[idx];
		const next = sql[idx + 1];

		// Single-line comments
		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', idx + 2);
			if (end < 0) {
				tokens.push({ type: 'comment', value: sql.slice(idx) });
				break;
			}
			tokens.push({ type: 'comment', value: sql.slice(idx, end + 1) });
			idx = end + 1;
			continue;
		}

		// Multi-line comments
		if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', idx + 2);
			if (end < 0) {
				tokens.push({ type: 'comment', value: sql.slice(idx) });
				break;
			}
			tokens.push({ type: 'comment', value: sql.slice(idx, end + 2) });
			idx = end + 2;
			continue;
		}

		// Backtick-quoted identifiers (MySQL)
		if (ch === '`') {
			let end = idx + 1;
			while (end < sql.length && sql[end] !== '`') {
				end += 1;
			}
			// Extract the content inside backticks
			const content = sql.slice(idx + 1, end);
			tokens.push({ type: 'backtick', value: content });
			idx = end + 1;
			continue;
		}

		// Single or double quoted strings
		if (ch === "'" || ch === '"') {
			let end = idx + 1;
			while (end < sql.length) {
				const q = sql[end];
				if (q === '\\') {
					end += 2;
					continue;
				}
				if (q === ch) {
					if (sql[end + 1] === ch) {
						end += 2;
						continue;
					}
					end += 1;
					break;
				}
				end += 1;
			}
			tokens.push({ type: 'string', value: sql.slice(idx, end) });
			idx = end;
			continue;
		}

		// Collect plain code until special token starts.
		let end = idx + 1;
		while (end < sql.length) {
			const c = sql[end];
			const n = sql[end + 1];
			if (
				c === "'" ||
				c === '"' ||
				c === '`' ||
				(c === '-' && n === '-') ||
				(c === '/' && n === '*')
			) {
				break;
			}
			end += 1;
		}
		tokens.push({ type: 'code', value: sql.slice(idx, end) });
		idx = end;
	}
	return tokens;
}

/**
 * Scanner-based SQL transformation for PostgreSQL.
 * Converts :name placeholders to $N positional, backticks to double-quotes,
 * LIMIT rewriting, function conversions, and JSON path conversions.
 *
 * @param {string} sql - The MySQL-dialect SQL string
 * @param {object} params - The named parameter map (keys used for matching)
 * @returns {{ sql: string, paramOrder: string[] }}
 */
function transformSqlWithScanner(sql, params = {}) {
	const keys = Object.keys(params || {}).sort((a, b) => b.length - a.length);
	const paramMap = {}; // key -> $N index (1-based)
	const paramOrder = []; // ordered list of keys

	// First pass: scan through code tokens to discover param order by position.
	// We need this because keys are sorted by length (for correct matching),
	// but paramOrder must reflect the order params appear in the SQL.
	const tokens = tokenizeSql(sql);
	const paramPositions = []; // { key, pos }
	let codeOffset = 0;
	tokens.forEach((token) => {
		if (token.type !== 'code') {
			codeOffset += token.value.length + (token.type === 'backtick' ? 2 : 0);
			return;
		}
		keys.forEach((key) => {
			const re = new RegExp(`:${key}(?![a-zA-Z0-9_])`, 'g');
			let m;
			// eslint-disable-next-line no-cond-assign
			while ((m = re.exec(token.value)) !== null) {
				paramPositions.push({ key, pos: codeOffset + m.index });
			}
		});
		codeOffset += token.value.length;
	});
	// Sort by position in the original SQL, then deduplicate keys
	paramPositions.sort((a, b) => a.pos - b.pos);
	paramPositions.forEach(({ key }) => {
		if (!(key in paramMap)) {
			paramOrder.push(key);
			paramMap[key] = paramOrder.length;
		}
	});

	// Second pass: rebuild SQL with transformations applied.
	const parts = tokens.map((token) => {
		if (token.type === 'comment') {
			return token.value;
		}
		if (token.type === 'backtick') {
			// Convert backtick identifiers to double-quoted identifiers
			return `"${token.value}"`;
		}
		if (token.type === 'string') {
			// Transform JSON paths in string tokens that follow -> or ->>
			// The string token includes surrounding quotes.
			return token.value;
		}
		// Code token - apply all transformations
		let result = token.value;

		// Convert :name placeholders to $N positional placeholders.
		keys.forEach((key) => {
			result = result.replace(
				new RegExp(`:${key}(?![a-zA-Z0-9_])`, 'g'),
				() => `$${paramMap[key]}`,
			);
		});

		// Convert MySQL LIMIT offset,count to PG LIMIT count OFFSET offset.
		result = result.replace(
			/LIMIT\s+(\d+)\s*,\s*(\d+)/gi,
			'LIMIT $2 OFFSET $1',
		);

		// Function conversions (scanner fallback when AST path unavailable).
		// NOW() is natively supported by PG - no change.
		result = result.replace(/\bCURDATE\s*\(\s*\)/gi, 'CURRENT_DATE');
		result = result.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');

		return result;
	});

	// Join and do a final pass for JSON path conversion across token boundaries.
	// The pattern ->> '$.key' spans a code token and a string token.
	let transformed = parts.join('');
	transformed = transformed.replace(
		/(->>?)\s*'(\$\.)([^']+)'/g,
		(match, operator, _dollarDot, key) => `${operator}'${key}'`,
	);
	transformed = transformed.replace(
		/(->>?)\s*"(\$\.)([^"]+)"/g,
		(match, operator, _dollarDot, key) => `${operator}'${key}'`,
	);

	return { sql: transformed, paramOrder };
}

/**
 * Full PostgreSQL SQL transformer: AST-first with scanner fallback.
 *
 * @param {{ sql: string, params?: object }} options
 * @returns {{ sql: string, paramOrder: string[], mode: string, error?: Error }}
 */
function transformSqlForPostgres({ sql, params = {} }) {
	// Preserve comments exactly as written; parser/sqlify drops comments.
	if (sql.includes('--') || sql.includes('/*')) {
		const result = transformSqlWithScanner(sql, params);
		return {
			...result,
			mode: 'scanner',
		};
	}

	try {
		const ast = parser.astify(sql, { database: 'mysql' });
		const transformedAst = transformAstForPostgres(ast);
		const pgSql = parser.sqlify(transformedAst, { database: 'postgresql' });
		// Still run scanner pass for placeholder conversion, LIMIT rewriting, backtick cleanup.
		const result = transformSqlWithScanner(pgSql, params);
		return {
			...result,
			mode: 'ast',
		};
	} catch (err) {
		const result = transformSqlWithScanner(sql, params);
		return {
			...result,
			mode: 'scanner',
			error: err,
		};
	}
}

module.exports = {
	transformSqlForPostgres,
	transformSqlWithScanner,
	transformAstForPostgres,
};
