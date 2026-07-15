/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-use-before-define, func-names, no-nested-ternary */
process.env.TZ = 'UTC';

const { v4: uuid } = require('uuid');
const config = require('./config');
const { getDialect } = require('./dialects');
const { parseIdField } = require('./parseIdField');
const { promiseMap } = require('./promiseMap');
const {
	LoadBalancerManager,
	defaultReadBalanceStrategy,
} = require('./load-balancing');
const { LoadBalancer } = require('./load-balancing/LoadBalancer');
const { jsonSafeStringify } = require('./jsonSafeStringify');
const {
	isRetryableTransactionError,
	runTransaction,
} = require('./transactions');

const dbHost = config.host;
const dbUser = config.user;
const dbPass = config.password;
const dbName = config.schema;
const dbCharset = config.charset;
const dbPort = config.port;
const dbSsl = config.ssl;
const FIND_OR_CREATE_META = Symbol('yass-orm.findOrCreateMeta');
const {
	readonlyNodes: configReadonlyNodes,
	deflateToStrings: configDeflateToStrings,
	disableTimezone: configDisableTimezone,
	disableFullGroupByPerSession: configDisableFullGroupByPerSession,
	// MariaDB default is 1s, increasing to 3 for more reliable connections for intercontinental connections (e.g. India>SF)
	connectTimeout: configConnectTimeout = 3_000,
	readBalanceStrategy: configReadBalanceStrategy = defaultReadBalanceStrategy,
	// Connection pool limit - default is 10, can be increased for high-concurrency applications
	connectionLimit: configConnectionLimit = 10,
	// Database dialect - 'mysql', 'mariadb', 'sqlite', 'sqlite3', 'postgres', or 'postgresql'
	dialect: configDialect = 'mysql',
	// SQLite-specific: path to database file (use ':memory:' for in-memory)
	filename: configFilename,
} = config;

// Shared load balancer manager for all connection instances
const loadBalancerManager = new LoadBalancerManager({
	strategy: configReadBalanceStrategy,
});

/** True if err indicates a closed/stale connection (08S01); used to avoid noisy full query dumps when retry will run. */
function isConnectionClosedError(err) {
	const msg = err && (err.message || String(err));
	return (
		typeof msg === 'string' &&
		(msg.includes('socket has unexpectedly been closed') ||
			msg.includes('08S01'))
	);
}

/**
 * Wrap a driver query error in a yass-orm error while preserving the
 * structured fields callers need to recognize duplicate-key / constraint /
 * connection violations without regex-matching the message.
 *
 * Backward compat: the wrapped message still starts with "Error in query:"
 * so existing string matchers keep working. The original driver error
 * is exposed on `.cause`, and `.code`/`.errno`/`.sqlState` are hoisted
 * onto the wrapped error so consumers don't have to walk `.cause`.
 * The original stack is on `.originalStack` (no longer concatenated into
 * `.message`, which used to bloat logs and break regexes).
 */
function wrapQueryError(err, trace) {
	const baseMessage =
		err && err.message
			? err.message
			: err == null
			? 'unknown error'
			: String(err);
	const wrapped = new Error(`Error in query: ${baseMessage}`);
	wrapped.cause = err;
	if (err && typeof err === 'object') {
		if (err.code !== undefined) wrapped.code = err.code;
		if (err.errno !== undefined) wrapped.errno = err.errno;
		if (err.sqlState !== undefined) wrapped.sqlState = err.sqlState;
	}
	wrapped.originalStack = trace;
	return wrapped;
}

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
		// Guard against invalid dates that would throw RangeError on toISOString()
		// Invalid dates have NaN as their time value
		if (value instanceof Date && Number.isNaN(value.getTime())) {
			// Invalid date, convert to null to avoid "Invalid time value" RangeError
			value = null;
		} else {
			try {
				value = value.toISOString();
			} catch (e) {
				// If toISOString throws (e.g., custom object with broken toISOString),
				// convert to null instead of crashing the query
				value = null;
			}
		}
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
		return jsonSafeStringify(value, 0);
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

const connCache = {};

