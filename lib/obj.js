/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require */
require('./decyclePolyfill');

const parentModule = require('parent-module');
const { v4: uuid } = require('uuid');
const path = require('path');
const url = require('url');
const fs = require('fs');
const util = require('util');
const { jsonSafeStringify } = require('./jsonSafeStringify');
const { jsonSafeParse } = require('./jsonSafeParse');

// Helper to convert file URLs to paths (ESM compatibility)
const fileUrlToPath = (p) => {
	if (!p || typeof p !== 'string') return p;
	if (p.startsWith('file:')) {
		try {
			return url.fileURLToPath(p);
		} catch {
			// Fallback: manually strip file:// prefix
			return p.replace(/^file:\/\//, '');
		}
	}
	return p;
};

const config = require('./config');

// For external deep access
const libUtils = require('./utils');
const dbhUtils = require('./dbh');

// import convertDefinition for easy of use by subclasses
const { convertDefinition } = require('./def-to-schema');
const { finder } = require('./finder');
const {
	autoFixTable,
	deflateValue,
	debugSql,
	QueryTiming,
	QueryLogger,
	loadBalancerManager,
	LoadBalancer,
	closeAllConnections,
} = require('./dbh');

const { parseIdField } = require('./parseIdField');

const {
	handle,
	retryIfConnectionLost,
	defer,
	exponentialDelayFactory,
} = require('./utils');
const {
	promisePoolMap,
	DEFAULT_PROMISE_POOL_MAP_CONFIG,
	updatePromiseMapDefaultConfig,
} = require('./promiseMap');

const promiseExists = util.promisify(fs.exists);

const PATCH_DEFER_DELAY = 300;

// Private Symbol for this file to prevent new class() from being called
// - use class.inflate() instead
const FROM_INFLATE_SYMBOL = Symbol('FROM_INFLATE_SYMBOL');
// Used to guard against recursion in inflate()
const INFLATE_GUARD_SYMBOL = Symbol('INFLATE_GUARD_SYMBOL');
// Used to guard against recursion in toJSON()
const TO_JSON_GUARD_SYMBOL = Symbol('TO_JSON_GUARD_SYMBOL');
// Used for cached fields to prevent external access
const CACHED_FIELDS_SYMBOL = Symbol('CACHED_FIELDS_SYMBOL');
const CACHED_ID_FIELD_SYMBOL = Symbol('CACHED_ID_FIELD_SYMBOL');

// Use globalThis for caches to survive ESM module duplication
// (e.g., when the same module is loaded via symlink and real path)
// This ensures object instance caching works correctly across all module instances

// Cache for object instances - MUST be global for ORM caching to work
if (!globalThis.__YASS_ORM_OBJECT_CACHE__) {
	globalThis.__YASS_ORM_OBJECT_CACHE__ = {};
}
const OBJECT_INSTANCE_CACHE = globalThis.__YASS_ORM_OBJECT_CACHE__;

// Cache for model classes, so we don't have to check disk EVERY time
if (!globalThis.__YASS_ORM_MODEL_CLASS_CACHE__) {
	globalThis.__YASS_ORM_MODEL_CLASS_CACHE__ = {};
}
const MODEL_CLASS_CACHE = globalThis.__YASS_ORM_MODEL_CLASS_CACHE__;

// Cache for model definitions, so we don't have to read disk EVERY time
if (!globalThis.__YASS_ORM_MODEL_DEFINITION_CACHE__) {
	globalThis.__YASS_ORM_MODEL_DEFINITION_CACHE__ = {};
}
const MODEL_DEFINITION_CACHE = globalThis.__YASS_ORM_MODEL_DEFINITION_CACHE__;

// Cache for model paths, so we don't have to resolve disk EVERY time
if (!globalThis.__YASS_ORM_PATH_CACHE__) {
	globalThis.__YASS_ORM_PATH_CACHE__ = new Map();
}
const PATH_CACHE = globalThis.__YASS_ORM_PATH_CACHE__;

// Debug cache hits via env flag
const DEBUG_MODEL_CACHE_HITS = process.env.DEBUG_MODEL_CACHE_HITS === 'true';

/**
 * @class DatabaseObject
 * Base class for YASS-ORM. Not designed to be used directly, rather should
 * be instantiated using {@link loadDefinition}.
 *
 * You can instantiate this if you really want to, but you must override
 * the static `schema()` method and return a schema provided by `convertDefinition()`.
 *
 * Also see the `config.js` param `baseClass` for providing an alternate base class.
 */
class DatabaseObject {
	/**
	 * @static promisePoolMapConfig - Configuration for promisePoolMap
	 * @type {Object}
	 */
	static promisePoolMapConfig = DEFAULT_PROMISE_POOL_MAP_CONFIG;

	/**
	 * @static schema - Access the schema object for this class
	 *
	 * Required settings by subclasses
	 * Note this is the ONLY thing subclasses MUST override
	 * Bare minimum subclass could be:
	 *
	 * const { DatabaseObject, convertDefinition } = require('../obj');
	 * const schema = convertDefinition(require('../defs/company'));
	 *
	 * class Company extends DatabaseObject {
	 * 	static schema() {
	 * 		return schema;
	 * 	}
	 * }
	 *
	 * OR
	 * Subclasses could just do:
	 * const base = require('../obj').loadDefinition('./defs/company');
	 * class MyModel extends base {
	 * 		someMethod() { ... }
	 * }
	 * OR:
	 * const base = require('../obj').loadDefinition(require('../defs/company'));
	 * Note the path for defs/company changes based on where the require() is done.
	 *
	 * @returns {type} Description
	 */
	static schema() {
		throw new Error('You forgot to override static schema()');
	}

	/**
	 * Async JSONification of an object.
	 * Can't use toJSON() as the name because JSON.stringify would try to execute it, get a Promise,
	 * output an empty object.
	 * Includes at minimum id, name, and any linked fields (either via their toJSON method, or entire objects)
	 * if includeLinked=true (defaults to false)
	 *
	 * @returns { id, name, ... }
	 * @memberof DatabaseObject
	 */
	async jsonify({ includeLinked = false, excludeLinked = false } = {}) {
		let guard = this[TO_JSON_GUARD_SYMBOL];
		if (guard) {
			return guard;
		}

		guard = defer();
		this[TO_JSON_GUARD_SYMBOL] = guard;

		const { id, name } = this;
		const struct = { id };
		if (name !== undefined) {
			struct.name = name;
		}

		// Prevent recursion
		// if (this[TO_JSON_GUARD_SYMBOL]) return struct;

		// this[TO_JSON_GUARD_SYMBOL] = struct;

		// Process fields based on the flags
		const fields = this.constructor.fields();

		if (includeLinked || excludeLinked) {
			// Include regular (non-linked) fields only when excludeLinked=true
			if (excludeLinked) {
				for (let i = 0; i < fields.length; i++) {
					const field = fields[i];
					if (!field.linkedModel) {
						const value = this[field.field];
						if (value !== null && value !== undefined) {
							struct[field.field] = value;
						}
					}
				}
			}

			// Include linked fields only if requested
			if (includeLinked) {
				const linkedFields = fields.filter(
					(field) => field.linkedModel && this[field.field],
				);

				await promisePoolMap(linkedFields, async (field) => {
					struct[field.field] =
						typeof this[field.field].jsonify === 'function'
							? await this[field.field].jsonify()
							: this[field.field];
				});
			}

			// Don't show isDeleted unless isDeleted for the sake of berevity
			if (!struct.isDeleted) {
				delete struct.isDeleted;
			}
		}

		// Clear guard
		guard.resolve(struct);
		this[TO_JSON_GUARD_SYMBOL] = null;

		return struct;
	}

	/**
	 * @static allowedFindParams - Override to set list of fields to be allowed by find() for querying
	 *
	 * @returns {Array} list of fields allowed to be used by find() for querying
	 */
	static allowedFindParams() {
		return null;
	}

	/**
	 * mutateQuery - Change the values in query before find() hits the database.
	 * 	Default impl does nothing, override in subclass to hook into find()
	 * 	to modify the behaviour.
	 *
	 * @param {Object} query   Raw query given to find
	 * @param {Object} sqlData data used by find() to build the query
	 * @param {Object} ctx     Accessor for your subclass to get useful utilities
	 *
	 * @returns {Promise} Promise that resolves when mutation is done
	 */
	mutateQuery(/* query, sqlData, ctx */) {
		return Promise.resolve();
	}

	/**
	 * mutateSort - Change the values in `sort` before find() hits the database.
	 * 	Default impl does nothing, override in subclass to hook into find()
	 * 	to modify the behaviour.
	 *
	 * @param {Object} sort    Array of fields from the schema to sort on
	 * @param {Object} sqlData data used by find() to build the query
	 * @param {Object} ctx     Accessor for your subclass to get useful utilities
	 *
	 * @returns {Promise} Promise that resolves with the new sort list
	 */
	mutateSort(sort /* , sqlData, ctx */) {
		return Promise.resolve(sort);
	}

	/**
	 * mutateResult - Change the values retrieved from the database by find()
	 * 	Default impl does nothing, override in subclass to hook into find()
	 * 	to modify the behaviour.
	 *
	 * @param {Object} result  Raw list of results from the database
	 * @param {Object} query   Query given to find()
	 * @param {Object} ctx     Accessor for your subclass to get useful utilities
	 *
	 * @returns {Promise} Promise that resolves with the new result set
	 */
	mutateResult(result /* , query, ctx */) {
		return Promise.resolve(result);
	}

	/**
	 * mutateMeta - Change the meta object returned by find()
	 * 	Default impl does nothing, override in subclass to hook into find()
	 * 	to modify the behaviour.
	 *
	 * @param {Object} meta    Meta data from the find() query
	 * @param {Object} sqlData data used by find() to build the query
	 * @param {Object} ctx     Accessor for your subclass to get useful utilities
	 *
	 * @returns {Promise} Promise that resolves with the new meta object
	 */
	mutateMeta(meta /* , sqlData, ctx */) {
		return Promise.resolve(meta);
	}

	/**
	 * @static find - Intelligent searching of the table for values.
	 * Designed to be exposed to a client. Supports $limit, $skip, and
	 * a special 'q' parameter to do full-text search with match ratio sorting.
	 *
	 * @param {type}   query     Query object where keys are fields in the schema,
	 * 	or $limit, $skip, or "q"
	 * @param {object} [opts={}] Unused at the moment
	 *
	 * @returns {Promise} Promise that fulfills with the result of the query
	 */
	static async find(query, opts = {}) {
		return finder.call(this, query, opts);
	}

	/**
	 * @static dbh - Easy access to the database handle for direct db access
	 *
	 * @returns {db} Database handle from db/dbh
	 */
	static async dbh() {
		return handle();
	}

	async dbh() {
		return handle();
	}

	// Centralize access to this utility to allow subclasses to override either
	// this central method, or this.dbh() itself to customize the handle used in this object
	static retryIfConnectionLost(callback) {
		return retryIfConnectionLost(callback, { handleFactory: () => this.dbh() });
	}

	retryIfConnectionLost(callback) {
		return this.constructor.retryIfConnectionLost(callback);
	}

	/**
	 * @static table - Return the table name for this class
	 *
	 * @returns {String} name of the table in the database
	 */
	static table() {
		return this.schema().table;
	}

	/**
	 * Return the table name for this class
	 *
	 * @returns {String} name of the table in the database
	 */
	table() {
		return this.constructor.table();
	}

	/**
	 * @static fields - List of fields from class schema
	 *
	 * @returns {Array} Array of fields
	 */
	static fields() {
		// Cache fields array to avoid repeated schema() calls and Object.values()
		if (!this[CACHED_FIELDS_SYMBOL]) {
			// Use fieldMap instead of .fields because .fields contains expanded object schemas and we don't need that
			this[CACHED_FIELDS_SYMBOL] = Object.values(this.schema().fieldMap);
		}
		return this[CACHED_FIELDS_SYMBOL];
	}

	/**
	 * Returns the cache instance for this class
	 *
	 * @private
	 * @static
	 * @returns Object
	 * @memberof DatabaseObject
	 */
	static _getClassCache() {
		const className = this.name;
		const cache =
			OBJECT_INSTANCE_CACHE[className] ||
			(OBJECT_INSTANCE_CACHE[className] = {});
		return cache;
	}

	/**
	 * Returns the cached instance for the given ID and current subclass
	 *
	 * Marked async so we can allow subclasses to do async work and block if needed. Default impl does not need async,
	 * but library code will await anyway incase subclass requires async.
	 *
	 * @param {string|number} id Key to use for lookup
	 * @returns {object|undefined} Returns instance if ID exists, or undefined if no key matches
	 * @static
	 * @memberof DatabaseObject
	 */
	static async getCachedId(id) {
		const cache = this._getClassCache();
		return cache[id];
	}

	/**
	 * Inserts/updates the data for `id` into the cache, freshing the existing reference if existing (using Object.assign-esque functionality) or inserting new reference
	 *
	 * Marked async so we can allow subclasses to do async work and block if needed. Default impl does not need async,
	 * but library code will await anyway incase subclass requires async.
	 *
	 * @param {string|number} id ID Key to use
	 * @param {object} freshData Object instance to use to freshen. If object for id already exists in cache, this will freshen fields on the existing object so that existing references to the cached object are automatically updated. If `id` does not exist in cache, this `freshData` param will be stored as-is in the cache for that `id`
	 * @returns {object} Returns the cached instance if previously existing, or `freshData` if newly inserted into cache
	 * @static
	 * @memberof DatabaseObject
	 */
	static async setCachedId(id, freshData) {
		// 'await' so we can allow subclasses to do async work and block if needed
		const cached = await this.getCachedId(id);
		if (cached) {
			this.fields().forEach(({ field }) => {
				cached[field] = freshData[field];
			});
			return cached;
		}

		this._getClassCache()[id] = freshData;
		return freshData;
	}

	/**
	 * Removes the given ID from the cache
	 * @param {string|number} id ID key to remove
	 * @returns {boolean} True if object existed, false if object was not present
	 * @static
	 * @memberof DatabaseObject
	 */
	static removeCachedId(id) {
		const cache = this._getClassCache();
		if (cache[id]) {
			delete cache[id];
			return true;
		}
		return false;
	}

	/**
	 * Empties all keys from the cache. Note that this does NOT destroy any existing references held externally, nor does it destroy any data in the database. This just removes the cached data so new calls will get fresh data right from the DB.
	 * @static
	 * @memberof DatabaseObject
	 */
	static clearCache() {
		const className = this.name;
		OBJECT_INSTANCE_CACHE[className] = {};
	}

	/**
	 * Get the name of the ID field for this object
	 * @returns {string} Name of the primary key (only supports one primary key)
	 * @static
	 * @memberof DatabaseObject
	 */
	static idField() {
		if (!this[CACHED_ID_FIELD_SYMBOL]) {
			const { idField } = parseIdField(this.table()) || { id: 'id' };
			this[CACHED_ID_FIELD_SYMBOL] = idField;
		}
		return this[CACHED_ID_FIELD_SYMBOL];
	}

	idField() {
		if (this.constructor[CACHED_ID_FIELD_SYMBOL]) {
			return this.constructor[CACHED_ID_FIELD_SYMBOL];
		}
		return this.constructor.idField();
	}

	/**
	 * @static inflate - Takes a raw javascript object and returns a class instance.
	 * Use this instead of new this(object) because you can't await new
	 *
	 * @param {Object} data - Raw object
	 *
	 * @returns {this} Class instance
	 */
	static async inflate(data, span = undefined, promisePoolMapConfig) {
		const idField = this.idField();
		if (!data) {
			// console.trace(`inflate: invalid data (data was null):`, data);
			return null;
		}
		const { [idField]: id } = data;
		if (!id) {
			console.trace(
				`inflate: invalid data (data was had no id at ${idField}):`,
				data,
			);
			return null;
		}

		// Get cache for this class
		// 'await' so we can allow subclasses to do async work and block if needed
		let cached = await this.getCachedId(id, span);

		if (!cached) {
			cached = new this({ id, [idField]: id }, FROM_INFLATE_SYMBOL);
			// 'await' so we can allow subclasses to do async work and block if needed
			await this.setCachedId(id, cached, span);
		}

		// This check of INFLATE_GUARD_SYMBOL prevents recursion where both models link to each other.
		// e.g. seed <-> adSet both could have fields linking one to the other
		// if(cached[INFLATE_GUARD_SYMBOL])
		// 	return cached;

		// For linked models, the call stack goes inflateValues > _resolvedLinkedModel > get > inflate (other class)
		// So by setting this here, we can shortcut the inflate() call (above)
		// because we "know" the inflate will finish and we just return the ref to the object
		// that will eventually get filled in
		cached[INFLATE_GUARD_SYMBOL] = true;

		// Inflate objects and linked models
		const inflatedData = await this.inflateValues(
			data,
			span,
			promisePoolMapConfig,
		);

		// Freshen cached data or set data first time
		const fields = this.fields();
		for (let i = 0; i < fields.length; i++) {
			const row = fields[i];
			cached[row.field] = inflatedData[row.field];
		}

		// Remove guard and return final object
		delete cached[INFLATE_GUARD_SYMBOL];

		// Set the object in the cache gently (Object.assign-like-functionality if it exists already)
		// 'await' so we can allow subclasses to do async work and block if needed
		await this.setCachedId(id, cached);

		return cached;
	}

	/**
	 * Takes a raw set of data from the database and applies any existing schema transformations to the data (such as inflating Dates, converting numbers, parsing JSON)
	 * @param {object} data Data to inflate
	 * @returns {object} Object containing the transformed data
	 */
	static async inflateValues(data, span, promisePoolMapConfig) {
		// Guard against undefined data (can happen if record was deleted during async operation)
		if (data === undefined || data === null) {
			return undefined;
		}

		const effectivePromisePoolMapConfig =
			promisePoolMapConfig || this.promisePoolMapConfig;
		// console.log(`inflateValues debug start`, {
		// 	data,
		// 	table: this.table(),
		// 	fields: this.schema().fieldMap.id,
		// });
		const inflatedData = {};
		await promisePoolMap(
			this.fields(),
			async (row) => {
				let value = data[row.field];
				if (value === null) {
					value = null;
				} else if (value === undefined) {
					value = undefined;
				} else if (row.linkedModel) {
					// TODO: Look into supporting t.linked('model', { array: true })
					// where both would deflate to an array of ids, and then we can inflate to an array of objects
					// This code is not yet implemented, but would be nice to have...

					let spanClone = span;
					if (spanClone) {
						spanClone = {
							...spanClone,
							stack: [
								...spanClone.stack,
								{
									table: this.table(),
									field: row.field,
									value: `${value}`,
									linkedModel: row.linkedModel,
								},
							],
						};
					}
					value = await this._resolvedLinkedModel(
						row.linkedModel,
						value,
						spanClone,
					);
				} else if (row.isObject) {
					if (typeof value === 'string' || value instanceof String) {
						const parsed = jsonSafeParse(value);
						if (parsed === undefined && data[row.field]) {
							const { [this.idField()]: id } = data;
							console.warn(
								`Error parsing JSON in ${this.table()}.${
									row.field
								}#${id} - original json:\n\n<<${data[row.field]}>>\n\n`,
							);
						} else {
							value = parsed;
						}
					}
					// else: Not going to try to parse, because it might not be a string
				} else if (row.nativeType === Boolean) {
					// Allowing casting incase db returns int for booleans
					// eslint-disable-next-line eqeqeq
					value = value == '1';
				} else if (row.nativeType === String) {
					if (row.type === 'date' && value instanceof Date) {
						// mariadb connector tries to be TOO smart/helpful by casting
						// 'date'-type columns to `Date` objects - which implies a timezone and time,
						// but MySQL doesn't store data like that, it only stores YYYY-MM-DD,
						// so represent in javascript as strings, not Dates
						// eslint-disable-next-line prefer-destructuring
						value = value.toISOString().split('T')[0];
					} else {
						value = String(value);
					}
				} else if (row.nativeType === Date) {
					// const pre = value;
					// DO NOTHING?
					value = new Date(
						`${value}`.replace(
							/^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*$/,
							'$1T$2.000Z',
						),
					);
					// console.log("[row.nativeType==Date] inflated:", { id: data.id, pre, value });
				} else if (row.nativeType === Number) {
					value = parseFloat(value);
				} else if (row.nativeType) {
					// eslint-disable-next-line new-cap
					value = new row.nativeType(value);
				}

				inflatedData[row.field] = value;
			},
			effectivePromisePoolMapConfig,
		);

		// console.log(`inflateValues debug end`, inflatedData);

		return inflatedData;
	}

	// Supported model file extensions, in order of preference
	static MODEL_EXTENSIONS = ['.js', '.ts', '.cjs', '.mjs'];

	static async _resolveModelClass(modelName, errorHint = '', span = undefined) {
		// Check for path resolver - enables bundled executables to translate /$bunfs/ paths
		const pathResolver = globalThis.__YASS_ORM_PATH_RESOLVER__;
		const resolvePath = (p) =>
			typeof pathResolver === 'function' ? pathResolver(p) : p;

		// Use global PATH_CACHE to avoid repeated path.resolve() calls
		let resolvedPath = PATH_CACHE.get(modelName);
		if (!resolvedPath) {
			const resolvedModel = path.resolve(this.basePath(), modelName);

			// Support multiple extensions for TypeScript/ESM models
			const hasKnownExtension = this.MODEL_EXTENSIONS.some((ext) =>
				resolvedModel.endsWith(ext),
			);

			if (hasKnownExtension) {
				resolvedPath = resolvedModel;
			} else {
				// Try each extension in order of preference
				// Use path resolver for fs.existsSync checks (handles /$bunfs/ paths)
				resolvedPath =
					this.MODEL_EXTENSIONS.map((ext) => `${resolvedModel}${ext}`).find(
						(p) => fs.existsSync(resolvePath(p)),
					) ||
					// Default to .js for error message consistency
					`${resolvedModel}.js`;
			}
			PATH_CACHE.set(modelName, resolvedPath);
		}

		const cached = MODEL_CLASS_CACHE[resolvedPath];
		if (cached) {
			if (DEBUG_MODEL_CACHE_HITS) {
				console.log(
					`[resolveModelClass] [✅ cache hit ✅] Returning cached model class for ${resolvedPath}`,
					`${Object.keys(MODEL_CLASS_CACHE).length} Model Classes in cache`,
				);
			}
			return cached;
		}

		// Check global model path index - this enables bundled executables (e.g., bun build --compile)
		// to resolve linked models without filesystem access. Models register themselves via
		// indexModelClass() which populates globalThis.__YASS_ORM_MODEL_PATH_INDEX__
		const externalPathIndex = globalThis.__YASS_ORM_MODEL_PATH_INDEX__;
		if (externalPathIndex instanceof Map && externalPathIndex.size > 0) {
			// Normalize path to match how models are registered
			// This extracts just the suffix starting from 'defs/' or 'models/' to create a common key
			// that works for both bundled ($bunfs) and non-bundled filesystem paths
			let normalizedPath = resolvedPath.replace(/\.(js|ts|cjs|mjs)$/, '');
			const defsIdx = normalizedPath.lastIndexOf('/defs/');
			const modelsIdx = normalizedPath.lastIndexOf('/models/');
			const cutIdx = Math.max(defsIdx, modelsIdx);
			if (cutIdx !== -1) {
				normalizedPath = normalizedPath.substring(cutIdx + 1);
			}

			const registered = externalPathIndex.get(normalizedPath);
			if (registered) {
				if (DEBUG_MODEL_CACHE_HITS) {
					console.log(
						`[resolveModelClass] [✅ external index hit ✅] Found model in global path index for ${normalizedPath}`,
					);
				}
				// Cache for future lookups
				MODEL_CLASS_CACHE[resolvedPath] = registered;
				return registered;
			}

			// Debug: log when we expected to find the model but didn't
			if (DEBUG_MODEL_CACHE_HITS || process.env.YASS_DEBUG_MODEL_INDEX) {
				console.log(
					`[resolveModelClass] [❌ external index miss ❌] Looking for '${normalizedPath}', resolvedPath='${resolvedPath}', index has ${externalPathIndex.size} entries:`,
					Array.from(externalPathIndex.keys()).slice(0, 10),
				);
			}
		}

		// I discovered in prod that frequently the 'exists' and then 'require' opts could take many milliseconds which add up when prod volume spikes. (By many milliseconds, I mean I've sean ranges from 9ms to 30-40ms) When you realize that 30ms PER 'linked(...)' access - that adds up horribly. So, caching the resolution SHOULD reduce that time considerably.
		// Use path resolver for bundled executable support (translates /$bunfs/ to real paths)
		const actualPath = resolvePath(resolvedPath);
		if (
			DEBUG_MODEL_CACHE_HITS ||
			process.env.YASS_DEBUG_PATH_RESOLVER ||
			(actualPath !== resolvedPath && process.env.YASS_DEBUG_MODEL_INDEX)
		) {
			console.log(
				`[resolveModelClass] Path resolution: ${resolvedPath} -> ${actualPath}`,
			);
		}

		const pathExists = await promiseExists(actualPath);
		if (!pathExists) {
			let errorSpan;
			if (span && span.stack.length) {
				// console.log(`Active span at time of next error: `, span);
				errorSpan = `\n\nDebugging trace on where this call originated:\n${jsonSafeStringify(
					span,
					4,
				)}`;
			}
			throw new Error(
				`Cannot resolve linked model '${modelName}' (resolved to file path: '${resolvedPath}', actual path: '${actualPath}') on table '${this.table()}' ${errorHint} ${
					errorSpan || ''
				}`,
			);
		}

		// Use dynamic import() for ESM compatibility - this ensures we use the same
		// module cache as ESM imports, so instanceof checks work correctly
		const { pathToFileURL } = require('url');
		const importedModule = await import(pathToFileURL(actualPath).href);
		let ModelClass = importedModule.default || importedModule;
		if (ModelClass.default) {
			ModelClass = ModelClass.default; // handle double-wrapped defaults
		}

		// Cache the resolved model class in our global cache list
		MODEL_CLASS_CACHE[resolvedPath] = ModelClass;

		if (DEBUG_MODEL_CACHE_HITS) {
			console.log(
				`[resolveModelClass] [❌ cache miss ❌] Loaded model class for ${resolvedPath}, cache keys now:`,
				Object.keys(MODEL_CLASS_CACHE),
				`${Object.keys(MODEL_CLASS_CACHE).length} Model Classes in cache`,
			);
		}

		return ModelClass;
	}

	static async _resolvedLinkedModel(modelName, modelId, span = undefined) {
		const ModelClass = await this._resolveModelClass(
			modelName,
			`(trying to look up ID '${modelId}')`,
			span,
		);

		// Certain inflateValue calls COULD incorrectly pass in an already-inflated
		// linked model. so don't force another call to get() if already inflated
		if (modelId instanceof ModelClass && modelId.id === modelId) {
			return modelId;
		}

		return ModelClass.get(modelId, { allowCached: true, span }); // don't force "SELECT" again
	}

	/**
	 * Returns a string containing the ID for this object. Note that this
	 * function overrides the existing `Object` `toString` function,
	 * this makes it suitable for printing out on the console and showing the ID of the
	 * object rather than just `[Object object]` etc.
	 * @returns {string} String containing the ID of this object
	 */
	toString() {
		const { [this.idField()]: id } = this;
		return id;
	}

	static _processObjectSchema(deflatedData = {}, row = {}, value = null) {
		if (value) {
			// Eventually, would like to support t.linked('model', { array: true }) and/or t.array('model')
			// where both would deflate to an array of ids, and then we can inflate to an array of objects
			// This code is not yet implemented, but would be nice to have...
			// if (row.arraySchema) {
			// 	// console.log(" > arraySchema processing...");
			// 	value.forEach((item) => {
			// 		this._processObjectSchema(deflatedData, row, item);
			// 	});
			// }

			// Only expand subfields to separate columns if noExpand is false
			// When noExpand is true (default for direct t.object({ ... }) format),
			// we only store as JSON, not in individual columns
			if (row.objectSchema && !row.noExpand) {
				// console.log(" > objectSchema processing...");
				Object.values(row.objectSchema).forEach((subrow) => {
					// console.log(` > > ${subrow.field} = ${deflateValue(value[subrow.subfield])} (${subrow.subfield})`, subrow);
					if (subrow.isObject) {
						const finalValue = this._processObjectSchema(
							deflatedData,
							subrow,
							value[subrow.subfield],
						);

						if (finalValue !== undefined) {
							deflatedData[subrow.field] = finalValue;
						}
					} else {
						const finalValue = deflateValue(value[subrow.subfield]);
						if (finalValue !== undefined) {
							deflatedData[subrow.field] = finalValue;
						}
					}
				});
			}
			value = jsonSafeStringify(value, 0);
		}
		return value;
	}

	static deflateValues(object = {}, noUndefined) {
		const deflatedData = {};
		const idField = this.idField();
		const fields = this.fields();
		for (let i = 0; i < fields.length; i++) {
			const row = fields[i];
			// Don't try to "deflate" a field that doesn't exist
			if (!(row.field in object)) {
				// eslint-disable-next-line no-continue
				continue;
			}

			let value = object[row.field];
			if (row.linkedModel && value && value[idField]) {
				value = value[idField];
			} else if (row.isObject) {
				// console.log("[base-model.deflate] isObject:", value, row);
				const tmp = this._processObjectSchema(deflatedData, row, value);
				if (tmp !== null) {
					value = tmp;
				}
			} else if (row.nativeType === Boolean) {
				if (noUndefined) {
					value = value === true ? 1 : 0;
				} else if (value !== undefined) {
					value = value === true ? 1 : 0;
				}
			} else {
				// console.log("[deflateValues] fallthru for:", value);
				value = deflateValue(value); // from dbh.js
			}

			if (value !== undefined) {
				deflatedData[row.field] = value;
			}
		}

		// If a user of this class declares this hook, then allow them to get warnings,
		// otherwise, we don't check
		if (this.constructor.warnOnInvalidDeflateKey) {
			const { fieldMap } = this.schema();
			Object.keys(object).forEach((patchKey) => {
				if (!fieldMap[patchKey]) {
					this.constructor.warnOnInvalidDeflateKey(
						`Warning: data given to a '${this.name}' method gave a field that does not exist in the DB schema: '${patchKey}' - the ORM will just ignore it, but you might want to check that.`,
						{ name: this.name, patchKey },
					);
				}
			});
		}

		// console.log("[deflateValues]", object, deflatedData, "\n\n\n");// [ object.updatedAt, deflatedData.updatedAt ]);

		return deflatedData;
	}

	deflate(data, noUndefined) {
		const object = data || this;
		return this.constructor.deflateValues(object, noUndefined);
	}

	/**
	 * Subclasses can override this hook to update props
	 */
	async afterChangeHook() {
		return Promise.resolve(this);
	}

	/**
	 * Subclasses can override this hook to update props
	 * Only called in findOrCreate if lastAction === 'create' or in create()
	 */
	async afterCreateHook() {
		return Promise.resolve(this);
	}

	async _updateProperties(data, span) {
		// console.log("[_updateProperties] got incoming data=", data);

		// Guard against undefined data (can happen if record was deleted during async operation)
		if (data === undefined || data === null) {
			// Record was likely deleted - return this instance as-is without updating
			// This prevents errors when a debounced operation tries to update a deleted record
			return this;
		}

		const inflatedData = await this.constructor.inflateValues(data, span);

		// Double-check inflateValues result (it should return undefined for undefined input)
		if (inflatedData === undefined || inflatedData === null) {
			return this;
		}

		const fields = this.constructor.fields();
		for (let i = 0; i < fields.length; i++) {
			const { field } = fields[i];
			const value = inflatedData[field];
			this[field] = value;
		}

		// Freshen the cache for this ID with these new values
		const { [this.idField()]: id } = this;

		// 'await' so we can allow subclasses to do async work and block if needed
		await this.constructor.setCachedId(id, this);

		await this.afterChangeHook();

		return this;
	}

	/**
	 * Returns all objects that match the whereClause
	 *
	 * @param {type} whereClause SQL to use for query (don't include WHERE, but can use LIMIT, ORDER BY, etc)
	 * @param {type} args        If SQL is "name=:someName order by name", then you would set args to {someName:"Bob"}
	 * @static
	 * @returns {type} List of class instances containing the search results
	 */
	static async fromSql(
		whereClause = '1',
		{
			promisePoolMapConfig = this.promisePoolMapConfig ||
				DEFAULT_PROMISE_POOL_MAP_CONFIG,
			...args
		} = {},
	) {
		const span = { name: 'fromSql', props: { whereClause, args }, stack: [] };
		return this.retryIfConnectionLost((dbh) => {
			const { table } = parseIdField(this.table());
			const sql = /* sql */ `select * from ${autoFixTable(
				table,
				dbh,
			)} where ${whereClause}`;
			return dbh.roQuery(sql, args).then((rows) => {
				// console.log(`Got rows:`, rows);
				return promisePoolMap(
					rows,
					async (row) => this.inflate(row, span),
					promisePoolMapConfig,
				);
			});
		});
	}

	/**
	 * Execute raw SQL against the underlying database
	 * @param {function} callback Function with signature like `(tableName)`, and the function is expected to return an array like `[sql, args]` where `sql` is the string to execute and `args` is an object containing any parameters for the SQL
	 */
	static async queryCallback(callback) {
		return this.retryIfConnectionLost(async (dbh) =>
			dbh.pquery(...(await callback(this.table()))),
		);
	}

	/**
	 * Utility to access the underlying database handle to perform queries or any
	 * other functions with the raw handle. Most useful is `dbh.pquery` and
	 * `dbh.roQuery` to execute raw SQL queries on the underlying database.
	 *
	 * Note that `dbh.roQuery` is recommended unless you are doing `UPDATE/INSERT/DELETE`
	 * queries, since `roQuery` will automatically use any read-only nodes defined in the config,
	 * instead of sending read queries to the master.
	 *
	 * Note also that `roQuery` does not examine the query, so if you use `roQuery`
	 * for a modification query (`UPDATE`, etc), the results are undefined.
	 *
	 * For modification queries, always use `dbh.pquery`
	 *
	 * @param {function} callback Function with signature like `(dbh, tableName)`, and the fu
	 * @returns {Array} Your callback`s eventual return value is returned
	 */
	static async withDbh(callback, props = {}) {
		// Auto-update raw SQL to a callback if given
		if (typeof callback === 'string') {
			const sql = callback;
			callback = (dbh) => dbh.pquery(sql, props);
		}

		return this.retryIfConnectionLost((dbh) => callback(dbh, this.table()));
	}

	/**
	 * Searches the database using all `fields` given, all must match. (E.g. `field1=X AND field2=Y ...`)
	 * @param {object} fields Fields to use for querying. All values will be used (..AND.. style)
	 * @returns {Array<DatabaseObject>} Returns an array of instantiated `DatabaseObject` if at least one row matches the query fields, OR returns an empty array, e.g. `[]` (not null, etc)
	 */
	static async search(
		fields = {},
		limitOne = false,
		promisePoolMapConfig = this.promisePoolMapConfig ||
			DEFAULT_PROMISE_POOL_MAP_CONFIG,
	) {
		const res = await this.retryIfConnectionLost((dbh) =>
			dbh.search(this.table(), this.deflateValues(fields), limitOne),
		);

		const span = { name: 'search', props: { fields, limitOne }, stack: [] };

		if (limitOne) {
			return this.inflate(res, span);
		}

		return promisePoolMap(
			res,
			async (object) => this.inflate(object, span),
			promisePoolMapConfig,
		);
	}

	/**
	 * Searches the database using all `fields` given, all must match. (E.g. `field1=X AND field2=Y ...`)
	 * @param {object} fields Fields to use for querying. All values will be used (..AND.. style)
	 * @returns {DatabaseObject|null} Returns the instantiated `DatabaseObject` if at least one row matches the query fields, OR returns `null` if no rows match.
	 */
	static async searchOne(
		fields = {},
		promisePoolMapConfig = this.promisePoolMapConfig ||
			DEFAULT_PROMISE_POOL_MAP_CONFIG,
	) {
		return this.search(fields, true, promisePoolMapConfig);
	}

	/**
	 * Generate a UUID for a new object. By default, generates using the 'uuid' NPM package. Override to generate, for example, using nanoid
	 * @returns {string} Generated ID
	 */
	static generateObjectId = () => {
		return uuid();
	};

	/**
	 * Searches the database for the values given in `fields` where all fields
	 * must match exactly (e.g. field1=X AND field2=Y AND field2=Z).
	 *
	 * Will load first matching record and use the same logic as
	 * {@link DatabaseObject#patchIf} to apply any updates (optional)
	 * before returning the instantiated `DatabaseObject`
	 *
	 * Note that this method bypasses the local cache and loads data
	 * from the database every time. This is because the cache only
	 * indexes objects by their ID, not by any other fields.
	 *
	 * @param {object} fields Fields to use for querying
	 * @param {object} patchIf Fields to set if the values don't match exactly
	 * @param {object} patchIfFalsey Fields to set if the existing values are falsey
	 * @returns {DatabaseObject} Instantiated object containing the data
	 */
	static async findOrCreate(
		fields,
		patchIf = {},
		patchIfFalsey = {},
		...extraArgs
	) {
		if (extraArgs.length) {
			console.warn(
				`${this.constructor.name}.findOrCreate() with USELESS ARGS (they WILL be ignored - check tour code, you probably didn't mean to do that) - this was called from:`,
				new Error('called from').stack,
			);
		}

		// console.log("[obj.findOrCreate]", { fields });
		const deflatedFields = this.deflateValues(fields);
		// console.log("[obj.findOrCreate]", { defl });

		const {
			fieldMap: {
				[this.idField()]: { type: idType },
			},
		} = this.schema();

		let handleUsed;
		const res = await this.retryIfConnectionLost((dbh) => {
			handleUsed = dbh;
			return dbh.findOrCreate(
				this.table(),
				deflatedFields,
				this.deflateValues(patchIf),
				this.deflateValues(patchIfFalsey),
				{
					allowBlankIdOnCreate: idType === 'idKey',
					idGenerator: this.generateObjectId,
				},
			);
		});

		// Need the ref that was used above to get the action
		const { lastAction, wasCreated } = handleUsed.findOrCreate;
		// console.log("[obj.findOrCreate]", { lastAction, wasCreated });

		const span = {
			name: 'findOrCreate',
			props: { fields, patchIf, patchIfFalsey },
			stack: [],
		};

		const instance = await this.inflate(res, span);

		if (wasCreated) {
			if (
				!patchIf.createdAt &&
				!patchIfFalsey.createdAt &&
				this.schema().fieldMap.createdAt
			) {
				await instance.patch({
					createdAt: new Date(),
				});
			}

			await instance.afterCreateHook();
		}

		if (lastAction !== 'get') {
			// Run on both patch AND create
			await instance.afterChangeHook({ wasCreated });
		}

		return instance;
	}

	/**
	 * Retrieves an instance of the given ID from the database (or from memory if present and `allowCached` option is set to a true value (false by default).
	 *
	 * Internally, the library will only load the cached object when loading linked fields
	 * when inflating data from the database.
	 *
	 * Note that you can override the caching implementation by subclassing `DatabaseObject`
	 * and overriding the {@link DatabaseObject#getCachedId}, {@link DatabaseObject#setCachedId},
	 * {@link DatabaseObject#removeCachedId}, and {@link DatabaseObject#clearCache} static methods.
	 * Possible use case would be to use Redis to handle caching instead of local RAM.
	 *
	 * @param {string|number} id ID field to load from the database
	 * @param {boolean} options.allowCached [default: false] If true, will check the cache for this class for the given ID and if present, returns the cached instance.
	 * @returns {DatabaseObject} Instantiated `DatabaseObject` containing the data from the database
	 */
	static async get(id, { allowCached, span = undefined } = {}) {
		if (allowCached) {
			// 'await' so we can allow subclasses to do async work and block if needed
			const cached = await this.getCachedId(id);
			if (cached) {
				return cached;
			}
		}

		if (!span) {
			span = { name: 'get', props: { id }, stack: [] };
		}

		return this.inflate(
			await this.retryIfConnectionLost((dbh) => dbh.get(this.table(), id)),
			span,
		);
	}

	/**
	 * Inserts a new object into the database
	 *
	 * See also: {@link DatabaseObject#findOrCreate}
	 *
	 * @param {Object} data Key/value pairs of data to insert into the database
	 * @returns {DatabaseObject} Instantiated object containing the data given and any default values set in the schema, as well as the fresh ID from the database (or UUID generated)
	 */
	static async create(data /* , params */) {
		const idField = this.idField();
		const { [idField]: id } = data;
		const {
			fieldMap: {
				[idField]: { type: idType },
			},
		} = this.schema();

		if (!id && idType === 'uuidKey') {
			data[idField] = this.generateObjectId();
			// console.log(`create() assigned id:`, data.id);
		} else {
			// console.log(
			// 	`create() NOT giving id because data had id or type=${idType}`,
			// 	data,
			// );
		}

		const createArgs = [
			this.table(),
			this.deflateValues({ ...data, createdAt: new Date() }, true),
			{
				allowBlankIdOnCreate: idType === 'idKey',
				idGenerator: this.generateObjectId,
			},
		];

		const createdRow = await this.retryIfConnectionLost((dbh) =>
			dbh.create(...createArgs),
		);
		// console.log(`obj create result:`, createdRow, {
		// 	originalData: data,
		// 	createdRow,
		// });

		if (!createdRow) {
			throw new Error(
				`Internal error creating row in database: Undefined result`,
			);
		}

		if (!createdRow[idField]) {
			throw new Error(
				`Internal error after creating row: No id on object returned: ${jsonSafeStringify(
					createdRow,
					0,
				)}`,
			);
		}

		const span = { name: 'create', props: { data }, stack: [] };

		const instance = await this.inflate(createdRow, span);

		// console.log(`instance from row`, createdRow, instance);

		await instance.afterCreateHook();
		await instance.afterChangeHook();

		return instance;
	}

	/**
	 * [INTERNAL] Do not construct `DatabaseObject`s directly - use static accessors
	 * like {@link DatabaseObject#get}, {@link DatabaseObject#search}, etc.
	 * @private
	 */
	constructor(data, constructorAllowed) {
		if (constructorAllowed !== FROM_INFLATE_SYMBOL)
			throw new TypeError(
				'Call ClassName.inflate() instead of new ClassName()',
			);

		// Object.assign(this, {}, data);
		// this._data = data;
		// this._defineProperties();

		// Cache frequently accessed values for this instance
		this[CACHED_FIELDS_SYMBOL] = this.constructor.fields();

		const fields = this[CACHED_FIELDS_SYMBOL];
		for (let i = 0; i < fields.length; i++) {
			const row = fields[i];
			this[row.field] = data[row.field];
		}
	}

	// _defineProperties() {
	// 	this.constructor.fields().forEach(row => {
	// 		Object.defineProperty(this, row.field, {
	// 			enumerable: true,
	// 			get: function() {
	// 				let value = this._data[row.field];
	//
	// 				// Can't inflate here - getters can't be async
	// 				// if(row.linkedModel)
	// 				// 	value = this._resolvedLinkedModel(row.linkedModel, value);
	//
	// 				return value;
	//
	// 			},
	//
	// 			set: function(newValue) {
	// 				this.set(row.field, newValue);
	// 			}
	// 		});
	// 	})
	// }

	/**
	 * Set a given `field` to a `newValue`
	 * @param {string} field Field to set
	 * @param {any} newValue Value to set
	 * @returns {DatabaseObject} `this
	 */
	set(field, newValue) {
		if (typeof field === 'object') {
			const keys = Object.keys(field);
			for (let i = 0; i < keys.length; i++) {
				const fieldName = keys[i];
				this.set(fieldName, field[fieldName]);
			}
			return this;
		}

		// this._changed[row.field] = {
		// 	// oldValue: this._data[row.field],
		// 	oldValue: this[row.field],
		// 	newValue
		// };
		// this._data[row.field] = newValue;

		this[field] = newValue;
		this._deferPatch();

		return this;
	}

	_deferPatch() {
		clearTimeout(this._patchDeferTid);
		this._patchDeferTid = setTimeout(() => this.update(), PATCH_DEFER_DELAY);
	}

	/**
	 * Patches the object, conditionally only setting certain values if false.
	 * @param {object} values Values to set on the object and overwrite existing values
	 * @param {object} ifFalsey Values to set if the existing values are falsey (null/undefined/false/0/empty string)
	 * @returns {DatabaseObject} `this`
	 */
	async patchIf(values = {}, ifFalsey = {}) {
		// Reset from setter
		// this._changed = {};
		const span = { name: 'patchIf', props: { values, ifFalsey }, stack: [] };
		return this._updateProperties(
			await this.retryIfConnectionLost((dbh) =>
				dbh.patchIf(
					this.constructor.table(),
					this.deflate(this),
					this.deflate(values),
					this.deflate(ifFalsey),
				),
			),
			span,
		);
	}

	/**
	 * update - Alias for `patch()`
	 *
	 * @param {Object} data Data to patch, may be empty
	 *
	 * @returns {Object} Object data once patched (complete data set)
	 */
	update(data /* , params */) {
		return this.patch(data);
	}

	/**
	 * Patches the object and catches ERR_NONCE failures and will retry the patch after a short delay.
	 *
	 * When it retries, it will first execute your `opts.shouldRetry` function - see notes below. Use a custom `shouldRetry` to short-circuit retries if the disk value gets changed externally to the value you want anyway.
	 *
	 * @param {object} patch Patch to apply
	 * @param {Logger} opts.logger [optional] Logger to use, defaults to console
	 * @param {number} opts.maxRetryTime [default: 30s] Max time to keep retrying, before throwing an error and really failing
	 * @param {function} opts.shouldRetry [default: (latestObj) => true] Optional async function, called with the latest data from disk. If you return false from it, no more tries, no failures. If return true, keep trying. Use this to check to see if your value you were trying to change really is changed, or if the changes is no longer relevant, etc. (For example, if your `patch` was { isUserOnline: true }, your shouldRetry could be as simple as: `shouldRetry: (d) => !d.isUserOnline` - i.e. keep retrying unless "someone else" sets isUserOnline to true - which is what we want anyway)
	 * @param {boolean} opts.verbose [default: false] Enable logging of intermediate results via the passed `logger.warn` method. Defaults to false. If enabled, logs retries and success. Does not disable errors or throwing.
	 * @returns {object} Object like `{ result, nonceFail, error }` where `result` is the actual result from the `patch` function, `nonceFail` is boolean true/false if we failed applying, and `error` is any error thrown while trying to apply the patch.
	 */
	async patchWithNonceRetry(
		patch,
		{
			logger = {
				warn: console.warn.bind(console),
				error: console.error.bind(console),
			},
			verbose = false,
			maxRetryTime = 30000,
			shouldRetry = async () => true,
		} = {},
	) {
		const patchAndCatch = async (db) => {
			let error;
			const result = await db.patch(patch).catch((ex) => {
				error = ex;
			});
			const nonceFail = error && error.code === 'ERR_NONCE';
			return { result, nonceFail, error };
		};

		const t1 = Date.now();
		let retryCount = 0;
		let delayFactory;

		const id = this.getId();
		const className = this.constructor.name;
		const debugKey = `${className}:${id}`;

		const retryFunc = async (ref) => {
			const { result, nonceFail, error } = await patchAndCatch(ref);
			if (!error) {
				if (retryCount > 0 && verbose) {
					logger.warn(
						`${debugKey}: We had ERR_NONCE but moved to SUCCESS (so you could say ERR_NONCE_SUCCESS) after ${retryCount} retries and ${
							Date.now() - t1
						}ms. Data patch we were attempting was:`,
						patch,
					);
				}

				return result;
			}

			if (!nonceFail) {
				logger.error(`Error, but not a nonce failure`, {
					error: {
						message: error.message,
						stack: error.stack,
					},
					patch,
				});
				throw error;
			}

			if (!delayFactory) {
				delayFactory = exponentialDelayFactory({
					initialDelay: 1500,
					multiplier: 1.25,
					maxDelay: 10000,
				});
			}

			const delta = Date.now() - t1;
			if (delta > maxRetryTime && nonceFail) {
				throw new Error(
					`${debugKey}: Nonce still failing after ${retryCount} retries for patch ${jsonSafeStringify(
						patch,
						0,
					)}`,
				);
			}

			retryCount++;
			const delay = delayFactory();
			if (verbose) {
				logger.warn(
					`${debugKey}: Nonce patch failed, waiting ${delay}ms before doing retry # ${retryCount} ... `,
					patch,
				);
			}

			await new Promise((resolve) => setTimeout(resolve, delay));

			// Load fresh from disk so we have latest changes
			const db = await this.constructor.get(id);

			const canRetry = await shouldRetry(db);
			if (!canRetry) {
				if (verbose) {
					logger.warn(
						`${debugKey}: After nonce fail and delay, shouldRetry returned false so not retrying patch:`,
						patch,
					);
				}
				return db;
			}

			return retryFunc(db);
		};

		return retryFunc(this);
	}

	async patch(data /* , params */) {
		// Reset from setter
		// delete this._changed;
		// console.log("[obj.patch] data=", data);

		const schema = this.constructor.schema();
		if (
			!data.updatedAt &&
			!schema.disableAutoUpdatedAt &&
			schema.fieldMap.updatedAt
		) {
			data.updatedAt = new Date();
		}

		// If nonce included in the schema, then enforce nonce feature
		if (this.constructor.schema().fieldMap.nonce) {
			// Get the nonce from the patch, or if not given, from the props on this object
			const { nonce: memoryNonce = this.nonce } = data || {};
			// Load the current nonce on disk
			const { table, idField } = parseIdField(this.table());
			const nonceData = await this.retryIfConnectionLost((dbh) => {
				const sql = `select \`nonce\` from ${autoFixTable(
					table,
					dbh,
				)} where \`${idField}\`=:id`;
				return dbh.pquery(sql, { id: this.id });
			});

			const [{ nonce: diskNonce = undefined }] = Array.from(nonceData || []);

			// Compare the nonces and throw if mismatch
			if (diskNonce && diskNonce !== memoryNonce) {
				const json =
					jsonSafeStringify(data, 0) || '<<Error stringifying patch>>';

				const error = new Error(
					`Nonce mismatch for table ${table} id ${this.id} (disk='${diskNonce}', memory='${memoryNonce}') - reload data from disk and retry patch. Wanting to patch: ${json}`,
				);
				error.code = 'ERR_NONCE';
				throw error;
			}

			// Generate a new random nonce for this edit
			data.nonce = `nonce_${Math.round(Math.random() * Date.now())}`;
		}

		const deflated = this.deflate(data);
		// console.log('[obj.patch] deflated=', deflated);

		if (!Object.keys(deflated).length) {
			console.warn(
				`No data you gave to patch ${
					this.constructor.name
				}:${this.getId()} made it to disk - nothing came out of deflation, did you give fields in the patch that aren't in the schema?`,
				// data,
			);
			// throw new Error(`Invalid fields in patch, see logs`);
			return this;
		}

		const span = { name: 'patch', props: { data }, stack: [] };
		return this._updateProperties(
			await this.retryIfConnectionLost((dbh) =>
				dbh.patch(this.constructor.table(), this[this.idField()], deflated),
			),
			span,
		);
	}

	/**
	 * remove - Sets the 'isDeleted' property to true, or throws Error if no isDeleted defined in schema().fieldMap
	 *
	 * @returns {Promise} promise that fulfills when patch completes
	 */
	remove(/* , params */) {
		this.constructor.removeCachedId(this[this.idField()]);

		// return dbh.destroy(this.constructor.table(), this.id);
		// throw new Error("todo");
		if (this.constructor.schema().fieldMap.isDeleted) {
			return this.patch({ isDeleted: true });
		}
		// console.dir(this.constructor.fields());
		throw new Error(
			'Refusing to DELETE object, add isDeleted field to schema instead',
		);
	}

	/**
	 * So named so it's not easy to delete accidentally
	 */
	async reallyDelete() {
		this.constructor.removeCachedId(this[this.idField()]);

		const { table } = parseIdField(this.constructor.table());
		return this.retryIfConnectionLost((dbh) => {
			const idField = this.idField();
			const sql = `delete from ${autoFixTable(
				table,
				dbh,
			)} where \`${idField}\`=:id`;
			return dbh.pquery(sql, { id: this[idField] });
		});
	}

	/**
	 * Get the ID value for this object
	 * @returns {any} Returns the ID for this object
	 */
	getId() {
		return this[this.idField()];
	}

	/**
	 * Useful method to check what SQL is being generated
	 * @param {string} sql SQL string to apply substitutions too
	 * @param {object} args Object containing key/value substitution args
	 * @returns {string} SQL with interpolated values
	 */
	static debugSql(sql, args) {
		return debugSql(sql, args);
	}

	/**
	 * Useful method to check what SQL is being generated
	 * @param {string} sql SQL string to apply substitutions too
	 * @param {object} args Object containing key/value substitution args
	 * @returns {string} SQL with interpolated values
	 */
	debugSql(sql, args) {
		return debugSql(sql, args);
	}
}

// Expose for external use
DatabaseObject.QueryTiming = QueryTiming;

// Cache the definitions to prevent hitting disk every time the process
// loads the same file. Should never happen, but trying to reduce local
// disk access to the bare minimum.
const getCachedDefinition = (basePath, definitionFile) => {
	// Debug: log inputs to understand path structure in bundled executables
	if (process.env.YASS_DEBUG_PATH_RESOLVER) {
		console.log(
			`[getCachedDefinition] INPUTS: basePath='${basePath}', definitionFile='${definitionFile}'`,
		);
	}
	const resolvedPath = path.resolve(basePath, definitionFile);
	const cached = MODEL_DEFINITION_CACHE[resolvedPath];
	if (cached) {
		if (DEBUG_MODEL_CACHE_HITS) {
			console.log(
				`[getCachedDefinition] [✅ cache hit ✅] Returning cached definition for ${resolvedPath}`,
				`${Object.keys(MODEL_DEFINITION_CACHE).length} definitions in cache`,
			);
		}
		return cached;
	}

	// Check global definition index - this enables bundled executables (e.g., bun build --compile)
	// to provide definition functions without filesystem access. Definitions register themselves via
	// registerDefinition() which populates globalThis.__YASS_ORM_DEFINITION_INDEX__
	const externalDefIndex = globalThis.__YASS_ORM_DEFINITION_INDEX__;
	if (externalDefIndex instanceof Map && externalDefIndex.size > 0) {
		// Normalize path to match how definitions are registered
		// This extracts just the suffix starting from 'defs/' to create a common key
		let normalizedPath = resolvedPath.replace(/\.(js|ts|cjs|mjs)$/, '');
		const defsIdx = normalizedPath.lastIndexOf('/defs/');
		if (defsIdx !== -1) {
			normalizedPath = normalizedPath.substring(defsIdx + 1);
		}

		const registered = externalDefIndex.get(normalizedPath);
		if (registered) {
			if (DEBUG_MODEL_CACHE_HITS) {
				console.log(
					`[getCachedDefinition] [✅ external index hit ✅] Found definition in global index for ${normalizedPath}`,
				);
			}
			// Cache for future lookups
			MODEL_DEFINITION_CACHE[resolvedPath] = registered;
			return registered;
		}

		// Debug: log when we expected to find the definition but didn't
		if (DEBUG_MODEL_CACHE_HITS || process.env.YASS_DEBUG_DEFINITION_INDEX) {
			console.log(
				`[getCachedDefinition] [❌ external index miss ❌] Looking for '${normalizedPath}', resolvedPath='${resolvedPath}', index has ${externalDefIndex.size} entries:`,
				Array.from(externalDefIndex.keys()).slice(0, 10),
			);
		}
	}

	// Check for def path map - this enables bundled executables (e.g., bun build --compile)
	// to resolve definitions by name when path information is lost during bundling.
	// The map is injected at build time via: define: { 'globalThis.__YASS_DEF_PATH_MAP__': JSON.stringify(map) }
	const defPathMap = globalThis.__YASS_DEF_PATH_MAP__;
	let actualPath = resolvedPath;

	if (defPathMap && typeof defPathMap === 'object') {
		// Extract the def name from the path (filename without extension)
		const defName = path
			.basename(resolvedPath)
			.replace(/\.(js|ts|cjs|mjs)$/, '');
		const mappedPath = defPathMap[defName];

		if (mappedPath) {
			actualPath = mappedPath;
			if (DEBUG_MODEL_CACHE_HITS || process.env.YASS_DEBUG_PATH_RESOLVER) {
				console.log(
					`[getCachedDefinition] Def map resolution: '${defName}' -> ${mappedPath}`,
				);
			}
		} else if (process.env.YASS_DEBUG_PATH_RESOLVER) {
			console.log(
				`[getCachedDefinition] Def name '${defName}' not found in path map (${
					Object.keys(defPathMap).length
				} entries)`,
			);
		}
	}

	// Fallback: Check for path resolver function
	// This enables custom path translation (e.g., /$bunfs/ to real paths if pattern is known)
	if (actualPath === resolvedPath) {
		const pathResolver = globalThis.__YASS_ORM_PATH_RESOLVER__;
		if (typeof pathResolver === 'function') {
			actualPath = pathResolver(resolvedPath);
		}
	}

	if (
		DEBUG_MODEL_CACHE_HITS ||
		process.env.YASS_DEBUG_PATH_RESOLVER ||
		(actualPath !== resolvedPath && process.env.YASS_DEBUG_DEFINITION_INDEX)
	) {
		console.log(
			`[getCachedDefinition] Path resolution: ${resolvedPath} -> ${actualPath}`,
		);
	}

	// Use createRequire for ESM compatibility - this creates a require function
	// that works in both CJS and ESM contexts
	const { createRequire } = require('module');
	const { pathToFileURL } = require('url');
	const esmRequire = createRequire(pathToFileURL(actualPath).href);
	const definition = esmRequire(actualPath);
	MODEL_DEFINITION_CACHE[resolvedPath] = definition; // Cache with original key for consistency

	if (DEBUG_MODEL_CACHE_HITS) {
		console.log(
			`[getCachedDefinition] [❌ cache miss ❌] Loaded definition for ${resolvedPath}, cache keys now:`,
			Object.keys(MODEL_DEFINITION_CACHE),
			`${Object.keys(MODEL_DEFINITION_CACHE).length} definitions in cache`,
		);
	}
	return definition;
};

/**
 * loadDefinition - Convenience function so subclasses can do this:
 * ```
 * 		const base = require('yass-orm').loadDefinition('./defs/some-definition');
 * 		class MyModel extends base {
 * 			someMethod() { ... }
 * 		}
 * ```
 *
 * ES6 is also supported, so you can do this even:
 *
 * ```
 *      import { loadDefinition } from 'yass-orm';
 *
 *      class MyModel extends loadDefinition('./defs/some-definition') {
 *          // ...
 *      }
 * ```
 *
 * @param {String} definition File name of the definition to require()
 *
 * @returns {class} Class to extend (or just export again)
 */
const loadDefinition = (definitionFile) => {
	const parentModuleUrl = parentModule();
	const basePath = path.dirname(fileUrlToPath(parentModuleUrl));

	// Debug: log parentModule result to understand bundled path structure
	if (process.env.YASS_DEBUG_PATH_RESOLVER) {
		// Also log the caller stack to see where this is coming from
		const stackLines = new Error().stack
			.split('\n')
			.slice(2, 6)
			.map((l) => l.trim());
		console.log(
			`[loadDefinition] parentModule()='${parentModuleUrl}', basePath='${basePath}', definitionFile='${definitionFile}'`,
		);
		console.log(`[loadDefinition] Stack: ${stackLines.join(' <- ')}`);
	}

	const definition =
		typeof definitionFile === 'function'
			? definitionFile
			: getCachedDefinition(basePath, definitionFile);

	const schema = convertDefinition(definition);

	// Allow consumers of this library to extend/override this
	// to add common functionality for all their classes.
	// For example, customizing the default 'jsonify' behavior,
	// or adding a Redis cache instead of in-memory cache, etc.
	const { baseClass = DatabaseObject } = config;

	return class extends baseClass {
		static basePath() {
			return basePath;
		}

		static schema() {
			return schema;
		}
	};
};

/**
 * Register a definition function for bundled executable support.
 * This enables bundled executables (e.g., bun build --compile) to pre-register
 * definition functions that loadDefinition can use without filesystem access.
 *
 * @param {string} name - The definition name/path (e.g., 'webhook-log' or 'defs/webhook-log')
 * @param {Function} defFn - The definition function that returns the schema
 *
 * @example
 * // In your defs file:
 * import { registerDefinition } from 'yass-orm';
 * const def = ({ types: t }) => ({ table: 'users', schema: { ... } });
 * registerDefinition('user', def);
 * export default def;
 */
const registerDefinition = (name, defFn) => {
	if (!globalThis.__YASS_ORM_DEFINITION_INDEX__) {
		globalThis.__YASS_ORM_DEFINITION_INDEX__ = new Map();
	}
	// Normalize the name to match lookup format: 'defs/name'
	const normalizedName = name.startsWith('defs/')
		? name
		: `defs/${name.replace(/\.(js|ts|cjs|mjs)$/, '')}`;
	globalThis.__YASS_ORM_DEFINITION_INDEX__.set(normalizedName, defFn);
};

module.exports = {
	loadDefinition,
	DatabaseObject,
	convertDefinition,
	retryIfConnectionLost,
	QueryTiming,
	QueryLogger,
	// For external deep access
	libUtils,
	dbhUtils,
	config,
	loadBalancerManager,
	LoadBalancer,
	updatePromiseMapDefaultConfig,
	// Graceful shutdown helper
	closeAllConnections,
	// Bundled executable support
	registerDefinition,
};
