/* eslint-disable no-unused-expressions */
/* global describe, it, before, after, beforeEach */
const { expect } = require('chai');
const { dbh } = require('../lib/dbh');
const { loadDefinition } = require('../lib/obj');

const CacheSelfLink = require('./fixtures/cache-self-link');

/**
 * The model instance cache: which bucket an instance lands in, and what a
 * transaction may put there. Live MySQL, because the transaction cases need a
 * real rollback.
 */
describe('#YASS-ORM instance cache scope', function cacheScopeSuite() {
	this.timeout(30000);

	const tables = {
		a: 'test.yass_cache_a',
		b: 'test.yass_cache_b',
		tx: 'test.yass_cache_tx',
		self: 'test.yass_cache_self',
	};

	// Both are anonymous `class extends` returned by loadDefinition(), so both
	// are named 'ModelClass'.
	const ModelA = loadDefinition(({ types: t }) => ({
		table: 'yass_cache_a',
		schema: { id: t.idKey, name: t.string },
	}));
	const ModelB = loadDefinition(({ types: t }) => ({
		table: 'yass_cache_b',
		schema: { id: t.idKey, name: t.string },
	}));
	const TxModel = loadDefinition(({ types: t }) => ({
		table: 'yass_cache_tx',
		schema: { id: t.idKey, name: t.string },
	}));

	const ROLLBACK = new Error('intentional rollback');
	const rollingBack = async (promise) => {
		try {
			await promise;
		} catch (err) {
			if (err !== ROLLBACK) throw err;
			return;
		}
		throw new Error('expected the transaction to roll back');
	};

	let conn;

	before(async () => {
		conn = await dbh();
		await Promise.all(
			Object.values(tables).map((table) =>
				conn.query(`DROP TABLE IF EXISTS ${table}`),
			),
		);
		await Promise.all(
			Object.values(tables).map((table) =>
				conn.query(`
					CREATE TABLE ${table} (
						id INT PRIMARY KEY AUTO_INCREMENT,
						name VARCHAR(255),
						parent INT NULL,
						isDeleted TINYINT DEFAULT 0,
						createdBy INT NULL,
						createdAt DATETIME NULL,
						updatedBy INT NULL,
						updatedAt DATETIME NULL
					) ENGINE=InnoDB
				`),
			),
		);
	});

	beforeEach(async () => {
		await Promise.all(
			Object.values(tables).map((table) => conn.query(`DELETE FROM ${table}`)),
		);
		[ModelA, ModelB, TxModel, CacheSelfLink].forEach((Model) =>
			Model.clearCache(),
		);
	});

	// No closeAllConnections(): later suites share the pool.
	after(async () => {
		if (conn) {
			await Promise.all(
				Object.values(tables).map((table) =>
					conn.query(`DROP TABLE IF EXISTS ${table}`),
				),
			);
		}
	});

	describe('models made straight from loadDefinition()', () => {
		beforeEach(async () => {
			await conn.query(
				`INSERT INTO ${tables.a} (id, name) VALUES (1, 'a-row')`,
			);
			await conn.query(
				`INSERT INTO ${tables.b} (id, name) VALUES (1, 'b-row')`,
			);
		});

		it('share a class name (the precondition for the bug)', () => {
			expect(ModelA.name).to.equal(ModelB.name);
		});

		it("do not get each other's cached instance for the same id", async () => {
			const a = await ModelA.get(1, { allowCached: true });
			const b = await ModelB.get(1, { allowCached: true });

			expect(a).to.be.an.instanceOf(ModelA);
			expect(a.name).to.equal('a-row');
			expect(b).to.be.an.instanceOf(ModelB);
			expect(b.name).to.equal('b-row');
		});

		it("clearCache() on one leaves the other's cache alone", async () => {
			const a = await ModelA.get(1);
			await ModelB.get(1);
			ModelB.clearCache();

			expect(await ModelA.getCachedId(1)).to.equal(a);
			expect(await ModelB.getCachedId(1)).to.equal(undefined);
		});

		it('two copies of one model class (same name, same table) still share a bucket', async () => {
			// What the globalThis cache is for: the same model module loaded twice
			// (e.g. through a symlink and its real path) is two classes.
			const CopyOne = class Widget extends ModelA {};
			const CopyTwo = class Widget extends ModelA {};

			const one = await CopyOne.get(1);
			expect(await CopyTwo.getCachedId(1)).to.equal(one);
		});
	});

	describe('transactions', () => {
		let id;
		beforeEach(async () => {
			const res = await conn.query(
				`INSERT INTO ${tables.tx} (name) VALUES ('committed')`,
			);
			id = Number(res.insertId);
		});

		it('a read and a write inside a rolled-back transaction do not reach the shared cache', async () => {
			await rollingBack(
				conn.transaction(async (tx) => {
					const inTx = await TxModel.get(id, { tx });
					await inTx.patch({ name: 'rolled back' }, { tx });
					// The transaction sees its own write.
					expect((await TxModel.get(id, { tx })).name).to.equal('rolled back');
					throw ROLLBACK;
				}),
			);

			expect(await TxModel.getCachedId(id)).to.equal(undefined);
			const after = await TxModel.get(id, { allowCached: true });
			expect(after.name).to.equal('committed');
		});

		it('a row created inside a rolled-back transaction is not served from the cache', async () => {
			let createdId;
			await rollingBack(
				conn.transaction(async (tx) => {
					const created = await TxModel.create({ name: 'ghost' }, { tx });
					createdId = created.id;
					throw ROLLBACK;
				}),
			);

			expect(createdId).to.be.a('number');
			expect(await TxModel.get(createdId, { allowCached: true })).to.not.exist;
		});

		it('an instance cached before the transaction is not changed by it, and rollback keeps it', async () => {
			const outside = await TxModel.get(id);
			expect(await TxModel.getCachedId(id)).to.equal(outside);

			await rollingBack(
				conn.transaction(async (tx) => {
					const inTx = await TxModel.get(id, { tx });
					await inTx.patch({ name: 'rolled back' }, { tx });
					throw ROLLBACK;
				}),
			);

			expect(outside.name).to.equal('committed');
			expect(await TxModel.get(id, { allowCached: true })).to.equal(outside);
		});

		it('writing through an instance from outside, then rolling back, evicts it from the cache', async () => {
			const outside = await TxModel.get(id);

			await rollingBack(
				conn.transaction(async (tx) => {
					await outside.patch({ name: 'rolled back' }, { tx });
					throw ROLLBACK;
				}),
			);

			// The caller's own object keeps what it was told (as any patched
			// object does); the cache no longer hands it out.
			expect(outside.name).to.equal('rolled back');
			const fresh = await TxModel.get(id, { allowCached: true });
			expect(fresh).to.not.equal(outside);
			expect(fresh.name).to.equal('committed');
		});

		it('a commit publishes what the transaction read and wrote, as before', async () => {
			const outside = await TxModel.get(id);
			let createdId;

			await conn.transaction(async (tx) => {
				const inTx = await TxModel.get(id, { tx });
				await inTx.patch({ name: 'committed again' }, { tx });
				createdId = (await TxModel.create({ name: 'new' }, { tx })).id;
			});

			// setCachedId freshens the instance already in the cache.
			expect(outside.name).to.equal('committed again');
			expect(await TxModel.get(id, { allowCached: true })).to.equal(outside);
			const created = await TxModel.getCachedId(createdId);
			expect(created).to.exist;
			expect(created.name).to.equal('new');
		});

		it('a savepoint rolled back inside a committed transaction leaves nothing of itself in the cache', async () => {
			const outside = await TxModel.get(id);

			await conn.transaction(async (tx) => {
				await rollingBack(
					tx.transaction(async (sp) => {
						const inSp = await TxModel.get(id, { tx: sp });
						await inSp.patch({ name: 'savepoint' }, { tx: sp });
						throw ROLLBACK;
					}),
				);
			});

			expect(outside.name).to.equal('committed');
			const after = await TxModel.get(id, { allowCached: true });
			expect(after.name).to.equal('committed');
		});

		it('after a savepoint rolls back, the rest of the transaction does not see its instances', async () => {
			await conn.transaction(async (tx) => {
				await rollingBack(
					tx.transaction(async (sp) => {
						const inSp = await TxModel.get(id, { tx: sp });
						await inSp.patch({ name: 'savepoint' }, { tx: sp });
						throw ROLLBACK;
					}),
				);
				const again = await TxModel.get(id, { allowCached: true, tx });
				expect(again.name).to.equal('committed');
			});
		});

		it('a commit does not overwrite a newer shared instance with what the transaction only read', async () => {
			const outside = await TxModel.get(id);

			await conn.transaction(async (tx) => {
				await TxModel.get(id, { tx });
				// Committed by someone else while the transaction is still open.
				await outside.patch({ name: 'newer' });
			});

			expect(outside.name).to.equal('newer');
			const after = await TxModel.get(id, { allowCached: true });
			expect(after.name).to.equal('newer');
		});

		it('after commit, a published link points at the shared instance, not the transaction copy', async () => {
			const parentRes = await conn.query(
				`INSERT INTO ${tables.self} (name) VALUES ('parent')`,
			);
			const parentId = Number(parentRes.insertId);
			const childRes = await conn.query(
				`INSERT INTO ${tables.self} (name, parent) VALUES ('child', ${parentId})`,
			);
			const childId = Number(childRes.insertId);
			const sharedParent = await CacheSelfLink.get(parentId);

			await conn.transaction(async (tx) => {
				const txParent = await CacheSelfLink.get(parentId, { tx });
				const txChild = await CacheSelfLink.get(childId, { tx });
				expect(txChild.parent).to.equal(txParent);
			});

			const child = await CacheSelfLink.getCachedId(childId);
			expect(child).to.exist;
			expect(child.parent).to.equal(sharedParent);
		});

		it('links that loop back resolve inside a transaction (no endless recursion)', async () => {
			await conn.transaction(async (tx) => {
				const row = await CacheSelfLink.create({ name: 'loop' }, { tx });
				await row.patch({ parent: row.id }, { tx });

				const again = await CacheSelfLink.get(row.id, { tx });
				expect(again.parent).to.equal(again);
				expect(again.name).to.equal('loop');
			});
		});

		it('keeps a cache override (Rubber-style getCachedId/setCachedId/removeCachedId) out of the transaction until it ends', async () => {
			const store = new Map();
			const calls = [];
			class Overridden extends TxModel {
				static async getCachedId(key) {
					calls.push(['get', key]);
					return store.get(key);
				}

				static async setCachedId(key, instance) {
					calls.push(['set', key]);
					store.set(key, instance);
					return instance;
				}

				static removeCachedId(key) {
					calls.push(['remove', key]);
					return store.delete(key);
				}
			}

			await rollingBack(
				conn.transaction(async (tx) => {
					const inTx = await Overridden.get(id, { tx });
					await inTx.patch({ name: 'rolled back' }, { tx });
					expect(calls).to.deep.equal([]);
					throw ROLLBACK;
				}),
			);
			// Only the transaction's own instance was written: nothing to undo.
			expect(store.has(id)).to.equal(false);
			expect(calls).to.deep.equal([]);

			// A write through an instance from outside is evicted on rollback.
			const outside = await Overridden.get(id);
			calls.length = 0;
			await rollingBack(
				conn.transaction(async (tx) => {
					await outside.patch({ name: 'rolled back' }, { tx });
					throw ROLLBACK;
				}),
			);
			expect(calls).to.deep.equal([['remove', id]]);
			expect(store.has(id)).to.equal(false);

			calls.length = 0;
			await conn.transaction(async (tx) => {
				const inTx = await Overridden.get(id, { tx });
				await inTx.patch({ name: 'committed again' }, { tx });
				expect(calls).to.deep.equal([]);
			});
			// Published through the override at commit (then looked up to relink).
			expect(calls).to.deep.equal([
				['set', id],
				['get', id],
			]);
			expect(store.get(id).name).to.equal('committed again');
		});
	});
});
