/**
 * The one module that owns yass's `globalThis` keys. No other module in lib/
 * touches `globalThis` (test/globals.test.js checks).
 *
 * Why globalThis at all: one package can be loaded twice in a process (a
 * symlink and its real path, CJS and ESM copies), and the copies must share
 * their caches and registries, or instances and links split between them.
 *
 * Two kinds of key, with the same names and behavior they always had:
 *
 * 1. yass's own stores. Adopted if already set (another copy of yass got there
 *    first), otherwise created, once, when this module loads.
 * 2. Keys a consumer writes. Rubber sets these for its Bun builds, before or
 *    after yass loads, so they are read live on every use:
 *    - `__YASS_ORM_MODEL_PATH_INDEX__`: a Map from `models/<name>` or
 *      `defs/<name>` to a model class (Rubber's indexModelClass()).
 *    - `__YASS_ORM_PATH_RESOLVER__`: maps a link path to a real file.
 *    - `__YASS_DEF_PATH_MAP__`: definition name -> file path. Rubber's Bun
 *      build does not set this at run time: `define` replaces the literal
 *      expression `globalThis.__YASS_DEF_PATH_MAP__` in this source text, so
 *      it must stay spelled exactly that way below, in a file directly in lib/.
 *    - `__YASS_ORM_DEFINITION_INDEX__`: filled by registerDefinition().
 */

const KEYS = {
	objectCache: '__YASS_ORM_OBJECT_CACHE__',
	modelClassCache: '__YASS_ORM_MODEL_CLASS_CACHE__',
	modelDefinitionCache: '__YASS_ORM_MODEL_DEFINITION_CACHE__',
	pathCache: '__YASS_ORM_PATH_CACHE__',
	globalChangeHooks: '__YASS_ORM_GLOBAL_CHANGE_HOOKS__',
	modelRegistry: '__YASS_ORM_MODEL_REGISTRY__',
	definitionIndex: '__YASS_ORM_DEFINITION_INDEX__',
	modelPathIndex: '__YASS_ORM_MODEL_PATH_INDEX__',
	pathResolver: '__YASS_ORM_PATH_RESOLVER__',
	defPathMap: '__YASS_DEF_PATH_MAP__',
};

/** The value at `key`, set to `create()` first if there is none. */
const adopt = (key, create) => {
	if (!globalThis[key]) {
		globalThis[key] = create();
	}
	return globalThis[key];
};

module.exports = {
	KEYS,

	// yass's own stores, adopted or created once.

	/** Instance cache: `{ [classCacheKey]: { [id]: instance } }`. */
	objectCache: adopt(KEYS.objectCache, () => ({})),
	/** Model classes by resolved link path. */
	modelClassCache: adopt(KEYS.modelClassCache, () => ({})),
	/** Definitions by resolved file path. */
	modelDefinitionCache: adopt(KEYS.modelDefinitionCache, () => ({})),
	/** Resolved link paths, keyed `${basePath}\0${link}`. */
	pathCache: adopt(KEYS.pathCache, () => new Map()),
	/** Functions registerGlobalChangeHook() added. */
	globalChangeHooks: adopt(KEYS.globalChangeHooks, () => []),
	/** The model registry: name -> model class (lib/model/registry.js). */
	modelRegistry: adopt(KEYS.modelRegistry, () => new Map()),

	// Keys a consumer writes, read live.

	/** Rubber's model path index (a Map), if set. */
	modelPathIndex: () => globalThis.__YASS_ORM_MODEL_PATH_INDEX__,
	/** The bundled-path resolver function, if set. */
	pathResolver: () => globalThis.__YASS_ORM_PATH_RESOLVER__,
	/** The Bun `define`d definition path map, if set. Keep the literal. */
	defPathMap: () => globalThis.__YASS_DEF_PATH_MAP__,
	/**
	 * The registerDefinition() index (a Map), if set; with `{ create: true }`,
	 * created when missing.
	 */
	definitionIndex: ({ create = false } = {}) =>
		create
			? adopt(KEYS.definitionIndex, () => new Map())
			: globalThis.__YASS_ORM_DEFINITION_INDEX__,
};
