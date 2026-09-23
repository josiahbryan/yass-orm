/* eslint-disable no-unused-expressions */
/* global describe, it, before, beforeEach */
const { expect } = require('chai');
const { loadDefinition } = require('../lib');
const { dbh } = require('../lib/dbh');
const {
	recreateTables,
	quoteTable,
	ROLLBACK,
	rollingBack,
} = require('./helpers/characterize');

/**
 * Characterization (step 3 of the modernization plan): the instance cache
 * outside and inside transactions, as it behaves after step 2 (a
 * per-transaction cache published on commit). test/obj.cache-scope.test.js
 * holds the step 2 regression tests; this adds the everyday behavior around
 * them, on MySQL (`npm test`) and Postgres (`npm run test:postgres`).
 */
describe('#characterize instance cache', function cacheSuite() {
	this.timeout(30000);

	const definition = ({ types: t }) => ({
		table: 'yass_char_cache',
		schema: { id: t.idKey, name: t.string },
	});
	const Model = loadDefinition(definition);

	let conn;
	let id;

	/** Changes the row on disk without going through the model. */
	const renameOnDisk = (rowId, name) =>
		conn.pquery(
			`UPDATE ${quoteTable(Model.table())} SET name = :name WHERE id = :id`,
			{ id: rowId, name },
		);

	before(async () => {
		await recreateTables([definition]);
		conn = await dbh();
	});

	beforeEach(async () => {
		await conn.pquery(`DELETE FROM ${quoteTable(Model.table())}`);
		Model.clearCache();
		// Created outside the model, so nothing is cached yet.
		await conn.pquery(
			`INSERT INTO ${quoteTable(Model.table())} (name) VALUES ('disk')`,
		);
		const [row] = await conn.pquery(
			`SELECT id FROM ${quoteTable(Model.table())} WHERE name = 'disk'`,
		);
		id = Number(row.id);
	});

	describe('outside a transaction', () => {
		it('the bucket lives on globalThis, keyed <class name>:<table>', async () => {
			const instance = await Model.get(id);
			const buckets = globalThis.__YASS_ORM_OBJECT_CACHE__;
			expect(buckets['ModelClass:yass_char_cache'][id]).to.equal(instance);
		});

		it('get() always reads, and freshens the one cached instance', async () => {
			const first = await Model.get(id);
			await renameOnDisk(id, 'renamed');
			const second = await Model.get(id);
			expect(second).to.equal(first);
			expect(first.name).to.equal('renamed');
		});

		it('get(id, { allowCached: true }) returns the cached instance without reading', async () => {
			const first = await Model.get(id);
			await renameOnDisk(id, 'renamed');
			const cached = await Model.get(id, { allowCached: true });
			expect(cached).to.equal(first);
			expect(cached.name).to.equal('disk');
		});

		it('get(id, { allowCached: true }) on a miss reads and caches', async () => {
			expect(await Model.getCachedId(id)).to.equal(undefined);
			const loaded = await Model.get(id, { allowCached: true });
			expect(loaded.name).to.equal('disk');
			expect(await Model.getCachedId(id)).to.equal(loaded);
		});

		it('get() of a missing id returns null and caches nothing', async () => {
			expect(await Model.get(999999)).to.equal(null);
			expect(await Model.get(999999, { allowCached: true })).to.equal(null);
			expect(await Model.getCachedId(999999)).to.equal(undefined);
		});

		it('create() caches the new instance', async () => {
			const created = await Model.create({ name: 'new' });
			expect(await Model.getCachedId(created.id)).to.equal(created);
		});

		it('search(), searchOne() and fromSql() hand out the cached instance', async () => {
			const cached = await Model.get(id);
			expect(await Model.searchOne({ name: 'disk' })).to.equal(cached);
			expect((await Model.search({ name: 'disk' }))[0]).to.equal(cached);
			expect((await Model.fromSql('id = :id', { id }))[0]).to.equal(cached);
		});

		it('patch() updates the instance, which is the cached one', async () => {
			const instance = await Model.get(id);
			await instance.patch({ name: 'patched' });
			expect(instance.name).to.equal('patched');
			expect(await Model.get(id, { allowCached: true })).to.equal(instance);
		});

		it('remove() evicts, then its patch caches the instance again (isDeleted true)', async () => {
			const instance = await Model.get(id);
			await instance.remove();
			const cached = await Model.getCachedId(id);
			expect(cached).to.equal(instance);
			expect(cached.isDeleted).to.equal(true);
		});

		it('reallyDelete() evicts, and the row is gone', async () => {
			const instance = await Model.get(id);
			await instance.reallyDelete();
			expect(await Model.getCachedId(id)).to.equal(undefined);
			expect(await Model.get(id, { allowCached: true })).to.equal(null);
		});

		it('removeCachedId() says whether it removed anything', async () => {
			await Model.get(id);
			expect(Model.removeCachedId(id)).to.equal(true);
			expect(Model.removeCachedId(id)).to.equal(false);
		});

		it('clearCache() empties the bucket; references held elsewhere keep their data', async () => {
			const held = await Model.get(id);
			Model.clearCache();
			expect(await Model.getCachedId(id)).to.equal(undefined);
			expect(held.name).to.equal('disk');
			const fresh = await Model.get(id);
			expect(fresh).to.not.equal(held);
		});
	});

	describe('inside a transaction', () => {
		it('get(id, { tx }) is a transaction copy, not the shared instance, and stays one object', async () => {
			const shared = await Model.get(id);
			await conn.transaction(async (tx) => {
				const inTx = await Model.get(id, { tx });
				expect(inTx).to.not.equal(shared);
				expect(await Model.get(id, { tx })).to.equal(inTx);
				expect(await Model.get(id, { tx, allowCached: true })).to.equal(inTx);
			});
		});

		it('get(id, { tx, allowCached: true }) before the transaction reads it falls back to the shared instance', async () => {
			const shared = await Model.get(id);
			await conn.transaction(async (tx) => {
				expect(await Model.get(id, { tx, allowCached: true })).to.equal(shared);
			});
		});

		it('the transaction reads its own writes; others do not see them until commit', async () => {
			let created;
			await conn.transaction(async (tx) => {
				created = await Model.create({ name: 'in tx' }, { tx });
				expect(await Model.get(created.id, { tx, allowCached: true })).to.equal(
					created,
				);
				expect(await Model.get(created.id, { allowCached: true })).to.equal(
					null,
				);
				expect(await Model.getCachedId(created.id)).to.equal(undefined);
			});
			// Nothing was cached for that id, so the transaction's own instance is
			// the one published.
			expect(await Model.getCachedId(created.id)).to.equal(created);
		});

		it('a savepoint that commits is published when the transaction commits', async () => {
			let created;
			await conn.transaction(async (tx) => {
				await tx.transaction(async (sp) => {
					created = await Model.create({ name: 'savepoint' }, { tx: sp });
				});
				expect(await Model.getCachedId(created.id)).to.equal(undefined);
			});
			expect(await Model.getCachedId(created.id)).to.equal(created);
		});

		it('a savepoint that commits inside a rolled-back transaction is not published', async () => {
			let created;
			await rollingBack(
				conn.transaction(async (tx) => {
					await tx.transaction(async (sp) => {
						created = await Model.create({ name: 'savepoint' }, { tx: sp });
					});
					throw ROLLBACK;
				}),
			);
			expect(await Model.getCachedId(created.id)).to.equal(undefined);
			expect(await Model.get(created.id)).to.equal(null);
		});

		it('remove({ tx }) is settled when the transaction ends: commit keeps isDeleted', async () => {
			const shared = await Model.get(id);
			await conn.transaction(async (tx) => {
				const inTx = await Model.get(id, { tx });
				await inTx.remove({ tx });
				expect(await Model.getCachedId(id)).to.equal(shared);
				expect(shared.isDeleted).to.equal(false);
			});
			expect(await Model.getCachedId(id)).to.equal(shared);
			expect(shared.isDeleted).to.equal(true);
		});

		it('remove({ tx }) through the shared instance, rolled back, evicts it', async () => {
			const shared = await Model.get(id);
			await rollingBack(
				conn.transaction(async (tx) => {
					await shared.remove({ tx });
					throw ROLLBACK;
				}),
			);
			expect(await Model.getCachedId(id)).to.equal(undefined);
			const fresh = await Model.get(id);
			expect(fresh.isDeleted).to.equal(false);
		});

		it('a `tx` that is not a transaction handle caches as if there were none', async () => {
			const viaHandle = await Model.get(id, { tx: conn });
			expect(await Model.getCachedId(id)).to.equal(viaHandle);
		});
	});
});
