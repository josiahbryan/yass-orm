/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-use-before-define, func-names, no-nested-ternary */
const mariadb = require('mariadb');
const { v4: uuid } = require('uuid');
const config = require('./config');

const dbHost = config.host;
const dbUser = config.user;
const dbPass = config.password;
const dbName = config.schema;
const dbCharset = config.charset;
const dbPort = config.port;
const dbSsl = config.ssl;

const parseIdField = (table) => {
	if (table.indexOf('.') > 0) {
		const parts = table.split('.');
		return { table: parts[0], idField: parts[1] };
	}
	return { table, idField: 'id' };
};

// Lookup
const QueryTiming = {
	enabled: false, // set to false to not record timings
	exclude: (/* sql */) => false,
	setEnabled(flag, exclude = (/* sql */) => false) {
		QueryTiming.enabled = flag;
		QueryTiming.queries = {};
		QueryTiming.exclude = exclude || (() => false);
	},
	queries: {},
	analyze() {
		const { exclude } = QueryTiming;
		let queries = Object.values(QueryTiming.queries);
		if (exclude) {
			queries = queries.filter((data) => !exclude(data[0].sql));
		}
		console.log(
			`[dbh.QueryTiming.analyze] ${queries.length} unique queries recorded:`,
		);
		return queries
			.map((data) => {
				if (!data.length) {
					return { queryTime: null };
				}

				let sum = 0;
				data.forEach((row) => {
					sum += row.queryTime;
				});
				return {
					queryTime: sum,
					sql: data[0].sql,
					data,
				};
			})
			.filter((a) => a.queryTime)
			.sort((a, b) => a.queryTime - b.queryTime)
			.map((result) => {
				console.log(
					` * ${result.queryTime / 1000} sec total (${
						result.data.length
					} queries - ${result.queryTime / result.data.length / 1000} avg) - ${
						result.sql
					} `,
				);
				// if(result.sql.includes('update optimizations'))
				// 	console.dir(result.data, { depth: 10 });
				return result;
			});
	},
};

function debugSql(sql, args) {
	Object.keys(args).forEach((key) => {
		let v = args[key];

		if (typeof v === 'string') {
			v = `"${v}"`;
		}

		sql = sql.replace(new RegExp(`:${key}`, 'g'), v);
	});

	return sql;
}

/**
 * autofixTable - replaces - with _ in table names and escapes the string
 *
 * @param {*} table - name of table
 * @returns Escaped, safe name of table
 */
function autoFixTable(table, handle) {
	if (!handle) {
		throw new Error(`Must pass current handle as 2nd arg`);
	}
	// Replace '-' with '_' (feathers uses 'test-name' and mysql uses 'test_name', for example),
	// and escape the name for direct use in SQL
	return handle.escapeId(table.replace(/-/g, '_'));
}

/**
 * sqlEscape - escapes values for use in SQL
 * @param {any}
 * @returns String with escaped value for use in sql
 */
function sqlEscape(value, handle) {
	if (!handle) {
		throw new Error(`Must pass current handle as 2nd arg`);
	}
	return handle.escape(value);
}

/**
 *deflateValues - calls deflateValue() for each value of an object or array member
 *
 * @param {Array|Object} params - object to deflate
 * @returns Array or Object with members deflated
 */
function deflateValues(params) {
	if (!params) return null;

	if (params.length) return params.map((value) => deflateValue(value));

	// NOTE: Use new object instead of changing `params`
	// so we don't change user's data unexpectedly
	const deflated = {};
	Object.keys(params).forEach((key) => {
		deflated[key] = deflateValue(params[key]);
	});

	return deflated;
}

// From https://stackoverflow.com/questions/1353684/detecting-an-invalid-date-date-instance-in-javascript
// function isValidDate(d) {
// 	return d instanceof Date && !isNaN(d);
// }

/**
 *deflateValue - deflates a given value if it's a Date, boolean, or Array
 *
 * @param {*} value
 * @returns Deflated value
 */
function deflateValue(value) {
	// console.log("[deflateValue] ", value, typeof(value));
	if (
		value &&
		typeof value === 'object' &&
		!Number.isNaN(value.id) &&
		value.id !== undefined &&
		value.id !== null
	) {
		return value.id;
	}

	if (
		value instanceof Date ||
		(value && typeof value.toISOString === 'function')
	) {
		value = value.toISOString(); // isValidDate(value) ? value.toISOString() : null;
	}

	if (value === true) {
		value = 1;
	} else if (value === false) {
		value = 0;
	}

	// console.log("[deflateValue 2] ", value, typeof(value));

	if (`${value}`.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/))
		return value.replace(/(T|\.\d+Z)/g, ' ').trim();

	// if(typeof(value) === 'object')
	if (Array.isArray(value)) return JSON.stringify(value);

	return value;
}

