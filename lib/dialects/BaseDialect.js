/* eslint-disable no-unused-vars, class-methods-use-this, no-console */
/**
 * BaseDialect - Abstract base class for database dialect implementations
 *
 * Each dialect provides database-specific behavior for:
 * - SQL syntax transformation
 * - Parameter placeholder formatting
 * - Type mapping
 * - Schema introspection
 * - Connection management
 */
/**
 * The SQL text of a query: a string, or mariadb's `{ sql, namedPlaceholders }`
 * options object.
 * @param {string|{sql: string}} sqlOrOptions
 * @returns {string}
 */
const sqlText = (sqlOrOptions) =>
	sqlOrOptions && typeof sqlOrOptions === 'object' && sqlOrOptions.sql
		? sqlOrOptions.sql
		: sqlOrOptions;

/**
 * True for a value a boolean column default spells as false: `false`, 0,
 * '0', 'false', 'no', ''.
 * @param {*} value
 * @returns {boolean}
 */
const isFalseLiteral = (value) => {
	if (typeof value === 'boolean') return !value;
	return ['0', 'false', '', 'no'].includes(`${value}`.trim().toLowerCase());
};

class BaseDialect {
	/**
	 * Get the dialect name (e.g., 'mysql', 'sqlite')
	 * @returns {string}
	 */
	get name() {
		throw new Error('Dialect must implement name getter');
	}

	// ============================================
	// SQL Syntax & Formatting
	// ============================================

	/**
	 * Quote an identifier (table name, column name) for safe use in SQL
	 * @param {string} name - The identifier to quote
	 * @returns {string} - Quoted identifier
	 */
	quoteIdentifier(name) {
		throw new Error('Dialect must implement quoteIdentifier()');
	}

	/**
	 * The character this dialect quotes identifiers with.
	 * @returns {string}
	 */
	get identifierQuoteChar() {
		return '"';
	}

	/**
	 * Quotes an identifier, or a `table.column` already quoted, exactly once:
	 * `quoteIdentifierOnce(quoteIdentifierOnce(x)) === quoteIdentifierOnce(x)`.
	 * A quote character inside a bare name is DROPPED, not doubled, so the
	 * result is always one well-formed pair (doubling and idempotency can't
	 * both hold). lib/finder.js hands this to its hooks as `dbQuote`, and
	 * third-party code can't be relied on to know whether a value is quoted
	 * yet (BDL-3893).
	 * @param {string} identifier
	 * @returns {string}
	 */
	quoteIdentifierOnce(identifier) {
		const q = this.identifierQuoteChar;
		const str = `${identifier}`;
		const part = `${q}[^${q}]+${q}`;
		if (new RegExp(`^${part}(?:\\.${part})*$`).test(str)) {
			return str;
		}
		return `${q}${str.split(q).join('')}${q}`;
	}

	/**
	 * A LIMIT clause (no leading space): `LIMIT count OFFSET offset`.
	 * @param {number} limit
	 * @param {number} [offset=0]
	 * @returns {string}
	 */
	limitSql(limit, offset = 0) {
		return `LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset || 0, 10)}`;
	}

	/**
	 * `expr`, or `fallback` where it is NULL.
	 * @param {string} expr
	 * @param {string} fallback
	 * @returns {string}
	 */
	ifNullSql(expr, fallback) {
		return `COALESCE(${expr}, ${fallback})`;
	}

	/**
	 * The string concatenation of the SQL expressions in `list`.
	 * @param {string[]} list
	 * @returns {string}
	 */
	concatSql(list) {
		return `CONCAT(${list.join(', ')})`;
	}

	/**
	 * A boolean literal: '1' or '0' (see isFalseLiteral for what is false).
	 * Postgres spells them `true` / `false`.
	 * @param {*} value
	 * @returns {string}
	 */
	toBooleanLiteral(value) {
		return isFalseLiteral(value) ? '0' : '1';
	}

	// ============================================
	// SQL helpers (lib/sql-helpers.js is the public face of these)
	// Defaults are standard SQL, as Postgres spells it; MySQL overrides.
	// ============================================

