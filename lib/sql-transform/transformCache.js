// A bounded LRU in front of a SQL translator.
//
// Translating one statement (parse, rewrite, print, then a scanner pass) costs
// far more than the query it is for, and an application sends the same few
// hundred statement texts over and over. A translation depends only on the
// statement text and on the SHAPE of the params (which names, or whether the
// array is empty), never on their values, so the result is memoized on those.

// Entries kept per dialect when `config.sqlTransformCacheSize` is not set.
// One entry is one statement text (a few hundred bytes to a few KB of SQL
// plus its translation); dynamic `IN (...)` lists make distinct texts, so the
// bound matters.
const DEFAULT_TRANSFORM_CACHE_SIZE = 5000;

// Separates the params shape from the SQL text in a cache key. NUL cannot
// occur in a param name, so a shape cannot run into the SQL.
const KEY_SEPARATOR = '\u0000';

/**
 * What of `params` changes the translation: for a positional array only
 * whether it is empty (`?` is a placeholder only when it is not), for a named
 * map the key names. Values are never part of it.
 *
 * @param {object|Array|undefined} params
 * @returns {string}
 */
function paramsShape(params) {
	if (Array.isArray(params)) return params.length > 0 ? 'a1' : 'a0';
	return `o${Object.keys(params || {}).join(KEY_SEPARATOR)}`;
}

/**
 * @template T
 * @param {object} options
 * @param {(args: { sql: string, params?: object }) => T} options.transform
 *   the translator; must be a pure function of the SQL text and params shape
 * @param {() => number|undefined} [options.getMaxEntries] read on every call,
 *   so a config set after startup applies; 0 (or less) turns the cache off
 * @returns {((args: { sql: string, params?: object }) => T) & {
 *   clear: () => void, size: () => number }}
 */
function createTransformCache({ transform, getMaxEntries }) {
	// A Map iterates in insertion order: the first key is the least recently
	// used one, as a hit re-inserts its key at the end.
	const entries = new Map();

	const resolveMax = () => {
		const max = getMaxEntries ? getMaxEntries() : undefined;
		return max === undefined || max === null
			? DEFAULT_TRANSFORM_CACHE_SIZE
			: Math.floor(max);
	};

	// A caller may edit what it gets back (the logger, a hook), and that must
	// not reach the next caller: hand out a copy of every part that is a
	// reference.
	const copyOf = (result) =>
		result && typeof result === 'object'
			? {
					...result,
					...(Array.isArray(result.paramOrder)
						? { paramOrder: [...result.paramOrder] }
						: {}),
			  }
			: result;

	function cached(args) {
		const max = resolveMax();
		const { sql, params } = args;
		if (!(max > 0) || typeof sql !== 'string') return transform(args);

		const key = `${paramsShape(params)}${KEY_SEPARATOR}${sql}`;
		if (entries.has(key)) {
			const hit = entries.get(key);
			entries.delete(key);
			entries.set(key, hit);
			return copyOf(hit);
		}

		// A throw skips the `set`: a failed translation is never remembered.
		const result = transform(args);
		entries.set(key, copyOf(result));
		while (entries.size > max) {
			entries.delete(entries.keys().next().value);
		}
		return result;
	}

	cached.clear = () => entries.clear();
	cached.size = () => entries.size;
	return cached;
}

module.exports = {
	createTransformCache,
	paramsShape,
	DEFAULT_TRANSFORM_CACHE_SIZE,
};