/**
 * closeAllConnections - Closes all cached database connection pools
 *
 * Use this during graceful shutdown to properly release all database connections.
 * This is especially important for CLI scripts to prevent connection exhaustion.
 *
 * @returns {Promise} Promise that resolves when all connections are closed
 */
async function closeAllConnections() {
	const pools = Object.values(connCache);
	const keys = Object.keys(connCache);

	if (pools.length === 0) {
		return { closed: 0 };
	}

	const results = await Promise.allSettled(
		pools.map(async (pool) => {
			if (pool && typeof pool.end === 'function') {
				await pool.end();
			}
		}),
	);

	// Clear the cache after closing
	keys.forEach((key) => {
		delete connCache[key];
	});

	const closed = results.filter((r) => r.status === 'fulfilled').length;
	const failed = results.filter((r) => r.status === 'rejected').length;

	if (failed > 0) {
		console.warn(
			`[yass-orm] closeAllConnections: ${closed} pools closed, ${failed} failed to close`,
		);
	}

	return { closed, failed };
}

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
		connectionLimit = configConnectionLimit,
		dialect: dialectName = configDialect,
		filename = configFilename,
	} = options;

	// Get the dialect implementation
	const dialect = getDialect(dialectName);

	// Include dialect in cache key so mysql/sqlite handles never collide.
	// For SQLite include filename because many apps use multiple DB files in one process.
	const cacheDbId =
		['sqlite', 'sqlite3'].includes(`${dialectName}`.toLowerCase()) && filename
			? `${db}@${filename}`
			: db;
	const key = [dialectName, user, host, cacheDbId, port].join('.');
	if (connCache[key] && !options.ignoreCachedConnections) {
		return connCache[key];
	}

	// If we reach here with an existing cached pool AND the caller opted in via
	// `closeReplacedPool`, we are about to REPLACE that pool and should close
	// the old one once the new pool is wired up — otherwise its open
	// connections are orphaned and linger server-side until idle-timeout,
	// doubling the live connection count and exhausting `max_connections` under
	// load (the retryIfConnectionLost recovery path).
	//
	// This is OPT-IN on purpose: plain `ignoreCachedConnections: true` is also
	// used to hand out an EXTRA fresh handle without invalidating existing
	// references (e.g. schema-sync, test setup). Closing the old pool there
	// would yank it out from under callers that still hold and use it.
	const previouslyCachedConn = options.closeReplacedPool
		? connCache[key]
		: undefined;

	const poolConfig = {
		host,
		database: db, // Use 'database' instead of 'db' for pool config
		password,
		user,
		charset,
		port,
		ssl,
		connectionLimit,
		// Automatically close idle connections after 10 minutes (600 seconds)
		// This prevents "socket has unexpectedly been closed" errors when the
		// database server closes idle connections
		idleTimeout: 600,
		// Based on https://github.com/mariadb-corporation/mariadb-connector-nodejs/blob/master/documentation/promise-api.md#timezone-consideration
		// disable timezone conversion since we take care to ensure times strings are stored/loaded as UTC
		...(disableTimezone
			? {}
			: { timezone: 'Etc/GMT+0', skipSetTimezone: true }),
		// Required for newer versions of MySQL
		allowPublicKeyRetrieval: true,
		connectTimeout,
		// SQLite-specific options
		filename,
		disableFullGroupByPerSession,
	};

	// console.log(`[yass-orm] poolConfig:`, poolConfig);
	// console.log(`[yass-orm] readonlyNodes:`, readonlyNodes);

	// Use the dialect to create the connection pool
	// This allows different database backends (MySQL, SQLite, etc.)
	const rawConn = await dialect.createPool(poolConfig);

	// Wrap the connection with dialect-specific helper methods (pquery, etc.)
	const conn = dialect.wrapConnection(rawConn);

	// Pool automatically selects the database specified in config.database
	// No need for manual USE statement with pools
	// Note: disableFullGroupByPerSession is handled by dialect.createPool() for MySQL

	// This adds support for read-only nodes in a MySQL/MariaDB cluster.
	// By adding nodes to this list, we can try to direct all read queries
	// to these nodes, freeing up the master node (e.g. the primary connection)
	// to just handle updates/inserts.
	// Note: Read replicas are only supported for MySQL/MariaDB, not SQLite.
	let readConns = [];
	const activeRoNodes =
		dialect.supportsReadReplicas &&
		readonlyNodes &&
		readonlyNodes.filter((x) => !x.disabled);
	if (activeRoNodes && activeRoNodes.length) {
		readConns = await promiseMap(
			activeRoNodes,
			// eslint-disable-next-line no-shadow
			async ({ host, user, password, ssl, port, loadBalancerOptions = {} }) => {
				const roConnConfig = {
					database: poolConfig.database || dbName,
					host: host || poolConfig.host || dbHost,
					password: password || poolConfig.password || dbPass,
					user: user || poolConfig.user || dbUser,
					charset: poolConfig.charset || dbCharset,
					port: port || poolConfig.port || dbPort,
					ssl: ssl || poolConfig.ssl || dbSsl,
					connectionLimit,
					idleTimeout: 600,
					// Based on https://github.com/mariadb-corporation/mariadb-connector-nodejs/blob/master/documentation/promise-api.md#timezone-consideration
					// disable timezone conversion since we take care to ensure times strings are stored/loaded as UTC
					...(disableTimezone
						? {}
						: { timezone: 'Etc/GMT+0', skipSetTimezone: true }),
					// Required for newer versions of MySQL
					allowPublicKeyRetrieval: true,
					connectTimeout,
					disableFullGroupByPerSession,
				};

				// console.log(`[yass-orm] roConnConfig:`, roConnConfig);

				// Use the dialect to create read-only connection pools
				const rawRoConn = await dialect.createPool(roConnConfig);
				const roConn = dialect.wrapConnection(rawRoConn);

				// For use in load balancers below
				roConn.loadBalancerTargetId = `${poolConfig.database}:${roConnConfig.host}:${roConnConfig.port}`;
				roConn.loadBalancerOptions = loadBalancerOptions;
				roConn.clone = async () =>
					dialect.wrapConnection(await dialect.createPool(roConnConfig));

				// Pool automatically selects the database specified in config.database
				// Note: disableFullGroupByPerSession is handled by dialect.createPool() for MySQL

				// use function() instead of ()=> so we can get this == conn
				roConn.pquery = async function (
					sql,
					params,
					{
						silenceErrors = false,
						silenceRetryableTransactionErrors = false,
					} = {},
				) {
					const startTime = Date.now();
					const trace = new Error().stack;

					// Use dialect to transform SQL and prepare parameters
					// Handle both string return (MySQL/SQLite) and object return (PostgreSQL)
					const transformResult = dialect.transformSql(sql, params);
					let transformedSql;
					let paramOrder;
					if (typeof transformResult === 'object' && transformResult.sql) {
						({ sql: transformedSql, paramOrder } = transformResult);
					} else {
						transformedSql = transformResult;
						paramOrder = undefined;
					}
					const values = dialect.prepareParams(params, paramOrder);

					// Store ref to the line before pushing it so we can modify it after we're done
					const loggedQuery = {
						sql,
						transformedSql: transformedSql !== sql ? transformedSql : undefined,
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
						// Use transformed SQL for actual query execution
						// For dialects with positional placeholders (PostgreSQL), values is always an array.
						// For MySQL with named params, wrap with namedPlaceholders option.
						if (Array.isArray(values)) {
							resolve(this.query(transformedSql, values));
						} else {
							resolve(
								this.query(
									{ namedPlaceholders: true, sql: transformedSql },
									values,
								),
							);
						}
					}).catch((err) => {
						if (
							!silenceErrors &&
							!(
								silenceRetryableTransactionErrors &&
								isRetryableTransactionError(err)
							)
						) {
							if (isConnectionClosedError(err)) {
								console.error('Database connection closed, retrying...');
							} else {
								console.error(`
=== Error processing query ===
Error:
	${err}

Raw SQL:
----------
${sql}
----------
${
	transformedSql !== sql
		? `
Transformed SQL:
----------
${transformedSql}
----------
`
		: ''
}
Interpolated SQL:
----------
${debugSql(sql, values)}
----------

Stack trace:
${trace}
==============================
						`);
							}
						}

						throw wrapQueryError(err, trace);
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
		{ silenceErrors = false, silenceRetryableTransactionErrors = false } = {},
	) {
		const startTime = Date.now();
		const trace = new Error().stack;

		// Use dialect to transform SQL (e.g., MySQL -> SQLite syntax)
		// and prepare parameters in the format expected by the driver
		// Handle both string return (MySQL/SQLite) and object return (PostgreSQL)
		const transformResult = dialect.transformSql(sql, params);
		let transformedSql;
		let paramOrder;
		if (typeof transformResult === 'object' && transformResult.sql) {
			({ sql: transformedSql, paramOrder } = transformResult);
		} else {
			transformedSql = transformResult;
			paramOrder = undefined;
		}
		const values = dialect.prepareParams(params, paramOrder);

		// Store ref to the line before pushing it so we can modify it after we're done
		const loggedQuery = {
			sql,
			transformedSql: transformedSql !== sql ? transformedSql : undefined,
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
			// Use transformed SQL for actual query execution
			if (Array.isArray(values)) {
				resolve(this.query(transformedSql, values));
			} else {
				resolve(
					this.query({ namedPlaceholders: true, sql: transformedSql }, values),
				);
			}
		}).catch((err) => {
			if (
				!silenceErrors &&
				!(silenceRetryableTransactionErrors && isRetryableTransactionError(err))
			) {
				if (isConnectionClosedError(err)) {
					console.error('Database connection closed, retrying...');
				} else {
					console.error(`
=== Error processing query ===
Error:
	${err}

Raw SQL:
----------
${sql}
----------
${
	transformedSql !== sql
		? `
Transformed SQL:
----------
${transformedSql}
----------
`
		: ''
}
Interpolated SQL:
----------
${debugSql(sql, values)}
----------

Stack trace:
${trace}
==============================
			`);
				}
			}

			throw wrapQueryError(err, trace);
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
	conn.search = function (
		tableAndIdField,
		fields = {},
		limitOne = false,
		{ silenceErrors = false, silenceRetryableTransactionErrors = false } = {},
	) {
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

		return this.roQuery(sql, fields, {
			silenceErrors,
			silenceRetryableTransactionErrors,
		}).then((rows) => {
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
	/**
	 * Shared SQL parts used by create / createIgnore / upsert. Keeps
	 * column-list / placeholder-list / table-quoting in ONE place so a fix
	 * to escaping in one path doesn't silently drift the others.
	 */
	conn._buildInsertParts = function (table, fields) {
		const tableSql = autoFixTable(table, this);
		const fieldKeys = Object.keys(fields);
		const columnList = fieldKeys.map((x) => this.escapeId(x));
		const columnsSql = columnList.join(',');
		const valuesSql = fieldKeys.map((x) => `:${x}`).join(',');
		const firstColumnSql = columnList[0];
		return { tableSql, columnsSql, valuesSql, firstColumnSql, fieldKeys };
	};

	conn.create = function (
		tableAndIdField,
		fields,
		{
			allowBlankIdOnCreate,
			idGenerator = uuid,
			silenceErrors = false,
			silenceRetryableTransactionErrors = false,
		} = {},
	) {
		let { table, idField } = parseIdField(tableAndIdField);

		if (config.uuidLinkedIds && !fields[idField] && !allowBlankIdOnCreate) {
			fields[idField] = idGenerator();
		}

		const { tableSql, columnsSql, valuesSql } = this._buildInsertParts(
			table,
			fields,
		);
		const sql = `insert into ${tableSql} (${columnsSql}) values (${valuesSql})`;

		// console.log("[conn.create]", { sql, fields });
		// if(idField !=== 'id')
		// 	throw new Error("Cannot auto-create because cannot re-query until mariadb gives us our ID - read the docs then update code")

		return this.pquery(sql, fields, {
			silenceErrors,
			silenceRetryableTransactionErrors,
		})
			.then((result) => {
				// console.log(`create raw result:`, result);

				if (!fields[idField]) {
					fields[idField] = result.insertId;
				}

				const select = /* sql */ `select * from ${tableSql} where ${idField}=:id`;
				const selectParams = { id: fields[idField] };

				// console.log(`select sql and query:`, select, selectParams);

				return this.pquery(select, selectParams, {
					silenceErrors,
					silenceRetryableTransactionErrors,
				});
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
			// Store the real diff so callers can report exactly which fields changed.
			conn.patchIf.lastPatch = patch;
			return this.patch(tableAndIdField, existing[idField], patch);
		}

		conn.patchIf.lastAction = null;
		// No fields changed — expose an empty diff so callers can suppress no-op events.
		conn.patchIf.lastPatch = {};

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
	 * @param {Object} options Transaction/create/query options
	 * @param {boolean} [options.useTransaction=true] Set false to use the legacy non-transactional sequence
	 * @param {Object} [options.transactionOptions] Overrides the dialect's safe transaction defaults
	 *
	 * @returns {Promise} Promise of an Object matching the fields given
	 */
	conn.findOrCreate = async function (
		tableAndIdField,
		fields,
		patchIf = {},
		patchIfFalsey = {},
		{
			allowBlankIdOnCreate,
			idGenerator,
			silenceErrors = false,
			useTransaction = true,
			transactionOptions,
		} = {},
	) {
		let { table /* , idField */ } = parseIdField(tableAndIdField);
		conn.findOrCreate.lastAction = null;

		const execute = async (handle) => {
			let lastAction;
			let wasCreated;
			let lastPatch = {};
			let ref = await handle.search(table, fields, true, {
				silenceErrors,
				silenceRetryableTransactionErrors: useTransaction,
			});
			if (!ref) {
				// console.log("[dbh.findOrCreate] **created**", { fields })
				lastAction = 'create';
				wasCreated = true;
				ref = await handle.create(tableAndIdField, fields, {
					allowBlankIdOnCreate,
					idGenerator,
					silenceErrors,
					silenceRetryableTransactionErrors: useTransaction,
				});
			} else {
				// console.log("[dbh.findOrCreate] **found**  ", { fields })
				wasCreated = false;
			}

			if (patchIf || patchIfFalsey) {
				Object.keys(patchIf || {}).forEach((fieldName) => {
					if (ref[fieldName] !== patchIf[fieldName]) {
						lastPatch[fieldName] = patchIf[fieldName];
					}
				});
				Object.keys(patchIfFalsey || {}).forEach((fieldName) => {
					if (!ref[fieldName]) {
						lastPatch[fieldName] = patchIfFalsey[fieldName];
					}
				});
				ref = await handle.patchIf(
					tableAndIdField,
					ref,
					patchIf,
					patchIfFalsey,
				);

				lastAction = Object.keys(lastPatch).length
					? 'patch'
					: lastAction || 'get';
			}
			lastAction = lastAction || 'get';

			// Preserve legacy function properties, but also attach concurrency-safe
			// metadata to this specific result for DatabaseObject hook handling.
			conn.findOrCreate.lastAction = lastAction;
			conn.findOrCreate.wasCreated = wasCreated;
			Object.defineProperty(ref, FIND_OR_CREATE_META, {
				value: { lastAction, wasCreated, lastPatch },
				enumerable: false,
				configurable: true,
			});

			return ref;
		};

		if (!useTransaction || this._transactionContext) {
			return execute(this);
		}

		return this.transaction(
			execute,
			transactionOptions || dialect.defaultFindOrCreateTransactionOptions,
		);
	};

	/**
	 * createIgnore - Atomic at-most-once insert. Runs a dialect-specific
	 * `INSERT IGNORE` / `ON CONFLICT DO NOTHING` and returns the new row
	 * if it was actually inserted, or `null` if a UNIQUE/PK conflict
	 * caused the insert to be skipped. CHECK, NOT NULL, FK, and other
	 * non-conflict errors still throw.
	 *
	 * This is the right primitive for any pattern that previously had to
	 * do SELECT-then-INSERT-with-catch — no race window between the check
	 * and the write, and no noisy duplicate-key log from pquery.
	 *
	 * Note: the happy path is INSERT followed by a SELECT-back to surface
	 * trigger-side defaults / auto-increment IDs, so it is 2 round-trips
	 * on success. The conflict path is 1 round-trip and the savings vs.
	 * SELECT-then-INSERT come from the race-free behavior. A future
	 * `RETURNING *` optimization for Postgres/SQLite could collapse the
	 * happy path to 1 round-trip; not implemented yet.
	 *
	 * @param {string} tableAndIdField Table name (e.g. 'drop_log')
	 * @param {Object} fields Row to insert
	 * @param {Object} [opts]
	 * @param {boolean} [opts.allowBlankIdOnCreate] See create()
	 * @param {Function} [opts.idGenerator] See create()
	 * @param {string[]} [opts.conflictColumns] Required by SQLite/Postgres; ignored by MySQL
	 * @param {boolean} [opts.silenceErrors=true] Default true — idempotency operations should not log
	 *
	 * @returns {Promise<Object|null>} The inserted row, or null on conflict
	 */
	conn.createIgnore = async function (
		tableAndIdField,
		fields,
		{
			allowBlankIdOnCreate,
			idGenerator = uuid,
			conflictColumns,
			silenceErrors = true,
		} = {},
	) {
		let { table, idField } = parseIdField(tableAndIdField);

		if (config.uuidLinkedIds && !fields[idField] && !allowBlankIdOnCreate) {
			fields[idField] = idGenerator();
		}

		const { tableSql, columnsSql, valuesSql, firstColumnSql } =
			this._buildInsertParts(table, fields);

		const sql = dialect.buildInsertIgnoreSql({
			tableSql,
			columnsSql,
			valuesSql,
			firstColumnSql,
			conflictColumns,
		});

		const result = await this.pquery(sql, fields, { silenceErrors });

		// affectedRows normalizes to 0 across dialects when a conflict
		// caused the insert to be skipped.
		if (!result || result.affectedRows === 0) {
			return null;
		}

		// Inserted — fetch the row by id to surface triggered defaults and,
		// for auto-increment keys, the new id assigned by the driver.
		if (!fields[idField] && result.insertId !== undefined) {
			fields[idField] = result.insertId;
		}

		const select = /* sql */ `select * from ${tableSql} where ${this.escapeId(
			idField,
		)}=:id`;
		const rows = await this.pquery(
			select,
			{ id: fields[idField] },
			{ silenceErrors },
		);
		return rows && rows[0] ? rows[0] : null;
	};

	/**
	 * upsert - Atomic insert-or-update. Runs `INSERT ... ON DUPLICATE KEY
	 * UPDATE` (MySQL) or `INSERT ... ON CONFLICT(...) DO UPDATE SET ...`
	 * (SQLite/Postgres) and returns the final row state.
	 *
	 * `onDuplicate` can be:
	 *   - Array of column names → those columns are set to their insert
	 *     values (e.g. `['name', 'updatedAt']` → `name=:name, updatedAt=:updatedAt`).
	 *     This is the safe form and should be preferred.
	 *   - Object of `{ column: 'sql expression' }` → the value is RAW SQL,
	 *     interpolated directly. Use only for in-place expressions like
	 *     `{ count: 'count + 1' }`. Never pass user-supplied input on the
	 *     RHS — it is not escaped.
	 *
	 * Like createIgnore, this is 2 round-trips: one to write, one to read
	 * back the final row by conflictColumns. A future `RETURNING *`
	 * optimization for Postgres/SQLite could collapse to 1 RTT.
	 *
	 * @param {string} tableAndIdField Table name
	 * @param {Object} fields Row to insert
	 * @param {Object} opts
	 * @param {Object|string[]} opts.onDuplicate See above
	 * @param {string[]} [opts.conflictColumns] Required by SQLite/Postgres; ignored by MySQL
	 * @param {boolean} [opts.allowBlankIdOnCreate]
	 * @param {Function} [opts.idGenerator]
	 * @param {boolean} [opts.silenceErrors=true] Default true — idempotency operations should not log
	 *
	 * @returns {Promise<Object>} The final row (inserted or updated)
	 */
	conn.upsert = async function (
		tableAndIdField,
		fields,
		{
			onDuplicate,
			conflictColumns,
			allowBlankIdOnCreate,
			idGenerator = uuid,
			silenceErrors = true,
		} = {},
	) {
		if (!onDuplicate) {
			throw new Error(
				'upsert() requires onDuplicate — an array of column names to copy from the insert values, or an object of {col: sqlExpr} for raw SQL updates',
			);
		}

		let { table, idField } = parseIdField(tableAndIdField);

		if (config.uuidLinkedIds && !fields[idField] && !allowBlankIdOnCreate) {
			fields[idField] = idGenerator();
		}

		const { tableSql, columnsSql, valuesSql, firstColumnSql } =
			this._buildInsertParts(table, fields);

		// Array form copies values from the insert payload (parameterized,
		// safe). Object form interpolates raw SQL — see warning in docstring.
		const updateAssignmentsSql = Array.isArray(onDuplicate)
			? onDuplicate.map((col) => `${this.escapeId(col)}=:${col}`).join(', ')
			: Object.entries(onDuplicate)
					.map(([col, expr]) => `${this.escapeId(col)}=${expr}`)
					.join(', ');

		const sql = dialect.buildUpsertSql({
			tableSql,
			columnsSql,
			valuesSql,
			firstColumnSql,
			updateAssignmentsSql,
			conflictColumns,
		});

		await this.pquery(sql, fields, { silenceErrors });

		// Read back via conflictColumns so we get the winning row whether we
		// inserted or updated. Falls back to id for the MySQL-no-conflict-cols
		// path.
		const lookupFields =
			conflictColumns && conflictColumns.length
				? conflictColumns.reduce((acc, col) => {
						acc[col] = fields[col];
						return acc;
				  }, {})
				: { [idField]: fields[idField] };
		return this.search(table, lookupFields, true, { silenceErrors });
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

	/**
	 * Run a callback atomically on one physical database connection.
	 * Nested calls use savepoints. The callback result is returned unchanged.
	 * tx.roQuery is deliberately pinned to this connection, never a replica.
	 * @param {Function} callback Receives the transaction-scoped dbh
	 * @param {Object} [transactionOptions] Isolation/access/retry options
	 * @returns {Promise<*>} Callback result after commit
	 */
	conn.transaction = function transaction(callback, transactionOptions = {}) {
		return runTransaction(this, callback, transactionOptions);
	};

	// Attach dialect reference to connection for introspection
	conn.dialect = dialect;

	// Don't set this till the end because if another function interrupts this one,
	// we don't want it getting an incomplete cached handle.
	//
	// BUT: a plain `ignoreCachedConnections` request (without `closeReplacedPool`)
	// is documented to hand out an EXTRA throwaway handle WITHOUT invalidating the
	// shared cached pool (see the `previouslyCachedConn` comment above, and
	// test/dbh.ignore-cached-closes-old.test.js). Overwriting the cache here broke
	// that contract: when the caller `end()`s the throwaway handle (schema-sync's
	// verifyAndHealColumns does exactly this), the next plain `dbh()` resolved to
	// the now-ended pool ("pool is closed"). So only (re)write the cache when this
	// is NOT a plain extra-handle request: normal calls, explicit
	// `closeReplacedPool` replacements, and the first-create case (no cache yet).
	const isPlainExtraHandle =
		options.ignoreCachedConnections && !options.closeReplacedPool;
	if (!isPlainExtraHandle || !connCache[key]) {
		connCache[key] = conn;
	}

	// Close the pool we just replaced (ignoreCachedConnections recovery path) so
	// its connections are released instead of orphaned. Best-effort and guarded:
	// a slow/failed close must not break the caller that now holds a healthy new
	// handle. Skipped on the normal first-create path (previouslyCachedConn is
	// undefined) and when, defensively, the cache somehow already points at the
	// new conn.
	if (previouslyCachedConn && previouslyCachedConn !== conn) {
		try {
			if (typeof previouslyCachedConn.end === 'function') {
				await previouslyCachedConn.end();
			}
		} catch (err) {
			console.error(
				`[yass-orm] Failed to close replaced connection pool for key '${key}' (continuing):`,
				err,
			);
		}
	}

	return conn;
}

module.exports = {
	dbh,
	closeAllConnections,
	deflateValue,
	sqlEscape,
	autoFixTable,
	debugSql,
	QueryTiming,
	QueryLogger,
	parseIdField,
	loadBalancerManager, // for setting custom strategies externally
	LoadBalancer, // for sub-classing
	getDialect, // for getting dialect instances directly
	FIND_OR_CREATE_META,
};