	/**
	 * The database clock, in UTC.
	 * @returns {string}
	 */
	nowSql() {
		return 'CURRENT_TIMESTAMP';
	}

	/**
	 * `expr` plus or minus `amount` (SQL: a number or a `:param`) of `unit`.
	 * @param {string} expr
	 * @param {string|number} amount
	 * @param {string} unit One of second, minute, hour, day, week, month, year
	 * @param {boolean} [subtract=false]
	 * @returns {string}
	 */
	intervalSql(expr, amount, unit, subtract = false) {
		const arg = {
			second: 'secs',
			minute: 'mins',
			hour: 'hours',
			day: 'days',
			week: 'weeks',
			month: 'months',
			year: 'years',
		}[unit];
		return `(${expr} ${
			subtract ? '-' : '+'
		} make_interval(${arg} => ${amount}))`;
	}

	/**
	 * `a` equals `b`, where NULL equals NULL (or, `negate`d, differs from it).
	 * @param {string} a
	 * @param {string} b
	 * @param {boolean} [negate=false]
	 * @returns {string}
	 */
	nullSafeEqualSql(a, b, negate = false) {
		return `(${a} IS ${negate ? '' : 'NOT '}DISTINCT FROM ${b})`;
	}

	/**
	 * An ORDER BY term that sorts NULLs last.
	 * @param {string} expr
	 * @param {'ASC'|'DESC'} direction
	 * @returns {string}
	 */
	nullsLastSql(expr, direction) {
		return `${expr} ${direction} NULLS LAST`;
	}

	/**
	 * COUNT(expr), read back as a JS number.
	 * @param {string} expr
	 * @returns {string}
	 */
	countSql(expr) {
		return `COUNT(${expr})`;
	}

	/**
	 * Whether `SELECT ... FOR UPDATE` locks rows (SQLite has no row locks).
	 * @returns {boolean}
	 */
	get supportsRowLocks() {
		return true;
	}

	/**
	 * The row-lock clause for a SELECT.
	 * @param {Object} [opts]
	 * @param {boolean} [opts.skipLocked] Skip rows another transaction holds
	 * @param {boolean} [opts.noWait] Fail at once instead of waiting
	 * @returns {string}
	 */
	forUpdateSql({ skipLocked, noWait } = {}) {
		if (skipLocked) return 'FOR UPDATE SKIP LOCKED';
		if (noWait) return 'FOR UPDATE NOWAIT';
		return 'FOR UPDATE';
	}

	/**
	 * The table lockKey() locks rows of: one per key name.
	 * @param {string} tableSql Quoted table name
	 * @returns {string}
	 */
	createLockTableSql(tableSql) {
		return `CREATE TABLE IF NOT EXISTS ${tableSql} (name VARCHAR(191) NOT NULL PRIMARY KEY)`;
	}

	/**
	 * A yass query (MySQL-flavored SQL, `:name` placeholders, or `?` with an
	 * array) as this dialect's driver takes it: `{ sql, values }`.
	 * @param {string} sql
	 * @param {Object|Array} [params]
	 * @returns {{ sql: string, values: Object|Array }}
	 */
	compileQuery(sql, params) {
		const transformed = this.transformSql(sql, params);
		if (transformed && typeof transformed === 'object') {
			return {
				sql: transformed.sql,
				values: this.prepareParams(params, transformed.paramOrder || []),
			};
		}
		return { sql: transformed, values: this.prepareParams(params) };
	}

