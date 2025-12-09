require('./decyclePolyfill');

function jsonSafeStringify(json, indents = 2) {
	if (!json) {
		return json;
	}

	let retryDecycle;
	try {
		return JSON.stringify(json, null, indents);
	} catch (ex) {
		if (`${ex.message}`.includes('Converting circular structure to JSON')) {
			retryDecycle = true;
		} else {
			// eslint-disable-next-line no-console
			console.error(`Error stringifying json:`, { json, ex });
			return undefined;
		}
	}

	if (retryDecycle) {
		try {
			return JSON.stringify(JSON.decycle(json), null, indents);
		} catch (ex) {
			// eslint-disable-next-line no-console
			console.error(`Error stringifying decycled json:`, { json, ex });
			return undefined;
		}
	}

	return undefined;
}

module.exports = { jsonSafeStringify };
