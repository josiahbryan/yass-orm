function jsonSafeParse(json) {
	try {
		return JSON.parse(json);
	} catch (ex) {
		if (jsonSafeParse.debug) {
			// eslint-disable-next-line no-console
			console.error(`Error parsing json:`, { json, ex });
		}
		return undefined;
	}
}

module.exports = { jsonSafeParse };