	/**
	 * The yass connection interface, for a driver that has none of its own
	 * (Postgres, SQLite): `query`, `pquery`, `roQuery`, `escapeId`, `escape`,
	 * `end` and `close`. (MySQL's mariadb pool already has most of it; its
	 * wrapConnection adds `pquery` to the pool itself.) dbh() then bolts its
	 * own `pquery` and helpers on top.
	 *
	 * @param {Object} args
	 * @param {Function} args.run `(sql, values)`: sends one statement (plain SQL text) to the driver
	 * @param {Function} args.end Closes the connection or pool
	 * @param {string} args.label Names the database in a logged query error
	 * @param {Object} [args.props] Extra properties (the raw driver handle)
	 * @param {Object} [args.methods] Extra methods, or overrides of the ones above
	 * @returns {Object}
	 */
	createConnectionWrapper({ run, end, label, props = {}, methods = {} }) {
		const dialect = this;
		return {
			...props,
			dialect,

			/** One statement; takes mariadb's `{ sql }` options object too. */
			query(sqlOrOptions, params) {
				return run(sqlText(sqlOrOptions), params);
			},

			/** A yass query: see compileQuery(). */
			async pquery(sql, params, opts = {}) {
				try {
					const compiled = dialect.compileQuery(sql, params);
					return await this.query(compiled.sql, compiled.values);
				} catch (err) {
					if (!opts.silenceErrors) {
						console.error(`${label} query error: ${err.message}\nSQL: ${sql}`);
					}
					throw err;
				}
			},

			/** No read replicas here: the same as pquery. */
			async roQuery(sql, params, opts = {}) {
				return this.pquery(sql, params, opts);
			},

			escapeId(name) {
				return dialect.quoteIdentifier(name);
			},

			escape(value) {
				return dialect.escapeValue(value);
			},

			end,

			close() {
				return this.end();
			},

			...methods,
		};
	}

	/**
	 * Format a named placeholder for parameterized queries
	 * @param {string} name - The parameter name
	 * @param {number} index - The parameter index (for positional placeholders)
	 * @returns {string} - Formatted placeholder (e.g., ':name', '$name', '?')
	 */
	formatPlaceholder(name, index) {
		throw new Error('Dialect must implement formatPlaceholder()');
	}

	/**
	 * Convert named parameters object to driver-expected format
	 * @param {Object} namedParams - Object with parameter values keyed by name
	 * @returns {Object|Array} - Parameters in driver-expected format
	 */
	prepareParams(namedParams) {
		throw new Error('Dialect must implement prepareParams()');
	}

	/**
	 * Transform SQL from yass-orm standard format to dialect-specific syntax
	 * Handles: placeholder conversion, identifier quoting, function syntax, etc.
	 * @param {string} sql - SQL in yass-orm standard format
	 * @param {Object} params - Named parameters (used to identify placeholders)
	 * @returns {string} - Transformed SQL for this dialect
	 */
	transformSql(sql, params) {
		throw new Error('Dialect must implement transformSql()');
	}

	/**
	 * Escape a value for safe inclusion in SQL (when not using parameters)
	 * @param {*} value - Value to escape
	 * @returns {string} - Escaped value safe for SQL
	 */
	escapeValue(value) {
		if (value === null || value === undefined) return 'NULL';
		if (typeof value === 'number') return String(value);
		if (typeof value === 'boolean') return value ? '1' : '0';
		if (value instanceof Date) {
			return `'${value
				.toISOString()
				.replace('T', ' ')
				.replace(/\.\d+Z$/, '')}'`;
		}
		return `'${String(value).replace(/'/g, "''")}'`;
	}

	/**
	 * Convert a JavaScript value to database-compatible format
	 * @param {*} value - Value to deflate
	 * @returns {*} - Database-compatible value
	 */
	deflateValue(value) {
		if (value === true) return 1;
		if (value === false) return 0;
		if (value instanceof Date) {
			// Guard against invalid dates
			if (Number.isNaN(value.getTime())) return null;
			return value
				.toISOString()
				.replace('T', ' ')
				.replace(/\.\d+Z$/, '');
		}
		if (Array.isArray(value)) {
			return JSON.stringify(value);
		}
		if (value && typeof value === 'object' && value.id !== undefined) {
			return value.id;
		}
		return value;
	}

	// ============================================
	// Type Mapping
	// ============================================

