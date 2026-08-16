/* global it, describe */
const { expect } = require('chai');
const { Parser } = require('node-sql-parser');
const {
	transformSqlForMySQL,
	decodeDoubleQuotedLiteral,
	encodeSingleQuotedLiteral,
} = require('../MySQLSqlTransformer.js');
const { MySQLDialect } = require('../../dialects/MySQLDialect.js');

const parser = new Parser();

/**
 * Independent decoder for the single-quote context -- deliberately NOT reusing
 * the transformer's encoder, so the assertion cannot pass by agreeing with a
 * bug in the code under test.
 */
function decodeSingleQuotedLiteral(raw) {
	let out = '';
	let i = 0;
	while (i < raw.length) {
		const ch = raw[i];
		if (ch === "'" && raw[i + 1] === "'") {
			out += "'";
			i += 2;
		} else if (ch === '\\' && i + 1 < raw.length) {
			const n = raw[i + 1];
			const map = {
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
			if (Object.prototype.hasOwnProperty.call(map, n)) {
				out += map[n];
			} else {
				out += n === '%' || n === '_' ? `\\${n}` : n;
			}
			i += 2;
		} else {
			out += ch;
			i += 1;
		}
	}
	return out;
}

/**
 * Read back the DECODED string values of every literal in the transformed SQL.
 * Asserting on the value -- not on the text -- is what proves the rewrite
 * preserved meaning across the quoting-context change, rather than merely
 * producing something that parses.
 */
function literalValuesOf(sql) {
	const values = [];
	const walk = (node) => {
		if (!node || typeof node !== 'object') {
			return;
		}
		if (Array.isArray(node)) {
			node.forEach(walk);
			return;
		}
		if (node.type === 'single_quote_string') {
			values.push(decodeSingleQuotedLiteral(`${node.value}`));
			return;
		}
		if (node.type === 'double_quote_string') {
			values.push(decodeDoubleQuotedLiteral(`${node.value}`));
			return;
		}
		Object.keys(node).forEach((key) => walk(node[key]));
	};
	walk(parser.astify(sql, { database: 'mysql' }));
	return values;
}

describe('MySQLSqlTransformer', () => {
	describe('decode / encode across the quoting boundary', () => {
		it('decodes the doubled-delimiter form to ONE quote character', () => {
			// This is the case the naive "escape the value" remedy corrupts
			// silently: `""` means one `"`, not two.
			expect(decodeDoubleQuotedLiteral('say ""hi""')).to.equal('say "hi"');
		});

		it('decodes backslash escapes', () => {
			expect(decodeDoubleQuotedLiteral('say \\"hi\\"')).to.equal('say "hi"');
			expect(decodeDoubleQuotedLiteral('back\\\\slash')).to.equal(
				'back\\slash',
			);
			expect(decodeDoubleQuotedLiteral("O\\'Brien")).to.equal("O'Brien");
		});

		it('KEEPS the backslash on \\% and \\_ (LIKE wildcard escapes)', () => {
			expect(decodeDoubleQuotedLiteral('%50\\% off%')).to.equal('%50\\% off%');
			expect(decodeDoubleQuotedLiteral('a\\_b')).to.equal('a\\_b');
		});

		it('round-trips value -> single-quote source -> value', () => {
			[
				"O'Brien",
				'say "hi"',
				'back\\slash',
				'%50\\% off%',
				'',
				"it''s not decoded yet",
			].forEach((value) => {
				expect(
					decodeSingleQuotedLiteral(encodeSingleQuotedLiteral(value)),
				).to.equal(value);
			});
		});
	});

	describe('transformSqlForMySQL()', () => {
		it('rewrites a double-quoted literal to single quotes', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where n = "bob"',
			});
			expect(out.mode).to.equal('rewrite');
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain("'bob'");
			expect(out.sql).to.not.contain('"');
		});

		it('CANARY: preserves an apostrophe (naive type-flip emits invalid SQL)', () => {
			const out = transformSqlForMySQL({
				sql: `select * from t where n = "O'Brien"`,
			});
			expect(out.sql).to.not.contain('"');
			// Must still PARSE -- a naive flip produces 'O'Brien' (1064).
			expect(() =>
				parser.astify(out.sql, { database: 'mysql' }),
			).to.not.throw();
			expect(literalValuesOf(out.sql)).to.deep.equal(["O'Brien"]);
		});

		it('CANARY: preserves a doubled quote as ONE character (silent-corruption case)', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where n = "say ""hi"""',
			});
			// The `"` characters that remain are literal CONTENT inside a
			// single-quoted string, which is exactly right -- assert the decoded
			// VALUE, not the absence of a quote character.
			expect(out.sql).to.contain('\'say "hi"\'');
			expect(literalValuesOf(out.sql)).to.deep.equal(['say "hi"']);
		});

		it('CANARY: preserves a literal backslash without double-escaping it', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where n = "back\\\\slash"',
			});
			expect(literalValuesOf(out.sql)).to.deep.equal(['back\\slash']);
		});

		it('CANARY: preserves a LIKE escaped-percent pattern', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where n like "%50\\% off%"',
			});
			expect(out.sql).to.not.contain('"');
			expect(literalValuesOf(out.sql)).to.deep.equal(['%50\\% off%']);
		});

		it('CANARY: handles the empty literal `!= ""`', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where tasks != ""',
			});
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain("!= ''");
			expect(out.sql).to.not.contain('"');
		});

		it('CANARY: leaves :named placeholders intact alongside a rewrite', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where a = "x" and b = :startDate',
				params: { startDate: 1 },
			});
			expect(out.sql).to.contain(':startDate');
			expect(out.sql).to.contain("'x'");
		});

		it('CANARY: rewrites every statement of a multi-statement query', () => {
			const out = transformSqlForMySQL({
				sql: 'select 1 from t where a = "x" ; select 2 from u where b = "y"',
			});
			expect(out.rewrites).to.equal(2);
			expect(out.sql).to.not.contain('"');
		});

		it('CANARY (real production site, valet-dashboard-report.js:2604)', () => {
			const out = transformSqlForMySQL({
				sql:
					'select * from nps where nps.linkedTransactionId like "upm%" ' +
					'and nps.createdAt between :startDate and :endDate',
				params: { startDate: 1, endDate: 2 },
			});
			expect(out.sql).to.not.contain('"');
			// Keyword case is the CALLER's now -- the rewrite splices the source
			// instead of reserializing it, so `like` does not become `LIKE`.
			expect(out.sql).to.contain("like 'upm%'");
			expect(out.sql).to.contain(':startDate');
			expect(out.sql).to.contain(':endDate');
		});
	});

	describe('fail-open behavior (never mangle, never throw)', () => {
		it('returns SQL with no double quotes byte-identical', () => {
			const sql = "select * from t where a = 'x' and b = :y";
			const out = transformSqlForMySQL({ sql, params: { y: 1 } });
			expect(out.sql).to.equal(sql);
			expect(out.mode).to.equal('identity');
		});

		it('returns parseable SQL that has no double-quoted STRING byte-identical', () => {
			// Backticked identifiers parse fine but yield zero rewrites -- the
			// original text must come back, NOT a reserialization.
			const sql = 'select  *  from  `t`  where  `a`  =  1';
			expect(transformSqlForMySQL({ sql }).sql).to.equal(sql);
		});

		it('preserves a -- comment VERBATIM while still fixing the literal', () => {
			// Superseded contract: this used to assert the whole query came back
			// untouched, which left it broken on ANSI_QUOTES. The guarantee now is
			// narrower and stronger -- the comment survives, the literal is fixed.
			const out = transformSqlForMySQL({
				sql: 'select * from t -- note\nwhere a = "x"',
			});
			expect(out.sql).to.equal("select * from t -- note\nwhere a = 'x'");
		});

		it('preserves a block comment VERBATIM while still fixing the literal', () => {
			const out = transformSqlForMySQL({
				sql: '/* tag */ select * from t where a = "x"',
			});
			expect(out.sql).to.equal("/* tag */ select * from t where a = 'x'");
			expect(out.mode).to.equal('rewrite');
		});

		it('REGRESSION: leaves index DDL with a double-quoted JSON path alone', () => {
			// sqlify does not round-trip this faithfully: it hoists the COLLATE
			// out of the expression parens and rewrites the path, so schemaSync
			// stops recognizing the existing index and recreates it every sync.
			const sql =
				'CREATE INDEX `idx_meta_valence` ON `t` ' +
				'((CAST(meta->>"valence" as CHAR(255)) COLLATE utf8mb4_bin))';
			const out = transformSqlForMySQL({ sql });
			expect(out.sql).to.equal(sql);
			expect(out.mode).to.equal('skipped-non-dml');
			expect(out.rewrites).to.equal(0);
		});

		it('leaves other DDL alone', () => {
			const sql = 'CREATE TABLE `t` (`a` varchar(10) COMMENT "hi")';
			expect(transformSqlForMySQL({ sql }).sql).to.equal(sql);
		});

		it('still rewrites a JSON-path query on the DML path', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t where meta->>"$.valence" = "x"',
			});
			expect(out.mode).to.equal('rewrite');
			expect(out.sql).to.contain("'$.valence'");
			expect(out.sql).to.contain("'x'");
		});

		it('returns nonsense input untouched rather than throwing', () => {
			// Used to be caught by `astify` throwing. There is no parser on this
			// path any more, so it is the leading-keyword gate that holds the line:
			// `this` is not a DML verb, so nothing is rewritten.
			const sql = 'this is not "sql" at all ((';
			let out;
			expect(() => {
				out = transformSqlForMySQL({ sql });
			}).to.not.throw();
			expect(out.sql).to.equal(sql);
			expect(out.mode).to.equal('skipped-non-dml');
			expect(out.rewrites).to.equal(0);
		});

		it('tolerates a non-string input', () => {
			expect(transformSqlForMySQL({ sql: undefined }).sql).to.equal(undefined);
		});
	});

	describe('GAP (a): comment-bearing SQL is fixed, not skipped', () => {
		// The first cut bailed on any `--`, `/*` or `#`, which left a real DML
		// query carrying BOTH a comment AND a double-quoted literal unfixed --
		// it still 1054s on an ANSI_QUOTES replica. The bar: comment INTACT and
		// literal REWRITTEN, in the same query.

		it('rewrites the literal and KEEPS a -- line comment', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t\n-- only active\nwhere a = "x"',
			});
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain('-- only active');
			expect(out.sql).to.contain("= 'x'");
			expect(out.sql).to.not.contain('"');
		});

		it('rewrites the literal and KEEPS a # line comment', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t\n# only active\nwhere a = "w"',
			});
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain('# only active');
			expect(out.sql).to.contain("= 'w'");
		});

		it('rewrites the literal and KEEPS a /* */ block comment', () => {
			const out = transformSqlForMySQL({
				sql: 'select * from t /* keep me */ where a = "z"',
			});
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain('/* keep me */');
			expect(out.sql).to.contain("= 'z'");
		});

		it('CANARY: a quote that is PROSE inside a comment is NOT rewritten, while the real literal outside it IS', () => {
			// This is the protective property the blunt guard bought, and it has
			// to survive the fix -- measured, not assumed. Both halves at once.
			const sql = 'select * from t\n-- Bob\'s "favourite" rows\nwhere a = "y"';
			const out = transformSqlForMySQL({ sql });
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain('-- Bob\'s "favourite" rows');
			expect(out.sql).to.contain("= 'y'");
		});

		it('leaves a comment-only difference byte-identical when there is no literal to fix', () => {
			const sql = 'select * from t -- don\'t "touch" this\nwhere a = 1';
			const out = transformSqlForMySQL({ sql });
			expect(out.sql).to.equal(sql);
			expect(out.rewrites).to.equal(0);
		});

		it('does NOT treat `--` as a comment unless whitespace follows (MySQL rule)', () => {
			// `a--1` is `a - (-1)`, not a comment. Mis-lexing it would swallow the
			// rest of the line and silently drop the predicate.
			const out = transformSqlForMySQL({
				sql: 'select a--1 from t where b = "x"',
			});
			expect(out.sql).to.contain('a--1');
			expect(out.sql).to.contain("= 'x'");
			expect(out.rewrites).to.equal(1);
		});
	});

	describe('GAP (b): SQL node-sql-parser cannot parse is still fixed', () => {
		it('CANARY: rewrites a reserved word used as an identifier', () => {
			const sql = 'select id from t where key like "upm%"';
			// Document WHY this was unfixed before: the parser rejects it outright.
			expect(() => parser.astify(sql, { database: 'mysql' })).to.throw();

			const out = transformSqlForMySQL({ sql });
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain("like 'upm%'");
			expect(out.sql).to.not.contain('"');
		});

		it('rewrites vendor/optimizer syntax the parser rejects', () => {
			const out = transformSqlForMySQL({
				sql: 'select id from t where rank = 1 and n = "bob"',
			});
			expect(out.rewrites).to.equal(1);
			expect(out.sql).to.contain("= 'bob'");
		});
	});

	describe('source fidelity: only the literals change', () => {
		it('preserves whitespace, case and layout byte-for-byte outside the literal', () => {
			const out = transformSqlForMySQL({
				sql: 'select  *\n  from  `t`\n  where  a  =  "x"',
			});
			expect(out.sql).to.equal("select  *\n  from  `t`\n  where  a  =  'x'");
		});

		it('does not touch a double quote inside a SINGLE-quoted string', () => {
			const sql = 'select * from t where a = \'say "hi"\'';
			const out = transformSqlForMySQL({ sql });
			expect(out.sql).to.equal(sql);
			expect(out.rewrites).to.equal(0);
		});

		it('does not touch a double quote inside a BACKTICKED identifier', () => {
			const sql = 'select `we"ird` from t';
			const out = transformSqlForMySQL({ sql });
			expect(out.sql).to.equal(sql);
			expect(out.rewrites).to.equal(0);
		});

		it('returns malformed SQL with an unterminated string untouched', () => {
			const sql = 'select * from t where a = "oops';
			const out = transformSqlForMySQL({ sql });
			expect(out.sql).to.equal(sql);
			expect(out.mode).to.equal('unterminated');
		});

		it('returns malformed SQL with an unterminated block comment untouched', () => {
			const sql = 'select * from t /* oops where a = "x"';
			const out = transformSqlForMySQL({ sql });
			expect(out.sql).to.equal(sql);
			expect(out.mode).to.equal('unterminated');
		});
	});

	describe('MySQLDialect.transformSql() wiring', () => {
		// These are the tests that FAIL against unfixed yass-orm, where
		// transformSql was `return sql;`.
		const dialect = new MySQLDialect();

		it('normalizes double-quoted literals through the dialect chokepoint', () => {
			const out = dialect.transformSql(
				'select * from t where n like "upm%"',
				{},
			);
			expect(out).to.not.contain('"');
			expect(out).to.contain("like 'upm%'");
		});

		it('still returns a plain string (dbh.js pquery contract)', () => {
			expect(dialect.transformSql('select 1', {})).to.be.a('string');
		});

		it('leaves double-quote-free SQL untouched', () => {
			const sql = "select * from `t` where a = 'x'";
			expect(dialect.transformSql(sql, {})).to.equal(sql);
		});
	});
});
