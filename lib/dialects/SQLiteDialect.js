/* eslint-disable no-console, global-require, no-restricted-syntax, no-continue, import/no-unresolved */
/**
 * SQLiteDialect - SQLite dialect implementation
 *
 * Provides SQLite-specific behavior for yass-orm.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 *
 * Key differences from MySQL:
 * - Uses double quotes for identifiers (not backticks)
 * - Uses $name or ?NNN for placeholders (not :name)
 * - No ALTER COLUMN support (only ADD COLUMN)
 * - No FULLTEXT indexes (FTS5 is separate)
 * - No stored functions/procedures
 * - Single-writer model (no connection pooling needed)
 * - Dates stored as TEXT in ISO format
 */

const { BaseDialect } = require('./BaseDialect.js');
const {
	transformSqlForSqlite,
} = require('../sql-transform/SQLiteSqlTransformer.js');

// Lazy-load better-sqlite3 to allow MySQL-only usage without it installed
let Database;
function getBetterSqlite3() {
	if (!Database) {
		try {
			Database = require('better-sqlite3');
		} catch (err) {
			throw new Error(
				'better-sqlite3 package is required for SQLite dialect. Install it with: npm install better-sqlite3',
			);
		}
	}
	return Database;
}

function extractIndexExpressionsFromSql(indexSql) {
	if (!indexSql) {
		return [];
	}

	const onIdx = indexSql.toUpperCase().indexOf(' ON ');
	if (onIdx < 0) {
		return [];
	}
	const openIdx = indexSql.indexOf('(', onIdx);
	if (openIdx < 0) {
		return [];
	}

	let closeIdx = -1;
	let depth = 0;
	let quote = null;
	for (let i = openIdx; i < indexSql.length; i++) {
		const ch = indexSql[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === '\\') {
				i += 1;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === '(') {
			depth += 1;
			continue;
		}
		if (ch === ')') {
			depth -= 1;
			if (depth === 0) {
				closeIdx = i;
				break;
			}
		}
	}

	if (closeIdx < 0) {
		return [];
	}

	const list = indexSql.slice(openIdx + 1, closeIdx);
	const parts = [];
	let buf = '';
	depth = 0;
	quote = null;

	for (let i = 0; i < list.length; i++) {
		const ch = list[i];
		if (quote) {
			buf += ch;
			if (ch === quote) {
				quote = null;
			} else if (ch === '\\') {
				const next = list[i + 1];
				if (next !== undefined) {
					buf += next;
					i += 1;
				}
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === '(') {
			depth += 1;
			buf += ch;
			continue;
		}
		if (ch === ')') {
			depth -= 1;
			buf += ch;
			continue;
		}
		if (ch === ',' && depth === 0) {
			parts.push(buf.trim());
			buf = '';
			continue;
		}
		buf += ch;
	}
	if (buf.trim()) {
		parts.push(buf.trim());
	}
	return parts;
}

class SQLiteDialect extends BaseDialect {
	get name() {
		return 'sqlite';
	}

	// ============================================
	// SQL Syntax & Formatting
	// ============================================

	quoteIdentifier(name) {
		// SQLite uses double quotes for identifier quoting (SQL standard)
		// Also supports brackets [] and backticks ` for compatibility
		return `"${name.replace(/"/g, '""')}"`;
	}

	// eslint-disable-next-line no-unused-vars
	formatPlaceholder(name, index) {
		// SQLite supports multiple placeholder styles:
		// - ?NNN (positional with number)
		// - :name, @name, $name (named)
		// We use $name to avoid conflicts with MySQL's :name in shared SQL
		return `$${name}`;
	}

	prepareParams(namedParams) {
		// better-sqlite3 expects params as object with keys matching placeholders
		// Keys should NOT include the $ prefix when passed to .run()/.all()
		if (!namedParams) return {};

		if (Array.isArray(namedParams)) {
			return namedParams.map((value) => this.deflateValue(value));
		}

		const prepared = {};
		for (const [key, value] of Object.entries(namedParams)) {
			prepared[key] = this.deflateValue(value);
		}
		return prepared;
	}

	transformSql(sql, params) {
		const transformed = transformSqlForSqlite({ sql, params });
		return transformed.sql;
	}

	// ============================================
	// Type Mapping
	// ============================================

	mapType(yassType) {
		// SQLite has dynamic typing with 5 storage classes: NULL, INTEGER, REAL, TEXT, BLOB
		// We map to these for clarity, though SQLite is flexible
		const typeMap = {
			idKey: 'INTEGER', // INTEGER PRIMARY KEY enables ROWID alias & autoincrement
			uuidKey: 'TEXT',
			string: 'TEXT',
			text: 'TEXT',
			int: 'INTEGER',
			integer: 'INTEGER',
			bool: 'INTEGER', // 0 or 1
			boolean: 'INTEGER',
			real: 'REAL',
			double: 'REAL',
			float: 'REAL',
			date: 'TEXT', // Store as ISO string: YYYY-MM-DD
			datetime: 'TEXT', // Store as ISO string: YYYY-MM-DD HH:MM:SS
			time: 'TEXT', // Store as HH:MM:SS
			timestamp: 'TEXT',
			json: 'TEXT', // JSON stored as text, use json_extract() to query
			blob: 'BLOB',
			longblob: 'BLOB',
			longtext: 'TEXT',
			varchar: 'TEXT',
			'varchar(255)': 'TEXT',
			'char(36)': 'TEXT',
			'int(11)': 'INTEGER',
			'int(1)': 'INTEGER',
			// Map SQL types to themselves (for when type is already resolved)
			INTEGER: 'INTEGER',
			TEXT: 'TEXT',
			REAL: 'REAL',
			BLOB: 'BLOB',
		};
		return typeMap[yassType] || 'TEXT';
	}

	getIntegerPrimaryKeyAttrs() {
		return {
			type: 'INTEGER',
			key: 'PRI',
			// SQLite auto-increments INTEGER PRIMARY KEY automatically (ROWID alias)
			// AUTOINCREMENT keyword is optional and prevents ROWID reuse
			extra: '', // Don't specify AUTOINCREMENT unless strictly needed
			readonly: 1,
			auto: 1,
		};
	}

	getUuidPrimaryKeyAttrs() {
		return {
			type: 'TEXT',
			key: 'PRI',
			null: 0,
			// No collation needed - SQLite TEXT comparison is already case-sensitive by default
		};
	}

	// ============================================
	// Schema Introspection
	// ============================================

	// eslint-disable-next-line no-unused-vars
	async tableExists(handle, database, tableName) {
		const row = handle
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
			.get(tableName);
		return !!row;
	}

	async getTableColumns(handle, tableName) {
		const rows = handle.prepare(`PRAGMA table_info("${tableName}")`).all();
		return rows.map((row) => ({
			name: row.name,
			type: row.type,
			nullable: row.notnull === 0,
			defaultValue: row.dflt_value,
			primaryKey: row.pk > 0,
			// SQLite INTEGER PRIMARY KEY is auto-increment by default (ROWID alias)
			autoIncrement: row.pk > 0 && row.type.toUpperCase() === 'INTEGER',
			_raw: row,
		}));
	}

	async getTableIndexes(handle, tableName) {
		const indexList = handle.prepare(`PRAGMA index_list("${tableName}")`).all();
		const indexDefinitions = handle
			.prepare(
				`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ?`,
			)
			.all(tableName)
			.reduce(
				(out, row) => ({
					...out,
					[row.name]: row.sql,
				}),
				{},
			);
		const indexes = [];

		for (const idx of indexList) {
			// Skip auto-generated indexes for PRIMARY KEY and UNIQUE constraints
			// These start with "sqlite_autoindex_"
			if (idx.name.startsWith('sqlite_autoindex_')) {
				continue;
			}

			const columnInfo = handle
				.prepare(`PRAGMA index_xinfo("${idx.name}")`)
				.all()
				.filter((row) => row.key === 1)
				.sort((a, b) => a.seqno - b.seqno);
			const expressionCols = extractIndexExpressionsFromSql(
				indexDefinitions[idx.name],
			);
			let expressionCursor = 0;

			indexes.push({
				name: idx.name,
				columns: columnInfo.map((c) => {
					if (c.name) {
						return c.desc ? `${c.name} DESC` : c.name;
					}
					const expression = expressionCols[expressionCursor];
					expressionCursor += 1;
					return expression || `__expr_${c.seqno}`;
				}),
				unique: idx.unique === 1,
				type: 'BTREE', // SQLite uses B-tree by default
				partial: idx.partial === 1,
				sql: indexDefinitions[idx.name],
			});
		}

		return indexes;
	}

	// eslint-disable-next-line no-unused-vars
	async getTables(handle, database) {
		const rows = handle
			.prepare(
				`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
			)
			.all();
		return rows.map((row) => row.name);
	}

	// ============================================
	// DDL Generation
	// ============================================

	// eslint-disable-next-line no-unused-vars
	generateCreateTable(tableName, fields, options = {}) {
		const columnDefs = fields.map((field) => this.generateFieldSpec(field));
		const quotedTable = this.quoteIdentifier(tableName);

		// SQLite doesn't need CHARACTER SET specification
		return `CREATE TABLE ${quotedTable} (${columnDefs.join(', ')})`;
	}

	generateFieldSpec(fieldData, options = {}) {
		const { ignore: ignoreList = [] } = options;
		const ignoreMap = Object.fromEntries(
			(ignoreList || []).map((k) => [k, true]),
		);

		const { field, key, default: defaultVal, _description } = fieldData;

		// Map yass-orm type to SQLite type
		let type = this.mapType(fieldData.type);

		// Build the field specification
		let spec = `${this.quoteIdentifier(field)} ${type}`;

		// Add PRIMARY KEY (unless ignored)
		if (!ignoreMap.key && key === 'PRI') {
			spec += ' PRIMARY KEY';
			// For INTEGER PRIMARY KEY, SQLite automatically makes it an alias for ROWID
			// which auto-increments. Only add AUTOINCREMENT if we want to prevent reuse.
		}

		// Add NOT NULL
		const nullVal = fieldData.null;
		if (nullVal === 'NO' || nullVal === 0 || nullVal === '0') {
			spec += ' NOT NULL';
		}

		// Add UNIQUE
		if (key === 'UNI') {
			spec += ' UNIQUE';
		}

		// Add DEFAULT
		if (defaultVal !== undefined && defaultVal !== null) {
			if (defaultVal === 'CURRENT_TIMESTAMP') {
				spec += " DEFAULT (datetime('now'))";
			} else if (typeof defaultVal === 'string') {
				spec += ` DEFAULT '${defaultVal.replace(/'/g, "''")}'`;
			} else {
				spec += ` DEFAULT ${defaultVal}`;
			}
		}

		// SQLite doesn't support COMMENT on columns directly
		// We could use a separate metadata table if needed
		if (_description) {
			// Store as a SQL comment for documentation (won't be in schema)
			// This is just informational - SQLite ignores it
		}

		return spec;
	}

	generateCreateIndex(tableName, indexName, columns, options = {}) {
		const { unique = false, where } = options;
		const quotedTable = this.quoteIdentifier(tableName);
		const quotedIndex = this.quoteIdentifier(indexName);

		// SQLite doesn't support FULLTEXT (use FTS5 extension separately)
		if (options.fulltext) {
			console.warn(
				`SQLite does not support FULLTEXT indexes. Skipping index: ${indexName}`,
			);
			return null;
		}

		const indexType = unique ? 'UNIQUE INDEX' : 'INDEX';

		// Regex to extract column name and any modifiers (DESC, ASC, (255), etc.)
		const colNameExtractRegex = /^([a-zA-Z_][a-zA-Z0-9_]*)([\s(].*)?$/;

		const columnList = columns
			.map((col) => {
				// Handle JSON functional indexes
				if (`${col || ''}`.includes('->>')) {
					// Convert MySQL JSON syntax to SQLite
					const sqliteCol = col.replace(
						/(\w+)->>["'](\$\.[^"']+)["']/g,
						"json_extract($1, '$2')",
					);
					return `(${sqliteCol})`;
				}
				// Handle expressions (columns in parentheses)
				if (col.startsWith('(') && col.endsWith(')')) {
					return col;
				}

				// Extract column name and any modifiers
				const match = col.match(colNameExtractRegex);
				if (match) {
					const [, colName, modifier] = match;
					// SQLite doesn't support prefix length indexes like MySQL's col(255)
					// Just use the column name for those
					if (modifier && modifier.trim().startsWith('(')) {
						// Skip prefix length, just use column name
						return this.quoteIdentifier(colName);
					}
					// Handle DESC/ASC modifiers - put them after the quoted column name
					if (modifier && /^\s*(DESC|ASC)/i.test(modifier)) {
						return `${this.quoteIdentifier(colName)}${modifier}`;
					}
					return this.quoteIdentifier(colName);
				}

				return this.quoteIdentifier(col);
			})
			.join(', ');

		let sql = `CREATE ${indexType} ${quotedIndex} ON ${quotedTable} (${columnList})`;

		// SQLite supports partial indexes with WHERE clause
		if (where) {
			sql += ` WHERE ${where}`;
		}

		return sql;
	}

	generateDropIndex(tableName, indexName) {
		// SQLite DROP INDEX doesn't require table name
		return `DROP INDEX IF EXISTS ${this.quoteIdentifier(indexName)}`;
	}

	generateAlterAddColumn(tableName, fieldData) {
		const quotedTable = this.quoteIdentifier(tableName);
		return `ALTER TABLE ${quotedTable} ADD COLUMN ${this.generateFieldSpec(
			fieldData,
		)}`;
	}

	generateAlterModifyColumn(tableName, fieldData) {
		// SQLite does NOT support modifying columns!
		// The only way is to recreate the table:
		// 1. CREATE TABLE new_table AS SELECT ... FROM old_table
		// 2. DROP TABLE old_table
		// 3. ALTER TABLE new_table RENAME TO old_table
		// 4. Recreate indexes
		throw new Error(
			`SQLite does not support ALTER COLUMN. Table recreation required for: ${tableName}.${fieldData.field}`,
		);
	}

	generateAlterDropColumn(tableName, columnName) {
		// SQLite 3.35.0+ supports DROP COLUMN, but with limitations
		const quotedTable = this.quoteIdentifier(tableName);
		return `ALTER TABLE ${quotedTable} DROP COLUMN ${this.quoteIdentifier(
			columnName,
		)}`;
	}

	// ============================================
	// Connection Management
	// ============================================

	async createConnection(config) {
		const BetterSqlite3 = getBetterSqlite3();

		const filename = config.filename || config.database || ':memory:';
		const db = new BetterSqlite3(filename, {
			verbose: config.verbose ? console.log : undefined,
			readonly: config.readonly || false,
			fileMustExist: config.fileMustExist || false,
		});

		// Enable foreign keys (disabled by default in SQLite)
		db.pragma('foreign_keys = ON');

		// Set journal mode to WAL for better concurrent read performance
		if (!config.readonly) {
			db.pragma('journal_mode = WAL');
		}

		// Wrap in async-compatible interface matching mariadb's API
		return this.wrapConnection(db);
	}

	async createPool(config) {
		// SQLite doesn't need connection pooling - it's file-based
		// Single connection is sufficient (and recommended)
		return this.createConnection(config);
	}

	/**
	 * Wrap a better-sqlite3 database with yass-orm compatible interface
	 * @param {Object} db - better-sqlite3 database instance
	 * @returns {Object} - Wrapped connection matching mariadb interface
	 */
	wrapConnection(db) {
		const dialect = this;

		const wrapper = {
			_db: db,
			dialect,

			/**
			 * Execute a query (for compatibility with mariadb interface)
			 * Handles both string SQL and mariadb-style { namedPlaceholders, sql } objects
			 */
			query(sqlOrOptions, params) {
				// Handle mariadb-style options object: { namedPlaceholders: true, sql: '...' }
				let sql;
				if (typeof sqlOrOptions === 'object' && sqlOrOptions.sql) {
					const { sql: sqlFromOptions } = sqlOrOptions;
					sql = sqlFromOptions;
				} else {
					sql = sqlOrOptions;
				}

				const stmt = db.prepare(sql);
				const upperSql = sql.trim().toUpperCase();

				if (
					upperSql.startsWith('SELECT') ||
					upperSql.startsWith('PRAGMA') ||
					upperSql.startsWith('WITH')
				) {
					// Read query - return rows
					if (Array.isArray(params)) {
						return Promise.resolve(stmt.all(...params));
					}
					return Promise.resolve(stmt.all(params || {}));
				}
				// Write query - return result info
				let result;
				if (Array.isArray(params)) {
					result = stmt.run(...params);
				} else {
					result = stmt.run(params || {});
				}
				return Promise.resolve({
					affectedRows: result.changes,
					insertId: result.lastInsertRowid,
				});
			},

			/**
			 * Parameterized query with yass-orm named placeholder support
			 */
			async pquery(sql, params, opts = {}) {
				try {
					const transformedSql = dialect.transformSql(sql, params);
					const preparedParams = dialect.prepareParams(params);
					return await this.query(transformedSql, preparedParams);
				} catch (err) {
					if (!opts.silenceErrors) {
						console.error(`SQLite query error: ${err.message}\nSQL: ${sql}`);
					}
					throw err;
				}
			},

			/**
			 * Read-only query (same as pquery for SQLite - no replicas)
			 */
			async roQuery(sql, params, opts = {}) {
				return this.pquery(sql, params, opts);
			},

			/**
			 * Escape identifier for safe use in SQL
			 */
			escapeId(name) {
				return dialect.quoteIdentifier(name);
			},

			/**
			 * Escape value for safe use in SQL
			 */
			escape(value) {
				return dialect.escapeValue(value);
			},

			/**
			 * Prepare a statement for repeated execution
			 */
			prepare(sql) {
				return db.prepare(sql);
			},

			/**
			 * Execute multiple statements in a transaction
			 */
			transaction(fn) {
				return db.transaction(fn);
			},

			/**
			 * Close the database connection
			 */
			end() {
				db.close();
				return Promise.resolve();
			},

			/**
			 * Close the database connection (alias)
			 */
			close() {
				return this.end();
			},
		};

		return wrapper;
	}

	// ============================================
	// Feature Flags
	// ============================================

	get supportsFullTextSearch() {
		return false; // FTS5 requires different API
	}

	get supportsJsonOperators() {
		return true; // Via json_extract(), json_set(), etc.
	}

	get supportsStoredFunctions() {
		return false;
	}

	get supportsAlterColumn() {
		return false; // Only ADD COLUMN is supported
	}

	get supportsNamedPlaceholders() {
		return true; // With $name prefix
	}

	get supportsConnectionPooling() {
		return false; // Not needed for SQLite
	}

	get supportsTriggers() {
		// SQLite supports triggers, but the MySQL-style UUID trigger in sync-to-db
		// won't work because SQLite lacks uuid() function and uses different syntax.
		// Return false to skip UUID trigger creation - UUIDs will be generated in JS.
		return false;
	}

	get supportsReadReplicas() {
		return false;
	}
}

module.exports = { SQLiteDialect };