	/**
	 * The field as this dialect stores it, for schema sync: resolves the
	 * portable field options (`precision`, `exact`) into this dialect's column
	 * shape. Returns a new object; never changes the one it is given.
	 *
	 * Default (Postgres, SQLite): drop `collation`. It is a MySQL/MariaDB
	 * concept that these dialects' DDL never emits and their introspection
	 * never reports, so keeping it made every re-sync see a changed column.
	 * `exact` needs nothing here: their default comparison is already exact.
	 * `precision` needs nothing either (Postgres keeps microseconds).
	 * @param {object} fieldData
	 * @returns {object}
	 */
	physicalField(fieldData) {
		const { collation, ...rest } = fieldData;
		return rest;
	}

	/**
	 * Map a yass-orm type to dialect-specific SQL type
	 * @param {string} yassType - yass-orm type (e.g., 'string', 'int', 'uuidKey')
	 * @returns {string} - SQL type for this dialect
	 */
	mapType(yassType) {
		throw new Error('Dialect must implement mapType()');
	}

	/**
	 * Get the primary key attributes for an auto-increment integer key
	 * @returns {Object} - Field attributes for integer primary key
	 */
	getIntegerPrimaryKeyAttrs() {
		throw new Error('Dialect must implement getIntegerPrimaryKeyAttrs()');
	}

	/**
	 * Get the primary key attributes for a UUID key
	 * @returns {Object} - Field attributes for UUID primary key
	 */
	getUuidPrimaryKeyAttrs() {
		throw new Error('Dialect must implement getUuidPrimaryKeyAttrs()');
	}

	/**
	 * Get the primary key attributes for a `t.stringKey` (an app-generated string
	 * id, e.g. `chat_0mfq3k2z1...`). Where a uuid key is already a string column
	 * (MySQL CHAR(36), SQLite TEXT) that is the same column; dialects with a
	 * native UUID type override this.
	 * @returns {Object} - Field attributes for a string primary key
	 */
	getStringPrimaryKeyAttrs() {
		return this.getUuidPrimaryKeyAttrs();
	}

	// ============================================
	// Schema Introspection
	// ============================================

	/**
	 * Check if a table exists in the database
	 * @param {Object} handle - Database connection handle
	 * @param {string} database - Database/schema name
	 * @param {string} tableName - Table name to check
	 * @returns {Promise<boolean>} - True if table exists
	 */
	async tableExists(handle, database, tableName) {
		throw new Error('Dialect must implement tableExists()');
	}

	/**
	 * Get column information for a table
	 * @param {Object} handle - Database connection handle
	 * @param {string} tableName - Table name
	 * @returns {Promise<Array>} - Array of column info objects
	 */
	async getTableColumns(handle, tableName) {
		throw new Error('Dialect must implement getTableColumns()');
	}

	/**
	 * Get index information for a table
	 * @param {Object} handle - Database connection handle
	 * @param {string} tableName - Table name
	 * @returns {Promise<Array>} - Array of index info objects
	 */
	async getTableIndexes(handle, tableName) {
		throw new Error('Dialect must implement getTableIndexes()');
	}

	/**
	 * Get DECLARED-trigger information for a table, in the shape the
	 * lib/sync-triggers.js reconciler consumes:
	 *   [{ name, timing, event, body, order }]
	 *
	 * - `body` MUST be the raw text of the trigger action statement as the
	 *   catalog stores it (yass-orm normalizes both sides before comparing;
	 *   dialects should NOT pre-normalize here).
	 * - `order` MUST be the 1-based firing position within the trigger's
	 *   timing+event group (e.g. MySQL's ACTION_ORDER). It is what the
	 *   reconciler uses to detect that a prior DROP+CREATE has silently
	 *   reordered a group.
	 * - Only relevant when `supportsDeclaredTriggers === true`; otherwise the
	 *   reconciler never calls it. Default throws so a partial dialect
	 *   implementation fails LOUDLY at wire-up time.
	 *
	 * @param {Object} handle - Database connection handle
	 * @param {string} database - schema/database name (some dialects need it
	 *                            to scope by TRIGGER_SCHEMA)
	 * @param {string} tableName - table name (no db prefix)
	 * @returns {Promise<Array>}
	 */
	// eslint-disable-next-line no-unused-vars
	async getTableTriggers(handle, database, tableName) {
		throw new Error('Dialect must implement getTableTriggers()');
	}

