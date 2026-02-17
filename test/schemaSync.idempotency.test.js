/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

describe('#schemaSync idempotency regression', () => {
	const tableName = `yass_schema_sync_regression_${uuid().replace(/-/g, '')}`;
	const indexTextName = 'idx_action_text';
	const indexJsonName = 'idx_meta_valence';
	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			action: t.text,
			meta: t.text,
		},
		options: {
			indexes: {
				[indexTextName]: ['action'],
				[indexJsonName]: ['meta->>"valence"'],
			},
		},
	});

	before(async () => {
		const schema = YassORM.convertDefinition(schemaDef);
		await syncSchemaToDb(schema);
	});

	it('should not recreate equivalent indexes on second sync', async () => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
			origLog(...args);
		};

		try {
			const schema = YassORM.convertDefinition(schemaDef);
			await syncSchemaToDb(schema);
		} finally {
			console.log = origLog;
		}

		const recreateLines = logs.filter((line) =>
			line.includes('Debug: (re)Creating index'),
		);
		const recreatedTargetIndexes = recreateLines.filter(
			(line) => line.includes(`'${indexTextName}'`) || line.includes(`'${indexJsonName}'`),
		);
		expect(recreatedTargetIndexes).to.deep.equal([]);
	});

	after(async () => {
		// Clean up table after regression test
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});
});
