/* eslint-disable no-param-reassign */

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
		throw err;
	}
}

async function runRootTransaction(parent, callback, normalizedOptions) {
	const { dialect } = parent;
	const lease = await dialect.acquireTransactionConnection(parent);
	const context = { savepointCounter: 0 };
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

	if (primaryError) {
		if (typeof primaryError === 'object') {
			if (cleanupError) primaryError.cleanupError = cleanupError;
			if (releaseError) primaryError.releaseError = releaseError;
		}
		throw primaryError;
	}
	if (cleanupError) {
		cleanupError.transactionCommitted = committed;
		throw cleanupError;
	}
	if (releaseError) {
		releaseError.transactionCommitted = committed;
		throw releaseError;
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

module.exports = { isRetryableTransactionError, runTransaction };
