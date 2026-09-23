/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require */
require('./decyclePolyfill');

// DatabaseObject: the model base class. Its methods are the public API; the
// work behind the cache, hydration, link resolution and definition loading
// lives in lib/model/*, and each method here that moved is a thin delegate
// that passes `this` along. Those modules call back through the class or
// instance (`Model.getCachedId(...)`), never around it, so a subclass that
// overrides any method (Rubber's _shared-base.js overrides get,
// getCachedId(id, span), setCachedId, afterChangeHook(txOptions), patch and
// findOrCreate) sees every call, in the same order, it always has.

const { v4: uuid } = require('uuid');
const { prefixedId, timeOrderedId } = require('./objectId');
const { jsonSafeStringify } = require('./jsonSafeStringify');
const { txInstanceCache } = require('./txInstanceCache');

const config = require('./config');
const {
	normalizeSearchOptions,
	splitSearchOneOptions,
} = require('./search-options');

// For external deep access
const libUtils = require('./utils');
const dbhUtils = require('./dbh');

// import convertDefinition for easy of use by subclasses
const { convertDefinition } = require('./def-to-schema');
const { finder } = require('./finder');
const {
	autoFixTable,
	debugSql,
	QueryTiming,
	QueryLogger,
	loadBalancerManager,
	LoadBalancer,
	closeAllConnections,
	FIND_OR_CREATE_META,
} = require('./dbh');

const { parseIdField } = require('./parseIdField');
const {
	resolveIndexColumns,
	isUniqueIndexSpec,
} = require('./resolveIndexColumns');

const {
	handle,
	retryIfConnectionLost,
	exponentialDelayFactory,
	isUniqueViolation,
	isConstraintError,
} = require('./utils');
const {
	promisePoolMap,
	DEFAULT_PROMISE_POOL_MAP_CONFIG,
	updatePromiseMapDefaultConfig,
} = require('./promiseMap');

const cache = require('./model/cache');
const hydrate = require('./model/hydrate');
const resolveModel = require('./model/resolve-model');
const {
	loadDefinition,
	registerDefinition,
} = require('./model/definition-loader');
const {
	stripManagedKeys,
	registerGlobalChangeHook,
	runGlobalChangeHooks,
} = require('./model/change-hooks');
const {
	registerModel,
	registerModels,
	getRegisteredModel,
	checkLinks,
} = require('./model/registry');

const { FROM_INFLATE_SYMBOL } = hydrate;

const PATCH_DEFER_DELAY = 300;

