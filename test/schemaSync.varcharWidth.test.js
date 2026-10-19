/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

const LEGACY_WIDTH = 32;
const MODEL_SPACE_WIDTH = 128;
const MODEL_SPACE =
	'embeddinggemma-2@daa72c51243991dfcaf9f9137d2c573d8f7790c0@fp32@768';

describe('#schemaSync varchar width changes', function suite() {
	this.timeout(30000);
	const table = `yass_width_${uuid().replace(/-/g, '').slice(0, 20)}`;
	const def =
		(width) =>
		({ types: t }) => ({
			table,
			schema: {
				id: t.idKey,
				model: t.string({ type: `varchar(${width})` }).nullable(),
			},
		});
	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`DROP TABLE IF EXISTS ${conn.dialect.quoteIdentifier(table)}`,
			);
		} finally {
			await conn.end();
		}
	});

	it('widens an existing column, preserves values and converges', async () => {
		const first = await syncSchemaToDb(
			YassORM.convertDefinition(def(LEGACY_WIDTH)),
		);
		expect(first.errors || []).to.deep.equal([]);
		const conn = await dbh();
		const q = (name) => conn.dialect.quoteIdentifier(name);
		await conn.pquery(
			`INSERT INTO ${q(table)} (${q('model')}) VALUES (:model)`,
			{ model: 'old-model@4' },
		);
		const widened = await syncSchemaToDb(
			YassORM.convertDefinition(def(MODEL_SPACE_WIDTH)),
		);
		expect(widened.errors || []).to.deep.equal([]);
		expect(widened.applied).to.be.greaterThan(0);
		const rows = await conn.pquery(`SELECT ${q('model')} FROM ${q(table)}`);
		expect(rows.map((row) => row.model)).to.deep.equal(['old-model@4']);
		await conn.pquery(`UPDATE ${q(table)} SET ${q('model')} = :model`, {
			model: MODEL_SPACE,
		});
		const saved = await conn.pquery(`SELECT ${q('model')} FROM ${q(table)}`);
		expect(saved[0].model).to.equal(MODEL_SPACE);
		const stable = await syncSchemaToDb(
			YassORM.convertDefinition(def(MODEL_SPACE_WIDTH)),
		);
		expect(stable.errors || []).to.deep.equal([]);
		expect(stable.applied).to.equal(0);
	});
});
