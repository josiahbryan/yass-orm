const { dbh: getDbh } = require('./dbh');

async function handle({ ignoreCachedConnections } = {}) {
	if (!handle.dbh || ignoreCachedConnections) {
		handle.dbh = await getDbh({ ignoreCachedConnections });
	}

	return handle.dbh;
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

module.exports = {
	handle,
	retryIfConnectionLost,
};
