/* eslint-disable no-console, global-require, no-restricted-syntax, no-continue */
/**
 * PostgresDialect - PostgreSQL dialect implementation
 *
 * Provides PostgreSQL-specific behavior for yass-orm.
 * Uses the `pg` package for connection management.
 *
 * Key differences from MySQL:
 * - Uses double quotes for identifiers (SQL standard)
 * - Uses $1, $2, ... for positional placeholders (not :name)
 * - ALTER COLUMN uses ALTER TABLE ... ALTER COLUMN ... TYPE (not CHANGE)
 * - FULLTEXT via GIN indexes with to_tsvector
 * - JSON stored as JSONB with native operators
 * - SERIAL type for auto-increment integer keys
 * - UUID type with gen_random_uuid() for UUID keys
 * - DROP INDEX does not require table name
 */

const { BaseDialect } = require('./BaseDialect.js');

// Lazy-load the PostgreSQL SQL transformer
let transformSqlForPostgres;
function getPostgresTransformer() {
	if (!transformSqlForPostgres) {
		try {
			// eslint-disable-next-line import/no-unresolved
			const mod = require('../sql-transform/PostgresSqlTransformer.js');
			({ transformSqlForPostgres } = mod);
		} catch (err) {
			// Transformer not available yet - provide a basic fallback
			transformSqlForPostgres = null;
		}
	}
	return transformSqlForPostgres;
}

// Lazy-load pg to allow usage of other dialects without it installed
let pg;
function getPg() {
	if (!pg) {
		try {
			pg = require('pg');
		} catch (err) {
			throw new Error(
				'pg package is required for PostgreSQL dialect. Install it with: npm install pg',
			);
		}
	}
	return pg;
}

class PostgresDialect extends BaseDialect {
	get name() {
		return 'postgres';
	}

	// ============================================
	// SQL Syntax & Formatting
	// ============================================

	quoteIdentifier(name) {
		// PostgreSQL uses double quotes for identifier quoting (SQL standard)
		return `"${name.replace(/"/g, '""')}"`;
	}

	// eslint-disable-next-line no-unused-vars
	formatPlaceholder(name, index) {
		// PostgreSQL uses positional placeholders: $1, $2, $3, ...
		return `$${index + 1}`;
	}

	prepareParams(namedParams, paramOrder) {
		// If already an array, just deflate each value
		if (Array.isArray(namedParams)) {
			return namedParams.map((value) => this.deflateValue(value));
		}

		if (!namedParams) return [];

		// If no paramOrder provided, return empty array
		if (!paramOrder || !paramOrder.length) return [];

		// Convert named params to ordered array based on paramOrder
		return paramOrder.map((key) => this.deflateValue(namedParams[key]));
	}

	transformSql(sql, params) {
		const transformer = getPostgresTransformer();
		if (!transformer) {
			// Fallback: return sql as-is if transformer not available yet
			return { sql, paramOrder: [], mode: 'passthrough' };
		}
		const result = transformer({ sql, params });
		return result;
	}

	// ============================================
	// Idempotent / Upsert SQL (Postgres native syntax)
	// ============================================

	buildInsertIgnoreSql({
		tableSql,
		columnsSql,
		valuesSql,
		// eslint-disable-next-line no-unused-vars
		firstColumnSql,
		// eslint-disable-next-line no-unused-vars
		conflictColumns,
	}) {
		// Postgres' `ON CONFLICT DO NOTHING` swallows ONLY unique/PK
		// conflicts — CHECK, NOT NULL, FK still throw, which matches the
		// method's contract. firstColumnSql is unused here (MySQL-only).
		return `INSERT INTO ${tableSql} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT DO NOTHING`;
	}

	buildUpsertSql({
		tableSql,
		columnsSql,
		valuesSql,
		updateAssignmentsSql,
		conflictColumns,
	}) {
		if (!conflictColumns || conflictColumns.length === 0) {
			throw new Error(
				'Postgres upsert requires conflictColumns (the UNIQUE/PK columns to match on).',
			);
		}
		const conflictSql = conflictColumns
			.map((c) => this.quoteIdentifier(c))
			.join(', ');
		return `INSERT INTO ${tableSql} (${columnsSql}) VALUES (${valuesSql}) ON CONFLICT (${conflictSql}) DO UPDATE SET ${updateAssignmentsSql}`;
	}

