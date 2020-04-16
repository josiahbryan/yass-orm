"use strict";

// import convertDefinition for easy of use by subclasses
const { convertDefinition } = require('./def-to-schema');
const { dbh: getDbh, autoFixTable, deflateValue, debugSql } = require('./dbh');
const {
	finder,
	// filterData,
	// promiseFilter
} = require('./finder');

const dbh = getDbh();

const PATCH_DEFER_DELAY = 300;

// Private Symbol for this file to prevent new class() from being called
// - use class.inflate() instead
const FROM_INFLATE_SYMBOL = Symbol();
// Used to guard against recursion in inflate()
const INFLATE_GUARD_SYMBOL = Symbol();
// Used to guard against recursion in toJSON()
const TO_JSON_GUARD_SYMBOL = Symbol();

// Cache for object instances
const OBJECT_INSTANCE_CACHE = {};

const DefaultFastifyRoutesOptions = {
	urlRoot: null,
	authRequired: true,
	hooks: {
		before: {
			find:   [],
			get:    [],
			create: [],
			update: [],
			delete: [],
		},
		after: {
			find:   [],
			get:    [],
			create: [],
			update: [],
			delete: [],
		},
	}
};

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
		throw new Error("You forgot to override static schema()");
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
	async jsonify({ includeLinked=false, excludeLinked=false } = {}) {
		const { id, name } = this;
		const struct = { id };
		if(name !== undefined) {
			struct.name = name;
		}

		// Prevent recursion
		if(this[TO_JSON_GUARD_SYMBOL])
			return struct;
		
		this[TO_JSON_GUARD_SYMBOL] = struct;
		
		// Convert linked models via jsonify if they support it
		if(includeLinked || excludeLinked) {
			for await (let row of this.constructor.fields()) {
				const value = this[row.field];
				if(value !== null && value !== undefined) {
					if(row.linkedModel) {
						if(includeLinked)
							struct[row.field] = typeof(value.jsonify) === 'function' ? await value.jsonify() : value;
					} else
					if(excludeLinked) {
						struct[row.field] = value;
					}
				}
			};
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
	static allowedFindParams() { return null; }


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
	mutateQuery  (query, sqlData, ctx) { return Promise.resolve()       }

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
	mutateSort   (sort,  sqlData, ctx) { return Promise.resolve(sort)   }

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
	mutateResult (result, query,  ctx) { return Promise.resolve(result) }

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
	mutateMeta   (meta,  sqlData, ctx) { return Promise.resolve(meta)   }


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
	static async find(query, opts={}) {
		return finder.call(this, query, opts);
	}


	 /**
	  * @static dbh - Easy access to the database handle for direct db access
	  *
	  * @returns {db} Database handle from db/dbh
	  */
	static dbh() {
		return dbh;
	}

	dbh() {
		return dbh;
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
		const cache = OBJECT_INSTANCE_CACHE[className] || (OBJECT_INSTANCE_CACHE[className] = {});
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
		if(!data || !data.id)
			return null;

		// Get cache for this class
		const cache = this._getClassCache();
		
		const cached = cache[data.id] || 
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
		this.fields().map(row => {
			cached[row.field] = inflatedData[row.field];
		});

		// Remove guard and return final object
		delete cached[INFLATE_GUARD_SYMBOL];
		return cached;
	}

	static async inflateValues(data) {
		const inflatedData = {};
		await Promise.all(this.fields().map(async row => {
			let value = data[row.field];
			if(value === null)
				value = null;
			else
			if(value === undefined)
				value = undefined;
			else
			if(row.linkedModel)
				value = await this._resolvedLinkedModel(row.linkedModel, value);
			else
			if(row.isObject)
				value = JSON.parse(value);
			else
			if(row.nativeType == Boolean)
				value = value == '1' ? true : false;
			else
			if(row.nativeType == String)
				value = String(value);
			else
			if(row.nativeType == Date) {
				// const pre = value;
				// DO NOTHING?
				value = new Date((value + "").replace(/^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*$/, '$1T$2.000Z'));
				// console.log("[row.nativeType==Date] inflated:", { id: data.id, pre, value });
			}
			else
			if(row.nativeType === Number)
				value = parseFloat(value);
			else
			if(row.nativeType)
				value = new row.nativeType(value);

			inflatedData[row.field] = value;
		}));

		return inflatedData;
	}

	static async _resolvedLinkedModel(modelName, modelId) {
		const ModelClass = require('./models/' + modelName);
		return ModelClass.get(modelId, { allowCached: true }); // don't force "SELECT" again
	}

	toString() {
		return this.id;
	}

	static _processObjectSchema(deflatedData={}, row={}, value=null) {
		if(value) {
			if(row.objectSchema) {	
				// console.log(" > objectSchema processing...");
				Object.values(row.objectSchema).forEach(subrow => {
					// console.log(` > > ${subrow.field} = ${deflateValue(value[subrow.subfield])} (${subrow.subfield})`, subrow);
					if(subrow.isObject) {
						deflatedData[subrow.field] = this._processObjectSchema(deflatedData, subrow, value[subrow.subfield]);
					} else {
						deflatedData[subrow.field] = deflateValue(value[subrow.subfield]);
					}
				});
						
			}
			value = JSON.stringify(value);
		}
		return value;
	}

	static deflateValues(object={}, noUndefined) {
		const deflatedData = {};
		this.fields().map(row => {
			let value = object[row.field];
			if(row.linkedModel && value && value.id)
				value = value.id;
			else
			if(row.isObject) {
				// console.log("[base-model.deflate] isObject:", value, row);
				const tmp = this._processObjectSchema(deflatedData, row, value);
				if(tmp !== null)
					value = tmp;
			}
			else
			if(row.nativeType == Boolean) {
				if(noUndefined)
					value = value === true ? 1 : 0;
				else
					if(value !== undefined)
						value = value === true ? 1 : 0;
			}
			else
				value = deflateValue(value); // from dbh.js

			if(value !== undefined)
				deflatedData[row.field] = value;
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
		this.constructor.fields().map(row => {
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
	static async fromSql(whereClause, args) {
		const sql = 'select * from ' + autoFixTable(this.table()) + ' where ' + whereClause;
		return dbh.pquery(sql, args).then(rows => {
			return Promise.all(rows.map(row => this.inflate(row)));
		});
	}

	static async search(fields={}, limitOne=false) {
		const res = await dbh.search(
			this.table(),
			Object.assign(fields, this.deflateValues(fields)),
			limitOne
		);

		if(limitOne) {
			return this.inflate(res);
		}

		return Promise.all(res.map(object => this.inflate(object)));
	}

	static async searchOne(fields={}) {
		return this.search(fields, true);
	}

	static async findOrCreate(fields, patchIf, patchIfFalsey) {

		// console.log("[obj.findOrCreate]", { fields });
		const defl = this.deflateValues(fields);
		// console.log("[obj.findOrCreate]", { defl });
		
		const res = await dbh.findOrCreate(
			this.table(),
			defl,
			this.deflateValues(patchIf),
			this.deflateValues(patchIfFalsey)
		);

		const { lastAction, wasCreated } = dbh.findOrCreate;
		// console.log("[obj.findOrCreate]", { lastAction, wasCreated });

		const instance = await this.inflate(res);
		
		if(wasCreated) {
			await instance.patch({
				createdAt: new Date()
			});

			await instance.afterCreateHook();
		}

		if(lastAction != 'get') {
			await instance.afterChangeHook();
		}

		return instance;
	}

	static async get(id, { allowCached } = {}) {
		if(allowCached) {
			const cache = this._getClassCache();
			if (cache[id])
				return cache[id];
		}

		return this.inflate(await dbh.get(this.table(), id));
	}

	static async create(data/*, params*/) {
		const instance = await this.inflate(
			await dbh.create(
				this.table(),
				this.deflateValues({ ...data, createdAt: new Date() }, true)
			));

		await instance.afterCreateHook();
		await instance.afterChangeHook();

		return instance;
	}

	constructor(data, constructorAllowed) {
		if(constructorAllowed != FROM_INFLATE_SYMBOL)
			throw new TypeError("Call ClassName.inflate() instead of new ClassName()");

		// Object.assign(this, {}, data);
		// this._data = data;
		// this._defineProperties();

		this.constructor.fields().forEach(row => {
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

	set(field, value) {
		if(typeof(field) == 'object') {
			for(let fieldName in field) {
				this.set(fieldName, field[fieldName]);
			}
			return;
		}

		// this._changed[row.field] = {
		// 	// oldValue: this._data[row.field],
		// 	oldValue: this[row.field],
		// 	newValue
		// };
		// this._data[row.field] = newValue;
		this[row.field] = newValue;
		this._deferPatch();

		return this;
	}

	_deferPatch() {
		clearTimeout(this._patchDeferTid);
		this._patchDeferTid = setTimeout(() => this.update(), PATCH_DEFER_DELAY);
	}

	async patchIf(values={}, ifFalsey={}) {
		// Reset from setter
		// this._changed = {};

		return this._updateProperties(
			await dbh.patchIf(
				this.constructor.table(),
				this.deflate(this),
				this.deflate(values),
				this.deflate(ifFalsey),
			));
	}


	 /**
	  * update - Alias for `patch()`
	  *
	  * @param {Object} data Data to patch, may be empty
	  *
	  * @returns {Object} Object data once patched (complete data set)
	  */
	update(data/*, params*/) {
		return this.patch(data);
	}

	async patch(data/*, params*/) {
		// Reset from setter
		// delete this._changed;

		if(!data.updatedAt && this.constructor.schema().fieldMap.updatedAt) {
			data.updatedAt = new Date();
		}

		const deflated = this.deflate(Object.assign({}, this, data));
		// console.log("[obj.patch] deflated=", deflated);
		
		return await this._updateProperties(
			await dbh.patch(
				this.constructor.table(),
				this.id,
				deflated
			));
	}

	 /**
	  * remove - Sets the 'isDeleted' property to true, or throws Error if no isDeleted defined in schema().fieldMap
	  *
	  * @returns {Promise} promise that fulfills when patch completes
	  */
	remove(/*, params*/) {
		// return dbh.destroy(this.constructor.table(), this.id);
		// throw new Error("todo");
		if(this.constructor.schema().fieldMap.isDeleted) {
			return this.patch({ isDeleted: true });
		} else {
			// console.dir(this.constructor.fields());
			throw new Error("Refusing to DELETE object, add isDeleted field to schema instead");
		}
	}

	/**
	 * Get FeathersServiceWrapper for this class
	 *
	 * @static
	 * @param {*} options
	 * @returns
	 * @memberof DatabaseObject
	 */
	static service(options) {
		return new FeathersServiceWrapper(this, options);
	}

	/**
	 * Adds Fastify routes for this database class (uses `FeathersServiceWrapper` internally)
	 *
	 * Hint: You can override this in subclasses and call add your own custom routes here -
	 * just make sure you call super.addFastifyRoutes() with the args as well to get the default routes.
	 * 
	 * @static
	 * @param {Fastify} fastify
	 * @param {string} [urlRoot=null] Uses `table()` name as url root if none specified
	 * @param {boolean} [authRequired=true]
	 * @memberof DatabaseObject
	 */
	

	static addFastifyRoutes(fastify, options=DefaultFastifyRoutesOptions) {
		options = Object.assign({}, DefaultFastifyRoutesOptions, options || {});

		const dbClass = this,
			service = dbClass.service();
	
		const auth = options.authRequired ? { 
			beforeHandler: fastify.auth([fastify.requireJwt]),
		} : {};
	
		if(!options.urlRoot)
			options.urlRoot = '/' + dbClass.table();

		const urlRoot = options.urlRoot;

		const runHooks = async (when, action, context={ data: {}, id: null, query: {} }) => {
			const list = ((options.hooks || {})[when] || {}) [action] || [];
			context.when = when;
			context.action = action;
			await Promise.all(list.map(cb => cb(context)));
		};
	
		fastify.route({
			method: 'GET',
			url: urlRoot,
			...auth,
			handler: async (req, reply) => {
				runHooks('before', 'find', { query: req.query });

				const data = await service.find(req.query);

				runHooks('after', 'find', { data, query: req.query });
				return data;
			},
		});
	
		fastify.route({
			method: 'GET',
			url: `${urlRoot}/:id`,
			...auth,
			handler: async req => {
				runHooks('before', 'get', { query: req.query });

				const data = service.get(req.params.id, req.query);

				runHooks('after', 'get', { data, id: req.params.id, query: req.query });
				return data;
			}
		});
	
	
		fastify.route({
			method: 'POST',
			url: urlRoot,
			...auth,
			handler: async req => {
				runHooks('before', 'create', { data: req.body, query: req.query });

				const data = service.create(req.body, req.query);

				runHooks('after',  'create', { data, query: req.query });

				return data;
			},
		});
	
		let patchHandler;
		fastify.route(patchHandler ={
			method: 'POST',
			url: `${urlRoot}/:id`,
			...auth,
			handler: async req => {
				runHooks('before', 'update', { data: req.body, id: req.params.id, query: req.query });

				const data = service.patch(req.params.id, req.body, req.query);

				runHooks('after ', 'update', { data, id: req.params.id, query: req.query });

				return data;
			},
		});
	
		fastify.route({
			...patchHandler,
			method: 'PATCH'
		});
	
		fastify.route({
			method: 'GET',
			url: `${urlRoot}/:id/patch`,
			...auth,
			handler: async req => {
				return service.patch(req.params.id, req.query);
			},
		});
	
		fastify.route(patchHandler ={
			method: 'DELETE',
			url: `${urlRoot}/:id`,
			...auth,
			handler: async req => {
				runHooks('before', 'delete', { id: req.params.id, query: req.query });

				const data = service.remove(req.params.id, req.query);

				runHooks('after', 'delete', { data, id: req.params.id, query: req.query });
				
				return data;
			},
		});
	
	}
}

class FeathersServiceWrapper {
	constructor (dbo, options) {
		this.options = options || {};
		this.dbo = dbo;

		// feathersjs authentication module requires a prop named id with a true value for some weird reason
		this.id = true;
	}
  
	async find (params) {

		// TODO: TEST THIS 
		// if(params.exec || params.query.exec) {
		// 	const exec = params.exec || params.query.exec;

		// 	// console.log(`[FeathersServiceWrapper.get] `, { query, exec });

		// 	// Simple RPC implementation where external users can do
		// 	// GET /foobar/123?exec=customMethod&args[0]=40&args[1]=2
		// 	// And assuming that Foobar.clientSafe={customMethod:true}, and Foobar.prototype.customMethod = (a,b) => a+b,
		// 	// Then we basically do Foobar.get(123).customMethod(40,2)
		// 	// which then will return '42' to the client.
		// 	const allowed = this.dbo.clientSafe;
		// 	if(allowed[exec]) {
		// 		return this.dbo.apply(this.dbo, params.args || params.query.args || []);
		// 	} else {
		// 		throw new Error("query exec arg '"+exec+"' not marked as clientSafe on " + this.dbo + " (set clientSafe={"+exec+":true} on the prototype of that class)");
		// 	}
		// }

		const ret = await this.dbo.find(params);
		// console.log(`[FeathersServiceWrapper.find] `, { params, ret });
		return ret;
	}
  
	async get (id, params) {
		if(!id)
			throw new Error("id required");

		if(id.includes(':')) {
			let exec = null;
			[ id, exec ] = id.split(':');
			params = { query: { exec } };
		}

		const ret = await this.dbo.get(id);
		// console.log(`[FeathersServiceWrapper.get] `, { id, ret });

		const { query } = params || {},
			  { exec }  = query  || {};

		// console.log(`[FeathersServiceWrapper.get] `, { query, exec });

		// Simple RPC implementation where external users can do
		// GET /foobar/123?exec=customMethod&args[0]=40&args[1]=2
		// And assuming that Foobar.clientSafe={customMethod:true}, and Foobar.prototype.customMethod = (a,b) => a+b,
		// Then we basically do Foobar.get(123).customMethod(40,2)
		// which then will return '42' to the client.
		// if(exec) {
		// 	const allowed = ret.clientSafe || ret.constructor.clientSafe || {};
		// 	if(allowed[exec]) {
		// 		return ret[exec].apply(ret, query.args || []);
		// 	} else {
		// 		throw new Error("query exec arg '"+exec+"' not marked as clientSafe on " + ret + " (set clientSafe={"+exec+":true} on the prototype of that class)");
		// 	}
		// } else {
		// 	const allowed = ret.clientSafe || ret.constructor.clientSafe || {};
		// 	ret._methods = Object.keys(allowed);
		// }

		return ret;
	}
  
	async create (data, params) {
		if (Array.isArray(data)) {
			return Promise.all(data.map(current => this.create(current, params)));
		}
  
	  	return this.dbo.create(data);
	}
  
	async update (id, data, params) {
		if(!id)
			throw new Error("id required");

		return this.patch(id, data, params);
	}
  
	async patch (id, data, params) {
		if(!id)
			throw new Error("id required");

		const res = await (await this.get(id)).patch(data);

		// console.log("[FeathersServiceWrapper:patch]", { table: this.dbo.table(), id, data, params, res });
		
		return res;
	}
  
	async remove (id, params) {
		if(!id)
			throw new Error("id required");

		return (await this.get(id)).remove();
	}
}


/**
 * loadDefinition - Convenience function so subclasses can do this:
 * 		const base = require('yass-orm').loadDefinition('./defs/some-definition');
 * 		class MyModel extends base {
 * 			someMethod() { ... }
 * 		}
 *
 * @param {String} definition File name of the definition to require() (relative to 'obj.js' location)
 *
 * @returns {class} Class to extend (or just export again)
 */
const loadDefinition = definition => {
	if(typeof(definition) != 'function' && !definition.default)
		definition = require(require('path').resolve(definition));

	const schema = convertDefinition(definition);
	return class extends DatabaseObject {
		static schema() {
			return schema;
		}
	}
}

module.exports = { loadDefinition, DatabaseObject, dbh, convertDefinition };
