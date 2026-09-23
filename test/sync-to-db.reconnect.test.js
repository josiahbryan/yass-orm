/* global describe, it, after */
const { expect } = require('chai');

const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

/**
 * Schema sync caches its handle in lib/sync-to-db.js. Before step 7 that
 * handle stayed closed after closeAllConnections(), so every later
 * syncSchemaToDb() failed with "pool is closed" (known bug 13; the model half
 * is in test/obj.characterize.contract.test.js).
 */
describe('#syncSchemaToDb after closeAllConnections()', function reconnectSuite() {
	this.timeout(30000);

	const schema = () =>
		YassORM.convertDefinition(({ types: t }) => ({
			table: 'yass_sync_reconnect',
			schema: { id: t.idKey, name: t.string },
		}));

	after(async () => {
		await (await dbh()).pquery('drop table if exists yass_sync_reconnect');
	});

	it('works again after closeAllConnections()', async () => {
		expect((await syncSchemaToDb(schema())).errors).to.deep.equal([]);
		await YassORM.closeAllConnections();
		expect((await syncSchemaToDb(schema())).errors).to.deep.equal([]);
	});
});
