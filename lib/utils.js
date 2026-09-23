/* eslint-disable no-console */
const { dbh: getDbh, onConnectionsClosed } = require('./dbh');
const { markBegan, runInRetryScope } = require('./transactions');

const DEFAULT_ON_RETRY_CONNECT_FAILURE = (ex) => {
	console.error(
		`[yass-orm] onReconnectRetryFailed: caught error, exiting application because retry failed. You can change this behavior using setOnConnectRetryFailed. Error was:`,
		ex,
	);

	process.exit(1);
};

let onReconnectRetryFailed = DEFAULT_ON_RETRY_CONNECT_FAILURE;

const setOnConnectRetryFailed = (cb) => {
	onReconnectRetryFailed = cb;
};

// Modified from http://lea.verou.me/2016/12/resolve-promises-externally-with-this-one-weird-trick/
function defer(cb = () => {}) {
	let res;
	let rej;

	const promise = new Promise((resolve, reject) => {
		res = resolve;
		rej = reject;
		cb(resolve, reject);
	});

	promise.resolve = res;
	promise.reject = rej;

	return promise;
}

// closeAllConnections() closed the pool behind the cached handle. The count
// lets handle() notice a close that lands while it awaits a handle.
let connectionsClosedCount = 0;

async function handle({ ignoreCachedConnections, ...options } = {}) {
	if (handle.accessInProgress) {
		return handle.accessInProgress;
	}

	handle.accessInProgress = defer();
	let newHandle = false;

	// Wrapping in try/catch so we can be sure our deferred promise is resolved
	try {
		if (!handle.dbh || ignoreCachedConnections) {
			let closesBefore;
			do {
				closesBefore = connectionsClosedCount;
				// eslint-disable-next-line no-await-in-loop
				handle.dbh = await getDbh({
					ignoreCachedConnections,
					...options,
				}).catch((ex) => {
					console.error(
						`Async access caught error creating database handle`,
						ex,
					);
				});
				// A closeAllConnections() during the await may have closed the
				// cached pool just handed back: fetch again, from a new pool.
			} while (
				!ignoreCachedConnections &&
				closesBefore !== connectionsClosedCount
			);
			newHandle = true;
		}
	} catch (ex) {
		console.error(`Error creating new database handle`, ex);
	}

	const { dbh } = handle;

	handle.accessInProgress.resolve(dbh);
	handle.accessInProgress = undefined;

	// External debugging of handle access
	if (
		handle.onHandleAccessDebug &&
		typeof handle.onHandleAccessDebug === 'function'
	) {
		handle.onHandleAccessDebug(dbh, {
			cacheMiss: newHandle,
			ignoreCachedConnections,
			...options,
		});
	}

	return dbh;
}

onConnectionsClosed(() => {
	handle.dbh = undefined;
	connectionsClosedCount += 1;
});

function isConnectionLost(ex) {
	const message = ex && ex.message;
	return (
		typeof message === 'string' &&
		(message.includes(`Cannot execute new commands: connection closed`) ||
			message.includes(`socket has unexpectedly been closed`) ||
			message.includes('NULL_HANDLE'))
	);
}

async function retryIfConnectionLost(
	callback,
	{ handleFactory = handle } = {},
) {
	// Wrap the callback and catch errors,
	// retrying ONLY if 'connection closed'
	let retry = false;
	let result;
	try {
		const dbh = await handleFactory();
		if (!dbh) {
			throw new Error(
				'NULL_HANDLE: Handle factory returned null, failing so we retry without cache',
			);
		}

		const { scope, promise } = runInRetryScope(() => callback(dbh));
		try {
			result = await promise;
		} catch (ex) {
			// Retrying re-runs the whole callback: one in which a transaction got
			// past BEGIN (its COMMIT may have landed) is never run again.
			throw markBegan(ex, scope.began);
		}
	} catch (ex) {
		if (isConnectionLost(ex) && !ex.transactionBegan) {
			retry = true;
		} else {
			throw ex;
		}
	}

	// We don't catch in the retry, allowing errors to bubble
	if (retry) {
		// `closeReplacedPool: true` — the connection we just used is dead, so the
		// pool it came from is being abandoned here. Close it as we swap in the
		// fresh pool so its remaining connections are released instead of
		// orphaned (orphaned pools linger server-side and, under load, stack up
		// to exhaust `max_connections`). Opt-in so only this known-bad-pool
		// recovery path triggers the close, never plain ignoreCachedConnections.
		const dbh = await handleFactory({
			ignoreCachedConnections: true,
			closeReplacedPool: true,
		});
		if (!dbh) {
			throw new Error(
				'NULL_HANDLE: Handle factory returned null even after passing ignoreCachedConnections, throwing to capture stack for troubleshooting. This should never happen.',
			);
		}

		try {
			result = await callback(dbh);
		} catch (ex) {
			if (onReconnectRetryFailed && isConnectionLost(ex)) {
				return onReconnectRetryFailed(ex);
			}

			throw ex;
		}
	}

	return result;
}

const monkeyConsole = console;
// Other loggers have .debug, but .debug on console is often silenced, so elevate;
monkeyConsole.debug = monkeyConsole.log;

class CodeTimingHelper {
	constructor(title = '') {
		this.title = title;
		this.marks = [];
	}

	mark(name = '') {
		if (!this.start) {
			this.start = Date.now();
		}

		this.marks.push({
			name,
			at: Date.now(),
		});
	}

