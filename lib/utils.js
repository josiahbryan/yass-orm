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

// Errors that mean the connection the query ran on DIED. The pool it came
// from is abandoned and replaced on retry. Matched by message (the historic
// shapes) and by driver code/errno.
const CONNECTION_DIED_CODES = new Set([
	'PROTOCOL_CONNECTION_LOST',
	'ER_SOCKET_UNEXPECTED_CLOSE', // mariadb 45009
	'ER_CMD_CONNECTION_CLOSED', // mariadb 45013
]);
const CONNECTION_DIED_ERRNOS = new Set([45009, 45013]);

// Errors where the query was NEVER SENT (no connection could be had), so a
// retry cannot double-apply anything. Retried on the SAME pool: 45028 also
// fires on plain pool exhaustion under load, where ending the cached pool
// would fail every sibling query using it.
//
// Deliberately NOT here: ECONNRESET. A reset mid-query on an autocommit write
// may land after the server committed, so re-running it could double-write.
const NEVER_SENT_CODES = new Set([
	'ER_GET_CONNECTION_TIMEOUT', // mariadb 45028, pool acquire timeout
	'ECONNREFUSED',
]);
const NEVER_SENT_ERRNOS = new Set([45028]);

function isConnectionLost(ex) {
	if (!ex) return false;
	const { message, code, errno } = ex;
	if (CONNECTION_DIED_CODES.has(code) || CONNECTION_DIED_ERRNOS.has(errno)) {
		return true;
	}
	return (
		typeof message === 'string' &&
		(message.includes(`Cannot execute new commands: connection closed`) ||
			message.includes(`socket has unexpectedly been closed`) ||
			message.includes('NULL_HANDLE'))
	);
}

function isNeverSent(ex) {
	return Boolean(
		ex && (NEVER_SENT_CODES.has(ex.code) || NEVER_SENT_ERRNOS.has(ex.errno)),
	);
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

// Total wall-clock time a lost connection is retried before giving up.
// Long enough to ride out a managed-DB switchover (DigitalOcean warns of
// "brief connection errors"), short enough not to hold requests forever.
const DEFAULT_CONNECT_RETRY_WINDOW_MS = 30000;
let connectRetryWindowMs = DEFAULT_CONNECT_RETRY_WINDOW_MS;

const setConnectRetryWindowMs = (ms) => {
	connectRetryWindowMs = ms;
};

const realSleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

async function retryIfConnectionLost(
	callback,
	{
		handleFactory = handle,
		retryWindowMs = connectRetryWindowMs,
		sleep = realSleep,
		now = Date.now,
		onReconnectRetryFailed: onFailed = onReconnectRetryFailed,
	} = {},
) {
	const startedAt = now();
	const nextDelay = exponentialDelayFactory();
	// Options for the NEXT handle: the first attempt uses the cached pool.
	let handleOptions;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			// eslint-disable-next-line no-await-in-loop
			const dbh = await handleFactory(handleOptions);
			if (!dbh) {
				throw new Error(
					'NULL_HANDLE: Handle factory returned null, failing so we retry without cache',
				);
			}

			// Every attempt gets its own scope, so a transaction that got past
			// BEGIN on ANY attempt (its COMMIT may have landed) is never re-run.
			const { scope, promise } = runInRetryScope(() => callback(dbh));
			try {
				// eslint-disable-next-line no-await-in-loop
				return await promise;
			} catch (ex) {
				throw markBegan(ex, scope.began);
			}
		} catch (ex) {
			const died = isConnectionLost(ex);
			const neverSent = !died && isNeverSent(ex);
			if ((!died && !neverSent) || ex.transactionBegan) {
				throw ex;
			}

			const remaining = retryWindowMs - (now() - startedAt);
			if (remaining <= 0) {
				// Window exhausted. A dead connection goes to the failure handler
				// (default: process.exit(1)); a never-sent error is rethrown, as it
				// always was, so a long pool-exhaustion stall cannot exit the app.
				if (died && onFailed) {
					return onFailed(ex);
				}
				throw ex;
			}

			// `closeReplacedPool: true` — the connection we just used is dead, so
			// the pool it came from is being abandoned here. Close it as we swap in
			// the fresh pool so its remaining connections are released instead of
			// orphaned (orphaned pools linger server-side and, under load, stack up
			// to exhaust `max_connections`). Opt-in so only this known-bad-pool
			// recovery path triggers the close, never plain ignoreCachedConnections.
			handleOptions = died
				? { ignoreCachedConnections: true, closeReplacedPool: true }
				: undefined;

			// eslint-disable-next-line no-await-in-loop
			await sleep(Math.min(nextDelay(), remaining));
		}
	}
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
	setConnectRetryWindowMs,
	DEFAULT_CONNECT_RETRY_WINDOW_MS,
	isConnectionLost,
	isUniqueViolation,
	isConstraintError,
};
