/* eslint-disable no-continue */

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
 * The bytes between the quotes are UNDECODED, so `""` is still two characters
 * and `\"` is still two characters. Anything that string-replaces on that raw
 * text is operating across an encoding boundary and will corrupt the value
 * (`""` means ONE `"` in double-quote context but TWO `"` in single-quote
 * context) -- silently, with no SQL error.
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
 * Token kinds emitted by `scanMySqlSql`. Every character of the input lands in
 * exactly one token, so joining the token texts reconstructs the input exactly.
 */
const TOKEN = {
	TEXT: 'text',
	SINGLE_QUOTED: 'single-quoted',
	DOUBLE_QUOTED: 'double-quoted',
	BACKTICK: 'backtick',
	LINE_COMMENT: 'line-comment',
	BLOCK_COMMENT: 'block-comment',
};

/**
 * Consume a quoted run starting at `start` (which must be the opening quote).
 *
 * @param {string} sql
 * @param {number} start - index of the opening delimiter
 * @param {string} quote - the delimiter character
 * @param {boolean} allowBackslash - whether `\` escapes apply (false for
 *   backtick identifiers, which only support the doubled-delimiter form)
 * @returns {number} index just past the closing delimiter, or -1 if unterminated
 */
function scanQuotedRun(sql, start, quote, allowBackslash) {
	let idx = start + 1;
	while (idx < sql.length) {
		const ch = sql[idx];
		if (allowBackslash && ch === '\\') {
			idx += 2;
			continue;
		}
		if (ch === quote) {
			// A doubled delimiter is an escaped delimiter, not the end.
			if (sql[idx + 1] === quote) {
				idx += 2;
				continue;
			}
			return idx + 1;
		}
		idx += 1;
	}
	return -1;
}

/**
 * Lexically split MySQL SQL into quoted runs, comments and everything else.
 *
 * This exists so the transformer can rewrite string literals by SPLICING THE
 * ORIGINAL SOURCE rather than reserializing a parsed statement. That choice is
 * what lets comments survive verbatim (a serializer has no way to put them
 * back -- the earlier cut had to skip comment-bearing SQL entirely) and what
 * lets SQL a full parser rejects still be fixed.
 *
 * Under default sql_mode a `"..."` run outside a comment, a single-quoted
 * string or a backticked identifier IS a string literal -- MySQL spells
 * identifiers with backticks -- so classifying lexically is sound here. It
 * would NOT be sound for SQL authored under ANSI_QUOTES; see the caveat on
 * `transformSqlForMySQL`.
 *
 * @param {string} sql
 * @returns {{ tokens: Array<{kind: string, text: string, raw?: string}>,
 *   unterminated: boolean }}
 */
function scanMySqlSql(sql) {
	const tokens = [];
	let idx = 0;
	let textStart = 0;

	const flushTextBefore = (end) => {
		if (end > textStart) {
			tokens.push({ kind: TOKEN.TEXT, text: sql.slice(textStart, end) });
		}
	};

	while (idx < sql.length) {
		const ch = sql[idx];

		// `#` runs to end of line. `--` only starts a comment when whitespace (or
		// end of input) follows it -- `a--1` is `a - (-1)`, and swallowing the
		// rest of that line would silently delete a predicate.
		const isDashComment =
			ch === '-' &&
			sql[idx + 1] === '-' &&
			(idx + 2 >= sql.length || /\s/.test(sql[idx + 2]));
		if (ch === '#' || isDashComment) {
			flushTextBefore(idx);
			const nl = sql.indexOf('\n', idx);
			const end = nl === -1 ? sql.length : nl;
			tokens.push({ kind: TOKEN.LINE_COMMENT, text: sql.slice(idx, end) });
			idx = end;
			textStart = idx;
			continue;
		}

		if (ch === '/' && sql[idx + 1] === '*') {
			flushTextBefore(idx);
			const close = sql.indexOf('*/', idx + 2);
			if (close === -1) {
				return { tokens, unterminated: true };
			}
			tokens.push({
				kind: TOKEN.BLOCK_COMMENT,
				text: sql.slice(idx, close + 2),
			});
			idx = close + 2;
			textStart = idx;
			continue;
		}

		if (ch === "'" || ch === '"' || ch === '`') {
			flushTextBefore(idx);
			const end = scanQuotedRun(sql, idx, ch, ch !== '`');
			if (end === -1) {
				return { tokens, unterminated: true };
			}
			let kind = TOKEN.BACKTICK;
			if (ch === "'") {
				kind = TOKEN.SINGLE_QUOTED;
			} else if (ch === '"') {
				kind = TOKEN.DOUBLE_QUOTED;
			}
			tokens.push({
				kind,
				text: sql.slice(idx, end),
				raw: sql.slice(idx + 1, end - 1),
			});
			idx = end;
			textStart = idx;
			continue;
		}

		idx += 1;
	}

	flushTextBefore(sql.length);
	return { tokens, unterminated: false };
}

/**
 * Split a token stream on top-level `;` so each statement can be gated on its
 * own leading keyword.
 *
 * @param {Array} tokens
 * @returns {Array<Array>} one token list per statement
 */