	/**
	 * Generate a CREATE TRIGGER statement.
	 *
	 * @param {Object} args
	 * @param {string} args.name - trigger name
	 * @param {string} args.timing - 'before' | 'after' (case-insensitive)
	 * @param {string} args.event  - 'insert' | 'update' | 'delete' (case-insensitive)
	 * @param {string} args.tableName - target table
	 * @param {string} [args.database] - optional db qualifier for the table
	 * @param {string} args.body - the trigger body written by the author (or
	 *                             the synthetic id-trigger body); the dialect
	 *                             owns the CREATE TRIGGER header and the ON
	 *                             clause, so the author never has to template
	 *                             the table name into their body.
	 * @param {string} [args.follows] - optional trigger name; when set, the
	 *                             DDL emits `FOLLOWS <name>` so the reconciler
	 *                             can pin firing order after a group rebuild.
	 * @returns {string}
	 */
	// eslint-disable-next-line no-unused-vars
	generateCreateTrigger({
		name,
		timing,
		event,
		tableName,
		database,
		body,
		follows,
	}) {
		throw new Error('Dialect must implement generateCreateTrigger()');
	}

	/**
	 * Generate a DROP TRIGGER IF EXISTS statement.
	 *
	 * @param {Object} args
	 * @param {string} args.name
	 * @param {string} [args.database]
	 * @returns {string}
	 */
	// eslint-disable-next-line no-unused-vars
	generateDropTrigger({ name, database }) {
		throw new Error('Dialect must implement generateDropTrigger()');
	}

	/**
	 * Get list of all tables in the database
	 * @param {Object} handle - Database connection handle
	 * @param {string} database - Database/schema name
	 * @returns {Promise<Array<string>>} - Array of table names
	 */
	async getTables(handle, database) {
		throw new Error('Dialect must implement getTables()');
	}

	// ============================================
	// DDL Generation
	// ============================================

	/**
	 * Generate CREATE TABLE SQL
	 * @param {string} tableName - Table name
	 * @param {Array} fields - Field definitions
	 * @param {Object} options - Table options
	 * @returns {string} - CREATE TABLE SQL statement
	 */
	generateCreateTable(tableName, fields, options) {
		throw new Error('Dialect must implement generateCreateTable()');
	}

	/**
	 * Generate field specification for CREATE/ALTER TABLE
	 * @param {Object} fieldData - Field definition
	 * @param {Object} options - Generation options
	 * @returns {string} - Field specification SQL fragment
	 */
	generateFieldSpec(fieldData, options) {
		throw new Error('Dialect must implement generateFieldSpec()');
	}

	/**
	 * Generate CREATE INDEX SQL
	 * @param {string} tableName - Table name
	 * @param {string} indexName - Index name
	 * @param {Array} columns - Column names
	 * @param {Object} options - Index options (unique, fulltext, etc.)
	 * @returns {string} - CREATE INDEX SQL statement
	 */
	generateCreateIndex(tableName, indexName, columns, options) {
		throw new Error('Dialect must implement generateCreateIndex()');
	}

	// ============================================
	// Connection Management
	// ============================================

	/**
	 * Create a database connection or pool
	 * @param {Object} config - Connection configuration
	 * @returns {Promise<Object>} - Database connection/pool handle
	 */
	async createConnection(config) {
		throw new Error('Dialect must implement createConnection()');
	}

	/**
	 * Create a connection pool (if supported)
	 * @param {Object} config - Pool configuration
	 * @returns {Promise<Object>} - Connection pool handle
	 */
	async createPool(config) {
		// Default to single connection for dialects without pooling
		return this.createConnection(config);
	}

	/**
	 * Close a connection or pool
	 * @param {Object} handle - Connection/pool handle
	 * @returns {Promise<void>}
	 */
	async closeConnection(handle) {
		if (handle && typeof handle.end === 'function') {
			return handle.end();
		}
		if (handle && typeof handle.close === 'function') {
			return handle.close();
		}
		return undefined;
	}

