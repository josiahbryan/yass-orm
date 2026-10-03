/* eslint-disable no-param-reassign, no-console */
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const { promiseMap } = require('./promiseMap');

// One scope per retryIfConnectionLost attempt, so it can tell whether a
// transaction began anywhere in its callback (see runInRetryScope).
const retryScopes = new AsyncLocalStorage();

function transactionContext(tx) {
	return (
		(tx && tx._transactionContext && tx._transactionContext.context) || null
	);
}

/**
 * Per-transaction state for other modules: returns the value stored under
 * `key` on `tx`'s transaction, creating it with `factory()` the first time.
 * Nested transactions share their root's slots.
 *
 * @returns {*} The stored value, or null when `tx` is not a transaction handle
 */
function transactionLocal(tx, key, factory) {
	const context = transactionContext(tx);
	if (!context) return null;
	if (!context.locals.has(key)) context.locals.set(key, factory());
	return context.locals.get(key);
}

/**
 * When `tx`'s root transaction started (`performance.now()`, taken just before
 * BEGIN): its snapshot can be that old, so a row read in it is stamped with
 * this (see LOADED_AT in lib/model/loaded-at.js).
 *
 * @returns {number|null} null when `tx` is not a transaction handle
 */
function transactionStartedAt(tx) {
	const context = transactionContext(tx);
	return context ? context.startedAt : null;
}

/**
 * Registers `listener` for how the transaction `tx` ends. Hooks, each optional:
 *   - `commit()`: the root transaction committed
 *   - `rollback()`: the root transaction rolled back (or never began)
 *   - `savepointRollback()`: a nested transaction rolled back to its savepoint;
 *     the root may still commit
 * They run after the transaction ends. A hook that throws is logged, never
 * rethrown: by then the transaction's outcome is settled.
 *
 * @returns {boolean} false when `tx` is not a transaction handle (nothing registered)
 */
function onTransactionEnd(tx, listener) {
	const context = transactionContext(tx);
	if (!context) return false;
	context.listeners.push(listener);
	return true;
}

async function notifyListeners(context, event) {
	if (!context.listeners.length) return;
	const hooks = context.listeners
		.map((listener) => listener[event])
		.filter((hook) => typeof hook === 'function');
	await promiseMap(hooks, async (hook) => {
		try {
			await hook();
		} catch (err) {
			console.error(`[yass-orm] transaction ${event} listener failed:`, err);
		}
	});
}

const TRANSACTION_CANCELLED = 'YASS_TRANSACTION_CANCELLED';

/**
 * What a cancelled transaction rejects with (`tx.cancel(reason)`): the
 * transaction() call, the statement that was in flight and every statement
 * after it. `reason` is kept as `reason` and as `cause`.
 */
class TransactionCancelledError extends Error {
	constructor(reason) {
		let why = '';
		if (reason instanceof Error) why = reason.message;
		else if (reason !== undefined) why = String(reason);
		super(
			why ? `Transaction cancelled: ${why}` : 'Transaction cancelled',
			reason === undefined ? undefined : { cause: reason },
		);
		this.name = 'TransactionCancelledError';
		this.code = TRANSACTION_CANCELLED;
		this.reason = reason;
	}
}

/**
 * Cancels the root transaction of `tx` (see tx.cancel in
 * createTransactionHandle).
 *
 * @returns {boolean} true when this call doomed it
 */
function cancelTransaction(tx, reason) {
	const context = transactionContext(tx);
	if (!context) {
		throw new TypeError('cancel() needs a transaction handle');
	}
	// Once COMMIT is sent, or the transaction has ended (its connection may
	// already serve someone else), there is nothing left to cancel.
	if (context.doomed || context.phase !== 'open') return false;
	context.doomed = new TransactionCancelledError(reason);
	context.onCancel(context.doomed);
	return true;
}

// A statement on a transaction handle: never sent once the root is doomed,
// and one in flight when it is doomed rejects with the cancel error rather
// than the driver's error for the closed socket.
function runStatement(state, args) {
	const { context, connection } = state;
	if (context.doomed) return Promise.reject(context.doomed);
	return Promise.resolve(connection.query(...args)).catch((err) => {
		throw context.doomed || err;
	});
}

