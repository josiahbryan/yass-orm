/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const config = require('../lib/config');
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
	it('preserves a wider MySQL column holding long data when the schema is narrower', async function narrower() {
		if ((config.dialect || 'mysql') !== 'mysql') this.skip();
		const conn = await dbh();
		const q = (name) => conn.dialect.quoteIdentifier(name);
		await syncSchemaToDb(YassORM.convertDefinition(def(MODEL_SPACE_WIDTH)));
		const longValue = 'x'.repeat(100);
		await conn.pquery(`UPDATE ${q(table)} SET ${q('model')} = :model`, {
			model: longValue,
		});
		const result = await syncSchemaToDb(
			YassORM.convertDefinition(def(LEGACY_WIDTH)),
		);
		expect(result.errors || []).to.deep.equal([]);
		expect(result.applied).to.equal(0);
		const saved = await conn.pquery(`SELECT ${q('model')} FROM ${q(table)}`);
		expect(saved[0].model).to.equal(longValue);
	});
	it('keeps legacy unbounded and UUID aliases stable on MySQL', async function aliases() {
		if ((config.dialect || 'mysql') !== 'mysql') this.skip();
		const pairs = [
			[255, 'varchar(-1)'],
			[256, 'varchar(-1)'],
			[255, 'nvarchar(-1)'],
			[256, 'uniqueidentifier'],
		];
		for (const [width, alias] of pairs) {
			const make =
				(type) =>
				({ types: t }) => ({
					table,
					schema: { id: t.idKey, model: t.string({ type }).nullable() },
				});
			const conn = await dbh();
			await conn.pquery(
				`ALTER TABLE ${conn.dialect.quoteIdentifier(
					table,
				)} MODIFY COLUMN model varchar(${width}) NULL`,
			);
			const result = await syncSchemaToDb(
				YassORM.convertDefinition(make(alias)),
			);
			expect(result.errors || []).to.deep.equal([]);
			expect(result.applied, alias).to.equal(0);
		}
	});

	it('skips indexed widening past the utf8mb4 key limit', async function indexed() {
		if ((config.dialect || 'mysql') !== 'mysql') this.skip();
		const conn = await dbh();
		const q = (name) => conn.dialect.quoteIdentifier(name);
		await conn.pquery(
			`ALTER TABLE ${q(
				table,
			)} MODIFY COLUMN model varchar(128) CHARACTER SET utf8mb4 NULL`,
		);
		await conn.pquery(`CREATE INDEX width_guard ON ${q(table)} (model)`);
		const indexedDef = YassORM.convertDefinition(def(1024));
		indexedDef.options.indexes = { width_guard: ['model'] };
		const result = await syncSchemaToDb(indexedDef);
		expect(result.errors || []).to.deep.equal([]);
		expect(result.applied).to.equal(0);
		const columns = await conn.dialect.getTableColumns(conn, table);
		expect(columns.find((column) => column.name === 'model').type).to.equal(
			'varchar(128)',
		);
	});
});
