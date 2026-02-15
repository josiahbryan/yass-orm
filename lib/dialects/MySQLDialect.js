/* eslint-disable no-console, no-param-reassign, global-require, no-restricted-syntax */
/**
 * MySQLDialect - MySQL/MariaDB dialect implementation
 *
 * Provides MySQL-specific behavior extracted from the original yass-orm codebase.
 * Compatible with both MySQL and MariaDB via the mariadb npm package.
 */

const { BaseDialect } = require('./BaseDialect.js');

// Lazy-load mariadb to allow SQLite-only usage without mariadb installed
let mariadb;
function getMariaDb() {
	if (!mariadb) {
		try {
			mariadb = require('mariadb');
		} catch (err) {
			throw new Error(
				'mariadb package is required for MySQL dialect. Install it with: npm install mariadb',
			);
		}
	}
	return mariadb;
}

function normalizeMySqlIndexExpression(expression) {
	if (!expression) {
		return expression;
	}

	// MySQL stores JSON functional index expressions in expanded form:
	// (cast(json_unquote(json_extract(`col`,_utf8mb4'$.path')) as char(255) ...))
	// Convert this back to the schema-friendly shorthand used in definitions:
	// col->>"$.path"
	const normalized = `${expression}`.replace(/\s+/g, ' ');
	const jsonExtractMatch = normalized.match(
		/json_extract\s*\(\s*`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s*,\s*(?:_utf8mb4)?'([^']+)'\s*\)/i,
	);
	if (jsonExtractMatch) {
		const [, fieldName, pathSpec] = jsonExtractMatch;
		return `${fieldName}->>"${pathSpec}"`;
	}

	return expression;
}

class MySQLDialect extends BaseDialect {
	get name() {
		return 'mysql';
	}

	// ============================================
	// SQL Syntax & Formatting
	// ============================================

	quoteIdentifier(name) {
		// MySQL uses backticks for identifier quoting
		return `\`${name.replace(/`/g, '``')}\``;
	}

	// eslint-disable-next-line no-unused-vars
	formatPlaceholder(name, index) {
		// MySQL/MariaDB driver supports :name syntax with namedPlaceholders option
		return `:${name}`;
	}

	prepareParams(namedParams) {
		// MariaDB driver accepts named params directly when namedPlaceholders: true
		// Just deflate values for database compatibility
		if (!namedParams) return null;

		if (Array.isArray(namedParams)) {
			return namedParams.map((value) => this.deflateValue(value));
		}

		const deflated = {};
		for (const [key, value] of Object.entries(namedParams)) {
			deflated[key] = this.deflateValue(value);
		}
		return deflated;
	}

	// eslint-disable-next-line no-unused-vars
	transformSql(sql, params) {
		// MySQL uses :name syntax natively with mariadb driver
		// No transformation needed - SQL is already in MySQL format
		return sql;
	}

	// ============================================
	// Type Mapping
	// ============================================

	mapType(yassType) {
		const typeMap = {
			idKey: 'int(11)',
			uuidKey: 'char(36)',
			string: 'varchar(255)',
			text: 'longtext',
			int: 'int(11)',
			integer: 'int(11)',
			bool: 'int(1)',
			boolean: 'int(1)',
			real: 'double',
			double: 'double',
			float: 'float',
			date: 'date',
			datetime: 'datetime',
			time: 'time',
			timestamp: 'timestamp',
			json: 'longtext',
			blob: 'blob',
			longblob: 'longblob',
		};
		return typeMap[yassType] || yassType;
	}

	getIntegerPrimaryKeyAttrs() {
		return {
			extra: 'auto_increment',
			type: 'int(11)',
			key: 'PRI',
			readonly: 1,
			auto: 1,
		};
	}

	getUuidPrimaryKeyAttrs() {
		return {
			// Cannot use 'char(36) binary' because it causes a warning 1287
			// Instead, use COLLATE utf8mb4_bin as recommended
			type: 'char(36)',
			collation: 'utf8mb4_bin',
			key: 'PRI',
			null: 0,
		};
	}

	// ============================================
	// Schema Introspection
	// ============================================

	async tableExists(handle, database, tableName) {
		const quotedDb = this.quoteIdentifier(database);
		const rows = await handle.query(
			`SHOW TABLES IN ${quotedDb} WHERE \`Tables_in_${database}\`=?`,
			[tableName],
		);
		return rows.length > 0;
	}

	async getTableColumns(handle, tableName) {
		const rows = await handle.query(
			`SHOW FULL COLUMNS FROM ${this.quoteIdentifier(tableName)}`,
		);
		return rows.map((row) => ({
			name: row.Field,
			type: row.Type,
			nullable: row.Null === 'YES',
			defaultValue: row.Default,
			primaryKey: row.Key === 'PRI',
			unique: row.Key === 'UNI',
			autoIncrement: (row.Extra || '').toLowerCase().includes('auto_increment'),
			collation: row.Collation,
			comment: row.Comment,
			extra: row.Extra,
			// Keep raw data for detailed comparisons
			_raw: row,
		}));
	}

	async getTableIndexes(handle, tableName) {
		const rows = await handle.query(
			`SHOW INDEXES FROM ${this.quoteIdentifier(tableName)}`,
		);

		// Group by Key_name since multi-column indexes have multiple rows
		const indexMap = {};
		for (const row of rows) {
			const name = row.Key_name;
			if (!indexMap[name]) {
				indexMap[name] = {
					name,
					columns: [],
					unique: row.Non_unique === 0,
					type: row.Index_type,
					isPrimary: name === 'PRIMARY',
				};
			}
			// Column_name is null for functional indexes, use Expression instead
			indexMap[name].columns.push({
				name: row.Column_name,
				expression: row.Expression,
				seq: row.Seq_in_index,
			});
		}

		// Sort columns by sequence and return
		return Object.values(indexMap).map((idx) => ({
			...idx,
			columns: idx.columns
				.sort((a, b) => a.seq - b.seq)
				.map((c) => c.name || normalizeMySqlIndexExpression(c.expression)),
		}));
	}

	async getTables(handle, database) {
		const rows = await handle.query(
			`SHOW TABLES IN ${this.quoteIdentifier(database)}`,
		);
		return rows.map((row) => Object.values(row)[0]);
	}

	async checkJsonSupport(handle) {
		// Test for support of JSON syntax
		const randColName = `json_test_${Math.random()
			.toString(36)
			.substring(2, 15)}`;
		try {
			await handle.query(
				`SELECT ((CAST(${randColName}->>"${randColName}" as CHAR(255)) COLLATE utf8mb4_bin))`,
			);
			return false; // If no error, something is wrong
		} catch (err) {
			if (err.message && err.message.includes('Unknown column')) {
				// This error means JSON syntax is supported
				return true;
			}
			// Other errors mean JSON is not supported
			return false;
		}
	}

	async getFunctions(handle, database) {
		const rows = await handle.query(`SHOW FUNCTION STATUS WHERE \`Db\`=?`, [
			database,
		]);
		return rows.map((row) => ({
			name: row.Name,
			database: row.Db,
			type: row.Type,
		}));
	}

	async getTriggers(handle, tableName) {
		const rows = await handle.query(`SHOW TRIGGERS WHERE \`Table\`=?`, [
			tableName,
		]);
		return rows.map((row) => ({
			name: row.Trigger,
			event: row.Event,
			timing: row.Timing,
			statement: row.Statement,
		}));
	}

	// ============================================
	// DDL Generation
	// ============================================

	// eslint-disable-next-line no-unused-vars
	generateCreateTable(tableName, fields, options = {}) {
		const columnDefs = fields.map((field) => this.generateFieldSpec(field));
		const quotedTable = this.quoteIdentifier(tableName);

		return `CREATE TABLE ${quotedTable} (${columnDefs.join(
			', ',
		)}) CHARACTER SET utf8mb4`;
	}

	generateFieldSpec(fieldData, options = {}) {
		const { ignore: ignoreList = [] } = options;
		const ignoreMap = Object.fromEntries(
			(ignoreList || []).map((k) => [k, true]),
		);

		// Normalize null value
		let nullVal = fieldData.null;
		if (nullVal !== undefined) {
			nullVal = `${nullVal}`.toUpperCase();
		}

		// Handle type normalization
		let { type } = fieldData;
		const schemaType = `${type}`.toLowerCase();

		// Normalize some MSSQL/legacy types to MySQL equivalents
		if (['varchar', 'varchar(-1)', 'nvarchar(-1)'].includes(schemaType)) {
			type = 'varchar(255)';
		} else if (schemaType === 'money') {
			type = 'real';
		} else if (schemaType === 'smalldatetime') {
			type = 'datetime';
		} else if (schemaType === 'uniqueidentifier') {
			type = 'varchar(256)';
		} else if (schemaType === 'xml(-1)') {
			type = 'longtext';
		}

		const {
			field,
			key,
			default: defaultVal,
			extra,
			collation,
			_description,
		} = fieldData;

		// Build the field specification
		let spec = `\`${field}\` ${type}`;

		// Add collation
		if (collation) {
			spec += ` COLLATE ${collation}`;
		}

		// Add NOT NULL
		if (nullVal === 'NO' || nullVal === '0') {
			spec += ' NOT NULL';
		}

		// Add PRIMARY KEY (unless ignored)
		if (!ignoreMap.key && key === 'PRI') {
			spec += ' PRIMARY KEY';
		} else if (key === 'UNI') {
			spec += ' UNIQUE';
		}

		// Add AUTO_INCREMENT (even when key is ignored, we still need auto_increment for ALTER)
		if (extra && extra.toLowerCase().includes('auto_increment')) {
			spec += ' AUTO_INCREMENT';
		}

		// Add DEFAULT (skip for longtext - MySQL doesn't support DEFAULT on TEXT/BLOB)
		if (defaultVal !== undefined && !type.match(/^longtext/i)) {
			if (defaultVal === 'CURRENT_TIMESTAMP') {
				// Skip - handled by timestamp type
			} else if (defaultVal === '' && type.match(/^int/i)) {
				spec += ' DEFAULT 0';
			} else if (defaultVal !== 'NULL') {
				spec += ` DEFAULT '${defaultVal}'`;
			}
		}

		// Add COMMENT for documentation
		if (_description) {
			const escapedDescription = _description.replace(/'/g, "''");
			spec += ` COMMENT '${escapedDescription}'`;
		}

		return spec;
	}

	generateCreateIndex(tableName, indexName, columns, options = {}) {
		const { fulltext = false, unique = false } = options;
		const quotedTable = this.quoteIdentifier(tableName);
		const quotedIndex = this.quoteIdentifier(indexName);

		let indexType = 'INDEX';
		if (fulltext) {
			indexType = 'FULLTEXT INDEX';
		} else if (unique) {
			indexType = 'UNIQUE INDEX';
		}

		// Regex to extract column name and any modifiers (DESC, ASC, (255), etc.)
		const colNameExtractRegex = /^([a-zA-Z_][a-zA-Z0-9_]*)([\s(].*)?$/;

		const columnList = columns
			.map((col) => {
				// Handle JSON functional indexes
				if (`${col || ''}`.includes('->>')) {
					return `(CAST(${col} as CHAR(255)) COLLATE utf8mb4_bin)`;
				}

				// Extract column name and any modifiers
				const match = col.match(colNameExtractRegex);
				if (match) {
					const [, colName, modifier] = match;
					// Handle text columns that need length specification
					if (options.textLengths && options.textLengths[colName]) {
						return `${this.quoteIdentifier(colName)}(${
							options.textLengths[colName]
						})`;
					}
					// Return quoted column name with any modifier appended
					return modifier
						? `${this.quoteIdentifier(colName)}${modifier}`
						: this.quoteIdentifier(colName);
				}

				// Fallback: quote the entire column spec
				return this.quoteIdentifier(col);
			})
			.join(', ');

		return `CREATE ${indexType} ${quotedIndex} ON ${quotedTable} (${columnList})`;
	}

	generateDropIndex(tableName, indexName) {
		return `DROP INDEX ${this.quoteIdentifier(
			indexName,
		)} ON ${this.quoteIdentifier(tableName)}`;
	}

	generateAlterAddColumn(tableName, fieldData) {
		const quotedTable = this.quoteIdentifier(tableName);
		return `ALTER TABLE ${quotedTable} ADD ${this.generateFieldSpec(
			fieldData,
		)}`;
	}

	generateAlterModifyColumn(tableName, fieldData) {
		const quotedTable = this.quoteIdentifier(tableName);
		const quotedField = this.quoteIdentifier(fieldData.field);
		// Use CHANGE for MySQL (allows renaming), specify same name to just modify
		return `ALTER TABLE ${quotedTable} CHANGE ${quotedField} ${this.generateFieldSpec(
			fieldData,
			{ ignore: ['key'] },
		)}`;
	}

	generateAlterDropColumn(tableName, columnName) {
		const quotedTable = this.quoteIdentifier(tableName);
		return `ALTER TABLE ${quotedTable} DROP ${this.quoteIdentifier(
			columnName,
		)}`;
	}

	// ============================================
	// Connection Management
	// ============================================

	async createConnection(config) {
		const db = getMariaDb();
		return db.createConnection({
			host: config.host || 'localhost',
			port: config.port || 3306,
			user: config.user || 'root',
			password: config.password,
			database: config.database,
			charset: config.charset || 'utf8mb4',
			connectTimeout: config.connectTimeout || 3000,
			allowPublicKeyRetrieval: true,
			...(config.ssl ? { ssl: config.ssl } : {}),
			// Timezone handling
			...(config.disableTimezone
				? {}
				: { timezone: 'Etc/GMT+0', skipSetTimezone: true }),
		});
	}

	async createPool(config) {
		const db = getMariaDb();
		const pool = await db.createPool({
			host: config.host || 'localhost',
			port: config.port || 3306,
			user: config.user || 'root',
			password: config.password,
			database: config.database,
			charset: config.charset || 'utf8mb4',
			connectionLimit: config.connectionLimit || 10,
			idleTimeout: config.idleTimeout || 600,
			connectTimeout: config.connectTimeout || 3000,
			allowPublicKeyRetrieval: true,
			...(config.ssl ? { ssl: config.ssl } : {}),
			// Timezone handling
			...(config.disableTimezone
				? {}
				: { timezone: 'Etc/GMT+0', skipSetTimezone: true }),
		});

		// Handle PlanetScale ONLY_FULL_GROUP_BY mode
		if (config.disableFullGroupByPerSession) {
			await pool.query(
				`SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))`,
			);
		}

		return pool;
	}

	/**
	 * Wrap a raw mariadb connection with yass-orm helper methods
	 * @param {Object} conn - Raw mariadb connection/pool
	 * @returns {Object} - Wrapped connection with pquery, search, etc.
	 */
	wrapConnection(conn) {
		const dialect = this;

		// Add pquery method for parameterized queries
		conn.pquery = async function pquery(sql, params, opts = {}) {
			const values = dialect.prepareParams(params);

			try {
				if (Array.isArray(values)) {
					return await this.query(sql, values);
				}
				return await this.query({ namedPlaceholders: true, sql }, values);
			} catch (err) {
				if (!opts.silenceErrors) {
					console.error(`Error in query: ${err}\nSQL: ${sql}`);
				}
				throw err;
			}
		};

		// Attach dialect reference
		conn.dialect = dialect;

		return conn;
	}

	// ============================================
	// Feature Flags
	// ============================================

	get supportsFullTextSearch() {
		return true;
	}

	get supportsJsonOperators() {
		return true;
	}

	get supportsStoredFunctions() {
		return true;
	}

	get supportsAlterColumn() {
		return true;
	}

	get supportsNamedPlaceholders() {
		return true;
	}

	get supportsConnectionPooling() {
		return true;
	}

	get supportsTriggers() {
		return true;
	}

	get supportsReadReplicas() {
		return true;
	}
}

module.exports = { MySQLDialect };
