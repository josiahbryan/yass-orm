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

module.exports = {
	handle,
	defer,
	retryIfConnectionLost,
};
