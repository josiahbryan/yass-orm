/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');

// A collation's name, through dbh.pquery, against a live Postgres. The SQL
// transformer round-trips a query through node-sql-parser, which used to hand
// back `COLLATE "C"` as `COLLATE C`; Postgres folds that unquoted name to `c`
// and fails with `collation "c" does not exist`. SKIPPED on other dialects:
//
//   YASS_CONFIG=$PWD/.yass-orm.postgres.js npm run test:postgres

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

describe('#Postgres COLLATE through pquery', () => {
	const table = `pg_collate_${uuid().replace(/-/g, '')}`;
	// "C" sorts bytewise: every capital before every small letter.
	const names = ['apple', 'Banana', 'cherry'];
	const bytewiseOrder = ['Banana', 'apple', 'cherry'];
	let conn;

	before(async function beforeSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`CREATE TABLE "${table}" (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`,
		);
		await names.reduce(
			(prior, name) =>
				prior.then(() =>
					conn.pquery(`INSERT INTO "${table}" (name) VALUES (:name)`, {
						name,
					}),
				),
			Promise.resolve(),
		);
	});

	after(async () => {
		if (!conn) {
			return;
		}
		await conn.pquery(`DROP TABLE IF EXISTS "${table}"`);
		await conn.end();
	});

	it('orders by a quoted collation: ORDER BY name COLLATE "C"', async () => {
		const rows = await conn.pquery(
			`SELECT name FROM ${table} ORDER BY name COLLATE "C"`,
		);
		expect(rows.map((row) => row.name)).to.deep.equal(bytewiseOrder);
	});

	// Under "C" only the capitalized name sorts before 'a'; under a linguistic
	// collation none does. So a COLLATE on the placeholder that went missing
	// (it used to be dropped outright) returns no rows here.
	it('compares under a quoted collation: WHERE name < :bound COLLATE "C"', async () => {
		const rows = await conn.pquery(
			`SELECT name FROM ${table} WHERE name < :bound COLLATE "C"`,
			{ bound: 'a' },
		);
		expect(rows.map((row) => row.name)).to.deep.equal(['Banana']);
	});

	it('updates under a quoted collation: UPDATE ... WHERE name COLLATE "C" = :name', async () => {
		await conn.pquery(
			`UPDATE ${table} SET name = :renamed WHERE name COLLATE "C" = :name`,
			{ renamed: 'Blueberry', name: 'Banana' },
		);
		const rows = await conn.pquery(
			`SELECT name FROM ${table} WHERE name COLLATE "C" = :name`,
			{ name: 'Blueberry' },
		);
		expect(rows.map((row) => row.name)).to.deep.equal(['Blueberry']);
	});
});
