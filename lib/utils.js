const { dbh: getDbh } = require('./dbh');

async function handle({ ignoreCachedConnections } = {}) {
	let newHandle = false;
	if (!handle.dbh || ignoreCachedConnections) {
		handle.dbh = await getDbh({ ignoreCachedConnections });
		newHandle = true;
	}

	const { dbh } = handle;

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

async function retryIfConnectionLost(callback) {
	// Wrap the callback and catch errors,
	// retrying ONLY if 'connection closed'
	let retry = false;
	let result;
	try {
		result = await callback(await handle());
	} catch (ex) {
		if (
			ex.message &&
			(ex.message.includes(`Cannot execute new commands: connection closed`) ||
				ex.message.includes(`socket has unexpectedly been closed`))
		) {
			retry = true;
		} else {
			throw ex;
		}
	}

	// We don't catch in the retry, allowing errors to bubble
	if (retry) {
		return callback(await handle({ ignoreCachedConnections: true }));
	}

	return result;
}

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
	handle,
	defer,
	retryIfConnectionLost,
	CodeTimingHelper,
};
