/* eslint-disable no-param-reassign */
/**
 * The shared instance cache: one bucket of `{ [id]: instance }` per model
 * class, on globalThis (lib/globals.js). DatabaseObject's cache statics
 * (`getCachedId`, `setCachedId`, `removeCachedId`, `clearCache`, ...) are thin
 * delegates to these, and these call back through the class (`Model.x()`),
 * so a subclass that overrides one (Rubber overrides `getCachedId` and
 * `setCachedId`) sees every call it saw before.
 *
 * Inside a transaction, instances live in the transaction's own cache
 * (lib/txInstanceCache.js) until it commits.
 */
const { objectCache } = require('../globals');

const CLASS_CACHE_KEY_SYMBOL = Symbol('CLASS_CACHE_KEY_SYMBOL');

/**
 * The instance cache's bucket for this class: its name and its table. The
 * name alone put every model made straight from loadDefinition() (all named
 * 'ModelClass') into one bucket, so two such models handed out each other's
 * instances for the same id. The name stays in the key so two copies of the
 * same model class (one module loaded twice, e.g. through a symlink and its
 * real path) still share a bucket, which is why the cache is on globalThis.
 */
const classCacheKey = (Model) => {
	// Memoized per class; an own property, since statics are inherited.
	if (!Object.prototype.hasOwnProperty.call(Model, CLASS_CACHE_KEY_SYMBOL)) {
		let table = '';
		try {
			table = Model.table();
		} catch (err) {
			// No schema (DatabaseObject itself): the name is all there is.
		}
		Model[CLASS_CACHE_KEY_SYMBOL] = `${Model.name}:${table}`;
	}
	return Model[CLASS_CACHE_KEY_SYMBOL];
};

/** The bucket for this class, created on first use. */
const getClassCache = (Model) => {
	const key = Model._classCacheKey();
	if (!objectCache[key]) {
		objectCache[key] = {};
	}
	return objectCache[key];
};

/** The cached instance for `id`, or undefined. */
const getCachedId = (Model, id) => Model._getClassCache()[id];

/**
 * Caches `freshData` for `id`, or, if an instance is already cached, freshens
 * that one in place (so references to it see the new values) and returns it.
 */
const setCachedId = async (Model, id, freshData) => {
	// 'await' so we can allow subclasses to do async work and block if needed
	const cached = await Model.getCachedId(id);
	if (cached) {
		Model._freshenInstance(cached, freshData);
		return cached;
	}

	Model._getClassCache()[id] = freshData;
	return freshData;
};

/** Copies every schema field from `source` onto `target`. */
const freshenInstance = (Model, target, source) => {
	Model.fields().forEach(({ field }) => {
		target[field] = source[field];
	});
};

/** Removes `id`; true if it was cached. */
const removeCachedId = (Model, id) => {
	const cache = Model._getClassCache();
	if (cache[id]) {
		delete cache[id];
		return true;
	}
	return false;
};

/** Empties this class's bucket (references held elsewhere are untouched). */
const clearCache = (Model) => {
	objectCache[Model._classCacheKey()] = {};
};

module.exports = {
	classCacheKey,
	getClassCache,
	getCachedId,
	setCachedId,
	freshenInstance,
	removeCachedId,
	clearCache,
};