function createTransactionHandle(parent, connection, context) {
	const tx = Object.create(parent);
	const state = { context, connection };

	// pquery and all higher-level dbh helpers deliberately come from `parent`.
	// They dispatch through `this.query`, so replacing only query pins every
	// helper to the leased physical connection without duplicating dbh's API.
	tx.query = function query(...args) {
		return runStatement(state, args);
	};
	tx.roQuery = function roQuery(sql, params, opts = {}) {
		return this.pquery(sql, params, opts);
	};
	/**
	 * Cancels the root transaction, from outside its body (a holder past its
	 * deadline): synchronously and for good, it is doomed, so no COMMIT is
	 * sent and every later statement rejects with a TransactionCancelledError
	 * without being sent; then the leased connection's socket is closed (the
	 * server rolls back on disconnect and releases the locks) and the
	 * connection is discarded from the pool, not returned. transaction()
	 * rejects with the error at once, even if the body is still awaiting.
	 * No second connection is used. Works from a nested transaction's handle
	 * and from an object made with Object.create(tx). Does nothing, returning
	 * false, once the root is already doomed, COMMIT has been sent or the
	 * transaction has ended. (SQLite has no socket: the root is doomed and
	 * rolled back.)
	 *
	 * @param {*} [reason] Kept as the error's `reason` and `cause`
	 * @returns {boolean} true when this call doomed the transaction
	 */
	tx.cancel = function cancel(reason) {
		return cancelTransaction(this, reason);
	};
	/** @returns {boolean} true once the root transaction has been cancelled */
	tx.isDoomed = function isDoomed() {
		const root = transactionContext(this);
		return Boolean(root && root.doomed);
	};
	tx._transactionContext = state;

	return tx;
}

async function runNestedTransaction(parent, callback, options) {
	if (Object.keys(options).length) {
		throw new Error(
			'Nested transaction options are not supported; isolation and access mode are inherited from the outer transaction',
		);
	}

	const { context } = parent._transactionContext;
	context.savepointCounter += 1;
	const name = `yass_orm_sp_${context.savepointCounter}`;
	await parent.query(`SAVEPOINT ${name}`);

	try {
		const result = await callback(parent);
		await parent.query(`RELEASE SAVEPOINT ${name}`);
		return result;
	} catch (err) {
		try {
			await parent.query(`ROLLBACK TO SAVEPOINT ${name}`);
			await parent.query(`RELEASE SAVEPOINT ${name}`);
		} catch (rollbackError) {
			if (err && typeof err === 'object') err.rollbackError = rollbackError;
		}
		await notifyListeners(context, 'savepointRollback');
		throw err;
	}
}

/**
 * Marks an error from a transaction that got past BEGIN
 * (`err.transactionBegan = true`). retryIfConnectionLost never retries such an
 * error: a connection lost in the callback, or after COMMIT was sent but
 * before its reply, would otherwise run the whole transaction again (a double
 * apply when the COMMIT had landed).
 */
function markBegan(err, began) {
	if (began && err && typeof err === 'object') err.transactionBegan = true;
	return err;
}

/**
 * Runs `callback` in a scope that records whether a root transaction got past
 * BEGIN while it ran, including under a retryIfConnectionLost nested in it.
 * The callback of retryIfConnectionLost is re-run as a whole, so one that
 * committed a transaction and then lost the connection must not be retried.
 *
 * @returns {{ scope: { began: boolean }, promise: Promise }}
 */
function runInRetryScope(callback) {
	const scope = { began: false, parent: retryScopes.getStore() };
	return { scope, promise: retryScopes.run(scope, callback) };
}

function markRetryScopesBegan() {
	for (let scope = retryScopes.getStore(); scope && !scope.began; ) {
		scope.began = true;
		scope = scope.parent;
	}
}