	// ============================================
	// Type Mapping
	// ============================================

	mapType(yassType) {
		const typeMap = {
			idKey: 'SERIAL',
			uuidKey: 'UUID',
			string: 'VARCHAR(255)',
			text: 'TEXT',
			int: 'INTEGER',
			integer: 'INTEGER',
			bigint: 'BIGINT',
			bool: 'BOOLEAN',
			boolean: 'BOOLEAN',
			real: 'DOUBLE PRECISION',
			double: 'DOUBLE PRECISION',
			float: 'REAL',
			date: 'DATE',
			datetime: 'TIMESTAMP',
			time: 'TIME',
			timestamp: 'TIMESTAMP',
			json: 'JSONB',
			blob: 'BYTEA',
			longblob: 'BYTEA',
			longtext: 'TEXT',
			'varchar(255)': 'VARCHAR(255)',
			'char(36)': 'CHAR(36)',
			'int(11)': 'INTEGER',
			'int(1)': 'BOOLEAN',
		};
		return typeMap[yassType] || 'TEXT';
	}

	getIntegerPrimaryKeyAttrs() {
		return {
			type: 'SERIAL',
			key: 'PRI',
			readonly: 1,
			auto: 1,
		};
	}

	getUuidPrimaryKeyAttrs() {
		return {
			type: 'UUID',
			key: 'PRI',
			null: 0,
			default: 'gen_random_uuid()',
		};
	}

	// ============================================
	// Schema Introspection
	// ============================================

	async tableExists(handle, database, tableName) {
		const rows = await handle.query(
			`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
			[tableName],
		);
		return (rows.rows || rows).length > 0;
	}

	async getTableColumns(handle, tableName) {
		const result = await handle.query(
			`SELECT column_name, data_type, is_nullable, column_default,
				character_maximum_length, numeric_precision, numeric_scale
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = $1
			ORDER BY ordinal_position`,
			[tableName],
		);
		const rows = result.rows || result;
		return rows.map((row) => ({
			name: row.column_name,
			type: row.data_type,
			nullable: row.is_nullable === 'YES',
			defaultValue: row.column_default,
			primaryKey: false, // Needs pg_constraint join for accuracy
			autoIncrement:
				row.column_default && row.column_default.includes('nextval'),
			_raw: row,
		}));
	}

	async getTableIndexes(handle, tableName) {
		const result = await handle.query(
			`SELECT
				i.relname AS index_name,
				ix.indisunique AS is_unique,
				ix.indisprimary AS is_primary,
				pg_get_indexdef(ix.indexrelid) AS index_def
			FROM pg_index ix
			JOIN pg_class i ON i.oid = ix.indexrelid
			JOIN pg_class t ON t.oid = ix.indrelid
			JOIN pg_namespace n ON n.oid = t.relnamespace
			WHERE t.relname = $1 AND n.nspname = 'public'
			ORDER BY i.relname`,
			[tableName],
		);
		const rows = result.rows || result;
		return rows
			.filter((row) => !row.is_primary)
			.map((row) => {
				// Parse columns from index definition
				const defMatch = row.index_def.match(/\((.+)\)$/);
				const columnStr = defMatch ? defMatch[1] : '';
				const columns = columnStr
					.split(',')
					.map((c) => c.trim().replace(/^"|"$/g, ''));

				return {
					name: row.index_name,
					columns,
					unique: row.is_unique,
					sql: row.index_def,
				};
			});
	}

	// eslint-disable-next-line no-unused-vars
	async getTables(handle, database) {
		const result = await handle.query(
			`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
		);
		const rows = result.rows || result;
		return rows.map((row) => row.table_name);
	}

	// ============================================
	// DDL Generation
	// ============================================

	// eslint-disable-next-line no-unused-vars
	generateCreateTable(tableName, fields, options = {}) {
		const columnDefs = fields.map((field) => this.generateFieldSpec(field));
		const quotedTable = this.quoteIdentifier(tableName);

		// PostgreSQL doesn't need CHARACTER SET specification
		return `CREATE TABLE ${quotedTable} (${columnDefs.join(', ')})`;
	}

