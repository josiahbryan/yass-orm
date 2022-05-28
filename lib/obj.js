/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require */
const parentModule = require('parent-module');
const { v4: uuid } = require('uuid');
const path = require('path');

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
	parseIdField,
	QueryTiming,
} = require('./dbh');

const { handle, retryIfConnectionLost, defer } = require('./utils');

const PATCH_DEFER_DELAY = 300;

// Private Symbol for this file to prevent new class() from being called
// - use class.inflate() instead
const FROM_INFLATE_SYMBOL = Symbol('FROM_INFLATE_SYMBOL');
// Used to guard against recursion in inflate()
const INFLATE_GUARD_SYMBOL = Symbol('INFLATE_GUARD_SYMBOL');
// Used to guard against recursion in toJSON()
const TO_JSON_GUARD_SYMBOL = Symbol('TO_JSON_GUARD_SYMBOL');

// Cache for object instances
const OBJECT_INSTANCE_CACHE = {};

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

		// Convert linked models via jsonify if they support it
		if (includeLinked || excludeLinked) {
			// eslint-disable-next-line no-restricted-syntax
			for await (let row of this.constructor.fields()) {
				const value = this[row.field];
				if (value !== null && value !== undefined) {
					if (row.linkedModel) {
						if (includeLinked)
							struct[row.field] =
								typeof value.jsonify === 'function'
									? await value.jsonify()
									: value;
					} else if (excludeLinked) {
						struct[row.field] = value;
					}
				}
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
		// Use fieldMap instead of .fields because .fields contains expanded object schemas and we don't need that
		return Object.values(this.schema().fieldMap);
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
		if (!this.parsedIdField) {
			const { idField } = parseIdField(this.table()) || { id: 'id' };
			this.parsedIdField = idField;
		}
		return this.parsedIdField;
	}

	idField() {
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
	static async inflate(data) {
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
		let cached = await this.getCachedId(id);

		if (!cached) {
			cached = new this({ id, [idField]: id }, FROM_INFLATE_SYMBOL);
			// 'await' so we can allow subclasses to do async work and block if needed
			await this.setCachedId(id, cached);
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
		const inflatedData = await this.inflateValues(data);

		// Freshen cached data or set data first time
		this.fields().forEach((row) => {
			cached[row.field] = inflatedData[row.field];
		});

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
	static async inflateValues(data) {
		const inflatedData = {};
		await Promise.all(
			this.fields().map(async (row) => {
				let value = data[row.field];
				if (value === null) value = null;
				else if (value === undefined) value = undefined;
				else if (row.linkedModel)
					value = await this._resolvedLinkedModel(row.linkedModel, value);
				else if (row.isObject) {
					try {
						if (typeof value === 'string' || value instanceof String) {
							value = JSON.parse(value);
						} else {
							// Not going to try to parse, because it might not be a string
							// value = value;
						}
					} catch (ex) {
						const { [this.idField()]: id } = data;
						console.warn(
							`Error parsing JSON in ${this.table()}.${
								row.field
							}#${id}: ${ex} - original json:\n\n<<${data[row.field]}>>\n\n`,
						);
					}
				} else if (row.nativeType === Boolean) {
					// Allowing casting incase db returns int for booleans
					// eslint-disable-next-line eqeqeq
					value = value == '1';
				} else if (row.nativeType === String) {
					value = String(value);
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
				} else if (row.nativeType === Number) value = parseFloat(value);
				else if (row.nativeType) {
					// eslint-disable-next-line new-cap
					value = new row.nativeType(value);
				}

				inflatedData[row.field] = value;
			}),
		);

		return inflatedData;
	}

	static async _resolvedLinkedModel(modelName, modelId) {
		let ModelClass = require(path.join(this.basePath(), modelName));
		if (ModelClass.default) {
			ModelClass = ModelClass.default; // es6 export as default
		}

		// Certain inflateValue calls COULD incorrectly pass in an already-inflated
		// linked model. so don't force another call to get() if already inflated
		if (modelId instanceof ModelClass && modelId.id === modelId) {
			return modelId;
		}

		return ModelClass.get(modelId, { allowCached: true }); // don't force "SELECT" again
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
			if (row.objectSchema) {
				// console.log(" > objectSchema processing...");
				Object.values(row.objectSchema).forEach((subrow) => {
					// console.log(` > > ${subrow.field} = ${deflateValue(value[subrow.subfield])} (${subrow.subfield})`, subrow);
					if (subrow.isObject) {
						deflatedData[subrow.field] = this._processObjectSchema(
							deflatedData,
							subrow,
							value[subrow.subfield],
						);
					} else {
						deflatedData[subrow.field] = deflateValue(value[subrow.subfield]);
					}
				});
			}
			value = JSON.stringify(value);
		}
		return value;
	}

	static deflateValues(object = {}, noUndefined) {
		const deflatedData = {};
		const idField = this.idField();
		this.fields().forEach((row) => {
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
		});

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

	async _updateProperties(data) {
		// console.log("[_updateProperties] got incoming data=", data);

		const inflatedData = await this.constructor.inflateValues(data);
		this.constructor.fields().forEach(({ field }) => {
			const value = inflatedData[field];
			this[field] = value;
		});

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
	static async fromSql(whereClause = '1', args) {
		return retryIfConnectionLost((dbh) => {
			const { table } = parseIdField(this.table());
			const sql = `select * from ${autoFixTable(
				table,
				dbh,
			)} where ${whereClause}`;
			return dbh.roQuery(sql, args).then((rows) => {
				// console.log(`Got rows:`, rows);
				return Promise.all(rows.map((row) => this.inflate(row)));
			});
		});
	}

	/**
	 * Execute raw SQL against the underlying database
	 * @param {function} callback Function with signature like `(tableName)`, and the function is expected to return an array like `[sql, args]` where `sql` is the string to execute and `args` is an object containing any parameters for the SQL
	 */
	static async queryCallback(callback) {
		return retryIfConnectionLost(async (dbh) =>
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
	static async withDbh(callback) {
		return retryIfConnectionLost((dbh) => callback(dbh, this.table()));
	}

	/**
	 * Searches the database using all `fields` given, all must match. (E.g. `field1=X AND field2=Y ...`)
	 * @param {object} fields Fields to use for querying. All values will be used (..AND.. style)
	 * @returns {Array<DatabaseObject>} Returns an array of instantiated `DatabaseObject` if at least one row matches the query fields, OR returns an empty array, e.g. `[]` (not null, etc)
	 */
	static async search(fields = {}, limitOne = false) {
		const res = await retryIfConnectionLost((dbh) =>
			dbh.search(
				this.table(),
				Object.assign({}, fields, this.deflateValues(fields)),
				limitOne,
			),
		);

		if (limitOne) {
			return this.inflate(res);
		}

		return Promise.all(res.map((object) => this.inflate(object)));
	}

	/**
	 * Searches the database using all `fields` given, all must match. (E.g. `field1=X AND field2=Y ...`)
	 * @param {object} fields Fields to use for querying. All values will be used (..AND.. style)
	 * @returns {DatabaseObject|null} Returns the instantiated `DatabaseObject` if at least one row matches the query fields, OR returns `null` if no rows match.
	 */
	static async searchOne(fields = {}) {
		return this.search(fields, true);
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
	static async findOrCreate(fields, patchIf = {}, patchIfFalsey = {}) {
		// console.log("[obj.findOrCreate]", { fields });
		const deflatedFields = this.deflateValues(fields);
		// console.log("[obj.findOrCreate]", { defl });

		const {
			fieldMap: {
				[this.idField()]: { type: idType },
			},
		} = this.schema();

		const res = await retryIfConnectionLost((dbh) =>
			dbh.findOrCreate(
				this.table(),
				deflatedFields,
				this.deflateValues(patchIf),
				this.deflateValues(patchIfFalsey),
				{
					allowBlankIdOnCreate: idType === 'idKey',
					idGenerator: this.generateObjectId,
				},
			),
		);

		// Need the ref that was used above
		const dbh = await handle();

		const { lastAction, wasCreated } = dbh.findOrCreate;
		// console.log("[obj.findOrCreate]", { lastAction, wasCreated });

		const instance = await this.inflate(res);

		if (wasCreated) {
			await instance.patch({
				createdAt: new Date(),
			});

			await instance.afterCreateHook();
		}

		if (lastAction !== 'get') {
			await instance.afterChangeHook();
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
	static async get(id, { allowCached } = {}) {
		if (allowCached) {
			// 'await' so we can allow subclasses to do async work and block if needed
			const cached = await this.getCachedId(id);
			if (cached) {
				return cached;
			}
		}

		return this.inflate(
			await retryIfConnectionLost((dbh) => dbh.get(this.table(), id)),
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
			// console.log(`create() assigned id:`, data.id)
		} else {
			// console.log(`create() NOT giving id because data had id or type=${idType}`, data);
		}

		const createArgs = [
			this.table(),
			this.deflateValues({ ...data, createdAt: new Date() }, true),
			{
				allowBlankIdOnCreate: idType === 'idKey',
				idGenerator: this.generateObjectId,
			},
		];

		const createdRow = await retryIfConnectionLost((dbh) =>
			dbh.create(...createArgs),
		);
		// console.log(`obj create result:`, createdRow);// { originalData: data, createdRow });

		if (!createdRow) {
			throw new Error(
				`Internal error creating row in database: Undefined result`,
			);
		}

		if (!createdRow[idField]) {
			throw new Error(
				`Internal error after creating row: No id on object returned: ${JSON.stringify(
					createdRow,
				)}`,
			);
		}

		const instance = await this.inflate(createdRow);

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

		this.constructor.fields().forEach((row) => {
			this[row.field] = data[row.field];
		});
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
			Object.keys(field).forEach((fieldName) => {
				this.set(fieldName, field[fieldName]);
			});
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
		return this._updateProperties(
			await retryIfConnectionLost((dbh) =>
				dbh.patchIf(
					this.constructor.table(),
					this.deflate(this),
					this.deflate(values),
					this.deflate(ifFalsey),
				),
			),
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

	async patch(data /* , params */) {
		// Reset from setter
		// delete this._changed;
		// console.log("[obj.patch] data=", data);

		if (!data.updatedAt && this.constructor.schema().fieldMap.updatedAt) {
			data.updatedAt = new Date();
		}

		// If nonce included in the schema, then enforce nonce feature
		if (this.constructor.schema().fieldMap.nonce) {
			// Get the nonce from the patch, or if not given, from the props on this object
			const { nonce: memoryNonce = this.nonce } = data || {};
			// Load the current nonce on disk
			const { table, idField } = parseIdField(this.table());
			const [{ nonce: diskNonce = undefined }] = await retryIfConnectionLost(
				(dbh) => {
					const sql = `select \`nonce\` from ${autoFixTable(
						table,
						dbh,
					)} where \`${idField}\`=:id`;
					return dbh.pquery(sql, { id: this.id });
				},
			);

			// Compare the nonces and throw if mismatch
			if (diskNonce && diskNonce !== memoryNonce) {
				const error = new Error(
					`Nonce mismatch (disk='${diskNonce}', memory='${memoryNonce}') - reload data from disk and retry patch`,
				);
				error.code = 'ERR_NONCE';
				throw error;
			}

			// Generate a new random nonce for this edit
			data.nonce = `nonce_${Math.round(Math.random() * Date.now())}`;
		}

		const deflated = this.deflate(Object.assign({}, this, data));
		// console.log("[obj.patch] deflated=", deflated);
		return this._updateProperties(
			await retryIfConnectionLost((dbh) =>
				dbh.patch(this.constructor.table(), this[this.idField()], deflated),
			),
		);
	}

	/**
	 * remove - Sets the 'isDeleted' property to true, or throws Error if no isDeleted defined in schema().fieldMap
	 *
	 * @returns {Promise} promise that fulfills when patch completes
	 */
	remove(/* , params */) {
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
		const { table } = parseIdField(this.constructor.table());
		return retryIfConnectionLost((dbh) => {
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
	const basePath = path.dirname(parentModule());
	const definition =
		typeof definitionFile === 'function'
			? definitionFile
			: require(path.join(basePath, definitionFile));

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

module.exports = {
	loadDefinition,
	DatabaseObject,
	convertDefinition,
	retryIfConnectionLost,
	QueryTiming,
	// For external deep access
	libUtils,
	dbhUtils,
};
