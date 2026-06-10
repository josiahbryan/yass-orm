/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// Regression test for the errno 1170 schema-sync failure:
//   "BLOB/TEXT column 'X' used in key specification without a key length"
//
// Repro: a column starts life as an indexed VARCHAR (the index has no prefix
// length, which is legal for varchar). A later schema revision changes the
// column to t.text (longtext). schema-sync emits `CHANGE COLUMN ... longtext`
// in the column-diff pass, which runs BEFORE the index-reconciliation pass --
// so the old prefix-less index is still attached when the column flips to TEXT.
// MySQL (and Vitess/PlanetScale) reject that with errno 1170, because a TEXT
// column cannot participate in a key without a prefix length.
//
// Contract: schema-sync MUST drop the conflicting prefix-less index before the
// CHANGE COLUMN, then the index pass recreates it with the implicit (255)
// prefix. The end state is a longtext column with a working prefixed index, and
// zero sync errors. Observed on the CI bastion's PlanetScale sub-sync against
// `ai_dataset_items.sourceUrl` and `messages.channelMessageId` (2026-06-10).

describe('#schemaSync indexed varchar -> text reindex', () => {
	const tableName = `yass_text_reindex_${uuid().replace(/-/g, '')}`;

	const varcharIndexedSchema = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			sourceUrl: t.string,
		},
		indexes: {
			sourceUrl: ['sourceUrl'],
		},
	});

	const textIndexedSchema = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			sourceUrl: t.text,
		},
		indexes: {
			sourceUrl: ['sourceUrl'],
		},
	});

	before(function beforeTextReindexSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('flips an indexed varchar column to longtext without errno 1170', async () => {
		// 1) Establish the drifted state: indexed varchar (prefix-less index).
		await syncSchemaToDb(YassORM.convertDefinition(varcharIndexedSchema));

		const conn = await dbh({ ignoreCachedConnections: true });
		const [colBefore] = await conn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = 'sourceUrl'`,
		);
		expect(colBefore.Type.toLowerCase()).to.match(/varchar/);
		await conn.end();

		// 2) Apply the revision that turns the indexed column into TEXT.
		const result = await syncSchemaToDb(
			YassORM.convertDefinition(textIndexedSchema),
		);

		// 3) No sync errors (the errno 1170 would land here before the fix).
		expect(
			result.errors,
			`expected zero sync errors, got: ${JSON.stringify(result.errors)}`,
		).to.have.length(0);
		expect(result.failed).to.equal(0);

		// 4) Column is now longtext and the index still exists (prefixed).
		const verifyConn = await dbh({ ignoreCachedConnections: true });
		const [colAfter] = await verifyConn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = 'sourceUrl'`,
		);
		expect(colAfter.Type.toLowerCase()).to.match(/text/);

		const indexRows = await verifyConn.pquery(
			`SHOW INDEX FROM \`${tableName}\` WHERE Key_name = 'sourceUrl'`,
		);
		await verifyConn.end();

		expect(
			indexRows.length,
			'sourceUrl index should still exist after the text conversion',
		).to.be.greaterThan(0);
		// A TEXT-column index requires a prefix length.
		expect(indexRows[0].Sub_part).to.be.a('number');
		expect(indexRows[0].Sub_part).to.be.greaterThan(0);
	});
});
