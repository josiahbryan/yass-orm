/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// A def's `.nullable()` stores `null: 1` (a NUMBER). Syncing it against a column the database has as NOT NULL reached
// the comparator's "users don't uppercase NOT NULL" carve-out, which called `bk.toUpperCase()` on that number and threw
// TypeError: the whole table's sync failed. Making a NOT NULL column nullable must just work, on every dialect.
describe('#schemaSync a nullable def against a NOT NULL column', () => {
	const tableName = `yass_nullable_${uuid().replace(/-/g, '').slice(0, 20)}`;
	const def = (notes) => ({ types: t }) => ({ table: tableName, schema: { id: t.uuidKey, notes: notes(t) } });

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS ${conn.dialect?.quoteIdentifier ? conn.dialect.quoteIdentifier(tableName) : tableName}`);
		await conn.end();
	});

	it('syncs without a TypeError, and the column then takes a NULL', async () => {
		// A default makes the column NOT NULL (`null: 0`).
		await syncSchemaToDb(YassORM.convertDefinition(def((t) => t.string.default('none'))));
		await syncSchemaToDb(YassORM.convertDefinition(def((t) => t.string.nullable())));
		const conn = await dbh({ ignoreCachedConnections: true });
		const q = (name) => (conn.dialect?.quoteIdentifier ? conn.dialect.quoteIdentifier(name) : name);
		await conn.pquery(`INSERT INTO ${q(tableName)} (${q('id')}, ${q('notes')}) VALUES (:id, NULL)`, { id: uuid() });
		const rows = await conn.pquery(`SELECT ${q('notes')} AS notes FROM ${q(tableName)}`);
		await conn.end();
		expect(rows.map((r) => r.notes)).to.deep.equal([null]);
	});
});
