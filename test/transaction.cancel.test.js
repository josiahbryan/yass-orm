/* eslint-disable no-unused-expressions */
/* global describe, it, before, after, beforeEach, afterEach */
const net = require('net');
const { expect } = require('chai');
const { dbh } = require('../lib/dbh');
const {
	TransactionCancelledError,
	TRANSACTION_CANCELLED,
	isRetryableTransactionError,
} = require('../lib/transactions');
const yass = require('../lib');
const { retryIfConnectionLost } = require('../lib/utils');
const { isPostgres, quoteTable } = require('./helpers/characterize');
const pkg = require('../package.json');

const table = `yass_tx_cancel_${process.pid}`;
const T = () => quoteTable(table);

// A promise the test resolves by hand: holds a transaction body open with its
// locks, as a body waiting on something outside the database would.
const gate = () => {
	let open;
	const promise = new Promise((resolve) => {
		open = resolve;
	});
	return { promise, open };
};

const tick = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

// The server session id of the connection a handle runs on
const sessionId = async (handle) => {
	const rows = await handle.query(
		isPostgres()
			? 'SELECT pg_backend_pid() AS id'
			: 'SELECT CONNECTION_ID() AS id',
	);
	return Number(rows[0].id);
};

const sessionAlive = async (handle, id) => {
	const rows = await handle.pquery(
		isPostgres()
			? 'SELECT COUNT(*) AS n FROM pg_stat_activity WHERE pid = :id'
			: 'SELECT COUNT(*) AS n FROM information_schema.processlist WHERE id = :id',
		{ id },
	);
	return Number(rows[0].n) > 0;
};

const lockRow = (tx, id) =>
	tx.pquery(`SELECT id, value FROM ${T()} WHERE id = :id FOR UPDATE`, { id });

const valueOf = async (handle, id) => {
	const rows = await handle.pquery(`SELECT value FROM ${T()} WHERE id = :id`, {
		id,
	});
	return rows.length ? rows[0].value : null;
};

const settle = (promise) =>
	promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);

/**
 * Cancelling a transaction from outside it (`tx.cancel(reason)`), for a
 * holder past its deadline, without a second connection: the root is doomed
 * at once (no COMMIT is sent afterwards, every later statement rejects), its
 * socket is destroyed (the server rolls back on disconnect and releases its
 * locks), the connection is discarded from the pool, and transaction()
 * rejects with a TransactionCancelledError. Live database: MySQL in
 * `npm test`, Postgres in `npm run test:postgres`.
 */
