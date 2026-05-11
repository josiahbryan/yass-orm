/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

describe('#schemaSync error reporting', () => {
	const tableName = `yass_err_report_${uuid().replace(/-/g, '')}`;

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

	before(function beforeErrorReportingSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('returns a result object with applied=0/failed=0 when there is nothing to do', async () => {
		const model = YassORM.convertDefinition(nullableSchema);
		const result = await syncSchemaToDb(model);

		expect(result).to.be.an('object');
		expect(result.table).to.equal(tableName);
		expect(result.applied).to.be.a('number');
		expect(result.failed).to.equal(0);
		expect(result.errors).to.deep.equal([]);
	});

	it('returns failed>0 and a populated errors array when an ALTER is blocked', async () => {
		// Seed the table with a NULL value so the NOT NULL preflight blocks
		// the ALTER and records an error rather than executing it.
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`INSERT INTO \`${tableName}\` (\`confidence\`) VALUES (NULL)`,
		);
		await conn.end();

		const origError = console.error;
		console.error = () => {};
		let result;
		try {
			const required = YassORM.convertDefinition(requiredSchema);
			result = await syncSchemaToDb(required);
		} finally {
			console.error = origError;
		}

		expect(result).to.be.an('object');
		expect(result.table).to.equal(tableName);
		expect(result.failed).to.be.greaterThan(0);
		expect(result.errors).to.be.an('array').with.length.greaterThan(0);

		const [firstErr] = result.errors;
		expect(firstErr).to.have.property('table');
		expect(firstErr).to.have.property('sql');
		expect(firstErr).to.have.property('error');
	});
});
