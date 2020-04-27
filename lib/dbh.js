"use strict";
const mariasql  = require('mariasql');

const config    = require('./config');
const dbHost    = config.host;
const dbUser    = config.user;
const dbPass    = config.password;
const dbName    = config.schema;
const dbCharset = config.charset;


// Lookup
const QueryTiming = {
	enabled: false, // set to false to not record timings
	exclude: sql => false,
	setEnabled(flag, exclude = sql => false) {
		QueryTiming.enabled = flag;
		QueryTiming.queries = {};
		QueryTiming.exclude = exclude || (() => false);
	},
	queries: {},
	analyze() {
		const exclude = QueryTiming.exclude;
		let queries = Object.values(QueryTiming.queries);
		if(exclude) {
			queries = queries.filter(data => !exclude(data[0].sql));
		}
		console.log(`[dbh.QueryTiming.analyze] ${queries.length} unique queries recorded:`);
		return queries.map(data => {
			if(!data.length) {
				return { queryTime: null };
			}
			
			let sum = 0;
			data.forEach(row => sum += row.queryTime);
			return {
				queryTime: sum,
				sql: data[0].sql,
				data
			};
		})
		.filter(a => a.queryTime)
		.sort((a,b) => a.queryTime - b.queryTime)
		.map(result => {
			console.log(` * ${result.queryTime / 1000} sec total (${result.data.length} queries - ${result.queryTime / result.data.length / 1000} avg) - ${result.sql} `);
			// if(result.sql.includes('update optimizations'))
			// 	console.dir(result.data, { depth: 10 });
			return result;
		});
	},
};



function debugSql(sql, args) {
	Object.keys(args).forEach(key => {
		let v = args[key];

		if(typeof(v) === 'string') {
			v = `"${v}"`;
		}

		sql = sql.replace(new RegExp(':' + key, 'g'), v);
	});

	return sql;
}

/**
 * autofixTable - replaces - with _ in table names and escapes the string
 *
 * @param {*} table - name of table
 * @returns Escaped, safe name of table
 */
function autoFixTable(table) {
	// Replace '-' with '_' (feathers uses 'test-name' and mysql uses 'test_name', for example),
	// and escape the name for direct use in SQL
	return mariasql.escape(table.replace(/-/g,'_'));
}

/**
 * sqlEscape - escapes values for use in SQL
 * @param {any} 
 * @returns String with escaped value for use in sql
 */
function sqlEscape(value) {
	return mariasql.escape(value);
}

/**
 *deflateValues - calls deflateValue() for each value of an object or array member
 *
 * @param {Array|Object} params - object to deflate
 * @returns Array or Object with members deflated
 */
function deflateValues(params) {
	if(!params)
		return null;

	if(params.length)
		return params.map(value => deflateValue(value));

	Object.keys(params).forEach(key => {
		params[key] = deflateValue(params[key]);
	});

	// console.log("[deflateValue]", params);

	return params;
}

// From https://stackoverflow.com/questions/1353684/detecting-an-invalid-date-date-instance-in-javascript
function isValidDate(d) {
	return d instanceof Date && !isNaN(d);
}

/**
 *deflateValue - deflates a given value if it's a Date, boolean, or Array
 *
 * @param {*} value
 * @returns Deflated value
 */
function deflateValue(value) {
	// console.log("[deflateValue] ", value, typeof(value));
	if(value && typeof(value) === 'object' && !isNaN(value.id))
		return value.id;

	if(value instanceof Date)
		value = value.toISOString(); //isValidDate(value) ? value.toISOString() : null;

	if(value === true)
		value = 1;
	else
	if(value === false)
		value = 0;

	if((value+'').match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/))
		return value.replace(/(T|\.\d+Z)/g,' ').trim();

	// if(typeof(value) === 'object')
	if(Array.isArray(value))
		return JSON.stringify(value);

	return value;
}

const connCache = {};

/**
 *dbh - returns a monkey-patched mariasql database handle
 *
 * @param {*} Hash containing {host, pass, db} keys - all optional
 * @returns moneky-patched mariasql handle
 */
