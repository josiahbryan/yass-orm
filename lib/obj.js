/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require */
const path = require('path');
const parentModule = require('parent-module');
const { v4: uuid } = require('uuid');

// import convertDefinition for easy of use by subclasses
const { convertDefinition } = require('./def-to-schema');
const {
	dbh: getDbh,
	autoFixTable,
	deflateValue,
	debugSql,
	QueryTiming,
} = require('./dbh');
const {
	finder,
	// filterData,
	// promiseFilter
} = require('./finder');

async function handle({ ignoreCachedConnections } = {}) {
	if (!handle.dbh || ignoreCachedConnections) {
		handle.dbh = await getDbh({ ignoreCachedConnections });
	}

	return handle.dbh;
}

async function retryIfConnectionLost(callback) {
	// Wrap the callback and catch errors,
	// retrying ONLY if 'connection closed'
	let retry = false;
	let result;
	try {
		result = await callback(await handle());
	} catch (ex) {
		if (
			ex.message &&
			ex.message.includes(`Cannot execute new commands: connection closed`)
		) {
			retry = true;
		} else {
			throw ex;
		}
	}

	// We don't catch in the retry, allowing errors to bubble
	if (retry) {
		return callback(await handle({ ignoreCachedConnections: true }));
	}

	return result;
}

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

class DatabaseObject {
	static debugSql(...args) {
		return debugSql(...args);
	}

	debugSql(...args) {
		return debugSql(...args);
	}

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
		const { id, name } = this;
		const struct = { id };
		if (name !== undefined) {
			struct.name = name;
		}

		// Prevent recursion
		if (this[TO_JSON_GUARD_SYMBOL]) return struct;

		this[TO_JSON_GUARD_SYMBOL] = struct;

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
	 * @static inflate - Takes a raw javascript object and returns a class instance.
	 * Use this instead of new this(object) because you can't await new
	 *
	 * @param {Object} data - Raw object
	 *
	 * @returns {this} Class instance
	 */
	static async inflate(data) {
		if (!data || !data.id) {
			// console.trace(`inflate: invalid data:`, data);
			return null;
		}

		// Get cache for this class
		const cache = this._getClassCache();

		const cached =
			cache[data.id] ||
			// This is the only place that new this() is called or should be called
			// Note: We cache this object so subsequent calls to inflate() with same .id
			// will return same object
			(cache[data.id] = new this({ id: data.id }, FROM_INFLATE_SYMBOL));

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
		return cached;
	}

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
						console.warn(
							`Error parsing JSON in ${this.table()}.${row.field}#${
								data.id
							}: ${ex} - original json:\n\n<<${data[row.field]}>>\n\n`,
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
		const ModelClass = require(path.join(this.basePath(), modelName));
		return ModelClass.get(modelId, { allowCached: true }); // don't force "SELECT" again
	}

	toString() {
		return this.id;
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
		this.fields().forEach((row) => {
			let value = object[row.field];
			if (row.linkedModel && value && value.id) value = value.id;
			else if (row.isObject) {
				// console.log("[base-model.deflate] isObject:", value, row);
				const tmp = this._processObjectSchema(deflatedData, row, value);
				if (tmp !== null) value = tmp;
			} else if (row.nativeType === Boolean) {
				if (noUndefined) value = value === true ? 1 : 0;
				else if (value !== undefined) value = value === true ? 1 : 0;
			} else {
				// console.log("[deflateValues] fallthru for:", value);
				value = deflateValue(value); // from dbh.js
			}

			if (value !== undefined) deflatedData[row.field] = value;
		});

		// console.log("[deflateValues]", object, deflatedData, "\n\n\n");// [ object.updatedAt, deflatedData.updatedAt ]);

		return deflatedData;
	}

	deflate(data, noUndefined) {
		const object = data || this;
		return this.constructor.deflateValues(object, noUndefined);
	}

	// Subclasses can override this hook to update props
	async afterChangeHook() {
		return Promise.resolve(this);
	}

	// Subclasses can override this hook to update props
	// Only called in findOrCreate if lastAction === 'create' or in create()
	async afterCreateHook() {
		return Promise.resolve(this);
	}