	// ============================================
	// Transactions
	// ============================================

	get supportedIsolationLevels() {
		return [];
	}

	get supportedTransactionModes() {
		return [];
	}

	get supportsReadOnlyTransactions() {
		return false;
	}

	get supportsDeferrableTransactions() {
		return false;
	}

	get defaultFindOrCreateTransactionOptions() {
		return {};
	}

	normalizeTransactionOptions(options = {}) {
		const normalized = { ...options };
		if (normalized.isolationLevel !== undefined) {
			const isolationLevel = `${normalized.isolationLevel}`
				.trim()
				.toLowerCase()
				.replace(/[_-]+/g, ' ')
				.replace(/\s+/g, ' ');
			if (!this.supportedIsolationLevels.includes(isolationLevel)) {
				throw new Error(
					`Isolation level '${isolationLevel}' is not supported by the ${
						this.name
					} dialect (supported: ${
						this.supportedIsolationLevels.join(', ') || 'none'
					})`,
				);
			}
			normalized.isolationLevel = isolationLevel;
		}

		if (normalized.mode !== undefined) {
			const mode = `${normalized.mode}`.trim().toLowerCase();
			if (!this.supportedTransactionModes.includes(mode)) {
				throw new Error(
					`Transaction mode '${mode}' is not supported by the ${
						this.name
					} dialect (supported: ${
						this.supportedTransactionModes.join(', ') || 'none'
					})`,
				);
			}
			normalized.mode = mode;
		}

		if (normalized.readOnly && !this.supportsReadOnlyTransactions) {
			throw new Error(
				`Read-only transactions are not supported by the ${this.name} dialect`,
			);
		}
		if (normalized.deferrable && !this.supportsDeferrableTransactions) {
			throw new Error(
				`Deferrable transactions are not supported by the ${this.name} dialect`,
			);
		}

		return normalized;
	}

	async acquireTransactionConnection() {
		throw new Error(
			`Transactions are not implemented by the ${this.name} dialect`,
		);
	}

	async beginTransaction(connection) {
		await connection.query('BEGIN');
		return undefined;
	}

	async commitTransaction(connection) {
		await connection.query('COMMIT');
	}

	async rollbackTransaction(connection) {
		await connection.query('ROLLBACK');
	}

	async cleanupTransaction() {
		return undefined;
	}

	// ============================================
	// Feature Flags
	// ============================================

	/**
	 * Whether this dialect supports FULLTEXT indexes
	 * @returns {boolean}
	 */
	get supportsFullTextSearch() {
		return false;
	}

	/**
	 * Whether this dialect supports JSON operators (->>, json_extract, etc.)
	 * @returns {boolean}
	 */
	get supportsJsonOperators() {
		return false;
	}

	/**
	 * Whether this dialect supports PARTIAL (filtered) indexes -- an index that
	 * covers only the rows matching a predicate: `CREATE INDEX ... WHERE <cond>`.
	 *
	 * Postgres and SQLite support them; MySQL/MariaDB do NOT (there is no
	 * equivalent syntax at all -- `CREATE INDEX ... WHERE` is a parse error).
	 * Defaults to false so a new dialect has to opt in deliberately.
	 *
	 * @returns {boolean}
	 */
	get supportsPartialIndexes() {
		return false;
	}

	/**
	 * Whether the dialect supports MULTI-VALUED indexes over a JSON array, i.e.
	 * `INDEX ((CAST(col->'$[*]' AS CHAR(64) ARRAY)))`, which let a JSON array
	 * column be searched with a sargable JSON_CONTAINS instead of a full-scan
	 * LIKE.
	 *
	 * MySQL 8.0.17+ only. Postgres expresses the same idea with a GIN index over
	 * jsonb and SQLite has no equivalent at all, so neither maps onto this
	 * spelling; both leave it false and schema-sync skips such an index rather
	 * than emitting something that means something different. Defaults to false
	 * so a new dialect has to opt in deliberately.
	 *
	 * @returns {boolean}
	 */
	get supportsMultiValuedIndexes() {
		return false;
	}

