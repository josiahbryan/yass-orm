/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// Model + transaction coverage against a live Postgres server. SKIPPED unless the
// active dialect is postgres:
//
//   YASS_CONFIG=$PWD/.yass-orm.postgres.js npm run test:postgres
//
// Up to 2.1.3 only schema-sync had ever been exercised against Postgres. This
// covers the layer above it: CRUD, object/array (JSONB) round-trips, and the
// transaction primitives (commit, rollback, read-your-own-writes, savepoints).
//
// Two findings came out of writing it:
//   * `dbh({ ignoreCachedConnections: true })` followed by `end()` poisoned the
//     shared pool when it was the FIRST handle for a key -- covered by a
//     dialect-agnostic regression test in test/dbh.ignore-cached-closes-old.test.js.
//   * `t.object`/`t.array` now map to JSONB rather than TEXT, which only works
//     because inflate already tolerates a non-string (the `pg` driver hands back
//     parsed objects for jsonb, not JSON text).

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

describe('#Postgres model + transaction layer', () => {
	const tableName = `pg_model_${uuid().replace(/-/g, '')}`;

	const defFn = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			name: t.string,
			body: t.text,
			meta: t.object,
			tags: t.array(t.string),
			count: t.int,
			score: t.real,
			flag: t.bool,
		},
	});

	let Model;

	before(async function beforePgModelSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		const result = await syncSchemaToDb(YassORM.convertDefinition(defFn));
		expect(result.errors).to.deep.equal([]);
		Model = await YassORM.loadDefinition(defFn);
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
	});

	it('stores t.object / t.array columns as JSONB', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SELECT column_name, data_type FROM information_schema.columns
			 WHERE table_name = $1 AND column_name IN ('meta', 'tags')`,
			[tableName],
		);
		await conn.end();

		const byName = {};
		rows.forEach((r) => {
			byName[r.column_name] = r.data_type;
		});
		expect(byName.meta).to.equal('jsonb');
		expect(byName.tags).to.equal('jsonb');
	});

	it('creates a row and inflates object/array/bool fields on read', async () => {
		const created = await Model.create({
			name: 'alpha',
			body: 'hello world',
			meta: { nested: { a: 1 }, list: [1, 2, 3] },
			tags: ['x', 'y'],
			count: 7,
			score: 1.5,
			flag: true,
		});
		expect(created.id).to.be.a('number');

		Model.clearCache();
		const row = await Model.get(created.id);

		// The pg driver returns jsonb as a parsed object, not JSON text -- inflate
		// must pass it through rather than trying to JSON.parse an object.
		expect(row.meta).to.be.an('object');
		expect(row.meta.nested.a).to.equal(1);
		expect(row.meta.list).to.deep.equal([1, 2, 3]);
		expect(row.tags).to.deep.equal(['x', 'y']);
		expect(row.count).to.equal(7);
		expect(row.flag).to.equal(true);
	});

	it('searches and patches', async () => {
		const found = await Model.searchOne({ name: 'alpha' });
		expect(found).to.not.equal(null);

		await found.patch({ count: 99, meta: { nested: { a: 2 } } });

		Model.clearCache();
		const again = await Model.get(found.id);
		expect(again.count).to.equal(99);
		expect(again.meta.nested.a).to.equal(2);
	});

	it('findOrCreate() finds an existing row and creates a missing one', async () => {
		const existing = await Model.findOrCreate({ name: 'alpha' });
		expect(existing).to.not.equal(null);

		const fresh = await Model.findOrCreate({ name: `fresh-${uuid()}` });
		expect(fresh.id).to.be.a('number');
		expect(fresh.id).to.not.equal(existing.id);
	});

	it('remove() soft-deletes by persisting a real boolean', async () => {
		const row = await Model.create({ name: 'to-remove' });
		await row.remove();

		// The deflate path converts booleans to MySQL-style 1/0; Postgres accepts
		// that for a boolean column, but confirm what actually landed on disk.
		const conn = await dbh({ ignoreCachedConnections: true });
		const [stored] = await conn.pquery(
			`SELECT "isDeleted" FROM "${tableName}" WHERE id = $1`,
			[row.id],
		);
		await conn.end();
		expect(stored.isDeleted).to.equal(true);
	});

	it('commits a transaction', async () => {
		const conn = await dbh();
		const name = `tx-commit-${uuid()}`;
		await conn.transaction(async (tx) => {
			await Model.create({ name }, { tx });
		});

		Model.clearCache();
		const row = await Model.searchOne({ name });
		expect(row).to.not.equal(null);
	});

	it('rolls a transaction back', async () => {
		const conn = await dbh();
		const name = `tx-rollback-${uuid()}`;
		let caught;
		try {
			await conn.transaction(async (tx) => {
				await Model.create({ name }, { tx });
				throw new Error('intentional');
			});
		} catch (e) {
			caught = e;
		}
		expect(caught && caught.message).to.equal('intentional');

		Model.clearCache();
		const row = await Model.searchOne({ name });
		// searchOne resolves null (not undefined) for "no match"
		expect(row === null || row === undefined).to.equal(true);
	});

	it('reads its own writes inside a transaction', async () => {
		const conn = await dbh();
		const name = `tx-read-${uuid()}`;
		await conn.transaction(async (tx) => {
			const made = await Model.create({ name }, { tx });
			// Clear the identity cache so the read cannot be served from memory --
			// it must actually join the transaction.
			Model.clearCache();
			const found = await Model.get(made.id, { tx });
			expect(found).to.not.equal(null);
			expect(found.id).to.equal(made.id);
		});
	});

	it('round-trips a JSONB field inside a transaction', async () => {
		const conn = await dbh();
		await conn.transaction(async (tx) => {
			const made = await Model.create(
				{ name: `tx-json-${uuid()}`, meta: { deep: { ok: true } } },
				{ tx },
			);
			Model.clearCache();
			const found = await Model.get(made.id, { tx });
			expect(found.meta.deep.ok).to.equal(true);
		});
	});

	it('rolls back a nested transaction to its savepoint, keeping the outer work', async () => {
		const conn = await dbh();
		const outerName = `outer-${uuid()}`;
		const innerName = `inner-${uuid()}`;

		await conn.transaction(async (tx) => {
			await Model.create({ name: outerName }, { tx });
			let caught;
			try {
				await tx.transaction(async (inner) => {
					await Model.create({ name: innerName }, { tx: inner });
					throw new Error('inner-fail');
				});
			} catch (e) {
				caught = e;
			}
			expect(caught && caught.message).to.equal('inner-fail');
		});

		Model.clearCache();
		expect(await Model.searchOne({ name: outerName })).to.not.equal(null);
		const inner = await Model.searchOne({ name: innerName });
		expect(inner === null || inner === undefined).to.equal(true);
	});
});
