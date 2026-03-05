require('./decyclePolyfill');

function jsonSafeStringify(json, indents = 2) {
	if (!json) {
		return json;
	}

	// Bun's JSON.stringify crashes in an un-capturable way (try/catch doesn't catch it)
	// so we need to use a custom implementation that handles circular references
	// NOTE: Use typeof check because `process` is not defined in CF Workers / edge runtimes
	if (
		typeof process !== 'undefined' &&
		process.versions &&
		process.versions.bun
	) {
		const seen = [];
		return JSON.stringify(
			json,
			(key, value) => {
				if (value != null && typeof value === 'object') {
					if (seen.indexOf(value) >= 0) {
						// Duplicate reference found, discard key
						return undefined;
					}
					seen.push(value);
				}
				return value;
			},
			indents,
		);
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