	generateFieldSpec(fieldData, options = {}) {
		const { ignore: ignoreList = [] } = options;
		const ignoreMap = Object.fromEntries(
			(ignoreList || []).map((k) => [k, true]),
		);

		const { field, key, default: defaultVal } = fieldData;

		// Map yass-orm type to PG type
		const type = this.mapType(fieldData.type);

		// Build the field specification
		let spec = `${this.quoteIdentifier(field)} ${type}`;

		// Add NOT NULL
		const nullVal = fieldData.null;
		if (nullVal === 'NO' || nullVal === 0 || nullVal === '0') {
			spec += ' NOT NULL';
		}

		// Add PRIMARY KEY (unless ignored)
		if (!ignoreMap.key && key === 'PRI') {
			spec += ' PRIMARY KEY';
		}

		// Add UNIQUE
		if (key === 'UNI') {
			spec += ' UNIQUE';
		}

		// Add DEFAULT
		if (defaultVal !== undefined && defaultVal !== null) {
			if (defaultVal === 'CURRENT_TIMESTAMP') {
				spec += ' DEFAULT CURRENT_TIMESTAMP';
			} else if (
				typeof defaultVal === 'string' &&
				defaultVal.match(/^[a-zA-Z_]+\(.*\)$/)
			) {
				// Function call like gen_random_uuid() - don't quote
				spec += ` DEFAULT ${defaultVal}`;
			} else if (typeof defaultVal === 'string') {
				spec += ` DEFAULT '${defaultVal.replace(/'/g, "''")}'`;
			} else {
				spec += ` DEFAULT ${defaultVal}`;
			}
		}

		return spec;
	}

