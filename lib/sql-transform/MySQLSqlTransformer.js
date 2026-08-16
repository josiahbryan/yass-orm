/* eslint-disable no-continue */
const { Parser } = require('node-sql-parser');

const parser = new Parser();

/**
 * Walk every node of a node-sql-parser AST, letting `visitor` replace nodes.
 * (Same shape as the helper in PostgresSqlTransformer.js.)
 */
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

/**
 * MySQL escape sequences that are recognized INSIDE a quoted string literal
 * (default sql_mode, i.e. NOT NO_BACKSLASH_ESCAPES).
 *
 * Deliberately absent: `\%` and `\_`. MySQL does NOT treat those as string
 * escapes -- the backslash SURVIVES into the string value, which is exactly
 * what makes `LIKE "%50\% off%"` work. Decoding them to a bare `%`/`_` would
 * silently turn an escaped wildcard into a live wildcard.
 */
const MYSQL_BACKSLASH_ESCAPES = {
	0: '\0',
	b: '\b',
	n: '\n',
	r: '\r',
	t: '\t',
	Z: '\x1a',
	"'": "'",
	'"': '"',
	'\\': '\\',
};

/**
 * Decode the RAW source text of a double-quoted MySQL string literal into the
 * actual string VALUE it denotes.
 *
 * node-sql-parser hands back the bytes between the quotes UNDECODED, so `""`
 * is still two characters and `\"` is still two characters. Anything that
 * string-replaces on that raw text is operating across an encoding boundary
 * and will corrupt the value (`""` means ONE `"` in double-quote context but
 * TWO `"` in single-quote context) -- silently, with no SQL error.
 *
 * @param {string} raw - source text between the double quotes
 * @returns {string} the decoded string value
 */
function decodeDoubleQuotedLiteral(raw) {
	let out = '';
	let idx = 0;
	while (idx < raw.length) {
		const ch = raw[idx];

		// `""` is the doubled-delimiter form of a single `"`.
		if (ch === '"' && raw[idx + 1] === '"') {
			out += '"';
			idx += 2;
			continue;
		}

		if (ch === '\\') {
			const next = raw[idx + 1];
			if (next === undefined) {
				// Trailing lone backslash - keep it as-is.
				out += '\\';
				idx += 1;
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(MYSQL_BACKSLASH_ESCAPES, next)) {
				out += MYSQL_BACKSLASH_ESCAPES[next];
			} else {
				// Unrecognized escape: MySQL keeps the backslash for `\%` / `\_`
				// (LIKE wildcards) and drops it for everything else.
				out += next === '%' || next === '_' ? `\\${next}` : next;
			}
			idx += 2;
			continue;
		}

		out += ch;
		idx += 1;
	}
	return out;
}

/**
 * Encode a decoded string VALUE back into the raw source text of a
 * single-quoted MySQL string literal.
 *
 * `'` is emitted as `''` (the doubled-delimiter form) rather than `\'` because
 * the doubled form is valid under NO_BACKSLASH_ESCAPES too. A literal
 * backslash still has to be doubled -- under default sql_mode a lone backslash
 * would start an escape sequence.
 *
 * @param {string} value - decoded string value
 * @returns {string} source text to place between single quotes
 */
