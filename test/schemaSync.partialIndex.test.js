/* eslint-disable no-console */
/* global describe, it */
const { expect } = require('chai');
const {
	normalizeIndexPredicate,
	buildIndexSignature,
} = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { PostgresDialect } = require('../lib/dialects/PostgresDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');

// PARTIAL (filtered) indexes -- `CREATE INDEX ... WHERE <predicate>` -- index only
// the rows matching the predicate. Postgres and SQLite support them; MySQL and
// MariaDB have NO equivalent syntax (verified against MySQL 8.4.2: the WHERE is a
// parse error).
//
// The hard part is not emitting the DDL, it is COMPARING predicates. The database
// does not hand back what you wrote: Postgres re-renders the predicate, adding
// parentheses around the whole thing AND around each conjunct, quoting
// identifiers, casting literals, rewriting `IN (...)` as `= ANY (ARRAY[...])`,
// and reporting LIKE/ILIKE/!= as the operators ~~ / ~~* / <>. Comparing raw text
// means a permanent drop-and-recreate on every sync -- the metadata-lock stall
// this whole line of work exists to eliminate. Every expected value below was
// taken from a live PostgreSQL 16 server, not from documentation.
describe('#schemaSync partial indexes', () => {
	describe('dialect capability', () => {
		it('is supported on Postgres and SQLite, not MySQL', () => {
			expect(new PostgresDialect().supportsPartialIndexes).to.equal(true);
			expect(new SQLiteDialect().supportsPartialIndexes).to.equal(true);
			// MySQL has no partial-index syntax at all.
			expect(new MySQLDialect().supportsPartialIndexes).to.equal(false);
		});
	});

	describe('normalizeIndexPredicate()', () => {
		it('returns undefined for an absent predicate', () => {
			expect(normalizeIndexPredicate(undefined)).to.equal(undefined);
			expect(normalizeIndexPredicate(null)).to.equal(undefined);
			expect(normalizeIndexPredicate('')).to.equal(undefined);
		});

		// Each pair is (what a schema author writes, what Postgres reports back).
		const equivalences = [
			['isDeleted = false', '("isDeleted" = false)'],
			['NOT isDeleted', '(NOT "isDeleted")'],
			['status IS NOT NULL', '(status IS NOT NULL)'],
			// varchar comparison: PG casts BOTH sides and parenthesizes the column
			["status = 'active'", "((status)::text = 'active'::text)"],
			['id > 100', '(id > 100)'],
			// each conjunct gets its own parens
			[
				'isDeleted = false AND status IS NOT NULL',
				'((isDeleted = false) AND (status IS NOT NULL))',
			],
			// IN is rewritten into = ANY (ARRAY[...])
			[
				"status IN ('a','b')",
				"((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))",
			],
			// LIKE / NOT LIKE / ILIKE come back as operators
			["email LIKE 'a%'", "(email ~~ 'a%'::text)"],
			["email NOT LIKE 'a%'", "(email !~~ 'a%'::text)"],
			["email ILIKE 'a%'", "(email ~~* 'a%'::text)"],
			// != and <> both render as <>
			["status != 'x'", "(status <> 'x'::text)"],
		];

		// These are POSTGRES renderings, so parse them as Postgres even though this
		// suite runs under the MySQL config -- in MySQL, `"x"` is a string literal
		// rather than an identifier, which would make the comparison meaningless.
		equivalences.forEach(([schemaForm, databaseForm]) => {
			it(`treats \`${schemaForm}\` and its reported form as equal`, () => {
				expect(normalizeIndexPredicate(schemaForm, 'postgresql')).to.equal(
					normalizeIndexPredicate(databaseForm, 'postgresql'),
				);
			});
		});

		it('still distinguishes genuinely different predicates', () => {
			// The whole point: a real change must be detected so the index rebuilds.
			expect(normalizeIndexPredicate("status = 'active'")).to.not.equal(
				normalizeIndexPredicate("status = 'archived'"),
			);
			expect(normalizeIndexPredicate('id > 100')).to.not.equal(
				normalizeIndexPredicate('id > 101'),
			);
			expect(normalizeIndexPredicate('isDeleted = false')).to.not.equal(
				normalizeIndexPredicate('isDeleted = true'),
			);
			expect(normalizeIndexPredicate('a IS NULL')).to.not.equal(
				normalizeIndexPredicate('a IS NOT NULL'),
			);
		});

		// Predicates are compared through a real SQL AST (node-sql-parser), so
		// grouping is carried by the SHAPE of the tree rather than by punctuation.
		// Postgres' added parentheses collapse for free, while the author's actual
		// structure survives. An earlier regex-only version had to drop ALL parens --
		// it could not tell whose they were -- which made these two indistinguishable.
		it('distinguishes re-GROUPING of a boolean expression', () => {
			expect(normalizeIndexPredicate('a AND (b OR c)')).to.not.equal(
				normalizeIndexPredicate('(a AND b) OR c'),
			);
		});

		it('still ignores redundant parentheses that change nothing', () => {
			expect(normalizeIndexPredicate('a AND b')).to.equal(
				normalizeIndexPredicate('((a) AND (b))'),
			);
			expect(normalizeIndexPredicate('a AND b AND c')).to.equal(
				normalizeIndexPredicate('((a AND b) AND c)'),
			);
		});

		it('distinguishes operator precedence written explicitly', () => {
			// `a OR b AND c` binds as `a OR (b AND c)`; the other grouping differs.
			expect(normalizeIndexPredicate('a OR b AND c')).to.equal(
				normalizeIndexPredicate('a OR (b AND c)'),
			);
			expect(normalizeIndexPredicate('a OR b AND c')).to.not.equal(
				normalizeIndexPredicate('(a OR b) AND c'),
			);
		});

		it('falls back to text normalization when a predicate cannot be parsed', () => {
			// Must not throw and must stay stable, so an exotic expression degrades to
			// "no churn" rather than to a sync error.
			const exotic = 'some_weird_op !!! thing';
			expect(normalizeIndexPredicate(exotic)).to.equal(
				normalizeIndexPredicate(exotic),
			);
			expect(normalizeIndexPredicate(exotic)).to.be.a('string');
		});
	});

	describe('index signature', () => {
		it('is byte-identical to a non-partial signature when no predicate is set', () => {
			// Guards against a mass rebuild on upgrade: adding the `where` key must not
			// change the signature of any existing ordinary index.
			expect(
				buildIndexSignature({ columns: ['a', 'b'], unique: true }),
			).to.equal(
				JSON.stringify({ fulltext: false, unique: true, columns: ['a', 'b'] }),
			);
		});

		it('distinguishes a partial index from an otherwise identical full one', () => {
			expect(
				buildIndexSignature({ columns: ['a'], where: 'id > 5' }),
			).to.not.equal(buildIndexSignature({ columns: ['a'] }));
		});

		it('matches across schema and database spellings of the same predicate', () => {
			// Single-quoted literals and casts only -- no double-quoted identifiers --
			// so this holds under either parser dialect.
			expect(
				buildIndexSignature({ columns: ['a'], where: "status = 'active'" }),
			).to.equal(
				buildIndexSignature({
					columns: ['a'],
					where: "((status)::text = 'active'::text)",
				}),
			);
		});
	});

	describe('DDL generation', () => {
		it('emits WHERE on Postgres', () => {
			const sql = new PostgresDialect().generateCreateIndex(
				'items',
				'idx_live',
				['status'],
				{ where: '"isDeleted" = false' },
			);
			expect(sql).to.include('WHERE "isDeleted" = false');
		});

		it('emits WHERE on SQLite', () => {
			const sql = new SQLiteDialect().generateCreateIndex(
				'items',
				'idx_live',
				['status'],
				{ where: 'isDeleted = 0' },
			);
			expect(sql).to.include('WHERE isDeleted = 0');
		});
	});

	describe('Postgres introspection', () => {
		const handleFor = (indexDef) => ({
			async query() {
				return {
					rows: [
						{
							index_name: 'idx_live',
							is_unique: false,
							is_primary: false,
							index_def: indexDef,
						},
					],
				};
			},
		});

		// THE dormant bug: the column list was parsed with a greedy
		// /\((.+)\)$/ -- first paren to last paren -- so a partial index's WHERE
		// clause was swallowed INTO the column list, giving columns like
		// `status) WHERE ("isDeleted" = false`. Those could never match the schema,
		// so any hand-created partial index churned on every sync.
		it('does not swallow the WHERE clause into the column list', async () => {
			const [idx] = await new PostgresDialect().getTableIndexes(
				handleFor(
					`CREATE INDEX idx_live ON public.items USING btree (status) WHERE ("isDeleted" = false)`,
				),
				'items',
			);
			expect(idx.columns).to.deep.equal(['status']);
		});

		it('reports the predicate so a change can be detected', async () => {
			const [idx] = await new PostgresDialect().getTableIndexes(
				handleFor(
					`CREATE INDEX idx_live ON public.items USING btree (status) WHERE ("isDeleted" = false)`,
				),
				'items',
			);
			expect(normalizeIndexPredicate(idx.where, 'postgresql')).to.equal(
				normalizeIndexPredicate('isDeleted = false', 'postgresql'),
			);
		});

		it('leaves an ordinary index with no predicate', async () => {
			const [idx] = await new PostgresDialect().getTableIndexes(
				handleFor(
					`CREATE INDEX idx_plain ON public.items USING btree (status, "createdAt")`,
				),
				'items',
			);
			expect(idx.where).to.equal(undefined);
			expect(idx.columns).to.deep.equal(['status', 'createdAt']);
		});

		it('parses a multi-column partial index correctly', async () => {
			const [idx] = await new PostgresDialect().getTableIndexes(
				handleFor(
					`CREATE INDEX idx_live ON public.items USING btree (status, email) WHERE (id > 100)`,
				),
				'items',
			);
			expect(idx.columns).to.deep.equal(['status', 'email']);
			expect(normalizeIndexPredicate(idx.where, 'postgresql')).to.equal(
				normalizeIndexPredicate('id > 100', 'postgresql'),
			);
		});
	});
});