function splitStatements(tokens) {
	const statements = [];
	let current = [];

	tokens.forEach((token) => {
		if (token.kind !== TOKEN.TEXT || !token.text.includes(';')) {
			current.push(token);
			return;
		}
		token.text.split(';').forEach((part, partIdx) => {
			if (partIdx > 0) {
				current.push({ kind: TOKEN.TEXT, text: ';' });
				statements.push(current);
				current = [];
			}
			if (part) {
				current.push({ kind: TOKEN.TEXT, text: part });
			}
		});
	});

	statements.push(current);
	return statements;
}

/**
 * Statements we are willing to rewrite, identified by leading keyword.
 *
 * DDL is DELIBERATELY EXCLUDED, and the reason is TEXT MATCHING, not meaning:
 * `CREATE INDEX x ON t ((CAST(meta->>"valence" AS CHAR(255)) COLLATE
 * utf8mb4_bin))` is semantically identical with `'valence'`, but the definition
 * MySQL reports back no longer text-matches what schemaSync generated, so it
 * drops and recreates the index on every single sync. (Caught by
 * test/schemaSync.idempotency.test.js "should not recreate equivalent indexes
 * on second sync (double-quote JSON path)".) yass-orm generates its own DDL
 * anyway, so DDL is not the caller-authored SQL this normalizer defends.
 */
const REWRITABLE_LEADING_KEYWORDS = new Set([
	'select',
	'insert',
	'replace',
	'update',
	'delete',
]);

/**
 * The first bare word of a statement, lowercased, skipping comments and
 * leading punctuation. Returns null when the statement starts with a quoted
 * run (or has no word at all), which is never something we want to rewrite.
 *
 * @param {Array} statement
 * @returns {string|null}
 */
function leadingKeywordOf(statement) {
	for (let i = 0; i < statement.length; i += 1) {
		const token = statement[i];
		if (
			token.kind === TOKEN.LINE_COMMENT ||
			token.kind === TOKEN.BLOCK_COMMENT
		) {
			continue;
		}
		if (token.kind !== TOKEN.TEXT) {
			return null;
		}
		const match = token.text.match(/[A-Za-z_][A-Za-z0-9_]*/);
		if (match) {
			return match[0].toLowerCase();
		}
	}
	return null;
}

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
 * HOW: lex the SQL, then SPLICE THE ORIGINAL SOURCE, replacing only the
 * double-quoted runs. Nothing else is reserialized, so whitespace, keyword
 * case, layout and -- critically -- comments come back byte-for-byte.
 *
 * Rewriting is still gated:
 *
 *  - no `"` anywhere in the SQL                 -> input returned untouched
 *  - a statement whose leading keyword is not
 *    SELECT/INSERT/REPLACE/UPDATE/DELETE        -> that statement untouched
 *  - an unterminated string or block comment    -> input returned untouched
 *  - nothing actually rewritten                 -> the INPUT is returned, so a
 *    query that needs no fix is never rebuilt
 *
 * A `"` appearing inside a comment, a single-quoted string or a backticked
 * identifier is left alone: it is prose or content, not a literal.
 *
 * CAVEAT (semantics, not a bug): SQL written *for* ANSI_QUOTES, where `"col"`
 * is meant as an identifier, is indistinguishable from a string literal here
 * and will be rewritten to the constant `'col'`. Under default sql_mode that is
 * already how MySQL reads it, so this is a no-op for SQL authored against the
 * primary -- but do not feed this transformer ANSI-authored SQL.
 *
 * @param {{ sql: string, params?: object }} options
 * @returns {{ sql: string, mode: string, rewrites: number }}
 */
function transformSqlForMySQL({ sql, params = {} }) {
	// eslint-disable-next-line no-unused-vars
	const _params = params;

	if (typeof sql !== 'string' || !sql.includes('"')) {
		return { sql, mode: 'identity', rewrites: 0 };
	}

	const { tokens, unterminated } = scanMySqlSql(sql);
	if (unterminated) {
		// Truncated or malformed - we cannot reason about it, so change nothing.
		return { sql, mode: 'unterminated', rewrites: 0 };
	}

	let rewrites = 0;
	let skippedNonDml = false;

	const rebuilt = splitStatements(tokens)
		.map((statement) => {
			if (!REWRITABLE_LEADING_KEYWORDS.has(leadingKeywordOf(statement))) {
				skippedNonDml =
					skippedNonDml ||
					statement.some((token) => token.kind === TOKEN.DOUBLE_QUOTED);
				return statement.map((token) => token.text).join('');
			}
			return statement
				.map((token) => {
					if (token.kind !== TOKEN.DOUBLE_QUOTED) {
						return token.text;
					}
					rewrites += 1;
					return `'${encodeSingleQuotedLiteral(
						decodeDoubleQuotedLiteral(token.raw),
					)}'`;
				})
				.join('');
		})
		.join('');

	if (!rewrites) {
		// Nothing to fix - hand back the ORIGINAL text.
		return {
			sql,
			mode: skippedNonDml ? 'skipped-non-dml' : 'identity',
			rewrites: 0,
		};
	}

	return { sql: rebuilt, mode: 'rewrite', rewrites };
}

module.exports = {
	transformSqlForMySQL,
	decodeDoubleQuotedLiteral,
	encodeSingleQuotedLiteral,
	scanMySqlSql,
	TOKEN,
};