describe('transactions: cancel(reason)', function cancelSuite() {
	this.timeout(30000);

	let conn;

	before(async () => {
		conn = await dbh();
		await conn.query(`DROP TABLE IF EXISTS ${T()}`);
		await conn.query(
			`CREATE TABLE ${T()} (id VARCHAR(80) PRIMARY KEY, value VARCHAR(255) NOT NULL)${
				isPostgres() ? '' : ' ENGINE=InnoDB'
			}`,
		);
	});

	beforeEach(async () => {
		await conn.query(`DELETE FROM ${T()}`);
		await conn.pquery(`INSERT INTO ${T()} (id, value) VALUES (:id, :value)`, {
			id: 'row',
			value: 'original',
		});
	});

	after(async () => {
		if (conn) await conn.query(`DROP TABLE IF EXISTS ${T()}`);
	});

	it('is exported, typed by code, and carries the reason', () => {
		expect(yass.TransactionCancelledError).to.equal(TransactionCancelledError);
		expect(TRANSACTION_CANCELLED).to.equal('YASS_TRANSACTION_CANCELLED');
		const reason = new Error('deadline');
		const err = new TransactionCancelledError(reason);
		expect(err).to.be.instanceOf(Error);
		expect(err.code).to.equal(TRANSACTION_CANCELLED);
		expect(err.reason).to.equal(reason);
		expect(err.cause).to.equal(reason);
		expect(err.message).to.contain('deadline');
	});

	it('a cancel during a held lock: the server rolls back, another connection gets the lock, nothing is committed', async () => {
		const held = gate();
		const locked = gate();
		const reason = new Error('fence hold deadline');
		let handle;
		let txSession;

		const running = settle(
			conn.transaction(async (tx) => {
				handle = tx;
				txSession = await sessionId(tx);
				await lockRow(tx, 'row');
				await tx.pquery(`UPDATE ${T()} SET value = :value WHERE id = :id`, {
					id: 'row',
					value: 'uncommitted',
				});
				locked.open();
				await held.promise;
				return 'body finished';
			}),
		);
		await locked.promise;

		// Another connection waits on the row lock the transaction holds
		let waiterGotLock = false;
		const waiter = conn.transaction(async (tx2) => {
			const rows = await lockRow(tx2, 'row');
			waiterGotLock = true;
			return rows[0].value;
		});
		await tick(300);
		expect(waiterGotLock).to.equal(false);

		expect(handle.cancel(reason)).to.equal(true);

		const outcome = await running;
		expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
		expect(outcome.error.reason).to.equal(reason);
		expect(outcome.error.cause).to.equal(reason);
		expect(outcome.error.transactionBegan).to.equal(true);

		// The waiter gets the lock and sees the row as it was
		expect(await waiter).to.equal('original');
		expect(await valueOf(conn, 'row')).to.equal('original');
		expect(await sessionAlive(conn, txSession)).to.equal(false);

		// The body resuming later changes nothing
		held.open();
		await tick(50);
		expect(await valueOf(conn, 'row')).to.equal('original');
	});

	describe('at pool size 1', () => {
		let small;

		beforeEach(async () => {
			small = await dbh({
				ignoreCachedConnections: true,
				connectionLimit: 1,
				minimumIdle: 1,
			});
		});

		afterEach(async () => {
			if (small) await small.end();
			small = null;
		});

		it('discards the connection without taking another, and the pool recovers', async () => {
			const held = gate();
			const ready = gate();
			let handle;
			let txSession;

			const running = settle(
				small.transaction(async (tx) => {
					handle = tx;
					txSession = await sessionId(tx);
					await tx.pquery(`UPDATE ${T()} SET value = :value WHERE id = :id`, {
						id: 'row',
						value: 'uncommitted',
					});
					ready.open();
					await held.promise;
				}),
			);
			await ready.promise;

			// The only connection is leased: a query on the pool has to wait
			const queued = settle(small.query('SELECT 1 AS one'));

			handle.cancel(new Error('deadline'));
			const outcome = await running;
			expect(outcome.error).to.be.instanceOf(TransactionCancelledError);

			// The queued query and the next ones run on a new connection
			const queuedOutcome = await queued;
			expect(queuedOutcome.error).to.equal(undefined);
			const nextSession = await sessionId(small);
			expect(nextSession).to.not.equal(txSession);
			expect(await valueOf(small, 'row')).to.equal('original');
			expect(await sessionAlive(conn, txSession)).to.equal(false);

			// And a whole transaction works again
			await small.transaction(async (tx) => {
				await tx.pquery(`UPDATE ${T()} SET value = :value WHERE id = :id`, {
					id: 'row',
					value: 'after',
				});
			});
			expect(await valueOf(conn, 'row')).to.equal('after');
			held.open();
		});

		it('a cancel after the commit does nothing to the (reused) connection', async () => {
			let handle;
			const txSession = await small.transaction(async (tx) => {
				handle = tx;
				return sessionId(tx);
			});
			expect(handle.cancel(new Error('too late'))).to.equal(false);
			expect(handle.isDoomed()).to.equal(false);
			expect(await sessionId(small)).to.equal(txSession);
		});

		it('a statement in flight, blocked on a row lock, is cancelled without a second connection', async () => {
			await conn.pquery(`INSERT INTO ${T()} (id, value) VALUES (:id, :value)`, {
				id: 'other',
				value: 'original',
			});

			// Another connection holds the row lock
			const holderLocked = gate();
			const holderRelease = gate();
			const holder = conn.transaction(async (tx) => {
				await lockRow(tx, 'row');
				holderLocked.open();
				await holderRelease.promise;
			});
			await holderLocked.promise;

			let handle;
			let txSession;
			let destroyCalls = 0;
			const writing = gate();
			const running = settle(
				small.transaction(async (tx) => {
					handle = tx;
					// The driver's destroy() opens a connection to KILL a statement
					// in flight: it must not be used.
					const { connection } = tx._transactionContext;
					const realDestroy = connection.destroy;
					connection.destroy = function countDestroy(...args) {
						destroyCalls += 1;
						return realDestroy.apply(this, args);
					};
					txSession = await sessionId(tx);
					await tx.pquery(`UPDATE ${T()} SET value = :value WHERE id = :id`, {
						id: 'other',
						value: 'uncommitted',
					});
					writing.open();
					await lockRow(tx, 'row'); // blocks behind the holder
				}),
			);
			await writing.promise;
			await tick(300); // the SELECT ... FOR UPDATE is waiting on the server

			const cancelledAt = Date.now();
			expect(handle.cancel(new Error('deadline'))).to.equal(true);
			const outcome = await running;
			expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
			expect(Date.now() - cancelledAt).to.be.below(2000);
			expect(destroyCalls).to.equal(0);

			// Nothing KILLed the session: it is still waiting on the lock
			expect(await sessionAlive(conn, txSession)).to.equal(true);

			// The pool recovers while the holder still holds the lock
			const nextSession = await sessionId(small);
			expect(nextSession).to.not.equal(txSession);

			// Once the holder lets go, the server ends the dead session and
			// nothing it wrote is committed
			holderRelease.open();
			await holder;
			const deadline = Date.now() + 10000;
			// eslint-disable-next-line no-await-in-loop
			while ((await sessionAlive(conn, txSession)) && Date.now() < deadline) {
				// eslint-disable-next-line no-await-in-loop
				await tick(100);
			}
			expect(await sessionAlive(conn, txSession)).to.equal(false);
			expect(await valueOf(conn, 'other')).to.equal('original');
			expect(await valueOf(small, 'row')).to.equal('original');
		});
	});

	it('the MySQL driver exposes the socket a cancel closes (mariadb is pinned)', async function socketHook() {
		if (isPostgres()) this.skip();
		expect(pkg.dependencies.mariadb).to.match(/^\d+\.\d+\.\d+$/);
		await conn.transaction(async (tx) => {
			const { connection } = tx._transactionContext;
			expect(connection.__tests.getSocket()).to.be.instanceOf(net.Socket);
		});
	});

	it('a MySQL connection without that socket hook is refused before BEGIN, and given back', async function noHook() {
		if (isPostgres()) this.skip();
		let released = 0;
		const fakeConnection = {
			query: async () => [],
			release: async () => {
				released += 1;
			},
		};
		const fakePool = { getConnection: async () => fakeConnection };
		let caught;
		try {
			await conn.dialect.acquireTransactionConnection(fakePool);
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(Error);
		expect(caught.message).to.match(/socket/);
		expect(released).to.equal(1);
	});

	it('is never retried, even when its reason is a deadlock or lock-wait timeout', async () => {
		const lockWait = Object.assign(new Error('Lock wait timeout exceeded'), {
			code: 'ER_LOCK_WAIT_TIMEOUT',
			errno: 1205,
		});
		const serialization = Object.assign(new Error('could not serialize'), {
			code: '40001',
		});
		expect(isRetryableTransactionError(lockWait)).to.equal(true);
		expect(
			isRetryableTransactionError(new TransactionCancelledError(lockWait)),
		).to.equal(false);
		expect(
			isRetryableTransactionError(new TransactionCancelledError(serialization)),
		).to.equal(false);

		// The default retry count, then a non-zero one
		const runsWith = async (options) => {
			let runs = 0;
			const outcome = await settle(
				conn.transaction(async (tx) => {
					runs += 1;
					tx.cancel(lockWait);
					await tx.query('SELECT 1 AS one');
				}, options),
			);
			expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
			expect(outcome.error.cause).to.equal(lockWait);
			return runs;
		};
		expect(await runsWith({})).to.equal(1);
		expect(await runsWith({ maxRetries: 3 })).to.equal(1);
	});

	it('sends no COMMIT after a cancel, even when the body catches and returns', async () => {
		const { dialect } = conn;
		const original = dialect.commitTransaction;
		let commits = 0;
		dialect.commitTransaction = function countCommit(...args) {
			commits += 1;
			return original.apply(this, args);
		};
		let caught;
		try {
			const outcome = await settle(
				conn.transaction(async (tx) => {
					await tx.pquery(`UPDATE ${T()} SET value = :value WHERE id = :id`, {
						id: 'row',
						value: 'uncommitted',
					});
					tx.cancel(new Error('deadline'));
					try {
						await tx.pquery(`INSERT INTO ${T()} (id, value) VALUES ('x', 'y')`);
					} catch (err) {
						caught = err;
					}
					return 'swallowed';
				}),
			);
			expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
		} finally {
			dialect.commitTransaction = original;
		}
		expect(caught).to.be.instanceOf(TransactionCancelledError);
		expect(commits).to.equal(0);
		expect(await valueOf(conn, 'row')).to.equal('original');
		expect(await valueOf(conn, 'x')).to.equal(null);
	});

	it('dooms the root synchronously, before the socket is gone: the next statement is never sent', async () => {
		const sent = [];
		const outcome = await settle(
			conn.transaction(async (tx) => {
				// The leased connection's own query: every statement reaches it
				const { connection } = tx._transactionContext;
				const realQuery = connection.query;
				connection.query = function spy(sql, ...rest) {
					sent.push(sql);
					return realQuery.call(this, sql, ...rest);
				};
				expect(tx.isDoomed()).to.equal(false);
				const wrapped = Object.create(tx); // as Tessera wraps a handle
				expect(wrapped.cancel(new Error('deadline'))).to.equal(true);
				// Same tick: doomed, and a statement rejects without being sent
				expect(tx.isDoomed()).to.equal(true);
				expect(wrapped.isDoomed()).to.equal(true);
				const statement = settle(tx.query('SELECT 1 AS one'));
				expect(tx.cancel(new Error('again'))).to.equal(false);
				const result = await statement;
				expect(result.error).to.be.instanceOf(TransactionCancelledError);
				expect(result.error.reason.message).to.equal('deadline');
			}),
		);
		expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
		expect(sent).to.deep.equal([]);
	});

	it('a nested handle dooms its root; the outer body cannot commit by catching', async () => {
		const outcome = await settle(
			conn.transaction(async (tx) => {
				await tx.pquery(`UPDATE ${T()} SET value = :value WHERE id = :id`, {
					id: 'row',
					value: 'outer',
				});
				try {
					await tx.transaction(async (nested) => {
						nested.cancel(new Error('from nested'));
						await nested.query('SELECT 1 AS one');
					});
				} catch (err) {
					// caught and ignored by the outer body
				}
				expect(tx.isDoomed()).to.equal(true);
				return 'ok';
			}),
		);
		expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
		expect(outcome.error.reason.message).to.equal('from nested');
		expect(await valueOf(conn, 'row')).to.equal('original');
	});

	it('an outstanding statement rejects with the cancel error, not a driver error', async () => {
		let statement;
		const outcome = await settle(
			conn.transaction(async (tx) => {
				statement = settle(
					tx.query(isPostgres() ? 'SELECT pg_sleep(0.5)' : 'SELECT SLEEP(0.5)'),
				);
				await tick(50);
				tx.cancel(new Error('deadline'));
				await statement;
			}),
		);
		expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
		const result = await statement;
		expect(result.error).to.be.instanceOf(TransactionCancelledError);
	});

	it('retryIfConnectionLost does not run a cancelled transaction again', async () => {
		let runs = 0;
		const outcome = await settle(
			retryIfConnectionLost(
				(db) =>
					db.transaction(async (tx) => {
						runs += 1;
						tx.cancel(new Error('deadline'));
						await tx.query('SELECT 1 AS one');
					}),
				{ handleFactory: async () => conn },
			),
		);
		expect(outcome.error).to.be.instanceOf(TransactionCancelledError);
		expect(runs).to.equal(1);
	});

	it('only a transaction handle has cancel() and isDoomed()', () => {
		expect(conn.cancel).to.equal(undefined);
		expect(conn.isDoomed).to.equal(undefined);
	});
});
