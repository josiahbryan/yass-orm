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
	// NOTE: Uses double-quoted JSON path syntax
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

	// Second table to test single-quoted JSON path syntax (the quote style used in real schemas)
	const tableName2 = `yass_schema_sync_regression_sq_${uuid().replace(/-/g, '')}`;
	const indexJsonSingleQuote = 'idx_data_count';
	// NOTE: Uses single-quoted JSON path syntax (like real-world schemas often do)
	const schemaDef2 = ({ types: t }) => ({
		table: tableName2,
		schema: {
			id: t.idKey,
			data: t.text,
		},
		options: {
			indexes: {
				[indexJsonSingleQuote]: ["data->>'$.count'"],
			},
		},
	});

	before(async () => {
		const schema = YassORM.convertDefinition(schemaDef);
		await syncSchemaToDb(schema);
		const schema2 = YassORM.convertDefinition(schemaDef2);
		await syncSchemaToDb(schema2);
	});

	it('should not recreate equivalent indexes on second sync (double-quote JSON path)', async () => {
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

	it('should not recreate equivalent indexes on second sync (single-quote JSON path)', async () => {
		// This test specifically covers the case where schema definitions use single-quoted
		// JSON accessor syntax like: data->>'$.count' (common in real-world schemas)
		// MySQL returns these as expanded json_extract() expressions, which must be
		// normalized to compare correctly against the schema-defined form.
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
			origLog(...args);
		};

		try {
			const schema2 = YassORM.convertDefinition(schemaDef2);
			await syncSchemaToDb(schema2);
		} finally {
			console.log = origLog;
		}

		const recreateLines = logs.filter((line) =>
			line.includes('Debug: (re)Creating index'),
		);
		const recreatedTargetIndexes = recreateLines.filter(
			(line) => line.includes(`'${indexJsonSingleQuote}'`),
		);
		expect(recreatedTargetIndexes).to.deep.equal([]);
	});

	after(async () => {
		// Clean up tables after regression test
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName2}\``);
		await conn.end();
	});
});
