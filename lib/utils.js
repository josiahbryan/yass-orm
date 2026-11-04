/* eslint-disable no-console */
const { dbh: getDbh, onConnectionsClosed } = require('./dbh');
const {
	markBegan,
	retryScopeMayHaveWritten,
	runInRetryScope,
	transactionBegan,
} = require('./transactions');
const {
	isConnectionLost,
	isRefused,
	isWriteOutcomeUnknown,
	WriteOutcomeUnknownError,
} = require('./write-safety');
const { isUniqueViolation, isConstraintError } = require('./db-errors');

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

// A NaN window makes `remaining` NaN and `NaN <= 0` false, so the loop would
// retry forever; Infinity is the same unbounded retry by another name.
const assertRetryWindowMs = (ms) => {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
		throw new TypeError(
			`retry window must be a finite, non-negative number of ms, got ${String(
				ms,
			)}`,
		);
	}
	return ms;
};

const setConnectRetryWindowMs = (ms) => {
	connectRetryWindowMs = assertRetryWindowMs(ms);
};

const realSleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Runs `callback(dbh)`, and runs it again on a lost connection, with backoff,
 * for up to `retryWindowMs` (BDL-4386), but never once a write it sent may
 * have landed: then it rejects with WriteOutcomeUnknownError (BDL-4470; the
 * policy is in lib/write-safety.js). A transaction that got past BEGIN is
 * never re-run either (`transactionBegan`).
 *
 * @param {Function} callback `(dbh) => Promise`, run once per attempt
 * @param {Object} [options]
 * @param {boolean} [options.idempotent] Running `callback` again is safe even
 * 	after its writes landed (e.g. it sets absolute values, or checks for its
 * 	own earlier write). Default false.
 */
// Handle options that abandon the pool a dead connection came from.
const REPLACE_DEAD_POOL = Object.freeze({
	ignoreCachedConnections: true,
	closeReplacedPool: true,
});

async function retryIfConnectionLost(
	callback,
	{
		handleFactory = handle,
		retryWindowMs = connectRetryWindowMs,
		sleep = realSleep,
		now = Date.now,
		onReconnectRetryFailed: onFailed = onReconnectRetryFailed,
		idempotent = false,
	} = {},
) {
	assertRetryWindowMs(retryWindowMs);
	const startedAt = now();
	const nextDelay = exponentialDelayFactory();
	// Options for the NEXT handle: the first attempt uses the cached pool.
	let handleOptions;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		// The attempt's retry scope; unset until the callback runs.
		let scope;
		try {
			// eslint-disable-next-line no-await-in-loop
			const dbh = await handleFactory(handleOptions);
			if (!dbh) {
				throw new Error(
					'NULL_HANDLE: Handle factory returned null, failing so we retry without cache',
				);
			}

			// Every attempt gets its own scope, so a transaction that got past
			// BEGIN on ANY attempt (its COMMIT may have landed), or a write that
			// may have landed, is never re-run.
			const attempt = runInRetryScope(() => callback(dbh));
			({ scope } = attempt);
			try {
				// eslint-disable-next-line no-await-in-loop
				return await attempt.promise;
			} catch (ex) {
				throw markBegan(ex, scope.began);
			}
		} catch (ex) {
			if (transactionBegan(ex) || isWriteOutcomeUnknown(ex)) throw ex;
			const died = isConnectionLost(ex);
			if (!died && !isRefused(ex)) {
				throw ex;
			}
			if (!idempotent && retryScopeMayHaveWritten(scope)) {
				// Not retried, but the dead pool is still replaced (in the
				// background), so the next call does not land on it too.
				if (died) {
					Promise.resolve()
						.then(() => handleFactory(REPLACE_DEAD_POOL))
						.catch(() => {});
				}
				throw new WriteOutcomeUnknownError(ex);
			}

			const remaining = retryWindowMs - (now() - startedAt);
			if (remaining <= 0) {
				// Window exhausted. A dead connection goes to the failure handler
				// (default: process.exit(1)); a refused connection is rethrown, as it
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
			handleOptions = died ? REPLACE_DEAD_POOL : undefined;

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