function dbh(options) {
	if(!options)
		options = {};

	const key = [options.host, options.pass, options.db, options.user].join('.');
	if(connCache[key])
		return connCache[key];

	const config = {
		host:      options.host || dbHost,
		db:        options.db   || dbName,
		password:  options.pass || dbPass,
		user:      options.user || dbUser,
		charset:   options.charset || dbCharset
	};

	const conn = connCache[key] = new mariasql(config);

// let idField; { table, idField } = parseIdField(table);
	const parseIdField = (table) => {
		if(table.indexOf('.') > 0) {
			const parts = table.split('.');
			return { table: parts[0], idField: parts[1] };
		} else {
			return { table, idField: 'id' };
		}
	};

	// conn.connect();

	// use function() instead of ()=> so we can get this == conn
	conn.pquery = async function(sql, params) {
		const trace = new Error().stack;
		const startTime = Date.now();
		const result = await new Promise((resolve,reject) => {
			const raw = deflateValues(params);
			// console.log("[pquery] ", { sql, raw });
		
			this.query(sql, raw, (err, rows) => err ? reject(err) : resolve(rows));
		});
		const endTime = Date.now(),
			queryTime = endTime - startTime;

		if (QueryTiming.enabled) {
			(QueryTiming.queries[sql] || (QueryTiming.queries[sql] = [])).push({ sql, queryTime, params, trace })
		}
			
		return result;
	};


	 /**
	  * search - Searches `table` for fields matching `fields` and returns all
	  * 	rows, or just the first row if `limitOne` is true
	  *
	  * @param {String}  table    Table name to search
	  * @param {Object}  fields   Key/value pairs to search for (only supports equality matching [=])
	  * @param {Boolean} limitOne If true, only returns first row
	  *
	  * @returns {Promise} promise of an array (or a single row if `limitOne` is true)
	  */
	conn.search = function(table, fields={}, limitOne=false) {
		const prep = 'select * from ' + autoFixTable(table),
			keys = Object.keys(fields),
			list = keys.map(x => {
				const col = "`" + mariasql.escape(x) + "`";
				if(fields[x] === null) {
					return `${col} is NULL`;
				}
				return `${col}=:${x}`;
			}),
			sql  = prep + (list.length > 0 ? ' where ' + list.join(' and ') : '') + (limitOne ? ' limit 1' : '');

		if(limitOne && !keys.length)
			return Promise.resolve(null);

		// if(fields.source_sourceId)
			// console.trace("[conn.search]", { sql, fields });

		return this.pquery(sql, fields).then(rows => {
			if(limitOne)
				return rows.length ? rows[0] : null;
			else
				return rows;
		});
	}

	/**
	 * find - see search(), above. This is just an alis for search().
	 */
	conn.find = conn.search;

	 /**
	  * create - Inserts the given `fields` into the `table`
	  *
	  * @param {string} table  Table name to insert into
	  * @param {Object} fields Key/value pairs with the key corresponding exactly to a
	  * 	column name. No conversion is done on the values, so must be explicit
	  * 	values to be inserted (e.g. ids, etc)
	  *
	  * @returns {Promise} Promise of a single row that has been inserted (e.g. we SELECT the
	  * 	row after INSERT to get any triggered values from the DB, including the new ID)
	  */
	conn.create = function(tableAndIdField, fields) {
		let { table, idField } = parseIdField(tableAndIdField);
		// if(idField !== 'id')
		// 	fields.id = idGen();

		const prep = 'insert into ' + autoFixTable(table);
		const fieldList = Object.keys(fields).map(x => mariasql.escape(x));
		const valueList = Object.keys(fields).map(x => ':'+x);

		const sql = prep + ' (' + fieldList.join(',') + ') values (' + valueList.join(',') + ')';

		// console.log("[conn.create]", { sql, fields });
		// if(idField !=== 'id')
		// 	throw new Error("Cannot auto-create because cannot re-query until mariasql gives us our ID - read the docs then update code")

		return this.pquery(sql, fields).then(result => {

			// if(idField !== 'id')
  				fields[idField] = result.info.insertId;

			// NB assumes primary key on all tables is `id`
			const select = 'select * from ' + autoFixTable(table) + ' where ' + idField + '=:id';

			return this.pquery(select, { id: fields[idField] });

		}).then(rows => {
			return rows[0];
		});
	}

	/**
	 * patch - Patches `table` at id `id` with the values in `fields`. NB: Assumes table primary column is `id`
	 *
	 * @param {String} table  Table name to insert into
	 * @param {String} id     ID of the row on `table` to update
	 * @param {Object} fields Key/value pairs with the key corresponding exactly to a
	 * 	column name. No conversion is done on the values, so must be explicit
	 * 	values to be inserted (e.g. ids, etc)
	 *
	 * @returns {Promise} Promise of the entire row that has been updated (e.g. we SELECT the
	 * 	row after UPDATE to get any triggered values from the DB)
	 */
	 conn.patch = function(tableAndIdField, id, fields) {
		let { table, idField } = parseIdField(tableAndIdField);
		const prep = 'update ' + autoFixTable(table) + ' set ';
		const list = Object.keys(fields).filter(field => field != idField).map(x => mariasql.escape(x)+'=:'+x);

		const sql = prep + list.join(', ') + ' where ' + idField + '=:id';

		// if(table === 'optimizations')
			// console.log("[conn.patch]", { sql, fields,tableAndIdField, id }, "\n", debugSql(sql, { ...fields, id }));

		return this.pquery(sql, Object.assign({}, fields, { id })).then(info => {

		   // NB assumes primary key on all tables is `id`
		   const select = 'select * from ' + autoFixTable(table) + ' where ' + idField + '=:id';
		//    if(table === 'optimizations')
		//    console.log("[conn.patch] select=", select, ", id=", id);

		   return this.pquery(select, { id });

	   }).then(rows => {
			// if(table === 'optimizations')
				// console.log("[conn.patch] rows=", rows[0]);
		   return rows[0];
	   });
	}

	 /**
	  * patchIf - Compares fields from `values` with values in `existing`, and if any different, patches the database.
	  *
	  * @param {String} table    Table to patch
	  * @param {Object} existing Existing object values
	  * @param {Object} values   Possible new values
	  * @param {Ojecct} ifFalsey Possible new values, set only if the corresponding key in `existing` is falsey
	  *
	  * @returns {Promise} Promise that resolves to false if no change, or resolves to the new object (fresh selected from database) if changes applied
	  */
	conn.patchIf = function(tableAndIdField, existing, values, ifFalsey) {
		// console.log("[dbh.patchIf]", { existing, values, ifFalsey });
		let { table, idField } = parseIdField(tableAndIdField);
		const patch = {};
		let changed = false;
		Object.keys(values || {}).forEach(key => {
			if(existing[key] != values[key]) {
				patch[key] = values[key];
				changed    = true;
			}
		});
		Object.keys(ifFalsey || {}).forEach(key => {
			if(!existing[key]) {
				patch[key] = ifFalsey[key];
				changed    = true;
			}
		});
		if(changed) {
			conn.patchIf.lastAction = 'patch';
			return this.patch(tableAndIdField, existing[idField], patch);
		}

		conn.patchIf.lastAction = null;

		return Promise.resolve(existing);
	};

	 /**
	  * findOrCreate - Searches `table` for the first row matching the fields in `fields`.
	  * 	If a matching row is found, the promise returns that row.
	  * 	If no matching rows found in `table`, the fields are inserted, and the result
	  * 	of the insert is returned in the promise.
	  *
	  * @param {String} table  Table name to search/insert into
	  * @param {Object} fields Key/value pairs to search/insert. NOTE: No conversion
	  * 	performed on values, must be explicit values to match/insert, e.g. IDs, etc.
	  * @param {Object} patchIf If given (may be falsey), the found/created ref will be patched with the key/values in the object via patchIf() for more info
	  * @param {Object} patchIfFalsey Passed thru to patchIf - see patchIf() for more info
	  *
	  * @returns {Promise} Promise of an Object matching the fields given
	  */
	conn.findOrCreate = async function(tableAndIdField, fields, patchIf, patchIfFalsey) {
		let { table, idField } = parseIdField(tableAndIdField);
		conn.findOrCreate.lastAction = null;
		return this.search(table, fields, true).then(ref => {
			if(!ref) {
				// console.log("[dbh.findOrCreate] **created**", { fields })
				conn.findOrCreate.lastAction = 'create';
				conn.findOrCreate.wasCreated = true;
				return this.create(tableAndIdField, fields);
			} else {
				// console.log("[dbh.findOrCreate] **found**  ", { fields })
				conn.findOrCreate.wasCreated = false;
				return ref;
			}
		}).then(async ref => {
			if(patchIf || patchIfFalsey) {
				ref = await this.patchIf(tableAndIdField, ref, patchIf, patchIfFalsey);
				
				conn.findOrCreate.lastAction = 
					conn.patchIf.lastAction == 'patch' ? 'patch' : 
					conn.findOrCreate.lastAction ? 
					conn.findOrCreate.lastAction : 'get';
				
				return ref;
			} else {
				if(!conn.findOrCreate.lastAction)
					conn.findOrCreate.lastAction = 'get';
				return ref;
			}
		});
	};

	 /**
	  * get - Returns the rows from `table` matching the given `id`
	  *
	  * @param {String} table Table name to SELECT from
	  * @param {String} id    ID from the `id` column of `table` to load
	  *
	  * @returns {Promise} Promise of a Object or null if no row matches
	  */
	conn.get = async function(tableAndIdField, id) {
		let { table, idField } = parseIdField(tableAndIdField);
		return this.pquery('select * from ' + autoFixTable(table) + ' where ' + idField + '=:id', { id }).then(rows => {
			return rows && rows.length ? rows[0] : null;
		});
	}

	 /**
	  * destroy - Delete `id` from table
	  *
	  * @param {String} table Table to remove id from
	  * @param {String} id    Id to remove from table
	  *
	  * @returns {Promise} Promise which resolves when deletion done
	  */
	conn.destroy = async function(tableAndIdField, id) {
		let { table, idField } = parseIdField(tableAndIdField);
		return this.pquery('delete from ' + autoFixTable(table) + ' where ' + idField + '=:id', { id });
	}

	conn.wrap = tableAndIdField => {
		// Emulate the feathersjs service API - https://docs.feathersjs.com/api/services.html
		return new ProxyServiceInstance(conn, tableAndIdField)
	};

	conn.proxyApp = function() {
		return conn._proxyApp || (conn._proxyApp = {
			service: table => conn.wrap(table)
		});
	};

	return conn;
};