const connCache = {};

/**
 *dbh - returns a monkey-patched mariadb database handle
 *
 * @param {*} Hash containing {host, pass, db} keys - all optional
 * @returns moneky-patched mariadb handle
 */
async function dbh(options = { ignoreCachedConnections: false }) {
	const key = [options.host, options.pass, options.db, options.user].join('.');
	if (connCache[key] && !options.ignoreCachedConnections) {
		return connCache[key];
	}

	const poolConfig = {
		host: options.host || dbHost,
		db: options.db || dbName,
		password: options.pass || dbPass,
		user: options.user || dbUser,
		charset: options.charset || dbCharset,
		port: options.port || dbPort,
		ssl: options.ssl || dbSsl,
		connectionLimit: 5,
	};

	// https://www.npmjs.com/package/mariadb
	const pool = mariadb.createPool(poolConfig);
	const conn = await pool.getConnection();

	// MariaDb doesn't use the .db config option, so select manually
	await conn.query(`use ${conn.escapeId(poolConfig.db)}`);

	connCache[key] = conn;

	// use function() instead of ()=> so we can get this == conn
	conn.pquery = async function (sql, params) {
		const startTime = Date.now();
		const trace = new Error().stack;

		const result = await new Promise((resolve /* , reject */) => {
			const raw = deflateValues(params);
			// console.log("[pquery] ", { sql, raw });

			// this.query(sql, raw, (err, rows) => err ? reject(err) : resolve(rows));

			// mariadb package now is promiseable
			resolve(this.query({ namedPlaceholders: true, sql }, raw));
		}).catch((err) => {
			console.error(`
=== Error processing query ===
Error:
	${err}

Raw SQL:
----------
${sql}
----------

Stack trace:
${trace}
==============================
			`);

			throw new Error(`Error in query: ${err}, original stack: ${trace}`);
		});

		const endTime = Date.now();
		const queryTime = endTime - startTime;

		if (QueryTiming.enabled) {
			const { stack } = new Error();
			(QueryTiming.queries[sql] || (QueryTiming.queries[sql] = [])).push({
				sql,
				queryTime,
				params,
				trace: stack,
			});
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
	conn.search = function (tableAndIdField, fields = {}, limitOne = false) {
		const { table } = parseIdField(tableAndIdField);
		const prep = `select * from ${autoFixTable(table, this)}`;
		const keys = Object.keys(fields);
		const list = keys.map((x) => {
			const col = this.escapeId(x);
			if (fields[x] === null) {
				return `${col} is NULL`;
			}
			return `${col}=:${x}`;
		});
		const sql =
			prep +
			(list.length > 0 ? ` where ${list.join(' and ')}` : '') +
			(limitOne ? ' limit 1' : '');

		if (limitOne && !keys.length) return Promise.resolve(null);

		// if(fields.source_sourceId)
		// console.trace("[conn.search]", { sql, fields });

		return this.pquery(sql, fields).then((rows) => {
			if (limitOne) return rows.length ? rows[0] : null;
			return rows;
		});
	};

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
	conn.create = function (tableAndIdField, fields) {
		let { table, idField } = parseIdField(tableAndIdField);
		// if(idField !== 'id')
		// fields.id = idGen();
		if (config.uuidLinkedIds && !fields[idField]) {
			fields[idField] = uuid();
		}

		const prep = `insert into ${autoFixTable(table, this)}`;
		const fieldList = Object.keys(fields).map((x) => this.escapeId(x));
		const valueList = Object.keys(fields).map((x) => `:${x}`);

		const sql = `${prep} (${fieldList.join(',')}) values (${valueList.join(
			',',
		)})`;

		// console.log("[conn.create]", { sql, fields });
		// if(idField !=== 'id')
		// 	throw new Error("Cannot auto-create because cannot re-query until mariadb gives us our ID - read the docs then update code")

		return this.pquery(sql, fields)
			.then((result) => {
				// console.log(`create raw result:`, result);

				if (!fields[idField]) {
					fields[idField] = result.insertId;
				}

				// NB assumes primary key on all tables is `id`
				const select = `select * from ${autoFixTable(
					table,
					this,
				)} where ${idField}=:id`;
				const selectParams = { id: fields[idField] };

				// console.log(`select sql and query:`, select, selectParams);

				return this.pquery(select, selectParams);
			})
			.then((rows) => {
				// console.log(`Selected:`, rows);
				return rows[0];
			});
	};

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
	conn.patch = function (tableAndIdField, id, fields) {
		// console.log("[conn.patch] raw", { tableAndIdField, id, fields });

		let { table, idField } = parseIdField(tableAndIdField);
		const prep = `update ${autoFixTable(table, this)} set `;
		const list = Object.keys(fields)
			.filter((field) => field !== idField)
			.map((field) => `${this.escapeId(field)}=:${field}`);

		const sql = `${prep + list.join(', ')} where ${idField}=:id`;

		// if(table === 'optimizations')
		// console.log("[conn.patch]", { sql, fields,tableAndIdField, id }, "\n", debugSql(sql, { ...fields, id }));

		return this.pquery(sql, Object.assign({}, fields, { id }))
			.then((/* info */) => {
				// NB assumes primary key on all tables is `id`
				const select = `select * from ${autoFixTable(
					table,
					this,
				)} where ${idField}=:id`;
				//    if(table === 'optimizations')
				//    console.log("[conn.patch] select=", select, ", id=", id);

				return this.pquery(select, { id });
			})
			.then((rows) => {
				// if(table === 'optimizations')
				// console.log("[conn.patch] rows=", rows[0]);
				return rows[0];
			});
	};

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
	conn.patchIf = function (tableAndIdField, existing, values, ifFalsey) {
		// console.log("[dbh.patchIf]", { existing, values, ifFalsey });
		let { /* table, */ idField } = parseIdField(tableAndIdField);
		const patch = {};
		let changed = false;
		if (existing) {
			Object.keys(values || {}).forEach((valueKey) => {
				if (existing[valueKey] !== values[valueKey]) {
					patch[valueKey] = values[valueKey];
					changed = true;
				}
			});
			Object.keys(ifFalsey || {}).forEach((valueKey) => {
				if (!existing[valueKey]) {
					patch[valueKey] = ifFalsey[valueKey];
					changed = true;
				}
			});
		} else {
			throw new Error('patchIf requires an "existing" object argument"');
		}
		if (changed) {
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
	conn.findOrCreate = async function (
		tableAndIdField,
		fields,
		patchIf,
		patchIfFalsey,
	) {
		let { table /* , idField */ } = parseIdField(tableAndIdField);
		conn.findOrCreate.lastAction = null;
		return this.search(table, fields, true)
			.then((ref) => {
				if (!ref) {
					// console.log("[dbh.findOrCreate] **created**", { fields })
					conn.findOrCreate.lastAction = 'create';
					conn.findOrCreate.wasCreated = true;
					return this.create(tableAndIdField, fields);
				}
				// console.log("[dbh.findOrCreate] **found**  ", { fields })
				conn.findOrCreate.wasCreated = false;
				return ref;
			})
			.then(async (ref) => {
				if (patchIf || patchIfFalsey) {
					ref = await this.patchIf(
						tableAndIdField,
						ref,
						patchIf,
						patchIfFalsey,
					);

					conn.findOrCreate.lastAction =
						conn.patchIf.lastAction === 'patch'
							? 'patch'
							: conn.findOrCreate.lastAction
							? conn.findOrCreate.lastAction
							: 'get';

					return ref;
				}
				if (!conn.findOrCreate.lastAction) conn.findOrCreate.lastAction = 'get';
				return ref;
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
	conn.get = async function (tableAndIdField, id) {
		let { table, idField } = parseIdField(tableAndIdField);
		return this.pquery(
			`select * from ${autoFixTable(table, this)} where ${idField}=:id`,
			{ id },
		).then((rows) => {
			return rows && rows.length ? rows[0] : null;
		});
	};

	/**
	 * destroy - Delete `id` from table
	 *
	 * @param {String} table Table to remove id from
	 * @param {String} id    Id to remove from table
	 *
	 * @returns {Promise} Promise which resolves when deletion done
	 */
	conn.destroy = async function (tableAndIdField, id) {
		let { table, idField } = parseIdField(tableAndIdField);
		return this.pquery(
			`delete from ${autoFixTable(table, this)} where ${idField}=:id`,
			{ id },
		);
	};

	return conn;
}

module.exports = {
	dbh,
	deflateValue,
	sqlEscape,
	autoFixTable,
	debugSql,
	QueryTiming,
	parseIdField,
};
