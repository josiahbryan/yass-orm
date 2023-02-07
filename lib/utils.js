/* eslint-disable no-console */
const { dbh: getDbh } = require('./dbh');

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

async function handle({ ignoreCachedConnections } = {}) {
	if (handle.accessInProgress) {
		return handle.accessInProgress;
	}

	handle.accessInProgress = defer();
	let newHandle = false;

	// Wrapping in try/catch so we can be sure our deferred promise is resolved
	try {
		if (!handle.dbh || ignoreCachedConnections) {
			handle.dbh = await getDbh({ ignoreCachedConnections }).catch((ex) => {
				console.error(`Async access caught error creating database handle`, ex);
			});
			newHandle = true;
		}
	} catch (ex) {
		console.error(`Error creating new database handle`, ex);
	}

	const { dbh } = handle;

	// console.log(`[yass-orm] handle() using dbh with threadId`, dbh.threadId);

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
		});
	}

	return dbh;
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

		result = await callback(dbh);
	} catch (ex) {
		if (
			ex.message &&
			(ex.message.includes(`Cannot execute new commands: connection closed`) ||
				ex.message.includes(`socket has unexpectedly been closed`) ||
				ex.message.includes('NULL_HANDLE'))
		) {
			retry = true;
		} else {
			throw ex;
		}
	}

	// We don't catch in the retry, allowing errors to bubble
	if (retry) {
		const dbh = await handleFactory({ ignoreCachedConnections: true });
		if (!dbh) {
			throw new Error(
				'NULL_HANDLE: Handle factory returned null even after passing ignoreCachedConnections, throwing to capture stack for troubleshooting. This should never happen.',
			);
		}

		result = await callback(dbh);
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

		// console.warn(`exponentialDelayFactory: attempt=${attempt}, delay=${delay}`);
		return delay;
	};

	generator.reset = () => {
		attempt = 0;
	};

	return generator;
}

module.exports = {
	clamp,
	exponentialDelayFactory,
	handle,
	defer,
	retryIfConnectionLost,
	CodeTimingHelper,
};
