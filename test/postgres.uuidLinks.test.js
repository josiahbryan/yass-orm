/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// With `uuidLinkedIds`, `t.linked()` columns were CHAR(36) while `t.uuidKey`
// primary keys are native UUID. Postgres has no `uuid = character` operator, so
// EVERY join from a link column to the row it links to failed:
//
//   ERROR: operator does not exist: uuid = character
//
// Link columns now get the same native UUID type as the keys they point at.
// Live against Postgres; SKIPPED on other dialects:
//
//   YASS_CONFIG=$PWD/.yass-orm.postgres.js npm run test:postgres

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

describe('#Postgres uuid link columns', () => {
	const suffix = uuid().replace(/-/g, '');
	const parentTable = `pg_link_parent_${suffix}`;
	const childTable = `pg_link_child_${suffix}`;
	let savedUuidLinkedIds;

	const parentDef = ({ types: t }) => ({
		table: parentTable,
		schema: { id: t.uuidKey, name: t.string },
	});
	const childDef = ({ types: t }) => ({
		table: childTable,
		schema: { id: t.uuidKey, parent: t.linked('parent'), label: t.string },
	});

	before(async function beforeSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		// t.linked() reads uuidLinkedIds live, at convertDefinition time.
		savedUuidLinkedIds = config.uuidLinkedIds;
		config.uuidLinkedIds = true;
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		config.uuidLinkedIds = savedUuidLinkedIds;
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${childTable}"`);
		await conn.pquery(`DROP TABLE IF EXISTS "${parentTable}"`);
		await conn.end();
	});

	it('creates link columns as native uuid, and a link joins to its key', async () => {
		expect(
			(await syncSchemaToDb(YassORM.convertDefinition(parentDef))).errors,
		).to.deep.equal([]);
		expect(
			(await syncSchemaToDb(YassORM.convertDefinition(childDef))).errors,
		).to.deep.equal([]);

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const [col] = await conn.pquery(
				`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'parent'`,
				[childTable],
			);
			expect(col.data_type).to.equal('uuid');

			const parentId = uuid();
			await conn.pquery(
				`INSERT INTO "${parentTable}" (id, name) VALUES ($1, 'p')`,
				[parentId],
			);
			await conn.pquery(
				`INSERT INTO "${childTable}" (parent, label) VALUES ($1, 'c')`,
				[parentId],
			);
			const rows = await conn.pquery(
				`SELECT c.label, p.name FROM "${childTable}" c JOIN "${parentTable}" p ON p.id = c.parent`,
			);
			expect(rows).to.deep.equal([{ label: 'c', name: 'p' }]);
		} finally {
			await conn.end();
		}
	});

	it('re-syncing the unchanged schema applies no DDL', async () => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(childDef));
		expect(result.errors).to.deep.equal([]);
		expect(result.applied).to.equal(0);
	});
});
