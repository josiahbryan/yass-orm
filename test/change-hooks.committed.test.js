/* eslint-disable no-unused-expressions, no-console */
/* global describe, it, before, after, beforeEach, afterEach */
const { performance } = require('node:perf_hooks');
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { getDialect } = require('../lib/dialects');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const transactions = require('../lib/transactions');

// Y1 of the bus design (tessera docs/2026-09-23-bus-and-realtime-design.md,
// 7.4), live: the package-root transaction exports, the after-COMMIT change
// hook (registerCommittedChangeHook) next to the unchanged global hook,
// reallyDelete() reaching only the new hook, and the LOADED_AT stamp. Runs on
// the configured dialect: MySQL by default, Postgres in `npm run test:postgres`.

describe('#Y1: committed change hooks, transaction exports, LOADED_AT', function suite() {
	this.timeout(30000);

	const dialect = getDialect(config.dialect || 'mysql');
	const table = `yass_y1_${uuid().replace(/-/g, '').slice(0, 12)}`;
	const def = ({ types: t }) => ({
		table,
		schema: { id: t.idKey, name: t.string, isDeleted: t.bool },
	});

	let Model;
	let pool;
	let events; // [kind, payload] in the order they fired
	let unregister = [];

	const committed = () =>
		events.filter(([kind]) => kind === 'committed').map(([, p]) => p);
	const global = () =>
		events.filter(([kind]) => kind === 'global').map(([, p]) => p);

	// The row as another connection sees it (a committed read).
	const visibleName = async (id) => {
		const rows = await pool.pquery(
			`SELECT name FROM ${dialect.quoteIdentifier(table)} WHERE id = ${Number(
				id,
			)}`,
		);
		return rows.length ? rows[0].name : null;
	};

	before(async () => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(result.errors).to.deep.equal([]);
		Model = YassORM.loadDefinition(def);
		pool = await dbh();
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(table)}`,
			);
		} finally {
			await conn.end();
		}
	});

	beforeEach(() => {
		events = [];
		unregister = [
			YassORM.registerGlobalChangeHook((p) => {
				events.push(['global', p]);
			}),
			YassORM.registerCommittedChangeHook((p) => {
				events.push(['committed', p]);
			}),
		];
	});

	afterEach(() => {
		unregister.forEach((fn) => fn());
	});

	describe('package-root exports', () => {
		it('exports onTransactionEnd, transactionLocal, registerCommittedChangeHook and LOADED_AT', () => {
			expect(YassORM.onTransactionEnd).to.equal(transactions.onTransactionEnd);
			expect(YassORM.transactionLocal).to.equal(transactions.transactionLocal);
			expect(YassORM.registerCommittedChangeHook).to.be.a('function');
			expect(YassORM.LOADED_AT).to.be.a('symbol');
			// Shared by every copy of yass in the process.
			expect(YassORM.LOADED_AT).to.equal(Symbol.for('yass-orm.loadedAt'));
		});

		it('onTransactionEnd returns false outside a transaction', () => {
			expect(YassORM.onTransactionEnd(undefined, {})).to.equal(false);
			expect(YassORM.onTransactionEnd(pool, {})).to.equal(false);
		});
	});

	describe('registerCommittedChangeHook', () => {
		it('outside a transaction fires once per write, after the global hook', async () => {
			const row = await Model.create({ name: 'a' });
			await row.patch({ name: 'b' });
			await row.remove();

			expect(events.map(([kind]) => kind)).to.deep.equal([
				'global',
				'committed',
				'global',
				'committed',
				'global',
				'committed',
			]);
			const [created, patched, removed] = committed();
			expect(created).to.deep.include({
				modelName: table,
				id: row.id,
				wasCreated: true,
				wasDeleted: false,
			});
			expect(created.changedFields).to.include({ name: 'a' });
			expect(patched.changedFields).to.deep.equal({ name: 'b' });
			expect(patched.wasCreated).to.equal(false);
			expect(removed.changedFields).to.have.property('isDeleted');
			// No transaction handle is handed to an after-commit hook.
			expect(created).to.not.have.property('tx');
		});

		it('inside a transaction fires after COMMIT, in order; the global hook still fires before it', async () => {
			let id;
			let globalBeforeCommit;
			let committedBeforeCommit;
			let visibleInHook;
			let cachedInHook;
			const hookSaw = YassORM.registerCommittedChangeHook(async (p) => {
				if (!p.wasCreated) return;
				visibleInHook = await visibleName(p.id);
				cachedInHook = await Model.getCachedId(p.id);
			});
			unregister.push(hookSaw);

			await pool.transaction(async (tx) => {
				const row = await Model.create({ name: 'in-tx' }, { tx });
				({ id } = row);
				await row.patch({ name: 'in-tx-2' }, { tx });
				globalBeforeCommit = global().length;
				committedBeforeCommit = committed().length;
			});

			expect(globalBeforeCommit).to.equal(2);
			expect(committedBeforeCommit).to.equal(0);
			expect(committed().map((p) => [p.id, p.wasCreated])).to.deep.equal([
				[id, true],
				[id, false],
			]);
			// The hook ran after the commit: another connection sees the row,
			// and the transaction's instances are already in the shared cache.
			expect(visibleInHook).to.equal('in-tx-2');
			expect(cachedInHook && cachedInHook.name).to.equal('in-tx-2');
		});

		it('a change in a savepoint that rolled back is still reported at COMMIT', async () => {
			let kept;
			let undone;
			await pool.transaction(async (tx) => {
				kept = await Model.create({ name: 'kept' }, { tx });
				await tx
					.transaction(async (inner) => {
						undone = await Model.create({ name: 'undone' }, { tx: inner });
						throw new Error('savepoint rollback');
					})
					.catch(() => {});
			});
			expect(await visibleName(undone.id)).to.equal(null);
			expect(committed().map((p) => p.id)).to.deep.equal([kept.id, undone.id]);
		});

		it('a rollback fires no committed hook (the global hook fired, as before)', async () => {
			await pool
				.transaction(async (tx) => {
					await Model.create({ name: 'rolled-back' }, { tx });
					throw new Error('rollback');
				})
				.catch(() => {});

			expect(global()).to.have.length(1);
			expect(committed()).to.have.length(0);
		});

		it('a throwing committed hook breaks neither the write nor the commit', async () => {
			unregister.push(
				YassORM.registerCommittedChangeHook(() => {
					throw new Error('hook failed');
				}),
			);
			const origError = console.error;
			console.error = () => {};
			try {
				const row = await Model.create({ name: 'survives' });
				let inTx;
				await pool.transaction(async (tx) => {
					inTx = await Model.create({ name: 'survives-tx' }, { tx });
				});
				expect(await visibleName(row.id)).to.equal('survives');
				expect(await visibleName(inTx.id)).to.equal('survives-tx');
			} finally {
				console.error = origError;
			}
		});
	});

	describe('reallyDelete()', () => {
		it('fires the committed hook with wasDeleted:true, and neither the global hook nor afterChangeHook', async () => {
			const row = await Model.create({ name: 'doomed' });
			let afterChangeCalls = 0;
			row.afterChangeHook = async () => {
				afterChangeCalls += 1;
			};
			events.length = 0;

			await row.reallyDelete();

			expect(await visibleName(row.id)).to.equal(null);
			expect(global()).to.have.length(0);
			expect(afterChangeCalls).to.equal(0);
			expect(committed()).to.deep.equal([
				{
					modelName: table,
					id: row.id,
					changedFields: {},
					wasCreated: false,
					wasDeleted: true,
				},
			]);
		});
	});

	describe('LOADED_AT', () => {
		const { LOADED_AT } = YassORM;

		it('stamps a read with the time it was issued, as a hidden property', async () => {
			const row = await Model.create({ name: 'stamp' });
			Model.clearCache();
			const before = performance.now();
			const read = await Model.get(row.id);
			expect(read[LOADED_AT]).to.be.a('number');
			expect(read[LOADED_AT]).to.be.at.least(before);
			expect(read[LOADED_AT]).to.be.at.most(performance.now());
			// Hidden: not enumerable, so a spread or Object.assign leaves it behind.
			expect(Object.prototype.propertyIsEnumerable.call(read, LOADED_AT)).to.be
				.false;
			expect({ ...read }[LOADED_AT]).to.equal(undefined);
		});

		it('stamps a write when it completes', async () => {
			const row = await Model.create({ name: 'w' });
			const before = performance.now();
			await row.patch({ name: 'w2' });
			expect(row[LOADED_AT]).to.be.at.least(before);
		});

		it("does not overwrite a cached instance's values with an older read", async () => {
			const row = await Model.create({ name: 'fresh' });
			Model.clearCache();
			const cached = await Model.get(row.id);
			const stamp = cached[LOADED_AT];

			const older = await Model.inflate(
				{ id: row.id, name: 'stale', isDeleted: 0 },
				undefined,
				undefined,
				{ loadedAt: stamp - 1 },
			);
			expect(older).to.equal(cached);
			expect(cached.name).to.equal('fresh');
			expect(cached[LOADED_AT]).to.equal(stamp);

			await Model.inflate(
				{ id: row.id, name: 'newer', isDeleted: 0 },
				undefined,
				undefined,
				{ loadedAt: stamp + 1 },
			);
			expect(cached.name).to.equal('newer');
			expect(cached[LOADED_AT]).to.equal(stamp + 1);
		});

		it('a read is stamped when its query was issued, so a write that lands while it is in flight is kept', async () => {
			// Every read the model makes pauses once its rows are back, so a write
			// can complete between the query and the inflate.
			let whileInFlight;
			const pauseAfterRead = (read) =>
				async function paused(...args) {
					const rows = await read.apply(this, args);
					const during = whileInFlight;
					whileInFlight = undefined;
					if (during) await during();
					return rows;
				};
			class Racing extends Model {
				static retryIfConnectionLost(callback) {
					return super.retryIfConnectionLost((conn) => {
						const racing = Object.create(conn);
						['get', 'search', 'roQuery'].forEach((method) => {
							racing[method] = pauseAfterRead(conn[method]);
						});
						return callback(racing);
					});
				}
			}
			const reads = [
				['get', (id) => Racing.get(id)],
				['search', (id) => Racing.searchOne({ id })],
				[
					'fromSql',
					(id) => Racing.fromSql('id = :id', { id }).then(([r]) => r),
				],
			];
			// eslint-disable-next-line no-restricted-syntax
			for (const [name, read] of reads) {
				// eslint-disable-next-line no-await-in-loop
				const cached = await Racing.create({ name: 'before' });
				whileInFlight = () => cached.patch({ name: `written during ${name}` });
				// eslint-disable-next-line no-await-in-loop
				const result = await read(cached.id);
				expect(whileInFlight, name).to.equal(undefined);
				expect(result, name).to.equal(cached);
				expect(cached.name, name).to.equal(`written during ${name}`);
			}
		});

		it('publishing a committed write onto a cached instance carries its stamp', async () => {
			const row = await Model.create({ name: 'shared' });
			Model.clearCache();
			const shared = await Model.get(row.id);
			const beforeTx = performance.now();
			let beforeCommit;
			await pool.transaction(async (tx) => {
				const inTx = await Model.get(row.id, { tx });
				// The transaction's own instance, not the shared one.
				expect(inTx).to.not.equal(shared);
				await inTx.patch({ name: 'committed' }, { tx });
				beforeCommit = performance.now();
			});
			expect(await Model.getCachedId(row.id)).to.equal(shared);
			expect(shared.name).to.equal('committed');
			expect(shared[LOADED_AT]).to.be.at.least(beforeCommit);

			// So a read issued before that commit can't put the old row back.
			await Model.inflate(
				{ id: row.id, name: 'shared', isDeleted: 0 },
				undefined,
				undefined,
				{ loadedAt: beforeTx },
			);
			expect(shared.name).to.equal('committed');
		});

		it("inside a transaction a read carries the transaction's start; a row it wrote is stamped at commit", async () => {
			const existing = await Model.create({ name: 'pre' });
			Model.clearCache();
			const beforeTx = performance.now();
			let readStamp;
			let secondReadStamp;
			let written;
			let beforeCommit;
			await pool.transaction(async (tx) => {
				const read = await Model.get(existing.id, { tx });
				readStamp = read[LOADED_AT];
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				secondReadStamp = (await Model.search({ name: 'pre' }, false, { tx }))
					.map((r) => r[LOADED_AT])
					.find(Boolean);
				written = await read.patch({ name: 'tx-written' }, { tx });
				beforeCommit = performance.now();
			});
			expect(readStamp).to.be.at.least(beforeTx);
			expect(secondReadStamp).to.equal(readStamp);
			const shared = await Model.getCachedId(existing.id);
			expect(shared.name).to.equal('tx-written');
			expect(written[LOADED_AT]).to.be.at.least(beforeCommit);
			expect(shared[LOADED_AT]).to.be.at.least(beforeCommit);
		});
	});
});