async function runRootTransaction(parent, callback, normalizedOptions) {
	const { dialect } = parent;
	const lease = await dialect.acquireTransactionConnection(parent);
	let discarded = false;
	let rejectCancelled;
	const cancelled = new Promise((resolve, reject) => {
		rejectCancelled = reject;
	});
	const context = {
		savepointCounter: 0,
		listeners: [],
		locals: new Map(),
		startedAt: performance.now(),
		// 'open' until COMMIT is sent, then 'committing'; 'ended' before the
		// connection is released. cancel() acts only while 'open'.
		phase: 'open',
		doomed: null,
		onCancel(err) {
			if (typeof lease.discard === 'function') {
				discarded = true;
				lease.discard(err);
			}
			rejectCancelled(err);
		},
	};
	const tx = createTransactionHandle(parent, lease.connection, context);
	let began = false;
	let transactionState;
	let primaryError;
	let result;
	let committed = false;

	try {
		transactionState = await dialect.beginTransaction(
			lease.connection,
			normalizedOptions,
		);
		began = true;
		markRetryScopesBegan();
		// A cancel rejects at once, whatever the body is awaiting; the body's
		// own outcome after that is ignored (race handles its rejection).
		result = await Promise.race([
			new Promise((resolve) => {
				resolve(callback(tx));
			}),
			cancelled,
		]);
		// Checked and set in the same tick as COMMIT is sent: a cancel either
		// came first, or finds 'committing' and does nothing.
		if (context.doomed) throw context.doomed;
		context.phase = 'committing';
		await dialect.commitTransaction(lease.connection);
		began = false;
		committed = true;
	} catch (err) {
		primaryError = context.doomed || err;
		if (began && !discarded) {
			try {
				await dialect.rollbackTransaction(lease.connection);
			} catch (rollbackError) {
				if (err && typeof err === 'object') err.rollbackError = rollbackError;
			}
		}
	}

	// The transaction is over (a cancel may have come during the rollback):
	// from here the connection goes back to the pool, so a later cancel() must
	// not touch it.
	context.phase = 'ended';
	if (context.doomed) primaryError = context.doomed;

	// A discarded connection has no session to clean up and is not released.
	let cleanupError;
	let releaseError;
	if (!discarded) {
		try {
			await dialect.cleanupTransaction(lease.connection, transactionState);
		} catch (err) {
			cleanupError = err;
		}
		try {
			await lease.release();
		} catch (err) {
			releaseError = err;
		}
	}

	await notifyListeners(context, committed ? 'commit' : 'rollback');
	// The transaction is over: let go of its listeners and whatever they hold.
	context.listeners = [];
	context.locals.clear();

	// Past BEGIN, the callback may have written and COMMIT may have been sent:
	// no error from here may lead to the transaction running again.
	const beganOnce = began || committed;
	if (primaryError) {
		if (typeof primaryError === 'object') {
			if (cleanupError) primaryError.cleanupError = cleanupError;
			if (releaseError) primaryError.releaseError = releaseError;
		}
		throw markBegan(primaryError, beganOnce);
	}
	if (cleanupError) {
		cleanupError.transactionCommitted = committed;
		throw markBegan(cleanupError, beganOnce);
	}
	if (releaseError) {
		releaseError.transactionCommitted = committed;
		throw markBegan(releaseError, beganOnce);
	}
	return result;
}

// ER_TABLE_DEF_CHANGED (1412): MySQL refused the transaction a table made
// or altered after its first read, and asks for it to be run again.
// A cancelled transaction (tx.cancel) is never retried, whatever its reason
// (its `cause`) is: whoever cancelled it decides what happens next.
function isRetryableTransactionError(err) {
	if (err && err.transactionCommitted) return false;
	let current = err;
	while (current) {
		if (current.code === TRANSACTION_CANCELLED) return false;
		const code = current.code || current.sqlState;
		if (
			[
				'40001',
				'40P01',
				'ER_LOCK_DEADLOCK',
				'ER_LOCK_WAIT_TIMEOUT',
				'ER_TABLE_DEF_CHANGED',
			].includes(`${code}`) ||
			[1205, 1213, 1412].includes(current.errno) ||
			`${code}`.startsWith('SQLITE_BUSY') ||
			`${code}`.startsWith('SQLITE_LOCKED')
		) {
			return true;
		}
		current = current.cause;
	}
	return false;
}

async function runTransaction(parent, callback, options = {}) {
	if (typeof callback !== 'function') {
		throw new TypeError('transaction(callback, options) requires a callback');
	}
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('Transaction options must be an object');
	}

	if (parent._transactionContext) {
		return runNestedTransaction(parent, callback, options);
	}

	const { maxRetries = 0, ...dialectOptions } = options;
	if (!Number.isInteger(maxRetries) || maxRetries < 0) {
		throw new TypeError(
			'Transaction maxRetries must be a non-negative integer',
		);
	}
	const normalizedOptions =
		parent.dialect.normalizeTransactionOptions(dialectOptions);

	const executeAttempt = async (attempt) => {
		try {
			return await runRootTransaction(parent, callback, normalizedOptions);
		} catch (err) {
			if (attempt >= maxRetries || !isRetryableTransactionError(err)) {
				throw err;
			}
			return executeAttempt(attempt + 1);
		}
	};

	return executeAttempt(0);
}

module.exports = {
	TRANSACTION_CANCELLED,
	TransactionCancelledError,
	isRetryableTransactionError,
	markBegan,
	onTransactionEnd,
	runInRetryScope,
	runTransaction,
	transactionLocal,
	transactionStartedAt,
};
