/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// `t.stringKey` + `stringLinkedIds` against a live Postgres: prefixed,
// time-ordered string ids (`par_0mfq...`) as primary keys, and link columns that
// hold them. On Postgres `t.uuidKey` is a native UUID column, which rejects such
// ids -- `t.stringKey` stores them as VARCHAR(36). SKIPPED on other dialects:
//
//   YASS_CONFIG=$PWD/.yass-orm.postgres.js npm run test:postgres

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

describe('#Postgres stringKey + stringLinkedIds', () => {
	const suffix = uuid().replace(/-/g, '');
	const parentTable = `pg_skey_parent_${suffix}`;
	const childTable = `pg_skey_child_${suffix}`;
	let saved;
	let Parent;
	let Child;

	const parentDef = ({ types: t }) => ({
		table: parentTable,
		objectIdPrefix: 'par',
		schema: { id: t.stringKey, name: t.string },
	});
	const childDef = ({ types: t }) => ({
		table: childTable,
		objectIdPrefix: 'kid',
		schema: { id: t.stringKey, parent: t.linked('parent'), label: t.string },
	});

	before(async function beforeSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		saved = config.stringLinkedIds;
		config.stringLinkedIds = true;
		Parent = YassORM.loadDefinition(parentDef);
		Child = YassORM.loadDefinition(childDef);
		// Resolve t.linked('parent') to the Parent class without a model file.
		Child._resolveModelClass = async () => Parent;
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		config.stringLinkedIds = saved;
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${childTable}"`);
		await conn.pquery(`DROP TABLE IF EXISTS "${parentTable}"`);
		await conn.end();
	});

	it('creates string id and link columns as VARCHAR(36)', async () => {
		expect(
			(await syncSchemaToDb(YassORM.convertDefinition(parentDef))).errors,
		).to.deep.equal([]);
		expect(
			(await syncSchemaToDb(YassORM.convertDefinition(childDef))).errors,
		).to.deep.equal([]);

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const cols = await conn.pquery(
				`SELECT table_name, column_name, data_type, character_maximum_length
				 FROM information_schema.columns
				 WHERE table_name IN ($1, $2) AND column_name IN ('id', 'parent')
				 ORDER BY table_name, column_name`,
				[childTable, parentTable],
			);
			expect(
				cols.map((c) => [
					c.column_name,
					c.data_type,
					c.character_maximum_length,
				]),
			).to.deep.equal([
				['id', 'character varying', 36],
				['parent', 'character varying', 36],
				['id', 'character varying', 36],
			]);
		} finally {
			await conn.end();
		}
	});

	it('create() assigns prefixed ids, links store them, and joins + inflation work', async () => {
		const parent = await Parent.create({ name: 'p' });
		expect(parent.id).to.match(/^par_[0-9a-z]{25}$/);

		const child = await Child.create({ parent, label: 'c' });
		expect(child.id).to.match(/^kid_[0-9a-z]{25}$/);

		Child.clearCache();
		const again = await Child.get(child.id);
		expect(again.parent.id).to.equal(parent.id);
		expect(again.parent.name).to.equal('p');

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const rows = await conn.pquery(
				`SELECT c.label, p.name FROM "${childTable}" c JOIN "${parentTable}" p ON p.id = c.parent`,
			);
			expect(rows).to.deep.equal([{ label: 'c', name: 'p' }]);
		} finally {
			await conn.end();
		}
	});

	it('re-syncing the unchanged schemas applies no DDL', async () => {
		const p = await syncSchemaToDb(YassORM.convertDefinition(parentDef));
		const c = await syncSchemaToDb(YassORM.convertDefinition(childDef));
		expect([p.errors, c.errors]).to.deep.equal([[], []]);
		expect([p.applied, c.applied]).to.deep.equal([0, 0]);
	});
});
