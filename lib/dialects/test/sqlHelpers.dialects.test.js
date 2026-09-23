/* global describe, it */
const { expect } = require('chai');
const { MySQLDialect } = require('../MySQLDialect');
const { PostgresDialect } = require('../PostgresDialect');
const { SQLiteDialect } = require('../SQLiteDialect');
const sql = require('../../sql-helpers');

/**
 * The SQL each dialect writes for finder.js and lib/sql-helpers.js. Unit
 * level: test/sql-helpers.test.js and test/finder.dialects.test.js run it
 * on live MySQL and Postgres.
 */
describe('dialect SQL for finder.js and the sql helpers', () => {
	const mysql = new MySQLDialect();
	const pg = new PostgresDialect();
	const sqlite = new SQLiteDialect();

	describe('quoteIdentifierOnce()', () => {
		it('quotes with the dialect quote, once', () => {
			expect(mysql.quoteIdentifierOnce('col')).to.equal('`col`');
			expect(pg.quoteIdentifierOnce('col')).to.equal('"col"');
			expect(sqlite.quoteIdentifierOnce('col')).to.equal('"col"');
			[mysql, pg, sqlite].forEach((d) => {
				const once = d.quoteIdentifierOnce('col');
				expect(d.quoteIdentifierOnce(once)).to.equal(once);
				const qualified = `${once}.${once}`;
				expect(d.quoteIdentifierOnce(qualified)).to.equal(qualified);
			});
		});

		it('drops a stray quote rather than doubling it (always one pair)', () => {
			expect(mysql.quoteIdentifierOnce('a`b')).to.equal('`ab`');
			expect(pg.quoteIdentifierOnce('a"b')).to.equal('"ab"');
			expect(mysql.quoteIdentifierOnce('t.c')).to.equal('`t.c`');
		});
	});

	it('limitSql(): MySQL keeps `LIMIT skip, limit`; the others LIMIT / OFFSET', () => {
		expect(mysql.limitSql(10, 20)).to.equal('LIMIT 20, 10');
		expect(mysql.limitSql('10')).to.equal('LIMIT 0, 10');
		expect(pg.limitSql(10, 20)).to.equal('LIMIT 10 OFFSET 20');
		expect(sqlite.limitSql(10)).to.equal('LIMIT 10 OFFSET 0');
	});

	it('ifNullSql() and toBooleanLiteral()', () => {
		expect(mysql.ifNullSql('x', "''")).to.equal("IFNULL(x,'')");
		expect(pg.ifNullSql('x', "''")).to.equal("COALESCE(x, '')");
		expect(mysql.toBooleanLiteral(false)).to.equal('0');
		expect(sqlite.toBooleanLiteral('true')).to.equal('1');
		expect(pg.toBooleanLiteral(0)).to.equal('false');
		expect(pg.toBooleanLiteral(1)).to.equal('true');
	});

	it('Postgres: a Date param is the ISO instant, whatever the session time zone', () => {
		const at = new Date('2026-01-02T03:04:05.678Z');
		expect(pg.deflateValue(at)).to.equal('2026-01-02T03:04:05.678Z');
		expect(pg.deflateValue(new Date('nope'))).to.equal(null);
		expect(pg.deflateValue(true)).to.equal(1);
		// MySQL keeps the whole-second UTC wall clock.
		expect(mysql.deflateValue(at)).to.equal('2026-01-02 03:04:05');
	});

	it('Postgres: `?` with an array of values becomes $1, $2 ... (not when the SQL has $N)', () => {
		const positional = pg.compileQuery(
			'SELECT * FROM `t` WHERE a = ? AND b = ?',
			[1, 'x'],
		);
		expect(positional.sql).to.match(/"?a"? = \$1 AND "?b"? = \$2$/);
		expect(positional.values).to.deep.equal([1, 'x']);
		expect(
			pg.compileQuery('SELECT * FROM t WHERE a = $1 AND j ? $2', [1, 'k']).sql,
		).to.match(/= \$1 AND "?j"? \? \$2$/);
		// A `$5` in a string literal is text, not a placeholder.
		expect(
			pg.compileQuery("SELECT * FROM t WHERE price = '$5' AND a = ?", [1]).sql,
		).to.match(/'\$5' AND "?a"? = \$1$/);
		const named = pg.compileQuery('SELECT * FROM t WHERE a = :a', { a: 1 });
		expect(named.sql).to.match(/= \$1$/);
		expect(named.values).to.deep.equal([1]);
	});

	describe('helpers', () => {
		const each = (fn) => ({
			mysql: fn(mysql),
			postgres: fn(pg),
			sqlite: fn(sqlite),
		});

		it('now()', () => {
			expect(each((d) => sql.now(d))).to.deep.equal({
				mysql: 'UTC_TIMESTAMP()',
				postgres: 'now()',
				sqlite: 'CURRENT_TIMESTAMP',
			});
		});

		it('addInterval() / subtractInterval()', () => {
			expect(
				each((d) => sql.addInterval(d, 'x', ':n', 'minutes')),
			).to.deep.equal({
				mysql: 'DATE_ADD(x, INTERVAL :n MINUTE)',
				postgres: '(x + make_interval(mins => :n))',
				sqlite: "datetime(x, '+' || (:n) || ' minutes')",
			});
			expect(
				each((d) => sql.subtractInterval(d, 'x', 2, 'WEEK')),
			).to.deep.equal({
				mysql: 'DATE_SUB(x, INTERVAL 2 WEEK)',
				postgres: '(x - make_interval(weeks => 2))',
				sqlite: "datetime(x, '-' || (2) * 7 || ' days')",
			});
			expect(() => sql.addInterval(mysql, 'x', 1, 'eon')).to.throw(/unit/);
		});

		it('nullSafeEqual() / nullSafeNotEqual()', () => {
			expect(each((d) => sql.nullSafeEqual(d, 'a', 'b'))).to.deep.equal({
				mysql: '(a <=> b)',
				postgres: '(a IS NOT DISTINCT FROM b)',
				sqlite: '(a IS b)',
			});
			expect(each((d) => sql.nullSafeNotEqual(d, 'a', 'b'))).to.deep.equal({
				mysql: 'NOT (a <=> b)',
				postgres: '(a IS DISTINCT FROM b)',
				sqlite: '(a IS NOT b)',
			});
		});

		it('nullsLast()', () => {
			expect(each((d) => sql.nullsLast(d, 'x', 'desc'))).to.deep.equal({
				mysql: 'x IS NULL, x DESC',
				postgres: 'x DESC NULLS LAST',
				sqlite: 'x DESC NULLS LAST',
			});
		});

		it('count()', () => {
			expect(each((d) => sql.count(d))).to.deep.equal({
				mysql: 'COUNT(*)',
				postgres: 'CAST(COUNT(*) AS INTEGER)',
				sqlite: 'COUNT(*)',
			});
		});

		it('forUpdate()', () => {
			expect(each((d) => sql.forUpdate(d, { noWait: true }))).to.deep.equal({
				mysql: 'FOR UPDATE NOWAIT',
				postgres: 'FOR UPDATE NOWAIT',
				sqlite: '',
			});
		});

		it('inList()', () => {
			expect(sql.inList('ids', new Set([1, 2]))).to.deep.equal({
				sql: 'IN (:ids_0, :ids_1)',
				params: { ids_0: 1, ids_1: 2 },
			});
			expect(sql.inList('ids', []).sql).to.equal('IN (NULL)');
		});

		it('refuses something that is neither a handle nor a dialect', () => {
			expect(() => sql.now({})).to.throw(TypeError);
		});

		it('upsertWhere(): a MySQL NOT NULL / foreign key error (SQLSTATE 23000 too) throws, not "the row exists"', async () => {
			const stub = (insertError) => {
				const db = {
					dialect: mysql,
					updates: 0,
					_buildInsertParts: () => ({
						tableSql: '`t`',
						columnsSql: '`k`',
						valuesSql: ':k',
					}),
					transaction: async () => {
						throw insertError;
					},
					pquery: async () => {
						db.updates += 1;
						return { affectedRows: 1 };
					},
				};
				return db;
			};
			const args = { values: { k: 1 }, conflictColumns: ['k'], update: ['k'] };
			const fk = Object.assign(new Error('fk'), {
				errno: 1452,
				sqlState: '23000',
			});
			const fkDb = stub(fk);
			const error = await sql.upsertWhere(fkDb, 't', args).catch((e) => e);
			expect(error).to.equal(fk);
			expect(fkDb.updates).to.equal(0);
			const dup = Object.assign(new Error('dup'), {
				errno: 1062,
				sqlState: '23000',
			});
			expect(await sql.upsertWhere(stub(dup), 't', args)).to.deep.equal({
				inserted: false,
				updated: true,
			});
		});
	});
});
