/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-use-before-define, func-names, no-nested-ternary */
process.env.TZ = 'UTC';

const mariadb = require('mariadb');
const { v4: uuid } = require('uuid');
const config = require('./config');
const { parseIdField } = require('./parseIdField');
const { promiseMap } = require('./promiseMap');
const {
	LoadBalancerManager,
	defaultReadBalanceStrategy,
} = require('./load-balancing');
const { LoadBalancer } = require('./load-balancing/LoadBalancer');

const dbHost = config.host;
const dbUser = config.user;
const dbPass = config.password;
const dbName = config.schema;
const dbCharset = config.charset;
const dbPort = config.port;
const dbSsl = config.ssl;
const {
	readonlyNodes: configReadonlyNodes,
	deflateToStrings: configDeflateToStrings,
	disableTimezone: configDisableTimezone,
	disableFullGroupByPerSession: configDisableFullGroupByPerSession,
	// MariaDB default is 1s, increasing to 3 for more reliable connections for intercontinental connections (e.g. India>SF)
	connectTimeout: configConnectTimeout = 3_000,
	readBalanceStrategy: configReadBalanceStrategy = defaultReadBalanceStrategy,
} = config;

// Shared load balancer manager for all connection instances
const loadBalancerManager = new LoadBalancerManager({
	strategy: configReadBalanceStrategy,
});

// Helper to save only a certain number of query logs in memory. Queries can be pretty noisy
// so you don't want to save too much data.
function createQueryLogger({ maxLinesSaved = 100 } = {}) {
	let enabled = false;

	const lines = [];
	let lastLogTimestamp;

	let listeners = [];
	function attachListener(fn) {
		listeners.push(fn);
	}

	function removeListener(fn) {
		listeners = listeners.filter((x) => x !== fn);
	}

	function disable() {
		enabled = false;
		// Empty the array when disabled so we don't just hold memory
		lines.splice(0, lines.length);
	}

	function enable() {
		enabled = true;
	}

	// Don't let the array get too long. Multiple lines may be logged/second the entire
	// time this runs. Only keep the most recent logs.
	function addLine(line) {
		if (!enabled) {
			return;
		}

		if (lines.length >= maxLinesSaved) {
			// Remove from the front of the array
			lines.splice(0, 50);
		}
		lines.push(line);
		lastLogTimestamp = new Date();
		listeners.forEach((x) => x(line));
	}

	return {
		maxLinesSaved,
		addLine,
		getLines: () => lines,
		getLastLogTimestamp: () => lastLogTimestamp,
		attachListener,
		removeListener,
		disable,
		enable,
		getEnabled: () => enabled,
	};
}

const QueryLogger = createQueryLogger();

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

	// Allow specifying an arbitrary schema other than configured in .yass-orm
	// by giving a table name of 'schema/table'
	const [databaseSchema, tableName] = `${table}`.includes('.')
		? `${table}`.split('.')
		: [undefined, table];

	// Replace '-' with '_' (feathers uses 'test-name' and mysql uses 'test_name', for example),
	// and escape the name for direct use in SQL
	const res =
		(databaseSchema ? `${handle.escapeId(databaseSchema)}.` : '') +
		handle.escapeId(tableName.replace(/-/g, '_'));

	return res;
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
		return configDeflateToStrings ? `${value.id}` : value.id;
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

	if (`${value}`.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)) {
		return value.replace(/(T|\.\d+Z)/g, ' ').trim();
	}

	if (Array.isArray(value)) {
		return JSON.stringify(value);
	}

	if (configDeflateToStrings && value !== undefined) {
		return `${value}`;
	}

	return value;
}

function debugSql(sql, args) {
	Object.keys(args || {})
		// Put longest strings at the top so :standIdName and :standId get properly handled (with :standIdName first)
		.sort((a, b) => b.length - a.length)
		.forEach((key) => {
			const deflatedValue = deflateValue(args[key]);

			let string = deflatedValue;

			// Stringify anything that's not a number and not null
			if (
				deflatedValue !== null &&
				(typeof deflatedValue !== 'number' ||
					Number.isNaN(parseFloat(deflatedValue)))
			) {
				string = `'${deflatedValue}'`;
			}

			if (deflatedValue === undefined) {
				console.warn(
					`debugSql: You gave field '${key}' as undefined, which would normally cause errors when executing a query anyway. We're not going to protect you from that here either, just a heads-up`,
				);
				string = deflatedValue;
			}

			// eslint-disable-next-line no-param-reassign
			sql = sql.replace(new RegExp(`:${key}`, 'g'), string);
		});

	return sql;
}