	dump({ logger: inputLogger } = {}) {
		const logger = inputLogger || monkeyConsole;
		const { title, marks } = this;

		logger.debug(`>>>>>> CodeTimingHelper [${title || 'unamed'}] >>>>>>`);

		let lastMark;
		marks.forEach((mark) => {
			const { name, at } = mark;
			const { name: lastName, at: lastAt } = lastMark || {};

			if (lastAt) {
				const diff = at - lastAt;
				logger.debug(` * ${diff} ms  \t ${lastName} > ${name}`);
			}

			lastMark = mark;
		});

		if (lastMark) {
			const { name, at } = lastMark;
			const diff = Date.now() - at;
			logger.debug(` * ${diff} ms  \t ${name} > (-end-)`);
		}

		logger.debug(`<<<<<< CodeTimingHelper [${title || 'unamed'}] <<<<<<`);
	}

	stringify() {
		const { title, marks } = this;
		const buffer = [];

		buffer.push(`>>>>>> CodeTimingHelper [${title || 'unamed'}] >>>>>>`);

		let lastMark;
		marks.forEach((mark) => {
			const { name, at } = mark;
			const { name: lastName, at: lastAt } = lastMark || {};

			if (lastAt) {
				const diff = at - lastAt;
				buffer.push(` * ${diff} ms  \t ${lastName} > ${name}`);
			}

			lastMark = mark;
		});

		if (lastMark) {
			const { name, at } = lastMark;
			const diff = Date.now() - at;
			buffer.push(` * ${diff} ms  \t ${name} > (-end-)`);
		}

		buffer.push(`<<<<<< CodeTimingHelper [${title || 'unamed'}] <<<<<<`);
		return buffer.join('\n');
	}
}

function clamp(val, min, max) {
	if (val < min) {
		return min;
	}
	if (val > max) {
		return max;
	}
	return val;
}

function exponentialDelayFactory({
	initialDelay = 500,
	maxDelay = 5000,
	multiplier = 1.33,
} = {}) {
	let attempt = 0;
	const generator = () => {
		attempt += 1;
		const delay = Math.floor(
			clamp(initialDelay * multiplier ** (attempt - 1), initialDelay, maxDelay),
		);

		return delay;
	};

	generator.reset = () => {
		attempt = 0;
	};

	return generator;
}

/**
 * Recognize a UNIQUE/PRIMARY KEY violation across MySQL, MariaDB,
 * Postgres, and SQLite — including errors wrapped by yass-orm's
 * `wrapQueryError`, which preserves `.code`, `.errno`, `.sqlState`,
 * and `.cause` on the wrapped Error.
 *
 * Driver signatures recognized:
 *   - MySQL/MariaDB: `ER_DUP_ENTRY` / errno 1062 / sqlState 23000
 *   - Postgres:      sqlState 23505 (unique_violation); node-postgres puts
 *                    the SQLSTATE on `code`
 *   - SQLite:        `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_PRIMARYKEY`
 */
function _matchesUniqueSignature(e) {
	if (!e || typeof e !== 'object') return false;
	const { code, errno, sqlState } = e;
	if (code === 'ER_DUP_ENTRY') return true;
	if (errno === 1062) return true;
	if (sqlState === '23000' || sqlState === '23505') return true;
	// Postgres via node-postgres: the SQLSTATE is `code`.
	if (code === '23505') return true;
	if (
		code === 'SQLITE_CONSTRAINT_UNIQUE' ||
		code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
	) {
		return true;
	}
	return false;
}

function isUniqueViolation(err) {
	if (!err || typeof err !== 'object') return false;
	if (_matchesUniqueSignature(err) || _matchesUniqueSignature(err.cause)) {
		return true;
	}
	// Last-resort message scan for drivers that strip codes.
	const msg = err.message || '';
	if (typeof msg === 'string') {
		if (/\bno:\s*1062\b/.test(msg)) return true;
		if (/\bSQLState:\s*230(00|05)\b/.test(msg)) return true;
	}
	return false;
}

/**
 * Recognize any constraint violation — UNIQUE/PK, CHECK, NOT NULL, FK.
 * Broader than `isUniqueViolation`; use when you want to catch
 * "anything the database rejected" rather than specifically dup-key.
 */
function _matchesConstraintSignature(e) {
	if (!e || typeof e !== 'object') return false;
	const { code, sqlState, errno } = e;
	// Postgres class 23: integrity constraint violation
	if (typeof sqlState === 'string' && sqlState.startsWith('23')) return true;
	// Postgres via node-postgres: the SQLSTATE is `code` (five characters).
	if (typeof code === 'string' && /^23[0-9A-Z]{3}$/.test(code)) return true;
	if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
		return true;
	}
	// MySQL: ER_BAD_NULL_ERROR (1048), ER_ROW_IS_REFERENCED_2 (1451),
	// ER_NO_REFERENCED_ROW_2 (1452), ER_CHECK_CONSTRAINT_VIOLATED (3819).
	if (errno === 1048 || errno === 1451 || errno === 1452 || errno === 3819) {
		return true;
	}
	return false;
}

function isConstraintError(err) {
	if (!err || typeof err !== 'object') return false;
	if (isUniqueViolation(err)) return true;
	return (
		_matchesConstraintSignature(err) || _matchesConstraintSignature(err.cause)
	);
}

module.exports = {
	clamp,
	exponentialDelayFactory,
	handle,
	defer,
	retryIfConnectionLost,
	CodeTimingHelper,
	setOnConnectRetryFailed,
	isUniqueViolation,
	isConstraintError,
};