	generateCreateIndex(tableName, indexName, columns, options = {}) {
		const { unique = false, fulltext = false, where } = options;
		const quotedTable = this.quoteIdentifier(tableName);
		const quotedIndex = this.quoteIdentifier(indexName);

		// Handle FULLTEXT indexes using GIN with to_tsvector
		if (fulltext) {
			const tsvectorColumns = columns
				.map((col) => `to_tsvector('english', ${this.quoteIdentifier(col)})`)
				.join(' || ');
			return `CREATE INDEX ${quotedIndex} ON ${quotedTable} USING GIN (${tsvectorColumns})`;
		}

		const indexType = unique ? 'UNIQUE INDEX' : 'INDEX';

		// Regex to extract column name and any modifiers (DESC, ASC, (255), etc.)
		const colNameExtractRegex = /^([a-zA-Z_][a-zA-Z0-9_]*)([\s(].*)?$/;

		const columnList = columns
			.map((col) => {
				// Handle JSON functional indexes
				if (`${col || ''}`.includes('->>')) {
					// Keep PG-native JSON syntax as expression index
					return `(${col})`;
				}
				// Handle expressions (columns in parentheses)
				if (col.startsWith('(') && col.endsWith(')')) {
					return col;
				}

				// Extract column name and any modifiers
				const match = col.match(colNameExtractRegex);
				if (match) {
					const [, colName, modifier] = match;
					// PostgreSQL doesn't support prefix length indexes like MySQL's col(255)
					if (modifier && modifier.trim().startsWith('(')) {
						return this.quoteIdentifier(colName);
					}
					// Handle DESC/ASC modifiers
					if (modifier && /^\s*(DESC|ASC)/i.test(modifier)) {
						return `${this.quoteIdentifier(colName)}${modifier}`;
					}
					return this.quoteIdentifier(colName);
				}

				return this.quoteIdentifier(col);
			})
			.join(', ');

		let sql = `CREATE ${indexType} ${quotedIndex} ON ${quotedTable} (${columnList})`;

		// PostgreSQL supports partial indexes with WHERE clause
		if (where) {
			sql += ` WHERE ${where}`;
		}

		return sql;
	}

	// eslint-disable-next-line no-unused-vars
	generateDropIndex(tableName, indexName) {
		// PostgreSQL DROP INDEX doesn't require table name
		return `DROP INDEX IF EXISTS ${this.quoteIdentifier(indexName)}`;
	}

	generateAlterAddColumn(tableName, fieldData) {
		const quotedTable = this.quoteIdentifier(tableName);
		return `ALTER TABLE ${quotedTable} ADD COLUMN ${this.generateFieldSpec(
			fieldData,
		)}`;
	}

	generateAlterModifyColumn(tableName, fieldData) {
		const quotedTable = this.quoteIdentifier(tableName);
		const quotedField = this.quoteIdentifier(fieldData.field);
		const type = this.mapType(fieldData.type);

		// PostgreSQL requires separate ALTER COLUMN statements for TYPE, NOT NULL, and DEFAULT
		const statements = [];

		// Change type
		statements.push(
			`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} TYPE ${type}`,
		);

		// Change nullability
		const nullVal = fieldData.null;
		if (nullVal === 'NO' || nullVal === 0 || nullVal === '0') {
			statements.push(
				`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET NOT NULL`,
			);
		} else {
			statements.push(
				`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} DROP NOT NULL`,
			);
		}

		// Change default
		if (fieldData.default !== undefined && fieldData.default !== null) {
			if (fieldData.default === 'CURRENT_TIMESTAMP') {
				statements.push(
					`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET DEFAULT CURRENT_TIMESTAMP`,
				);
			} else if (
				typeof fieldData.default === 'string' &&
				fieldData.default.match(/^[a-zA-Z_]+\(.*\)$/)
			) {
				// Function call like gen_random_uuid() - don't quote
				statements.push(
					`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET DEFAULT ${fieldData.default}`,
				);
			} else if (typeof fieldData.default === 'string') {
				statements.push(
					`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET DEFAULT '${fieldData.default.replace(
						/'/g,
						"''",
					)}'`,
				);
			} else {
				statements.push(
					`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET DEFAULT ${fieldData.default}`,
				);
			}
		}

		return statements.join(';\n');
	}

	generateAlterDropColumn(tableName, columnName) {
		const quotedTable = this.quoteIdentifier(tableName);
		return `ALTER TABLE ${quotedTable} DROP COLUMN ${this.quoteIdentifier(
			columnName,
		)}`;
	}

	// ============================================
	// Connection Management
	// ============================================

	async createConnection(config) {
		const pgLib = getPg();

		const client = new pgLib.Client({
			host: config.host || 'localhost',
			port: config.port || 5432,
			user: config.user || 'postgres',
			password: config.password,
			database: config.database,
			ssl: config.ssl || false,
			connectionTimeoutMillis: config.connectTimeout || 3000,
		});

		await client.connect();
		return client;
	}

	async createPool(config) {
		const pgLib = getPg();

		const pool = new pgLib.Pool({
			host: config.host || 'localhost',
			port: config.port || 5432,
			user: config.user || 'postgres',
			password: config.password,
			database: config.database,
			ssl: config.ssl || false,
			max: config.connectionLimit || 10,
			idleTimeoutMillis: (config.idleTimeout || 600) * 1000,
			connectionTimeoutMillis: config.connectTimeout || 3000,
		});

		return pool;
	}

	/**
	 * Wrap a pg Client or Pool with yass-orm compatible interface
	 * @param {Object} conn - pg Client or Pool instance
	 * @returns {Object} - Wrapped connection matching yass-orm interface
	 */
	wrapConnection(conn) {
		// Idempotent: if already wrapped (has _conn property), return as-is
		if (conn && conn._conn) {
			return conn;
		}

		const dialect = this;

		const wrapper = {
			_conn: conn,
			dialect,

			/**
			 * Execute a query (for compatibility with mariadb interface)
			 * Handles both string SQL and mariadb-style { namedPlaceholders, sql } objects
			 */
			async query(sqlOrOptions, params) {
				// Handle mariadb-style options object: { namedPlaceholders: true, sql: '...' }
				let sql;
				if (typeof sqlOrOptions === 'object' && sqlOrOptions.sql) {
					({ sql } = sqlOrOptions);
				} else {
					sql = sqlOrOptions;
				}

				// For INSERT statements, append RETURNING * if not already present
				// so we can extract insertId from the result
				const upperSql = sql.trim().toUpperCase();
				if (upperSql.startsWith('INSERT') && !upperSql.includes('RETURNING')) {
					sql += ' RETURNING *';
				}

				const result = await conn.query(sql, params);

				if (
					upperSql.startsWith('SELECT') ||
					upperSql.startsWith('WITH') ||
					upperSql.startsWith('SHOW')
				) {
					return result.rows;
				}

				return {
					affectedRows: result.rowCount,
					insertId: result.rows && result.rows[0] ? result.rows[0].id : null,
				};
			},

			/**
			 * Parameterized query with yass-orm named placeholder support
			 */
			async pquery(sql, params, opts = {}) {
				try {
					const transformed = dialect.transformSql(sql, params);

					let finalSql;
					let paramOrder;

					if (typeof transformed === 'object' && transformed.sql) {
						finalSql = transformed.sql;
						paramOrder = transformed.paramOrder || [];
					} else {
						finalSql = transformed;
						paramOrder = [];
					}

					const preparedParams = dialect.prepareParams(params, paramOrder);
					return await this.query(finalSql, preparedParams);
				} catch (err) {
					if (!opts.silenceErrors) {
						console.error(
							`PostgreSQL query error: ${err.message}\nSQL: ${sql}`,
						);
					}
					throw err;
				}
			},

			/**
			 * Read-only query (for read replica support)
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
			 * Close the connection/pool
			 */
			async end() {
				return conn.end();
			},

			/**
			 * Close the connection/pool (alias)
			 */
			async close() {
				return this.end();
			},
		};

		return wrapper;
	}

	// ============================================
	// Transactions
	// ============================================

	get supportedIsolationLevels() {
		return [
			'read uncommitted',
			'read committed',
			'repeatable read',
			'serializable',
		];
	}

	get supportsReadOnlyTransactions() {
		return true;
	}

	get supportsDeferrableTransactions() {
		return true;
	}

	get defaultFindOrCreateTransactionOptions() {
		return { isolationLevel: 'serializable', maxRetries: 2 };
	}

	normalizeTransactionOptions(options = {}) {
		const normalized = super.normalizeTransactionOptions(options);
		if (
			normalized.deferrable &&
			(!normalized.readOnly || normalized.isolationLevel !== 'serializable')
		) {
			throw new Error(
				'Postgres deferrable transactions require readOnly: true and isolationLevel: serializable',
			);
		}
		return normalized;
	}

	async acquireTransactionConnection(handle) {
		const raw = handle._conn || handle;
		const isPool =
			typeof raw.connect === 'function' && typeof raw.totalCount === 'number';
		const leased = isPool ? await raw.connect() : raw;
		return {
			connection: this.wrapConnection(leased),
			release: async () => {
				if (isPool && typeof leased.release === 'function') leased.release();
			},
		};
	}

	async beginTransaction(connection, options) {
		const clauses = [];
		if (options.isolationLevel) {
			clauses.push(`ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`);
		}
		if (options.readOnly !== undefined) {
			clauses.push(options.readOnly ? 'READ ONLY' : 'READ WRITE');
		}
		if (options.deferrable !== undefined) {
			clauses.push(options.deferrable ? 'DEFERRABLE' : 'NOT DEFERRABLE');
		}
		await connection.query(
			`BEGIN${clauses.length ? ` ${clauses.join(' ')}` : ''}`,
		);
	}

	// ============================================
	// JSON Support Check
	// ============================================

	async checkJsonSupport(handle) {
		try {
			await handle.query("SELECT '{}'::jsonb");
			return true;
		} catch (err) {
			return false;
		}
	}

	// ============================================
	// Feature Flags
	// ============================================

	get supportsFullTextSearch() {
		return true; // GIN indexes with to_tsvector
	}

	get supportsJsonOperators() {
		return true; // Native JSONB operators ->>, ->, @>, etc.
	}

	get supportsStoredFunctions() {
		return false; // PL/pgSQL exists but yass-orm uses MySQL-specific SHOW FUNCTION STATUS syntax
	}

	get supportsAlterColumn() {
		return true; // ALTER TABLE ... ALTER COLUMN ... TYPE
	}

	get supportsNamedPlaceholders() {
		return false; // Uses positional $1, $2, ...
	}

	get supportsConnectionPooling() {
		return true; // pg.Pool
	}

	get supportsTriggers() {
		// PG supports triggers, but the MySQL-style UUID trigger syntax
		// used in yass-orm won't work. Skip auto-trigger creation.
		return false;
	}

	get supportsReadReplicas() {
		return true;
	}
}

module.exports = { PostgresDialect };
