/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const {
	syncSchemaToDb,
	findMissingSchemaColumns,
} = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

// Regression test for the silent ADD-COLUMN drop observed on the CI bastion
// (2026-06-10): schema-sync logged `ALTER TABLE ... ADD agentPid`, the apply
// promise resolved with NO error, schema-sync reported "completed successfully"
// -- yet the column never persisted (the parallel sync worker's connection did
// not commit it under connection pressure). The gap surfaced one stage later as
// a confusing "Unknown column 'agentPid'" precommit failure.
//
// Contract: after applying its column alters, schema-sync MUST re-read the
// table and FAIL LOUD (record a sync error) for any column it just ADD/CHANGEd
// that is not actually present -- rather than silently reporting success.

describe('#schemaSync findMissingSchemaColumns', () => {
	it('returns ADD/CHANGE columns absent from the post-sync table', () => {
		const missing = findMissingSchemaColumns({
			existingColumns: [{ name: 'id' }, { name: 'sidecarPid' }],
			changedColumns: [
				{ col: 'sidecarPid', type: 'ADD' },
				{ col: 'agentPid', type: 'ADD' },
				{ col: 'staleCol', type: 'DROP' },
			],
		});
		expect(missing).to.deep.equal(['agentPid']);
	});

	it('ignores DROP columns and is case-insensitive', () => {
		const missing = findMissingSchemaColumns({
			existingColumns: [{ name: 'AgentPid' }],
			changedColumns: [
				{ col: 'agentPid', type: 'CHANGE' },
				{ col: 'goneCol', type: 'DROP' },
			],
		});
		expect(missing).to.deep.equal([]);
	});
});

describe('#schemaSync post-sync column verification', () => {
	const tableName = `yass_missing_col_${uuid().replace(/-/g, '')}`;

	const baseSchema = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey },
	});

	const withGhostSchema = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey, ghostColumn: t.int },
	});

	before(function beforeMissingColSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('fails loud when an ADD COLUMN silently does not persist', async () => {
		// 1) Create the table with just the id column.
		await syncSchemaToDb(YassORM.convertDefinition(baseSchema));

		// 2) Sabotage the ADD for ghostColumn so the apply "succeeds" (a valid
		//    no-op statement) but the column is never actually added -- exactly the
		//    silent-drop failure mode, deterministically.
		const originalGenerate = MySQLDialect.prototype.generateAlterAddColumn;
		MySQLDialect.prototype.generateAlterAddColumn = function patched(
			table,
			fieldData,
		) {
			if (fieldData && fieldData.field === 'ghostColumn') {
				return 'DO 1'; // valid MySQL no-op: resolves without error, adds nothing
			}
			return originalGenerate.call(this, table, fieldData);
		};

		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(withGhostSchema));
		} finally {
			MySQLDialect.prototype.generateAlterAddColumn = originalGenerate;
		}

		// 3) The silent drop must now surface as a real sync error.
		expect(
			result.errors,
			`expected a missing-column error, got: ${JSON.stringify(result.errors)}`,
		).to.have.length.greaterThan(0);
		const found = result.errors.some((e) =>
			/ghostColumn/.test(JSON.stringify(e)),
		);
		expect(found, 'expected an error mentioning ghostColumn').to.equal(true);
		expect(result.failed).to.be.greaterThan(0);

		// 4) Sanity: the column really is absent (proves we caught a real gap).
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = 'ghostColumn'`,
		);
		await conn.end();
		expect(rows.length).to.equal(0);
	});
});