// TODO: If actually using with feathers, make it emit events as documented https://docs.feathersjs.com/api/events.html#patched
class ProxyServiceInstance {
	constructor(dbh, tableAndIdField) {
		this.dbh = dbh;
		this.tableAndIdField = tableAndIdField;

		// Move this to .setup, below, and make our proxy init above call .setup
		// // Parse out table from id field if given in dotted format
		// let { table, idField } = parseIdField(tableAndIdField);
		//
		// // If no id field given, check to see what the primary col is from the schema on disk
		// if(!idField) {
		// 	idField = this._findTableIdField(table);
		// }
		//
		// // If the normal form ('id'), then just use the table name
		// // for conventions sake
		// if(idField === 'id') {
		// 	this.tableAndIdField = table;
		// } else {
		// 	// Otherwise, make sure the ID field is present for use below in all service calls
		// 	this.tableAndIdField = `${table}.${idField}`;
		// }
	}

	// _findTableIdField(table) {
	// 	// TODO: "explain table" and find row that has .key=pri and return .field as proimary
	// }

	async find(params) {
		console.warn("[mariasql.util.ProxyServiceInstance("+this.tableAndIdField+").find] We don't emulate the FeathersJS find() service method exactly (only honor $limit===1, and params are assumed to be straight field=value pairs, for example)...use at your own risk!");
		const limitOne = (params||{}).$limit === 1;
		const res = await this.dbh.find(this.tableAndIdField, params, limitOne);
		if(limitOne) {
			return [res];
		} else {
			return res;
		}
	}

	get(id/*, params*/) {
		return this.dbh.get(this.tableAndIdField,     id);
	}

	create(data/*, params*/) {
		return this.dbh.create(this.tableAndIdField,      data);
	}

	update(id, data/*, params*/) {
		return this.dbh.patch(this.tableAndIdField,   id, data);
	}

	patch(id, data/*, params*/) {
		return this.dbh.patch(this.tableAndIdField,   id, data);
	}

	remove(id/*, params*/) {
		return this.dbh.destroy(this.tableAndIdField, id, data);
	}

	// Only present to be compliant with feathers Services API
	setup(/*app, path*/) {
		// Unused
	}
}

module.exports = {
	dbh, deflateValue, sqlEscape, autoFixTable, debugSql,
	QueryTiming
};