function encodeSingleQuotedLiteral(value) {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * Rewrite every double-quoted string literal in the AST to the equivalent
 * single-quoted one. Returns the number of literals rewritten so the caller
 * can leave the SQL completely untouched when there is nothing to fix.
 *
 * @param {object|Array} ast
 * @returns {{ ast: object|Array, rewrites: number }}
 */
function rewriteDoubleQuotedStrings(ast) {
	let rewrites = 0;
	const next = visitAst(ast, (node) => {
		if (node.type !== 'double_quote_string') {
			return node;
		}
		rewrites += 1;
		return {
			...node,
			type: 'single_quote_string',
			value: encodeSingleQuotedLiteral(
				decodeDoubleQuotedLiteral(`${node.value}`),
			),
		};
	});
	return { ast: next, rewrites };
}

/**
 * Statement types we are willing to reserialize.
 *
 * DDL is DELIBERATELY EXCLUDED. Two reasons, both measured:
 *  - yass-orm GENERATES its own DDL, so it is not the caller-authored SQL this
 *    normalizer exists to defend against.
 *  - `sqlify` does not round-trip index DDL faithfully. On
 *    `CREATE INDEX x ON t ((CAST(meta->>"valence" AS CHAR(255)) COLLATE
 *    utf8mb4_bin))` it moves the COLLATE outside the expression parens AND
 *    rewrites the JSON path to `'valence'` -- which no longer text-matches the
 *    definition MySQL reports back, so schemaSync drops and recreates the index
 *    on every single sync. (Caught by
 *    test/schemaSync.idempotency.test.js "should not recreate equivalent
 *    indexes on second sync (double-quote JSON path)".)
 */
const REWRITABLE_STATEMENT_TYPES = new Set([
	'select',
	'insert',
	'replace',
	'update',
	'delete',
]);

/**
 * Normalize MySQL SQL so it means the same thing under `ANSI_QUOTES`.
 *
 * WHY: under `ANSI_QUOTES` (which one of rubber's read replicas, ro1, runs on
 * purpose for PlanetScale-replication compatibility) a double-quoted token is
 * an IDENTIFIER, not a string. So caller SQL like `... like "upm%"` succeeds on
 * the primary and dies with `ERROR 1054 unknown column 'upm%'` on that one
 * replica -- routing-dependent, intermittent, and the error text points the
 * reader at the schema instead of at quoting.
 *
 * HOW: AST-first, and DELIBERATELY CONSERVATIVE about when it rewrites at all:
 *
 *  - no `"` anywhere in the SQL              -> return the input untouched
 *  - SQL contains `--` or comment markers    -> return the input untouched
 *    (`sqlify` drops comments, and yass-orm callers write them)
 *  - parses to anything that is not SELECT/INSERT/REPLACE/UPDATE/DELETE
 *    (i.e. DDL)                              -> return the input untouched
 *  - parses, but has no double-quoted string -> return the INPUT, not the
 *    round-tripped output, so a query that needs no fix is never reserialized
 *  - `astify` throws                         -> return the input untouched
 *
 * Every arm is fail-open: worst case is the current (broken-on-ro1) behavior,
 * never a mangled query.
 *
 * CAVEAT (semantics, not a bug): SQL written *for* ANSI_QUOTES, where `"col"`
 * is meant as an identifier, parses as a `double_quote_string` too and will be
 * rewritten to the constant `'col'`. Under default sql_mode that is already
 * how MySQL reads it, so this is a no-op for SQL authored against the primary
 * -- but do not feed this transformer ANSI-authored SQL.
 *
 * @param {{ sql: string, params?: object }} options
 * @returns {{ sql: string, mode: string, rewrites: number, error?: Error }}
 */
function transformSqlForMySQL({ sql, params = {} }) {
	// eslint-disable-next-line no-unused-vars
	const _params = params;

	if (typeof sql !== 'string' || !sql.includes('"')) {
		return { sql, mode: 'identity', rewrites: 0 };
	}

	// Preserve comments exactly as written; parser/sqlify drops them.
	if (sql.includes('--') || sql.includes('/*') || sql.includes('#')) {
		return { sql, mode: 'skipped-comments', rewrites: 0 };
	}

	try {
		const ast = parser.astify(sql, { database: 'mysql' });

		// DDL (and anything else we do not recognize) is never reserialized.
		const statements = Array.isArray(ast) ? ast : [ast];
		const rewritable = statements.every(
			(stmt) =>
				stmt &&
				typeof stmt.type === 'string' &&
				REWRITABLE_STATEMENT_TYPES.has(stmt.type.toLowerCase()),
		);
		if (!rewritable) {
			return { sql, mode: 'skipped-non-dml', rewrites: 0 };
		}

		const { ast: rewritten, rewrites } = rewriteDoubleQuotedStrings(ast);
		if (!rewrites) {
			// Nothing to fix - hand back the ORIGINAL text, never a reserialization.
			return { sql, mode: 'identity', rewrites: 0 };
		}
		return {
			sql: parser.sqlify(rewritten, { database: 'mysql' }),
			mode: 'ast',
			rewrites,
		};
	} catch (err) {
		return { sql, mode: 'fail-open', rewrites: 0, error: err };
	}
}

module.exports = {
	transformSqlForMySQL,
	decodeDoubleQuotedLiteral,
	encodeSingleQuotedLiteral,
	rewriteDoubleQuotedStrings,
};
