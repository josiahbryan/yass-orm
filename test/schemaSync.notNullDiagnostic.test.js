/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');

const {
	buildNotNullBackfillDiagnostic,
	mapDatabaseColumnTypeToSchemaType,
	syncSchemaToDb,
} = require('../lib/sync-to-db');

describe('#schemaSync database type inference', () => {
	it('maps database bigint columns back to t.bigint', () => {
		expect(mapDatabaseColumnTypeToSchemaType({ type: 'bigint' })).to.equal(
			't.bigint',
		);
		expect(mapDatabaseColumnTypeToSchemaType({ type: 'bigint(20)' })).to.equal(
			't.bigint',
		);
	});
});

describe('#schemaSync NOT NULL diagnostics', () => {
	it('explains nullable-to-required alters blocked by existing NULL rows', () => {
		const message = buildNotNullBackfillDiagnostic({
			tableSqlName: '`ai_agent_memories`',
			fieldName: 'confidence',
			nullRowCount: 1317520,
			defaultValue: 0.5,
			alterSql:
				"ALTER TABLE `ai_agent_memories` CHANGE `confidence` `confidence` double NOT NULL DEFAULT '0.5'",
		});

		expect(message).to.include(
			'Cannot make `ai_agent_memories`.`confidence` NOT NULL',
		);
		expect(message).to.include(
			'1,317,520 existing rows where `confidence` IS NULL',
		);
		expect(message).to.include(
			'UPDATE `ai_agent_memories` SET `confidence` = 0.5 WHERE `confidence` IS NULL;',
		);
		expect(message).to.include(
			"ALTER TABLE `ai_agent_memories` CHANGE `confidence` `confidence` double NOT NULL DEFAULT '0.5'",
		);
	});

	it('avoids suggesting a destructive placeholder when no default is available', () => {
		const message = buildNotNullBackfillDiagnostic({
			tableSqlName: '`accounts`',
			fieldName: 'externalId',
			nullRowCount: 2,
			defaultValue: undefined,
			alterSql:
				'ALTER TABLE `accounts` CHANGE `externalId` `externalId` varchar(255) NOT NULL',
		});

		expect(message).to.include(
			'Backfill those rows with the intended value before rerunning schema-sync.',
		);
		expect(message).to.not.include('SET `externalId` =');
	});
});

describe('#schemaSync NOT NULL alter preflight', () => {
	const tableName = `yass_not_null_diag_${uuid().replace(/-/g, '')}`;

	const nullableSchema = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			confidence: t.float.nullable(),
		},
	});

	const requiredSchema = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			confidence: t.float.default(0.5),
		},
	});

	before(function beforeNotNullPreflightSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('reports the NULL backfill needed before making an existing column required', async () => {
		const nullableModel = YassORM.convertDefinition(nullableSchema);
		await syncSchemaToDb(nullableModel);

		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`INSERT INTO \`${tableName}\` (\`confidence\`) VALUES (NULL)`,
		);
		await conn.end();

		const errors = [];
		const origError = console.error;
		console.error = (...args) => {
			errors.push(args.join(' '));
			origError(...args);
		};

		try {
			const requiredModel = YassORM.convertDefinition(requiredSchema);
			await syncSchemaToDb(requiredModel);
		} finally {
			console.error = origError;
		}

		const output = errors.join('\n');
		expect(output).to.include(
			`Cannot make \`${tableName}\`.\`confidence\` NOT NULL`,
		);
		expect(output).to.include('1 existing rows where `confidence` IS NULL');
		expect(output).to.include(
			`UPDATE \`${tableName}\` SET \`confidence\` = 0.5 WHERE \`confidence\` IS NULL;`,
		);

		const verifyConn = await dbh({ ignoreCachedConnections: true });
		const [columnBeforeBackfill] = await verifyConn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = 'confidence'`,
		);
		expect(columnBeforeBackfill.Null).to.equal('YES');

		await verifyConn.pquery(
			`UPDATE \`${tableName}\` SET \`confidence\` = 0.5 WHERE \`confidence\` IS NULL`,
		);
		await verifyConn.end();

		const requiredModel = YassORM.convertDefinition(requiredSchema);
		await syncSchemaToDb(requiredModel);

		const finalConn = await dbh({ ignoreCachedConnections: true });
		const [columnAfterBackfill] = await finalConn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = 'confidence'`,
		);
		await finalConn.end();

		expect(columnAfterBackfill.Null).to.equal('NO');
		expect(columnAfterBackfill.Default).to.equal('0.5');
	});
});
