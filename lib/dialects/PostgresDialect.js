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

/**
 * Reduce one argument of a `pg_get_indexdef()` expression back to the plain
 * column name it refers to.
 *
 * `pg_get_indexdef()` does not echo back the DDL we sent; it re-renders the
 * parsed expression. So a `varchar` column passed to `to_tsvector` comes back
 * with an explicit cast — `(notes)::text` — and a camelCase column stays
 * double-quoted, while a lowercase one is bare.
 *
 * @param {string} raw a single expression argument, e.g. `(notes)::text`
 * @returns {string} the bare column name, e.g. `notes`
 */
function unquotePostgresIdentifier(raw) {
	let value = `${raw || ''}`.trim();
	// Trailing cast added by Postgres when the argument is not already `text`.
	value = value.replace(/::\s*[a-z_][a-z0-9_ ]*$/i, '').trim();
	// That cast leaves its operand parenthesized: `(notes)::text` -> `(notes)`.
	while (value.startsWith('(') && value.endsWith(')')) {
		value = value.slice(1, -1).trim();
	}
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/""/g, '"');
	}
	return value;
}

/**
 * Extract the source columns of a Postgres FULLTEXT (GIN over `to_tsvector`)
 * index, in index order.
 *
 * Multi-column full-text indexes concatenate one `to_tsvector()` call per
 * column with `||`, so every call contributes one column. The regconfig
 * argument (`'english'::regconfig`) is skipped when present.
 *
 * @param {string} indexDef the full `pg_get_indexdef()` string
 * @returns {string[]} bare column names in index order
 */