	/**
	 * Whether schema-sync should prefix declared index names with their table name.
	 *
	 * Needed where index names share ONE namespace across the whole database rather
	 * than being scoped to their table: two tables both declaring `idx_status` would
	 * otherwise collide. Defaults to false (MySQL's behavior, where index names are
	 * table-scoped and no prefixing is wanted).
	 *
	 * @returns {boolean}
	 */
	get prefixIndexNamesWithTable() {
		return false;
	}

	/**
	 * Maximum identifier length in characters, or undefined for no practical limit.
	 *
	 * Matters because some servers silently TRUNCATE an over-long identifier rather
	 * than erroring, which would make schema-sync ask for a name the catalog never
	 * reports back -- and recreate the object on every run.
	 *
	 * @returns {number|undefined}
	 */
	get maxIdentifierLength() {
		return undefined;
	}

	/**
	 * Whether this dialect supports stored functions/procedures
	 * @returns {boolean}
	 */
	get supportsStoredFunctions() {
		return false;
	}

	/**
	 * Whether this dialect supports ALTER TABLE ... MODIFY/CHANGE COLUMN
	 * @returns {boolean}
	 */
	get supportsAlterColumn() {
		return false;
	}

	/**
	 * Whether this dialect accepts SEVERAL `ADD` clauses in ONE `ALTER TABLE`,
	 * i.e. `ALTER TABLE t ADD a ..., ADD b ...`.
	 *
	 * MySQL and Postgres do. SQLite does NOT -- measured 2026-09-12 against
	 * both better-sqlite3 and node:sqlite: `near ",": syntax error`, with a
	 * passing single-ADD control proving the rejection is real and not a dead
	 * probe.
	 *
	 * Defaults to FALSE so a dialect keeps the safe one-statement-per-column
	 * behaviour until it opts in deliberately.
	 *
	 * @returns {boolean}
	 */
	get supportsMultiClauseAlterAdd() {
		return false;
	}

	/**
	 * Build ONE `ALTER TABLE` that adds several columns at once.
	 *
	 * Only ever called when `supportsMultiClauseAlterAdd` is true, so the base
	 * implementation THROWS rather than guessing a syntax: a dialect that opts
	 * in without implementing this must fail loud, not silently emit something
	 * the server rejects halfway through a migration.
	 *
	 * @param {string} tableName
	 * @param {object[]} fieldDataList - fieldData for each column, in order
	 * @returns {string}
	 */
	// eslint-disable-next-line no-unused-vars
	generateAlterAddColumns(tableName, fieldDataList) {
		throw new Error(
			`${this.constructor.name} does not implement generateAlterAddColumns()`,
		);
	}

	/**
	 * SQL that reports a table's approximate row count and data/index size, or
	 * `null` when this dialect has no cheap way to answer.
	 *
	 * Returns a COMPLETE, fully-inlined statement because schema-sync's
	 * `execQuery` takes no bind parameters.
	 *
	 * @param {string} tableName
	 * @param {object} [opts]
	 * @param {string} [opts.database]
	 * @returns {string|null}
	 */
	// eslint-disable-next-line no-unused-vars
	generateTableSizeQuery(tableName, opts = {}) {
		return null;
	}

	/**
	 * Whether this dialect supports named placeholders natively
	 * @returns {boolean}
	 */
	get supportsNamedPlaceholders() {
		return false;
	}

	/**
	 * Whether this dialect supports connection pooling
	 * @returns {boolean}
	 */
	get supportsConnectionPooling() {
		return false;
	}

	/**
	 * Whether the underlying DATABASE supports triggers at all.
	 *
	 * This is the coarse capability flag: MySQL/MariaDB, Postgres, and SQLite
	 * all say YES here. Individual yass-orm features on top of triggers have
	 * their own flags below (`supportsUuidIdTrigger`,
	 * `supportsDeclaredTriggers`), so a dialect can implement one, both, or
	 * neither without lying about what the database itself can do.
	 * @returns {boolean}
	 */
	get supportsTriggers() {
		return false;
	}

