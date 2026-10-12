/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// A binary column declared as a MySQL blob type (`t.string({ type: 'longblob' })`) is `bytea` on Postgres. The column
// comparator had no rule for that pair, so every sync on Postgres re-ran `ALTER COLUMN ... TYPE BYTEA` (and its
// nullability) under an ACCESS EXCLUSIVE lock, on every boot of every service, forever. Found by Tessera's test
// harness, which refuses a schema change in a database that was already synced. A second sync must change nothing, on
// every dialect. (`tinyblob` and `mediumblob` are made TEXT on Postgres today, a separate, breaking fix: not here.)
describe('#schemaSync a blob-typed column is stable across syncs', () => {
	const tableName = `yass_blob_${uuid().replace(/-/g, '').slice(0, 20)}`;
	const def = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.uuidKey,
			whole: t.string({ type: 'blob' }),
			large: t.string({ type: 'longblob' }),
			optional: t.string({ type: 'longblob' }).nullable(),
		},
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS ${conn.dialect?.quoteIdentifier ? conn.dialect.quoteIdentifier(tableName) : tableName}`);
		await conn.end();
	});

	it('creates the table, then a second sync applies nothing', async () => {
		const first = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(first.errors || []).to.deep.equal([]);
		const second = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(second.errors || []).to.deep.equal([]);
		expect(second.applied).to.equal(0);
	});
});