function parsePostgresFulltextColumns(indexDef) {
	// The column argument may itself contain one level of parens (the `(col)` of
	// a `(col)::text` cast), but never a comma, which is what separates it from
	// the regconfig argument.
	const callRegex =
		/to_tsvector\(\s*(?:'[^']*'(?:::\s*regconfig)?\s*,\s*)?((?:[^(),]|\([^()]*\))+)\s*\)/gi;
	const columns = [];
	let match = callRegex.exec(indexDef);
	while (match) {
		const column = unquotePostgresIdentifier(match[1]);
		if (column) {
			columns.push(column);
		}
		match = callRegex.exec(indexDef);
	}
	return columns;
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
			// `t.string` converts to the bare type `varchar` (no length). MySQL
			// normalizes that to `varchar(255)` in generateFieldSpec; without the same
			// normalization here it fell through to the TEXT fallback, so every
			// `t.string` column silently became TEXT instead of VARCHAR(255).
			varchar: 'VARCHAR(255)',
			'varchar(-1)': 'VARCHAR(255)',
			'nvarchar(-1)': 'VARCHAR(255)',
			// Map native PG types to themselves, for when the type is ALREADY
			// resolved. schema-sync resolves primary keys through
			// getIntegerPrimaryKeyAttrs()/getUuidPrimaryKeyAttrs() -- which return
			// 'SERIAL'/'UUID' -- and generateFieldSpec then maps that resolved type a
			// second time. Without these entries the `|| 'TEXT'` fallback silently
			// rewrote every native type to TEXT, so `id SERIAL PRIMARY KEY` was
			// emitted as `id TEXT PRIMARY KEY` and no Postgres table ever got a
			// working auto-increment key. (SQLiteDialect carries the same identity
			// entries for the same reason.)
			SERIAL: 'SERIAL',
			BIGSERIAL: 'BIGSERIAL',
			UUID: 'UUID',
			TEXT: 'TEXT',
			'VARCHAR(255)': 'VARCHAR(255)',
			'CHAR(36)': 'CHAR(36)',
			INTEGER: 'INTEGER',
			BIGINT: 'BIGINT',
			BOOLEAN: 'BOOLEAN',
			REAL: 'REAL',
			'DOUBLE PRECISION': 'DOUBLE PRECISION',
			DATE: 'DATE',
			TIMESTAMP: 'TIMESTAMP',
			TIME: 'TIME',
			JSONB: 'JSONB',
			BYTEA: 'BYTEA',
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
		// The LEFT JOIN against pg_index/pg_attribute resolves primary-key
		// membership. Without it `primaryKey` was hardcoded false, so schema-sync
		// could never tell a primary key from an ordinary column -- and the key
		// attrs it compares against always carry `key: 'PRI'`.
		const result = await handle.query(
			`SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
				c.character_maximum_length, c.numeric_precision, c.numeric_scale,
				(pk.attname IS NOT NULL) AS is_primary_key
			FROM information_schema.columns c
			LEFT JOIN (
				SELECT a.attname
				FROM pg_index i
				JOIN pg_class t ON t.oid = i.indrelid
				JOIN pg_namespace n ON n.oid = t.relnamespace
				JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
				WHERE i.indisprimary AND t.relname = $1 AND n.nspname = 'public'
			) pk ON pk.attname = c.column_name
			WHERE c.table_schema = 'public' AND c.table_name = $1
			ORDER BY c.ordinal_position`,
			[tableName],
		);
		const rows = result.rows || result;
		return rows.map((row) => ({
			name: row.column_name,
			// Include the declared length, as MySQL's SHOW COLUMNS does
			// (`character varying(255)`, not a bare `character varying`) -- the
			// schema-diff normalization rules compare against the parameterized form.
			type:
				row.character_maximum_length !== null &&
				row.character_maximum_length !== undefined
					? `${row.data_type}(${row.character_maximum_length})`
					: row.data_type,
			nullable: row.is_nullable === 'YES',
			defaultValue: row.column_default,
			primaryKey: !!row.is_primary_key,
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
				const def = `${row.index_def || ''}`;
				// `USING <method> (...)` -- pg_get_indexdef always emits the method.
				const methodMatch = def.match(/\sUSING\s+([a-z0-9_]+)\s*\(/i);
				const method = methodMatch ? methodMatch[1].toUpperCase() : 'BTREE';
				// A FULLTEXT index in Postgres is a GIN index over to_tsvector().
				// A GIN index WITHOUT to_tsvector (e.g. on a jsonb column) is an
				// ordinary index and must not be reported as FULLTEXT. Schema-sync
				// compares this against the schema's `fulltext` flag; leaving `type`
				// unset made every existing FULLTEXT index compare as fulltext:false,
				// so it was dropped and recreated on every sync.
				const isFullText = method === 'GIN' && /to_tsvector\s*\(/i.test(def);

				let columns;
				if (isFullText) {
					// The tsvector expression is not a comma-separated column list --
					// splitting it on commas yields garbage like
					// `to_tsvector('english'::regconfig`.
					columns = parsePostgresFulltextColumns(def);
				} else {
					// Parse columns from index definition
					const defMatch = def.match(/\((.+)\)$/);
					const columnStr = defMatch ? defMatch[1] : '';
					columns = columnStr
						.split(',')
						.map((c) => c.trim().replace(/^"|"$/g, ''));
				}

				return {
					name: row.index_name,
					columns,
					unique: row.is_unique,
					type: isFullText ? 'FULLTEXT' : method,
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

	/**
	 * Render a value as a Postgres boolean literal.
	 *
	 * yass-orm expresses booleans the MySQL way (0/1, sometimes as strings), but
	 * Postgres will not accept an integer where a boolean is expected.
	 *
	 * @param {*} value 0/1, '0'/'1', 'false'/'true', or a real boolean
	 * @returns {string} 'true' or 'false'
	 */
	// eslint-disable-next-line class-methods-use-this
	toBooleanLiteral(value) {
		if (typeof value === 'boolean') {
			return value ? 'true' : 'false';
		}
		const normalized = `${value}`.trim().toLowerCase();
		const isFalse =
			normalized === '0' ||
			normalized === 'false' ||
			normalized === '' ||
			normalized === 'no';
		return isFalse ? 'false' : 'true';
	}

	/**
	 * Translate a creation-time type into one that is legal in
	 * `ALTER COLUMN ... TYPE`.
	 *
	 * `SERIAL`/`BIGSERIAL` are not real Postgres types -- they are CREATE-time
	 * shorthand for an integer column plus a sequence and a `nextval()` default.
	 * `ALTER COLUMN ... TYPE SERIAL` fails with `type "serial" does not exist`,
	 * which took down the whole sync.
	 *
	 * @param {string} type a mapped type, e.g. 'SERIAL'
	 * @returns {string} a type valid in an ALTER, e.g. 'INTEGER'
	 */
	// eslint-disable-next-line class-methods-use-this
	alterableType(type) {
		const serialToInteger = {
			SERIAL: 'INTEGER',
			BIGSERIAL: 'BIGINT',
			SMALLSERIAL: 'SMALLINT',
		};
		return serialToInteger[`${type}`.toUpperCase()] || type;
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
			if (type === 'BOOLEAN') {
				// Postgres is strict about DEFAULT expression types: a boolean column
				// rejects an integer default outright. yass-orm's `t.bool` carries
				// `default: 0` (a JS number), which MySQL happily accepts, so this only
				// ever failed here -- and it failed CREATE TABLE for every schema using
				// the standard `isDeleted` commonField.
				spec += ` DEFAULT ${this.toBooleanLiteral(defaultVal)}`;
			} else if (defaultVal === 'CURRENT_TIMESTAMP') {
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
			// Postgres' index_elem grammar accepts a bare column name or a bare
			// function call, but ANY other expression must be parenthesized. A
			// multi-column full-text index concatenates tsvectors (`a || b`), which is
			// an operator expression -- unparenthesized, that is a syntax error. An
			// extra pair of parens around a lone function call is always legal, so
			// wrap unconditionally rather than branching on column count.
			return `CREATE INDEX ${quotedIndex} ON ${quotedTable} USING GIN ((${tsvectorColumns}))`;
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
		const type = this.alterableType(this.mapType(fieldData.type));

		// PostgreSQL requires separate ALTER COLUMN statements for TYPE, NOT NULL, and DEFAULT
		const statements = [];

		// Change type
		statements.push(
			`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} TYPE ${type}`,
		);

		// Change nullability. A PRIMARY KEY column is implicitly NOT NULL and
		// Postgres refuses to drop that, so never emit DROP NOT NULL for one --
		// yass-orm's key attrs do not all carry `null: 0`, so this would otherwise
		// fire on the primary key and fail the whole sync.
		const nullVal = fieldData.null;
		const isPrimaryKey = fieldData.key === 'PRI';
		if (nullVal === 'NO' || nullVal === 0 || nullVal === '0') {
			statements.push(
				`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET NOT NULL`,
			);
		} else if (!isPrimaryKey) {
			statements.push(
				`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} DROP NOT NULL`,
			);
		}

		// Change default
		if (fieldData.default !== undefined && fieldData.default !== null) {
			if (type === 'BOOLEAN') {
				// Same strictness as generateFieldSpec: a boolean column rejects an
				// integer default, and yass-orm carries `default: 0` for `t.bool`.
				statements.push(
					`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} SET DEFAULT ${this.toBooleanLiteral(
						fieldData.default,
					)}`,
				);
			} else if (fieldData.default === 'CURRENT_TIMESTAMP') {
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