// Make sure grouping queries work fine - necessary for PlanetScale since they force this ON
// Note: This can only be done on a per-connection basis and cannot be done with SET GLOBAL
// on PlanetScale (they don't allow global config changes.)
const DISABLE_FULL_GROUP_BY_SQL = /* sql */ `
	SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))
`;

const connCache = {};

/**
 *dbh - returns a monkey-patched mariadb database handle
 *
 * @param {*} Hash containing {host, pass, db} keys - all optional
 * @returns monkey-patched mariadb handle
 */
async function dbh(options = { ignoreCachedConnections: false }) {
	const {
		host = dbHost,
		db = dbName,
		password: passwordProp,
		pass: password = passwordProp || dbPass,
		user = dbUser,
		charset = dbCharset,
		port = dbPort,
		ssl = dbSsl,
		readonlyNodes = configReadonlyNodes,
		disableFullGroupByPerSession = configDisableFullGroupByPerSession,
		disableTimezone = configDisableTimezone,
		connectTimeout = configConnectTimeout,
	} = options;

	const key = [user, host, db, port].join('.');
	if (connCache[key] && !options.ignoreCachedConnections) {
		return connCache[key];
	}

	const poolConfig = {
		host,
		db,
		password,
		user,
		charset,
		port,
		ssl,
		// connectionLimit: 5,
		// Based on https://github.com/mariadb-corporation/mariadb-connector-nodejs/blob/master/documentation/promise-api.md#timezone-consideration
		// disable timezone conversion since we take care to ensure times strings are stored/loaded as UTC
		...(disableTimezone ? {} : { timezone: 'Etc/GMT+0' }),
		// Required for newer versions of MySQL
		allowPublicKeyRetrieval: true,
		connectTimeout,
	};

	// console.log(`[yass-orm] poolConfig:`, poolConfig);
	// console.log(`[yass-orm] readonlyNodes:`, readonlyNodes);

	// https://www.npmjs.com/package/mariadb
	const conn = await mariadb.createConnection(poolConfig);

	// MariaDb doesn't use the .db config option, so select manually
	await conn.query(/* sql */ `use ${conn.escapeId(poolConfig.db)}`);

	if (disableFullGroupByPerSession) {
		// Make sure grouping queries work fine - necessary for PlanetScale since they force this ON
		// Note: This can only be done on a per-connection basis and cannot be done with SET GLOBAL
		// on PlanetScale (they don't allow global config changes.)
		await conn.query(DISABLE_FULL_GROUP_BY_SQL);
	}

	// This adds support for read-only nodes in a MySQL/MariaDB cluster.
	// By adding nodes to this list, we can try to direct all read queries
	// to these nodes, freeing up the master node (e.g. the primary connection)
	// to just handle updates/inserts.
	let readConns = [];
	const activeRoNodes =
		readonlyNodes && readonlyNodes.filter((x) => !x.disabled);
	if (activeRoNodes && activeRoNodes.length) {
		readConns = await promiseMap(
			activeRoNodes,
			// eslint-disable-next-line no-shadow
			async ({ host, user, password, ssl, port, loadBalancerOptions = {} }) => {
				const roConnConfig = {
					db: poolConfig.db || dbName,
					host: host || poolConfig.host || dbHost,
					password: password || poolConfig.password || dbPass,
					user: user || poolConfig.user || dbUser,
					charset: poolConfig.charset || dbCharset,
					port: port || poolConfig.port || dbPort,
					ssl: ssl || poolConfig.ssl || dbSsl,
					// connectionLimit: 5,
					// Based on https://github.com/mariadb-corporation/mariadb-connector-nodejs/blob/master/documentation/promise-api.md#timezone-consideration
					// disable timezone conversion since we take care to ensure times strings are stored/loaded as UTC
					...(disableTimezone ? {} : { timezone: 'Etc/GMT+0' }),
					// Required for newer versions of MySQL
					allowPublicKeyRetrieval: true,
				};

				// console.log(`[yass-orm] roConnConfig:`, roConnConfig);

				// https://www.npmjs.com/package/mariadb
				const roConn = await mariadb.createConnection(roConnConfig);

				// For use in load balancers below
				roConn.loadBalancerTargetId = `${poolConfig.db}:${roConnConfig.host}:${roConnConfig.port}`;
				roConn.loadBalancerOptions = loadBalancerOptions;
				roConn.clone = async () => mariadb.createConnection(roConnConfig);

				// MariaDb doesn't use the .db config option, so select manually
				await roConn.query(/* sql */ `use ${roConn.escapeId(roConnConfig.db)}`);

				if (disableFullGroupByPerSession) {
					// Make sure grouping queries work fine - necessary for PlanetScale since they force this ON
					// Note: This can only be done on a per-connection basis and cannot be done with SET GLOBAL
					// on PlanetScale (they don't allow global config changes.)
					await roConn.query(DISABLE_FULL_GROUP_BY_SQL);
				}

				// use function() instead of ()=> so we can get this == conn
				roConn.pquery = async function (
					sql,
					params,
					{ silenceErrors = false } = {},
				) {
					const startTime = Date.now();
					const trace = new Error().stack;
					const values = deflateValues(params);

					// Store ref to the line before pushing it so we can modify it after we're done
					const loggedQuery = {
						sql,
						values,
						startTime,
						trace,
						endTime: undefined,
						queryTime: undefined,
					};

					// Add the line to the log before querying so we have accurate sequences if another
					// query tries to execute while waiting the results of this one
					QueryLogger.addLine(loggedQuery);

					const result = await new Promise((resolve /* , reject */) => {
						// 			console.log("[pquery] ", { sql, params, values });
						// 			console.log("[pquery - interpolated]", `

						// Interpolated SQL:
						// ----------
						// ${debugSql(sql, values)}
						// ----------

						// 			`)

						// mariadb package now is promiseable
						if (Array.isArray(values)) {
							resolve(this.query(sql, values));
						} else {
							resolve(this.query({ namedPlaceholders: true, sql }, values));
						}
					}).catch((err) => {
						if (!silenceErrors) {
							console.error(`
=== Error processing query ===
Error:
	${err}

Raw SQL:
----------
${sql}
----------

Interpolated SQL:
----------
${debugSql(sql, values)}
----------

Stack trace:
${trace}
==============================
						`);
						}

						throw new Error(`Error in query: ${err}, original stack: ${trace}`);
					});

					const endTime = Date.now();
					const queryTime = endTime - startTime;

					Object.assign(loggedQuery, { endTime, queryTime });

					// If an external listener to the QueryLogger adds an onFinish prop to the line,
					// then execute it to let it know we're done
					if (loggedQuery.onFinish) {
						loggedQuery.onFinish();
					}

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

				return roConn;
			},
		);
	}

	conn.roQuery = async function roQuery(
		sql,
		params,
		opts = { silenceErrors: false, loadBalancerOptions: {} },
		...args
	) {
		// Nothing to load balance if no read only connections.
		if (readConns.length) {
			try {
				return loadBalancerManager.executeQuery({
					// Pass in targets dynamically since the load balancer is shared among all connections
					targets: readConns,
					// The actual query to execute.
					// Passing in the query instead of just executing it here so balancers can implement
					// retries or circuit breaking as needed.
					query: { sql, params, args, opts },
				});
			} catch (err) {
				console.error(
					`[dbh] Error executing query on load balancer, will use .pquery instead:`,
					err,
				);
				return this.pquery(sql, params, opts, ...args);
			}
		}

		return this.pquery(sql, params, opts, ...args);
	};

	// use function() instead of ()=> so we can get this == conn
	conn.pquery = async function (
		sql,
		params,
		// eslint-disable-next-line no-unused-vars
		{ silenceErrors = false, loadBalancerOptions = {} } = {},
	) {
		const startTime = Date.now();
		const trace = new Error().stack;
		const values = deflateValues(params);

		// Store ref to the line before pushing it so we can modify it after we're done
		const loggedQuery = {
			sql,
			values,
			startTime,
			trace,
			endTime: undefined,
			queryTime: undefined,
		};

		// Add the line to the log before querying so we have accurate sequences if another
		// query tries to execute while waiting the results of this one
		QueryLogger.addLine(loggedQuery);

		const result = await new Promise((resolve /* , reject */) => {
			// 			console.log("[pquery] ", { sql, params, values });
			// 			console.log("[pquery - interpolated]", `

			// Interpolated SQL:
			// ----------
			// ${debugSql(sql, values)}
			// ----------

			// 			`)

			// mariadb package now is promiseable
			if (Array.isArray(values)) {
				resolve(this.query(sql, values));
			} else {
				resolve(this.query({ namedPlaceholders: true, sql }, values));
			}
		}).catch((err) => {
			if (!silenceErrors) {
				console.error(`
=== Error processing query ===
Error:
	${err}

Raw SQL:
----------
${sql}
----------

Interpolated SQL:
----------
${debugSql(sql, values)}
----------

Stack trace:
${trace}
==============================
			`);
			}

			throw new Error(`Error in query: ${err}, original stack: ${trace}`);
		});

		const endTime = Date.now();
		const queryTime = endTime - startTime;

		Object.assign(loggedQuery, { endTime, queryTime });

		// If an external listener to the QueryLogger adds an onFinish prop to the line,
		// then execute it to let it know we're done
		if (loggedQuery.onFinish) {
			loggedQuery.onFinish();
		}

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
		const prep = /* sql */ `select * from ${autoFixTable(table, this)}`;
		const keys = Object.keys(fields);
		const list = keys.map((x) => {
			const col = this.escapeId(x);
			if (fields[x] === null) {
				return /* sql */ `${col} is NULL`;
			}
			return /* sql */ `${col}=:${x}`;
		});

		const sql =
			prep +
			(list.length > 0 ? /* sql */ ` where ${list.join(' and ')}` : '') +
			(limitOne ? /* sql */ ` limit 1` : '');

		if (limitOne && !keys.length) {
			return Promise.resolve(null);
		}

		// if(fields.source_sourceId)
		// console.trace("[conn.search]", { sql, fields });

		return this.roQuery(sql, fields).then((rows) => {
			if (limitOne) {
				return rows.length ? rows[0] : null;
			}

			return rows;
		});
	};

	/**
	 * find - see search(), above. This is just an alias for search().
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
	conn.create = function (
		tableAndIdField,
		fields,
		{ allowBlankIdOnCreate, idGenerator = uuid() } = {},
	) {
		let { table, idField } = parseIdField(tableAndIdField);

		if (config.uuidLinkedIds && !fields[idField] && !allowBlankIdOnCreate) {
			fields[idField] = idGenerator();
		}

		const prep = /* sql */ `insert into ${autoFixTable(table, this)}`;
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

				const select = /* sql */ `select * from ${autoFixTable(
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

		// Nothing to patch
		if (!Object.keys(fields).length) {
			return undefined;
		}

		let { table, idField } = parseIdField(tableAndIdField);
		const prep = /* sql */ `update ${autoFixTable(table, this)} set `;
		const list = Object.keys(fields)
			.filter((field) => field !== idField)
			.map((field) => `${this.escapeId(field)}=:${field}`);

		const sql = /* sql */ `${prep + list.join(', ')} where ${idField}=:id`;

		// if(table === 'optimizations')
		// console.log(
		// 	'[conn.patch]',
		// 	{ sql, fields, tableAndIdField, id },
		// 	'\n',
		// 	debugSql(sql, { ...fields, id }),
		// );

		return this.pquery(sql, Object.assign({}, fields, { id }))
			.then((/* info */) => {
				const select = /* sql */ `select * from ${autoFixTable(
					table,
					this,
				)} where ${idField}=:id`;

				return this.pquery(select, { id });
			})
			.then((rows) => rows[0]);
	};

	/**
	 * patchIf - Compares fields from `values` with values in `existing`, and if any different, patches the database.
	 *
	 * @param {String} table    Table to patch
	 * @param {Object} existing Existing object values
	 * @param {Object} values   Possible new values
	 * @param {Object} ifFalsey Possible new values, set only if the corresponding key in `existing` is falsey
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
		patchIf = {},
		patchIfFalsey = {},
		{ allowBlankIdOnCreate, idGenerator } = {},
	) {
		let { table /* , idField */ } = parseIdField(tableAndIdField);
		conn.findOrCreate.lastAction = null;
		return this.search(table, fields, true)
			.then((ref) => {
				if (!ref) {
					// console.log("[dbh.findOrCreate] **created**", { fields })
					conn.findOrCreate.lastAction = 'create';
					conn.findOrCreate.wasCreated = true;
					return this.create(tableAndIdField, fields, {
						allowBlankIdOnCreate,
						idGenerator,
					});
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
				if (!conn.findOrCreate.lastAction) {
					conn.findOrCreate.lastAction = 'get';
				}

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
		return this.roQuery(
			/* sql */ `select * from ${autoFixTable(
				table,
				this,
			)} where ${idField}=:id`,
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
			/* sql */ `delete from ${autoFixTable(table, this)} where ${idField}=:id`,
			{ id },
		);
	};

	// Don't set this till the end because if another function interrupts this one,
	// we don't want it getting an incomplete cached handle
	connCache[key] = conn;

	return conn;
}

module.exports = {
	dbh,
	deflateValue,
	sqlEscape,
	autoFixTable,
	debugSql,
	QueryTiming,
	QueryLogger,
	parseIdField,
	loadBalancerManager, // for setting custom strategies externally
	LoadBalancer, // for sub-classing
};