// Used for cached fields to prevent external access
const CACHED_FIELDS_SYMBOL = Symbol('CACHED_FIELDS_SYMBOL');
const CACHED_ID_FIELD_SYMBOL = Symbol('CACHED_ID_FIELD_SYMBOL');

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
	async jsonify(options) {
		return hydrate.jsonify(this, options);
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
	 * Runs `callback` on an explicit transaction handle when one is given,
	 * otherwise on a pooled handle with the usual lost-connection retry.
	 *
	 * Inside a transaction there is deliberately NO retry wrapper: a dropped
	 * connection kills the whole transaction, and retrying that single statement
	 * on a fresh connection would land the write OUTSIDE the transaction —
	 * committed and unrollbackable — while the surrounding transaction rolls
	 * back. `dbh.transaction({ maxRetries })` retries at the correct
	 * granularity: the entire callback, replayed from the start.
	 *
	 * @param {object} [tx] Transaction handle from `dbh.transaction((tx) => ...)`
	 * @param {function} callback Receives the handle to execute against
	 */
	static _runOn(tx, callback) {
		if (tx) {
			return callback(tx);
		}
		return this.retryIfConnectionLost(callback);
	}

	_runOn(tx, callback) {
		return this.constructor._runOn(tx, callback);
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
		return cache.getClassCache(this);
	}

	/**
	 * The instance cache's bucket key for this class: its name and its table
	 * (see lib/model/cache.js).
	 *
	 * @private
	 */
	static _classCacheKey() {
		return cache.classCacheKey(this);
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
		return cache.getCachedId(this, id);
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
		return cache.setCachedId(this, id, freshData);
	}

	/**
	 * Copies every schema field from `source` onto `target`, so references to
	 * `target` see the fresh values. How a cached instance is freshened.
	 *
	 * @private
	 */
	static _freshenInstance(target, source) {
		cache.freshenInstance(this, target, source);
	}

	/**
	 * Removes the given ID from the cache
	 * @param {string|number} id ID key to remove
	 * @returns {boolean} True if object existed, false if object was not present
	 * @static
	 * @memberof DatabaseObject
	 */
	static removeCachedId(id) {
		return cache.removeCachedId(this, id);
	}

	/**
	 * Empties all keys from the cache. Note that this does NOT destroy any existing references held externally, nor does it destroy any data in the database. This just removes the cached data so new calls will get fresh data right from the DB.
	 * @static
	 * @memberof DatabaseObject
	 */
	static clearCache() {
		cache.clearCache(this);
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
	static async inflate(data, span = undefined, promisePoolMapConfig, options) {
		return hydrate.inflate(this, data, span, promisePoolMapConfig, options);
	}

	/**
	 * Takes a raw set of data from the database and applies any existing schema transformations to the data (such as inflating Dates, converting numbers, parsing JSON)
	 * @param {object} data Data to inflate
	 * @returns {object} Object containing the transformed data
	 */
	static async inflateValues(data, span, promisePoolMapConfig, options) {
		return hydrate.inflateValues(
			this,
			data,
			span,
			promisePoolMapConfig,
			options,
		);
	}

	// Supported model file extensions, in order of preference
	static MODEL_EXTENSIONS = ['.js', '.ts', '.cjs', '.mjs'];

	/**
	 * The model class a link names: a lazy reference (`() => Model`), a name
	 * in the model registry, or a path (see lib/model/resolve-model.js).
	 *
	 * @private
	 */
	static async _resolveModelClass(link, errorHint = '', span = undefined) {
		return resolveModel.resolveModelClass(this, link, errorHint, span);
	}

	/**
	 * The linked row `modelId` as an instance of the model `link` names.
	 *
	 * @private
	 */
	static async _resolvedLinkedModel(link, modelId, span = undefined, options) {
		return resolveModel.resolvedLinkedModel(this, link, modelId, span, options);
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

	static _processObjectSchema(deflatedData, row, value) {
		return hydrate.processObjectSchema(this, deflatedData, row, value);
	}

	static deflateValues(object, noUndefined) {
		return hydrate.deflateValues(this, object, noUndefined);
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

	async _updateProperties(data, span, options) {
		return hydrate.updateProperties(this, data, span, options);
	}

	/**
	 * Returns all objects that match the whereClause
	 *
	 * @param {type} whereClause SQL to use for query (don't include WHERE, but can use LIMIT, ORDER BY, etc).
	 * 	Defaults to every row (`1=1`: a bare `1` is not a boolean on Postgres).
	 * @param {type} args        If SQL is "name=:someName order by name", then you would set args to {someName:"Bob"}
	 * @static
	 * @returns {type} List of class instances containing the search results
	 */
	static async fromSql(
		whereClause = '1=1',
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
	 * @param {boolean|object} [limitOneOrOptions] Legacy `true`/`false`, OR
	 *   `{ limitOne, limit, offset, orderBy, orderDir }`. Any other key throws,
	 *   naming the key. `orderBy` must be a column on this model.
	 * @param {object} [promisePoolMapConfig] Concurrency config for inflation. May also carry `tx`, so `search(fields, false, { tx })` works as written.
	 * @param {object} [options] `{ tx }` transaction handle to run the query on
	 * @returns {Array<DatabaseObject>|DatabaseObject|null} An ARRAY of instances
	 *   (possibly empty), unless `limitOne` is true.
	 */
	static async search(
		fields = {},
		limitOneOrOptions = false,
		promisePoolMapConfig = this.promisePoolMapConfig ||
			DEFAULT_PROMISE_POOL_MAP_CONFIG,
		{ tx: explicitTx } = {},
	) {
		// This layer owns the schema, so it is the layer that can tell an
		// `orderBy` typo from a real column. dbh.search re-normalizes (the
		// normalizer is idempotent) but has no schema to check against.
		const searchOptions = normalizeSearchOptions(limitOneOrOptions, {
			validColumns: Object.keys(this.schema().fieldMap),
		});
		const { limitOne } = searchOptions;

		// `promisePoolMapConfig` already occupies the third positional slot, so
		// `{ tx }` is also accepted there - otherwise `search(fields, false, { tx })`
		// (the shape callers naturally write) would silently land in the pool config.
		// The explicit fourth argument wins when both are given.
		const { tx: poolConfigTx, ...poolConfig } = promisePoolMapConfig || {};
		const tx = explicitTx || poolConfigTx;
		const effectivePoolConfig = poolConfigTx
			? poolConfig
			: promisePoolMapConfig;

		const res = await this._runOn(tx, (dbh) =>
			dbh.search(this.table(), this.deflateValues(fields), searchOptions),
		);

		const span = {
			name: 'search',
			props: { fields, searchOptions },
			stack: [],
		};

		if (limitOne) {
			return this.inflate(res, span, undefined, { tx });
		}

		return promisePoolMap(
			res,
			async (object) => this.inflate(object, span, undefined, { tx }),
			effectivePoolConfig,
		);
	}

	/**
	 * Searches the database using all `fields` given, all must match. (E.g. `field1=X AND field2=Y ...`)
	 *
	 * @param {object} fields Fields to use for querying. All values will be used (..AND.. style)
	 * @param {object} [options] Second positional. Accepts THREE disjoint
	 *   vocabularies in one object, and throws naming any other key (BDL-2700):
	 *   - search options: `orderBy`, `orderDir` — validated against this model's
	 *     schema by `search()`. (`limit`/`offset` are not expressible here: they
	 *     contradict the single-row shape. Use `search()` for a bounded page.)
	 *   - pool config: `concurrency`, `debug`, `logger`, `throwErrors`, `yieldEvery`.
	 *   - `tx`, so `searchOne(fields, { tx })` keeps working as written.
	 * @param {object} [txOptions] `{ tx }` transaction handle; wins over a `tx`
	 *   passed in `options`.
	 * @returns {DatabaseObject|null} Returns the instantiated `DatabaseObject` if at least one row matches the query fields, OR returns `null` if no rows match.
	 */
	static async searchOne(fields = {}, options = undefined, { tx } = {}) {
		// Before BDL-2700 this method hardcoded `true` into the SECOND slot — the
		// only one carrying `search()`'s option vocabulary — and forwarded the
		// caller's object to the third (pool-config) slot, where an ordering bag
		// is meaningless and is dropped without a word. Partition it instead;
		// `search()` still does the schema-aware validation of the ordering keys,
		// so there is one validator, not two.
		const {
			searchOptions,
			poolConfig,
			tx: optionsTx,
		} = splitSearchOneOptions(options);

		// `poolConfig` is undefined unless the caller supplied pool keys, so
		// `search()`'s own default parameter still applies in the normal case.
		return this.search(
			fields,
			{ ...searchOptions, limitOne: true },
			poolConfig,
			{ tx: tx || optionsTx },
		);
	}

	/**
	 * Generate a UUID for a new object. By default, generates using the 'uuid' NPM package. Override to generate, for example, using nanoid.
	 * A definition that declares `objectIdPrefix` gets prefixed, time-ordered ids instead (see loadDefinition).
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
	 * @param {object} options Transaction behavior (`tx`, `useTransaction`, `transactionOptions`).
	 * 	Passing `tx` JOINS the caller's transaction (no inner transaction/savepoint is
	 * 	opened) and takes precedence over `useTransaction`/`transactionOptions`.
	 * @returns {DatabaseObject} Instantiated object containing the data
	 */
	static async findOrCreate(
		fields,
		patchIf = {},
		patchIfFalsey = {},
		options = {},
	) {
		const { tx, useTransaction = true, transactionOptions } = options;

		if (
			tx &&
			('useTransaction' in options || 'transactionOptions' in options)
		) {
			console.warn(
				`[${this.name}.findOrCreate] Both 'tx' and 'useTransaction'/'transactionOptions' were given; 'tx' wins and the caller's transaction is joined.`,
			);
		}

		const deflatedFields = this.deflateValues(fields);

		const {
			fieldMap: {
				[this.idField()]: { type: idType },
			},
		} = this.schema();

		let handleUsed;
		const res = await this._runOn(tx, (dbh) => {
			handleUsed = dbh;
			return dbh.findOrCreate(
				this.table(),
				deflatedFields,
				this.deflateValues(patchIf),
				this.deflateValues(patchIfFalsey),
				{
					allowBlankIdOnCreate: idType === 'idKey',
					// A t.uuidKey id is made here, as create() makes it, not left
					// to the table (see dbh.create's fillInsertedId).
					generateId: idType === 'uuidKey',
					idGenerator: this.generateObjectId,
					// When `tx` is given these are inert: dbh.findOrCreate detects the
					// handle is already transactional (`_transactionContext`) and runs
					// inline, JOINING the caller's transaction instead of opening a
					// savepoint. They are passed through unchanged so retryable-conflict
					// silencing keeps its current behavior.
					useTransaction,
					transactionOptions,
				},
			);
		});

		// Need the ref that was used above to get the action
		const findOrCreateMeta =
			(res && res[FIND_OR_CREATE_META]) || handleUsed.findOrCreate;
		const { lastAction, wasCreated } = findOrCreateMeta;

		const span = {
			name: 'findOrCreate',
			props: { fields, patchIf, patchIfFalsey },
			stack: [],
		};

		const instance = await this.inflate(res, span, undefined, { tx });

		if (wasCreated) {
			if (
				!patchIf.createdAt &&
				!patchIfFalsey.createdAt &&
				this.schema().fieldMap.createdAt
			) {
				await instance.patch(
					{
						createdAt: new Date(),
					},
					{ tx },
				);
			}

			await instance.afterCreateHook({ tx });
		}

		if (lastAction !== 'get') {
			// Run on both patch AND create
			await instance.afterChangeHook({ wasCreated, tx });

			// Fire global change hooks.
			if (wasCreated) {
				// Full deflated entity (includes default-valued fields).
				await runGlobalChangeHooks({
					modelName: instance.constructor.table(),
					id: instance.id,
					changedFields: stripManagedKeys(
						instance.constructor.deflateValues(instance, true),
						instance.constructor.idField(),
					),
					wasCreated: true,
					tx,
				});
			} else {
				// Use the real diff that dbh.patchIf computed (only fields whose
				// values actually differed from what was already in the DB).
				// If nothing changed, lastPatch is {} and Fix 1 suppresses the event.
				const realDiff =
					findOrCreateMeta.lastPatch || handleUsed.patchIf.lastPatch || {};
				await runGlobalChangeHooks({
					modelName: instance.constructor.table(),
					id: instance.id,
					changedFields: stripManagedKeys(
						realDiff,
						instance.constructor.idField(),
					),
					wasCreated: false,
					tx,
				});
			}
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
	static async get(id, { allowCached, span = undefined, tx = undefined } = {}) {
		if (allowCached) {
			// The transaction's own instances first: it must see its own writes.
			const txCache = txInstanceCache(tx);
			const cached =
				(txCache && txCache.get(this, id)) ||
				// 'await' so we can allow subclasses to do async work and block if needed
				(await this.getCachedId(id));
			if (cached) {
				return cached;
			}
		}

		if (!span) {
			span = { name: 'get', props: { id }, stack: [] };
		}

		return this.inflate(
			await this._runOn(tx, (dbh) => dbh.get(this.table(), id)),
			span,
			undefined,
			{ tx },
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
	static async create(data, { tx } = {}) {
		const idField = this.idField();
		const { [idField]: id } = data;
		const {
			fieldMap: {
				[idField]: { type: idType },
			},
		} = this.schema();

		if (!id && idType === 'uuidKey') {
			data[idField] = this.generateObjectId();
		}

		const createArgs = [
			this.table(),
			this.deflateValues({ ...data, createdAt: new Date() }, true),
			{
				allowBlankIdOnCreate: idType === 'idKey',
				idGenerator: this.generateObjectId,
			},
		];

		const createdRow = await this._runOn(tx, (dbh) =>
			dbh.create(...createArgs),
		);

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

		const instance = await this.inflate(createdRow, span, undefined, { tx });

		await instance.afterCreateHook({ tx });
		await instance.afterChangeHook({ tx });

		// Fire global change hooks with the full deflated entity (so default-
		// valued fields are included, not just what the caller passed in).
		await runGlobalChangeHooks({
			modelName: instance.constructor.table(),
			id: instance.id,
			changedFields: stripManagedKeys(
				instance.constructor.deflateValues(instance, true),
				instance.constructor.idField(),
			),
			wasCreated: true,
			tx,
		});

		return instance;
	}

	/**
	 * Resolve the `conflictColumns` argument for {@link DatabaseObject#createIgnore}.
	 *
	 * Exposed as its own static so it is directly unit-testable. That matters
	 * more than it looks: see the DIALECT REALITY note on `createIgnore` below
	 * — no dialect's `buildInsertIgnoreSql` currently READS `conflictColumns`,
	 * so a wrong derivation produces byte-identical SQL on MySQL, SQLite and
	 * Postgres alike and cannot be caught by any end-to-end insert. This
	 * function is therefore the ONLY layer at which the derivation can be
	 * proven correct, and it is tested directly.
	 *
	 * Precedence, in order:
	 *   1. An explicit `conflictColumns` is used VERBATIM, with no derivation.
	 *      Escape hatch for a key the def does not declare.
	 *   2. `uniqueIndex: '<name>'` resolves that index's columns. THROWS if the
	 *      name is absent or the index is not `unique: true` — asking for a
	 *      specific index and silently getting a different answer is worse
	 *      than an error.
	 *   3. Exactly ONE `unique: true` index in the def -> its columns. This is
	 *      the common case and it leaves the CALL SITE carrying zero index
	 *      knowledge, which is the point of the whole exercise.
	 *   4. Zero, or two-or-more, unique indexes -> THROW, naming the model and
	 *      every unique index found, and naming `uniqueIndex` as the fix.
	 *
	 * 🔴 NEVER fall through to `undefined`. On every dialect today an
	 * `undefined` here is harmless, so a fall-through would ship a latent
	 * defect that only wakes up when a dialect starts emitting a targeted
	 * conflict clause — a failure in the reassuring direction, invisible until
	 * long after the code that caused it was written.
	 *
	 * Note the shorthand forms (`myIdx: ['a','b']`) can carry no `unique` flag
	 * at all, so they are never candidates. That is what keeps the `isDeleted`
	 * index which sync-to-db injects into every table from polluting the
	 * derivation: it is array-shorthand.
	 *
	 * @param {Object} [options]
	 * @param {string[]} [options.conflictColumns] Used verbatim if given
	 * @param {string} [options.uniqueIndex] Name of the unique index to target
	 * @returns {string[]} The resolved conflict-target columns
	 */
	static resolveConflictColumns({ conflictColumns, uniqueIndex } = {}) {
		if (conflictColumns !== undefined) {
			return conflictColumns;
		}

		const model = this.table();
		const { options: { indexes } = {} } = this.schema();
		const indexMap = indexes || {};

		// Shared with sync-to-db so the DDL emitter and this deriver cannot
		// disagree about what counts as unique. See isUniqueIndexSpec's docblock.
		const isUniqueSpec = isUniqueIndexSpec;

		const asColumnArray = (spec, indexName) => {
			const cols = resolveIndexColumns(spec);
			const list = Array.isArray(cols) ? cols : [cols];
			if (!cols || list.length === 0 || list.some((c) => !c)) {
				throw new Error(
					`createIgnore: index '${indexName}' on model '${model}' is marked unique but declares no readable column list. ` +
						`Only 'cols' and 'columns' are read (NOT 'fields'); pass conflictColumns explicitly to override.`,
				);
			}
			return list;
		};

		if (uniqueIndex !== undefined) {
			const spec = indexMap[uniqueIndex];
			if (!spec) {
				throw new Error(
					`createIgnore: uniqueIndex '${uniqueIndex}' is not declared on model '${model}'. ` +
						`Declared indexes: ${Object.keys(indexMap).join(', ') || '(none)'}`,
				);
			}
			if (!isUniqueSpec(spec)) {
				throw new Error(
					`createIgnore: uniqueIndex '${uniqueIndex}' on model '${model}' exists but is NOT 'unique: true', ` +
						`so it constrains nothing and cannot be a conflict target.`,
				);
			}
			return asColumnArray(spec, uniqueIndex);
		}

		const uniqueNames = Object.keys(indexMap).filter((name) =>
			isUniqueSpec(indexMap[name]),
		);

		if (uniqueNames.length === 1) {
			return asColumnArray(indexMap[uniqueNames[0]], uniqueNames[0]);
		}

		if (uniqueNames.length === 0) {
			throw new Error(
				`createIgnore: model '${model}' declares no 'unique: true' index, so there is no conflict target to derive. ` +
					`Declare one in the def, or pass conflictColumns explicitly.`,
			);
		}

		throw new Error(
			`createIgnore: model '${model}' declares ${
				uniqueNames.length
			} unique indexes (${uniqueNames.join(
				', ',
			)}), so the conflict target is ambiguous. ` +
				`Pass uniqueIndex: '<name>' to choose one, or conflictColumns explicitly.`,
		);
	}

	/**
	 * Atomic at-most-once insert: the model-layer face of `dbh.createIgnore`.
	 *
	 * Runs a dialect-specific `INSERT ... ON DUPLICATE KEY UPDATE <noop>`
	 * (MySQL) / `INSERT ... ON CONFLICT DO NOTHING` (SQLite, Postgres) and
	 * returns the inflated instance if the row was actually inserted, or
	 * `null` if a UNIQUE/PK conflict caused the insert to be skipped. CHECK,
	 * NOT NULL, FK and other non-conflict errors still throw.
	 *
	 * This is the race-free replacement for SELECT-then-INSERT-with-catch.
	 * {@link DatabaseObject#findOrCreate} is a bare search-then-create with no
	 * row lock: two callers can both search, both miss, and both INSERT, and
	 * only the database can settle it. `createIgnore` never opens that window.
	 *
	 * 🔑 IT CLOSES THE RACE; IT DOES NOT ANSWER "WHICH ROW IS THERE INSTEAD".
	 * A `null` return says only that SOMETHING already occupies a unique slot.
	 * Callers that need the occupant must go read it — and callers whose model
	 * soft-deletes must remember that a soft-deleted row still occupies the
	 * index slot while being invisible to a live-scoped search. No INSERT
	 * primitive can fix that; it is not a race.
	 *
	 * ⚠️ DELIBERATELY NO FIND-FIRST FAST PATH. Whether to read before writing
	 * is caller policy (it trades a round-trip on the hot path against one on
	 * the cold path), and baking it in here would make the primitive's cost
	 * and its race behavior un-auditable from the call site.
	 *
	 * 🔴 DIALECT REALITY, MEASURED 2026-09-14 at 8d8e7e8, and NOT what
	 * `dbh.createIgnore`'s own docblock says: NO dialect's
	 * `buildInsertIgnoreSql` reads `conflictColumns`. MySQLDialect.js:285,
	 * SQLiteDialect.js:266 and PostgresDialect.js:300 each take the parameter
	 * and each carry an explicit `eslint-disable no-unused-vars` over it;
	 * SQLite and Postgres emit an UNCONSTRAINED `ON CONFLICT DO NOTHING`.
	 * (The claim IS true of `buildUpsertSql`, which genuinely requires it —
	 * SQLiteDialect.js:290 throws without it. That is the sibling method, not
	 * this one.) Consequence: a wrong conflict target is INERT everywhere
	 * today and no insert on any dialect can fail on it. It is resolved and
	 * passed anyway, because the parameter is part of the connection-layer
	 * contract and a future targeted-conflict or `RETURNING *` optimization
	 * would start reading it — at which point a silently-undefined value
	 * becomes a live defect in code nobody is looking at. The derivation is
	 * proven by direct unit tests on {@link DatabaseObject#resolveConflictColumns},
	 * because an end-to-end insert structurally cannot prove it.
	 *
	 * @param {Object} data Key/value pairs of data to insert
	 * @param {Object} [options]
	 * @param {Object} [options.tx] Transaction handle
	 * @param {string[]} [options.conflictColumns] Explicit conflict target; skips derivation
	 * @param {string} [options.uniqueIndex] Name of the def index to derive the target from
	 * @param {boolean} [options.allowBlankIdOnCreate] Defaults from the id field's type, as create() does
	 * @param {boolean} [options.silenceErrors] Passed through; the connection layer defaults it to true
	 * @returns {Promise<DatabaseObject|null>} The created instance, or null on conflict
	 */
	static async createIgnore(
		data,
		{
			tx,
			conflictColumns,
			uniqueIndex,
			allowBlankIdOnCreate,
			silenceErrors,
		} = {},
	) {
		const idField = this.idField();
		const { [idField]: id } = data;
		const {
			fieldMap: {
				[idField]: { type: idType },
			},
		} = this.schema();

		if (!id && idType === 'uuidKey') {
			data[idField] = this.generateObjectId();
		}

		// Resolved BEFORE the write so an ambiguous/absent conflict target
		// throws instead of inserting under a target nobody chose.
		const resolvedConflictColumns = this.resolveConflictColumns({
			conflictColumns,
			uniqueIndex,
		});

		const createArgs = [
			this.table(),
			this.deflateValues({ ...data, createdAt: new Date() }, true),
			{
				allowBlankIdOnCreate:
					allowBlankIdOnCreate === undefined
						? idType === 'idKey'
						: allowBlankIdOnCreate,
				idGenerator: this.generateObjectId,
				conflictColumns: resolvedConflictColumns,
				...(silenceErrors === undefined ? {} : { silenceErrors }),
			},
		];

		const createdRow = await this._runOn(tx, (dbh) =>
			dbh.createIgnore(...createArgs),
		);

		// A conflict skipped the insert. NOT an error, and deliberately not a
		// throw — the caller is required to branch on it.
		if (!createdRow) {
			return null;
		}

		if (!createdRow[idField]) {
			throw new Error(
				`Internal error after createIgnore: No id on object returned: ${jsonSafeStringify(
					createdRow,
					0,
				)}`,
			);
		}

		const span = { name: 'createIgnore', props: { data }, stack: [] };

		const instance = await this.inflate(createdRow, span, undefined, { tx });

		// Hooks fire ONLY on the inserted path. A conflict is not a create, so
		// firing anything there would tell every subscriber a row appeared
		// when none did.
		await instance.afterCreateHook({ tx });
		await instance.afterChangeHook({ tx });

		await runGlobalChangeHooks({
			modelName: instance.constructor.table(),
			id: instance.id,
			changedFields: stripManagedKeys(
				instance.constructor.deflateValues(instance, true),
				instance.constructor.idField(),
			),
			wasCreated: true,
			tx,
		});

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

		// Cache frequently accessed values for this instance
		this[CACHED_FIELDS_SYMBOL] = this.constructor.fields();

		const fields = this[CACHED_FIELDS_SYMBOL];
		for (let i = 0; i < fields.length; i++) {
			const row = fields[i];
			this[row.field] = data[row.field];
		}
	}

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

		this[field] = newValue;
		this._deferPatch();

		return this;
	}

	_deferPatch() {
		clearTimeout(this._patchDeferTid);
		// Nothing awaits this save, so a failure must be handled here: left
		// alone it is an unhandled rejection, which crashes Node.
		this._patchDeferTid = setTimeout(() => {
			Promise.resolve()
				.then(() => this.update())
				.catch((error) => this.onAutoSaveError(error))
				.catch((hookError) => {
					console.error(
						`[yass-orm] onAutoSaveError threw for ${
							this.constructor.name
						}:${this.getId()}:`,
						hookError,
					);
				});
		}, PATCH_DEFER_DELAY);
	}

	/**
	 * Called when the save that `set()` schedules fails. Nothing awaits that
	 * save, so its error arrives here rather than at a caller. Override to route
	 * it (the default logs it); may be async. An error thrown from here is
	 * logged, not rethrown.
	 *
	 * @param {Error} error The error from the failed save
	 */
	onAutoSaveError(error) {
		console.error(
			`[yass-orm] auto-save after set() failed for ${
				this.constructor.name
			}:${this.getId()}:`,
			error,
		);
	}

	/**
	 * Patches the object, conditionally only setting certain values if false.
	 * @param {object} values Values to set on the object and overwrite existing values
	 * @param {object} ifFalsey Values to set if the existing values are falsey (null/undefined/false/0/empty string)
	 * @returns {DatabaseObject} `this`
	 */
	async patchIf(values = {}, ifFalsey = {}) {
		const span = { name: 'patchIf', props: { values, ifFalsey }, stack: [] };

		let dbhUsed;
		const updated = await this._updateProperties(
			await this.retryIfConnectionLost((dbh) => {
				dbhUsed = dbh;
				return dbh.patchIf(
					this.constructor.table(),
					this.deflate(this),
					this.deflate(values),
					this.deflate(ifFalsey),
				);
			}),
			span,
		);

		// Use the real diff that dbh.patchIf computed (only fields whose values
		// actually differed from what was on disk).  If nothing changed, lastPatch
		// is {} and Fix 1's empty-changedFields guard suppresses the event entirely.
		const realDiff = (dbhUsed && dbhUsed.patchIf.lastPatch) || {};
		await runGlobalChangeHooks({
			modelName: this.constructor.table(),
			id: this.id,
			changedFields: stripManagedKeys(realDiff, this.constructor.idField()),
			wasCreated: false,
		});

		return updated;
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

	async patch(data, { tx } = {}) {
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
			const nonceData = await this._runOn(tx, (dbh) => {
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

		if (!Object.keys(deflated).length) {
			console.warn(
				`No data you gave to patch ${
					this.constructor.name
				}:${this.getId()} made it to disk - nothing came out of deflation, did you give fields in the patch that aren't in the schema?`,
			);
			return this;
		}

		const span = { name: 'patch', props: { data }, stack: [] };
		const updated = await this._updateProperties(
			await this._runOn(tx, (dbh) =>
				dbh.patch(this.constructor.table(), this[this.idField()], deflated),
			),
			span,
			{ tx },
		);

		// Fire global change hooks with the deflated changed fields (managed
		// keys and the id field stripped so consumers only see user-driven changes).
		await runGlobalChangeHooks({
			modelName: this.constructor.table(),
			id: this.id,
			changedFields: stripManagedKeys(deflated, this.constructor.idField()),
			wasCreated: false,
			tx,
		});

		return updated;
	}

	/**
	 * remove - Sets the 'isDeleted' property to true, or throws Error if no isDeleted defined in schema().fieldMap
	 *
	 * @returns {Promise} promise that fulfills when patch completes
	 */
	remove({ tx } = {}) {
		// Inside a transaction the shared cache is settled when it ends.
		if (!txInstanceCache(tx)) {
			this.constructor.removeCachedId(this[this.idField()]);
		}

		if (this.constructor.schema().fieldMap.isDeleted) {
			return this.patch({ isDeleted: true }, { tx });
		}
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

module.exports = {
	loadDefinition,
	prefixedId,
	timeOrderedId,
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
	// Error classifiers — recognize unique/constraint violations across
	// MySQL/MariaDB/Postgres/SQLite, including yass-orm's wrapped errors.
	isUniqueViolation,
	isConstraintError,
	// Global change hooks — fired after every successful create() / patch()
	registerGlobalChangeHook,
	// The model registry (t.linked('name')) and the startup link check
	registerModel,
	registerModels,
	getRegisteredModel,
	checkLinks,
};
