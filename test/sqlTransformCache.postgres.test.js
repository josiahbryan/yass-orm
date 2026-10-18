/* global describe, it, before, beforeEach, afterEach, after */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { Parser } = require('node-sql-parser');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { PostgresDialect } = require('../lib/dialects/PostgresDialect');
const {
	transformSqlForPostgres,
} = require('../lib/sql-transform/PostgresSqlTransformer');
const {
	createTransformCache,
	DEFAULT_TRANSFORM_CACHE_SIZE,
} = require('../lib/sql-transform/transformCache');
const { isPostgres } = require('./helpers/characterize');

/**
 * The Postgres statement translator is memoized on (params shape, SQL text).
 * Runs against a live Postgres in `npm run test:postgres`: the dialect is the
 * real one and the last test runs a query through a live connection.
 */
describe('Postgres SQL translation cache', function suite() {
	this.timeout(30000);

	const dialect = new PostgresDialect();
	let savedSize;
	let astifyCalls;
	let realAstify;

	before(() => {
		savedSize = config.sqlTransformCacheSize;
	});

	beforeEach(() => {
		// Count real parses: the cache exists to avoid them.
		astifyCalls = 0;
		realAstify = Parser.prototype.astify;
		Parser.prototype.astify = function countingAstify(...args) {
			astifyCalls += 1;
			return realAstify.apply(this, args);
		};
		config.sqlTransformCacheSize = 1000;
		// Fresh entries per test: the dialect's cache is module level.
		dialect.transformSql('SELECT 1', {});
	});

	afterEach(() => {
		Parser.prototype.astify = realAstify;
	});

	after(() => {
		config.sqlTransformCacheSize = savedSize;
	});

	// Each test uses its own statement texts, so no test depends on another's
	// entries.
	it('parses a statement once however often it is translated', () => {
		const sql = 'SELECT * FROM cachetest_once WHERE id = :id';
		const first = dialect.transformSql(sql, { id: 1 });
		const parsesForFirst = astifyCalls;
		expect(parsesForFirst).to.be.greaterThan(0);
		for (let i = 0; i < 50; i += 1) {
			expect(dialect.transformSql(sql, { id: i })).to.deep.equal(first);
		}
		expect(astifyCalls).to.equal(parsesForFirst);
	});

	it('does not key on param VALUES', () => {
		const sql = 'SELECT * FROM cachetest_values WHERE a = :a AND b = :b';
		const out1 = dialect.transformSql(sql, { a: 'x', b: 1 });
		const parses = astifyCalls;
		const out2 = dialect.transformSql(sql, { a: 99, b: null });
		expect(astifyCalls).to.equal(parses);
		expect(out2).to.deep.equal(out1);
	});

	it('keeps separate entries for different param shapes', () => {
		const sql = 'SELECT * FROM cachetest_shapes WHERE a = :a OR b = :b';
		const both = dialect.transformSql(sql, { a: 1, b: 2 });
		const onlyA = dialect.transformSql(sql, { a: 1 });
		expect(both.paramOrder).to.deep.equal(['a', 'b']);
		expect(onlyA.paramOrder).to.deep.equal(['a']);
		expect(both.sql).to.not.equal(onlyA.sql);

		// `?` is a placeholder only for a non-empty array: otherwise the jsonb
		// operator.
		const qSql = 'SELECT * FROM cachetest_shapes WHERE a = ? AND b = ?';
		const positional = dialect.transformSql(qSql, [1, 2]);
		const empty = dialect.transformSql(qSql, []);
		expect(positional.sql).to.include('$1');
		expect(empty.sql).to.not.include('$1');
		// And each comes back the same on the second ask.
		expect(dialect.transformSql(qSql, [3, 4])).to.deep.equal(positional);
		expect(dialect.transformSql(qSql, [])).to.deep.equal(empty);
	});

	it('hands out copies: editing a result does not change the next one', () => {
		const sql = 'SELECT * FROM cachetest_copy WHERE a = :a AND b = :b';
		const first = dialect.transformSql(sql, { a: 1, b: 2 });
		const pristine = JSON.parse(JSON.stringify(first));
		first.sql = 'DROP TABLE x';
		first.paramOrder.push('zzz');
		first.paramOrder.reverse();
		const second = dialect.transformSql(sql, { a: 1, b: 2 });
		expect(JSON.parse(JSON.stringify(second))).to.deep.equal(pristine);
		second.paramOrder.pop();
		expect(dialect.transformSql(sql, { a: 1, b: 2 }).paramOrder).to.deep.equal(
			pristine.paramOrder,
		);
	});

	it('can be turned off: size 0 parses every time', () => {
		config.sqlTransformCacheSize = 0;
		const sql = 'SELECT * FROM cachetest_off WHERE id = :id';
		dialect.transformSql(sql, { id: 1 });
		const parses = astifyCalls;
		dialect.transformSql(sql, { id: 1 });
		expect(astifyCalls).to.equal(parses * 2);
	});

	describe('createTransformCache()', () => {
		const counting = (maxEntries) => {
			let calls = 0;
			const cache = createTransformCache({
				dialect: 'postgres',
				transform: ({ sql }) => {
					calls += 1;
					return { sql: sql.toUpperCase(), paramOrder: [] };
				},
				getMaxEntries: () => maxEntries,
			});
			return { cache, calls: () => calls };
		};

		it('uses a named default size', () => {
			expect(DEFAULT_TRANSFORM_CACHE_SIZE).to.be.a('number');
			let calls = 0;
			const cache = createTransformCache({
				dialect: 'postgres',
				transform: () => {
					calls += 1;
					return { sql: 'x', paramOrder: [] };
				},
			});
			cache({ sql: 'a' });
			cache({ sql: 'a' });
			expect(calls).to.equal(1);
		});

		it('evicts the least recently used entry at its bound', () => {
			const { cache, calls } = counting(3);
			['a', 'b', 'c'].forEach((sql) => cache({ sql }));
			expect(calls()).to.equal(3);
			expect(cache.size()).to.equal(3);

			cache({ sql: 'a' }); // a is now the most recent; b the oldest
			expect(calls()).to.equal(3);

			cache({ sql: 'd' }); // evicts b
			expect(cache.size()).to.equal(3);
			expect(calls()).to.equal(4);

			cache({ sql: 'a' });
			cache({ sql: 'c' });
			cache({ sql: 'd' });
			expect(calls()).to.equal(4); // all still cached

			cache({ sql: 'b' }); // was evicted: translated again
			expect(calls()).to.equal(5);
			expect(cache.size()).to.equal(3);
		});

		it('never grows past a bound of 1', () => {
			const { cache } = counting(1);
			['a', 'b', 'c'].forEach((sql) => cache({ sql }));
			expect(cache.size()).to.equal(1);
		});

		it('shrinking the bound takes effect on the next miss', () => {
			let max = 5;
			const cache = createTransformCache({
				dialect: 'postgres',
				transform: ({ sql }) => ({ sql, paramOrder: [] }),
				getMaxEntries: () => max,
			});
			['a', 'b', 'c', 'd'].forEach((sql) => cache({ sql }));
			max = 2;
			cache({ sql: 'e' });
			expect(cache.size()).to.equal(2);
		});

		it('never caches a translation that threw', () => {
			let calls = 0;
			const cache = createTransformCache({
				dialect: 'postgres',
				transform: () => {
					calls += 1;
					if (calls === 1) throw new Error('boom');
					return { sql: 'ok', paramOrder: [] };
				},
				getMaxEntries: () => 10,
			});
			expect(() => cache({ sql: 'x' })).to.throw('boom');
			expect(cache.size()).to.equal(0);
			expect(cache({ sql: 'x' }).sql).to.equal('ok');
			expect(calls).to.equal(2);
		});

		it('separates entries by params shape, not by SQL concatenation', () => {
			const { cache, calls } = counting(10);
			cache({ sql: 'S', params: { a: 1 } });
			cache({ sql: 'S', params: { b: 1 } });
			cache({ sql: 'S', params: [] });
			cache({ sql: 'S', params: [1] });
			cache({ sql: 'S' });
			cache({ sql: 'S', params: {} }); // same shape as no params
			expect(calls()).to.equal(5);
		});
	});

	describe('output is byte-identical with the cache on and off', () => {
		// The corpus: every SQL string in the transformer's own unit tests.
		const source = fs.readFileSync(
			path.join(
				__dirname,
				'../lib/sql-transform/test/PostgresSqlTransformer.test.js',
			),
			'utf8',
		);
		const corpus = [
			...new Set(
				[...source.matchAll(/(['`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)]
					.map((m) => m[2].replace(/\\'/g, "'"))
					.filter((s) =>
						/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE)\b/i.test(s),
					),
			),
		];
		const paramSets = [
			undefined,
			{},
			{ id: 1, name: 'n', x: 2, y: 3, a: 4, b: 5, limit: 6 },
			[],
			[1, 2, 3],
		];

		it('has a real corpus', () => {
			expect(corpus.length).to.be.greaterThan(30);
		});

		it('matches an uncached translation, cold and warm', () => {
			let compared = 0;
			corpus.forEach((sql) => {
				paramSets.forEach((params) => {
					let expected;
					let threw;
					try {
						expected = transformSqlForPostgres({ sql, params });
					} catch (e) {
						threw = e.message;
					}
					const compare = () => {
						if (threw) {
							expect(() => dialect.transformSql(sql, params)).to.throw(threw);
						} else {
							const got = dialect.transformSql(sql, params);
							// `error` is an Error: compare by message.
							const norm = (r) =>
								JSON.stringify({ ...r, error: r.error && r.error.message });
							expect(norm(got), sql).to.equal(norm(expected));
						}
					};
					compare(); // cold
					compare(); // warm
					compared += 1;
				});
			});
			expect(compared).to.equal(corpus.length * paramSets.length);
		});
	});

	describe('through a live connection', () => {
		it('runs the same query repeatedly with different values', async () => {
			if (!isPostgres()) return;
			const conn = await dbh();
			for (let i = 1; i <= 5; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				const rows = await conn.pquery('SELECT :a AS a, :b AS b', {
					a: i,
					b: `v${i}`,
				});
				expect(`${rows[0].a}`).to.equal(`${i}`);
				expect(rows[0].b).to.equal(`v${i}`);
			}
		});
	});
});
