/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { getDialect } = require('../lib/dialects');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// Syncing the SAME converted schema object twice in one process. syncSchemaToDb
// used to write the dialect's primary-key attrs into the schema's id field
// (`type: 'char(36)'` on MySQL), so on the second call the id no longer looked
// like a uuidKey and was synced as `int AUTO_INCREMENT`. Found by the Tessera
// Better Auth spike. Runs on the configured dialect (MySQL by default; also in
// `npm run test:postgres`).

describe('#schemaSync: the same converted schema, synced twice', () => {
	const dialect = getDialect(config.dialect || 'mysql');
	const suffix = uuid().replace(/-/g, '').slice(0, 12);
	const stringTable = `yass_double_sync_s_${suffix}`;
	const intTable = `yass_double_sync_i_${suffix}`;

	const stringDef = ({ types: t }) => ({
		table: stringTable,
		objectIdPrefix: 'dbl',
		schema: { id: t.stringKey, name: t.string },
		options: { indexes: { name: ['name'] } },
	});
	// No id in the schema: sync adds an integer key of its own.
	const intDef = ({ types: t }) => ({
		table: intTable,
		schema: { name: t.string },
	});

	// Everything a sync could change, as plain data: functions (nativeType)
	// compare by reference, which is what we want.
	const snapshot = (schema) => ({
		fields: schema.fields.map((field) => ({ ...field })),
		fieldMap: Object.fromEntries(
			Object.entries(schema.fieldMap).map(([k, v]) => [k, { ...v }]),
		),
		options: {
			...schema.options,
			indexes: { ...(schema.options && schema.options.indexes) },
		},
	});

	const idColumn = async (table) => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const columns = await dialect.getTableColumns(conn, table);
			const id = columns.find((c) => c.name === 'id');
			return { type: `${id.type}`.toLowerCase(), auto: !!id.autoIncrement };
		} finally {
			await conn.end();
		}
	};

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(stringTable)}`,
			);
			await conn.pquery(
				`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(intTable)}`,
			);
		} finally {
			await conn.end();
		}
	});

	it('a t.stringKey id stays a string column, and the second sync applies nothing', async () => {
		const schema = YassORM.convertDefinition(stringDef);

		const first = await syncSchemaToDb(schema);
		expect(first.errors).to.deep.equal([]);
		const created = await idColumn(stringTable);

		const second = await syncSchemaToDb(schema);
		expect(second.errors).to.deep.equal([]);
		expect(second.applied).to.equal(0);

		const after = await idColumn(stringTable);
		expect(after).to.deep.equal(created);
		expect(after.auto).to.equal(false);
		expect(after.type).to.match(/char|varying|text/);
	});

	it('does not change the schema object it is given', async () => {
		const stringSchema = YassORM.convertDefinition(stringDef);
		const intSchema = YassORM.convertDefinition(intDef);
		const stringBefore = snapshot(stringSchema);
		const intBefore = snapshot(intSchema);

		await syncSchemaToDb(stringSchema);
		await syncSchemaToDb(intSchema);
		await syncSchemaToDb(intSchema);

		expect(snapshot(stringSchema)).to.deep.equal(stringBefore);
		expect(snapshot(intSchema)).to.deep.equal(intBefore);
	});

	it('a schema without an id, synced twice, keeps its integer key and applies nothing', async () => {
		const schema = YassORM.convertDefinition(intDef);
		expect((await syncSchemaToDb(schema)).errors).to.deep.equal([]);
		const second = await syncSchemaToDb(schema);
		expect(second.errors).to.deep.equal([]);
		expect(second.applied).to.equal(0);
		expect((await idColumn(intTable)).auto).to.equal(true);
	});
});