	/**
	 * Whether this dialect implements the built-in `before_insert_*_set_id`
	 * UUID trigger yass-orm auto-attaches to `t.uuidKey` tables. The MySQL
	 * body uses `uuid()`, which Postgres and SQLite spell differently (and in
	 * Postgres's case requires an inline function body it does not have), so
	 * only MySQL says YES here. When false, yass-orm generates UUIDs in JS
	 * and the id trigger is not emitted.
	 * @returns {boolean}
	 */
	get supportsUuidIdTrigger() {
		return false;
	}

	/**
	 * Whether this dialect implements the DECLARED-trigger reconciler
	 * (schema-def `triggers: { ... }` block reconciled against the catalog).
	 * MySQL says YES; Postgres and SQLite say NO in this pass because their
	 * introspection is harder (PG reformats `pg_get_triggerdef()`, and both
	 * need a live-DB idempotency test to build the normalizer against). See
	 * the plan for the deferred-until-needed rationale.
	 * @returns {boolean}
	 */
	get supportsDeclaredTriggers() {
		return false;
	}

	/**
	 * Whether this dialect supports read replicas / load balancing
	 * @returns {boolean}
	 */
	get supportsReadReplicas() {
		return false;
	}

	// ============================================
	// Idempotent / Upsert SQL
	// ============================================

	/**
	 * Build an INSERT statement that silently no-ops on a UNIQUE/PK
	 * conflict — and ONLY on that — rather than erroring. CHECK, NOT NULL,
	 * FK, and data-truncation failures must still throw. Used by
	 * dbh.createIgnore() for atomic at-most-once inserts.
	 *
	 * `conflictColumns` is REQUIRED by SQLite and Postgres (the SQL
	 * standard mandates a conflict target). MySQL ignores it — its
	 * `ON DUPLICATE KEY UPDATE` idiom infers the matched UNIQUE index
	 * from the row itself. Callers writing portable SQL should always
	 * supply it; the asymmetry is a quirk of MySQL, not a feature.
	 *
	 * `firstColumnSql` is used by the MySQL implementation to construct
	 * a no-op SET clause (e.g. `ON DUPLICATE KEY UPDATE \`id\`=\`id\``).
	 * Other dialects ignore it.
	 *
	 * @param {Object} args
	 * @param {string} args.tableSql Pre-quoted table reference
	 * @param {string} args.columnsSql Comma-joined, pre-quoted column list
	 * @param {string} args.valuesSql Comma-joined placeholder list (e.g. `:id,:tenant`)
	 * @param {string} args.firstColumnSql Pre-quoted first column (used by MySQL for the no-op SET)
	 * @param {string[]} [args.conflictColumns] Conflict target (required by SQLite/Postgres, ignored by MySQL)
	 * @returns {string} Dialect-specific SQL
	 */
	// eslint-disable-next-line no-unused-vars
	buildInsertIgnoreSql({
		tableSql,
		columnsSql,
		valuesSql,
		firstColumnSql,
		conflictColumns,
	}) {
		throw new Error('Dialect must implement buildInsertIgnoreSql()');
	}

	/**
	 * Build an atomic insert-or-update statement. Used by dbh.upsert().
	 *
	 * `conflictColumns` is required by SQLite and Postgres; MySQL ignores it.
	 *
	 * @param {Object} args
	 * @param {string} args.tableSql Pre-quoted table reference
	 * @param {string} args.columnsSql Comma-joined, pre-quoted column list
	 * @param {string} args.valuesSql Comma-joined placeholder list
	 * @param {string} args.updateAssignmentsSql SET clause body
	 * @param {string[]} [args.conflictColumns] Conflict target (required by SQLite/Postgres, ignored by MySQL)
	 * @returns {string} Dialect-specific SQL
	 */
	// eslint-disable-next-line no-unused-vars
	buildUpsertSql({
		tableSql,
		columnsSql,
		valuesSql,
		updateAssignmentsSql,
		conflictColumns,
	}) {
		throw new Error('Dialect must implement buildUpsertSql()');
	}
}

module.exports = { BaseDialect, sqlText, isFalseLiteral };