	async _updateProperties(data) {
		// console.log("[_updateProperties] got incoming data=", data);
		const inflatedData = await this.constructor.inflateValues(data);
		this.constructor.fields().forEach((row) => {
			this[row.field] = inflatedData[row.field];
		});

		await this.afterChangeHook();

		return this;
	}

	/**
	 * @static fromSql - Returns all objects that match the whereClause
	 *
	 * @param {type} whereClause SQL to use for query (don't include WHERE, but can use LIMIT, ORDER BY, etc)
	 * @param {type} args        If SQL is "name=:someName order by name", then you would set args to {someName:"Bob"}
	 *
	 * @returns {type} List of class instances containing the search results
	 */
	static async fromSql(whereClause = '1', args) {
		return retryIfConnectionLost((dbh) => {
			const sql = `select * from ${autoFixTable(
				this.table(),
				dbh,
			)} where ${whereClause}`;
			return dbh.pquery(sql, args).then((rows) => {
				return Promise.all(rows.map((row) => this.inflate(row)));
			});
		});
	}

	static async queryCallback(callback) {
		return retryIfConnectionLost(async (dbh) =>
			dbh.pquery(...(await callback(this.table()))),
		);
	}

	static async withDbh(callback) {
		return retryIfConnectionLost((dbh) => callback(dbh, this.table()));
	}

	static async search(fields = {}, limitOne = false) {
		const res = await retryIfConnectionLost((dbh) =>
			dbh.search(
				this.table(),
				Object.assign(fields, this.deflateValues(fields)),
				limitOne,
			),
		);

		if (limitOne) {
			return this.inflate(res);
		}

		return Promise.all(res.map((object) => this.inflate(object)));
	}

	static async searchOne(fields = {}) {
		return this.search(fields, true);
	}

	static async findOrCreate(fields, patchIf = {}, patchIfFalsey = {}) {
		// console.log("[obj.findOrCreate]", { fields });
		const defl = this.deflateValues(fields);
		// console.log("[obj.findOrCreate]", { defl });

		const res = await retryIfConnectionLost((dbh) =>
			dbh.findOrCreate(
				this.table(),
				defl,
				this.deflateValues(patchIf),
				this.deflateValues(patchIfFalsey),
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

	static async get(id, { allowCached } = {}) {
		if (allowCached) {
			const cache = this._getClassCache();
			if (cache[id]) return cache[id];
		}

		return this.inflate(
			await retryIfConnectionLost((dbh) => dbh.get(this.table(), id)),
		);
	}

	static async create(data /* , params */) {
		// if (!data.id && this.schema().id === )
		const {
			fieldMap: {
				id: { type: idType },
			},
		} = this.schema();
		if (!data.id && idType === 'uuidKey') {
			data.id = uuid();
			// console.log(`create() assigned id:`, data.id)
		} else {
			// console.log(`create() NOT giving id because data had id or type=${idType}`, data);
		}

		const createdRow = await retryIfConnectionLost((dbh) =>
			dbh.create(
				this.table(),
				this.deflateValues({ ...data, createdAt: new Date() }, true),
			),
		);
		// console.log(`obj create result:`, createdRow);// { originalData: data, createdRow });

		if (!createdRow) {
			throw new Error(
				`Internal error creating row in database: Undefined result`,
			);
		}

		if (!createdRow.id) {
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

		const deflated = this.deflate(Object.assign({}, this, data));
		// console.log("[obj.patch] deflated=", deflated);
		return this._updateProperties(
			await retryIfConnectionLost((dbh) =>
				dbh.patch(this.constructor.table(), this.id, deflated),
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
		return retryIfConnectionLost((dbh) => {
			const sql = `delete from ${autoFixTable(
				this.constructor.table(),
				dbh,
			)} where id=:id`;
			return dbh.pquery(sql, { id: this.id });
		});
	}
}

// Expose for external use
DatabaseObject.QueryTiming = QueryTiming;

/**
 * loadDefinition - Convenience function so subclasses can do this:
 * 		const base = require('yass-orm').loadDefinition('./defs/some-definition');
 * 		class MyModel extends base {
 * 			someMethod() { ... }
 * 		}
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

	return class extends DatabaseObject {
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
};
