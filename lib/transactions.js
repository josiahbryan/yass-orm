/* eslint-disable no-param-reassign, no-console */
const { AsyncLocalStorage } = require('node:async_hooks');
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

function createTransactionHandle(parent, connection, context) {
	const tx = Object.create(parent);

	// pquery and all higher-level dbh helpers deliberately come from `parent`.
	// They dispatch through `this.query`, so replacing only query pins every
	// helper to the leased physical connection without duplicating dbh's API.
	tx.query = connection.query.bind(connection);
	tx.roQuery = function roQuery(sql, params, opts = {}) {
		return this.pquery(sql, params, opts);
	};
	tx._transactionContext = context;

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
	const context = { savepointCounter: 0, listeners: [], locals: new Map() };
	const tx = createTransactionHandle(parent, lease.connection, {
		context,
	});
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
		result = await callback(tx);
		await dialect.commitTransaction(lease.connection);
		began = false;
		committed = true;
	} catch (err) {
		primaryError = err;
		if (began) {
			try {
				await dialect.rollbackTransaction(lease.connection);
			} catch (rollbackError) {
				if (err && typeof err === 'object') err.rollbackError = rollbackError;
			}
		}
	}

	let cleanupError;
	try {
		await dialect.cleanupTransaction(lease.connection, transactionState);
	} catch (err) {
		cleanupError = err;
	}

	let releaseError;
	try {
		await lease.release();
	} catch (err) {
		releaseError = err;
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

function isRetryableTransactionError(err) {
	if (err && err.transactionCommitted) return false;
	let current = err;
	while (current) {
		const code = current.code || current.sqlState;
		if (
			['40001', '40P01', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(
				`${code}`,
			) ||
			[1205, 1213].includes(current.errno) ||
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
	isRetryableTransactionError,
	markBegan,
	onTransactionEnd,
	runInRetryScope,
	runTransaction,
	transactionLocal,
};
