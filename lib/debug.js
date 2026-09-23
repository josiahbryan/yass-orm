/**
 * One switch for yass-orm's debug logging: `YASS_DEBUG`, a comma-separated
 * list of areas, or `*` for all of them.
 *
 *   YASS_DEBUG=cache,path-resolver node app.js
 *   YASS_DEBUG=* node app.js
 *
 * Areas:
 *   - `cache`            model-class and definition cache hits and misses
 *   - `path-resolver`    link and definition path resolution (bundled builds)
 *   - `model-index`      misses in the bundled model path index
 *   - `definition-index` misses in the bundled definition index
 *   - `finder`           the SQL (placeholders only) and timings of finder.js
 *
 * The flags this replaced still work, as aliases, because consumers set them
 * (Rubber reads `YASS_DEBUG_PATH_RESOLVER` itself):
 *   DEBUG_MODEL_CACHE_HITS=true -> cache
 *   YASS_DEBUG_PATH_RESOLVER    -> path-resolver
 *   YASS_DEBUG_MODEL_INDEX      -> model-index
 *   YASS_DEBUG_DEFINITION_INDEX -> definition-index
 *
 * `YASS_DEBUG` and the three `YASS_DEBUG_*` aliases are read on every call, so
 * setting one after yass-orm loads still takes effect (as those flags always
 * did). `DEBUG_MODEL_CACHE_HITS` is read once, at load, as it always was: it
 * guards the model-class cache hit, which runs for every linked field.
 */

const DEBUG_AREAS = Object.freeze([
	'cache',
	'path-resolver',
	'model-index',
	'definition-index',
	'finder',
]);

// Legacy flag -> the area it turns on. Truthiness matches the old checks:
// DEBUG_MODEL_CACHE_HITS had to be exactly 'true'; the others any non-empty value.
const CACHE_HITS_AT_LOAD = process.env.DEBUG_MODEL_CACHE_HITS === 'true';
const LEGACY_FLAGS = Object.freeze({
	cache: () => CACHE_HITS_AT_LOAD,
	'path-resolver': () => !!process.env.YASS_DEBUG_PATH_RESOLVER,
	'model-index': () => !!process.env.YASS_DEBUG_MODEL_INDEX,
	'definition-index': () => !!process.env.YASS_DEBUG_DEFINITION_INDEX,
});

// Parsed YASS_DEBUG, re-parsed only when the raw value changes.
let lastRaw;
let lastAreas = new Set();
function enabledAreas() {
	const raw = process.env.YASS_DEBUG || '';
	if (raw !== lastRaw) {
		lastRaw = raw;
		lastAreas = new Set(
			raw
				.split(',')
				.map((area) => area.trim().toLowerCase())
				.filter(Boolean),
		);
	}
	return lastAreas;
}

/**
 * @param {...string} areas One or more of DEBUG_AREAS
 * @returns {boolean} Whether debug logging is on for any of `areas`
 */
function isDebugEnabled(...areas) {
	if (areas.some((area) => LEGACY_FLAGS[area] && LEGACY_FLAGS[area]())) {
		return true;
	}
	const enabled = enabledAreas();
	return enabled.has('*') || areas.some((area) => enabled.has(area));
}

module.exports = { DEBUG_AREAS, isDebugEnabled };
