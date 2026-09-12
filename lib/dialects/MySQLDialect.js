/* eslint-disable no-console, no-param-reassign, global-require, no-restricted-syntax */
/**
 * MySQLDialect - MySQL/MariaDB dialect implementation
 *
 * Provides MySQL-specific behavior extracted from the original yass-orm codebase.
 * Compatible with both MySQL and MariaDB via the mariadb npm package.
 */

const { BaseDialect } = require('./BaseDialect.js');
const { CANONICAL_UUID_COLLATION } = require('../uuid-collation.js');
const {
	transformSqlForMySQL,
} = require('../sql-transform/MySQLSqlTransformer.js');

// MySQL/MariaDB caps COLUMN COMMENT at 1024 chars (ER_TOO_LONG_FIELD_COMMENT,
// errno 1629). A description over that kills the ENTIRE CREATE TABLE, not just
// the one column, and only shows up against a fresh database — a box that
// already has the table never re-issues the CREATE, so this is easy to ship
// and not notice until someone syncs a new environment.
const MAX_MYSQL_COMMENT_LEN = 1020; // really 1024, but less 4 char for ellipsis + safety

// Default upper bound (ms) on how long the first-connect probe inside
// createPool may wait before we give up on it. Chosen in the tens-of-seconds
// range: long enough that a healthy-but-momentarily-saturated pool never
// false-trips, short enough that an unreachable / wedged server rejects instead
// of hanging forever. The mariadb driver's own `acquireTimeout` default is 10s,
// but production has observed that timer NOT firing (connection ESTAB, no query
// in flight, promise never settling until an external 3h watchdog) — so this
// watchdog is deliberately INDEPENDENT of the driver's internal timer.
const DEFAULT_ACQUIRE_TIMEOUT_MS = 45_000;

// mariadb's ER_GET_CONNECTION_TIMEOUT — the errno callers already recognize for
// "retrieve connection from pool timeout". Surface the SAME code from our
// watchdog so consumers (retry/backoff logic, log matchers) treat a wedged
// first-connect identically to a driver-reported acquire timeout.
const ER_GET_CONNECTION_TIMEOUT = 45028;

/**
 * Race a promise against a wall-clock timeout. If `promise` does not settle
 * within `ms`, reject with an errno-45028 error (and run `onTimeout` for
 * cleanup, e.g. closing the just-built pool). The timer is always cleared so a
 * settled promise never keeps the event loop alive. `onTimeout` failures are
 * swallowed — the original timeout error is what the caller must see.
 */
async function withAcquireTimeout(promise, ms, { label, onTimeout } = {}) {
	if (!(ms > 0) || !Number.isFinite(ms)) {
		// A non-positive / non-finite bound means "no watchdog" — but the whole
		// point of this fix is that there is ALWAYS a bound, so fall back to the
		// default rather than reintroducing the infinite hang.
		ms = DEFAULT_ACQUIRE_TIMEOUT_MS;
	}
	let timer;
	const timeout = new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			const err = new Error(
				`${label || 'connection acquire'} timed out after ${ms}ms ` +
					`(yass-orm pool-acquire watchdog; retrieve connection from pool timeout)`,
			);
			err.errno = ER_GET_CONNECTION_TIMEOUT;
			err.sqlState = 'HY000';
			err.code = 'ER_GET_CONNECTION_TIMEOUT';
			reject(err);
		}, ms);
		if (timer && typeof timer.unref === 'function') {
			timer.unref();
		}
	});
	try {
		return await Promise.race([promise, timeout]);
	} catch (err) {
		if (err && err.errno === ER_GET_CONNECTION_TIMEOUT && onTimeout) {
			try {
				await onTimeout();
			} catch {
				// best-effort cleanup; propagate the original timeout error
			}
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

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

/**
 * Canonicalize a MySQL cast type so the schema spelling and the catalog's
 * re-rendered spelling compare equal.
 *
 * MySQL does NOT echo back the type as written: `DECIMAL(10,2)` is reported by
 * the catalog as `decimal(10, 2)` -- lowercased, with a space inserted after the
 * comma. Comparing the two raw would make the desired and introspected
 * signatures permanently unequal, which is precisely the drop-and-recreate churn
 * this module exists to prevent.
 *
 * @param {string} rawType e.g. `char(64)`, `DECIMAL(10, 2)`, `unsigned`
 * @returns {string} canonical form, e.g. `CHAR(64)`, `DECIMAL(10,2)`, `UNSIGNED`
 */
function normalizeMySqlCastType(rawType) {
	return `${rawType || ''}`
		.trim()
		.replace(/\s+/g, ' ')
		.replace(/\s*\(\s*/g, '(')
		.replace(/\s*\)\s*/g, ')')
		.replace(/\s*,\s*/g, ',')
		.toUpperCase();
}

// The canonical shorthand this module uses for a MULTI-VALUED index key part.
// Both sides of the signature comparison are rendered through it -- the schema
// def via `buildMultiValuedIndexExpression`, and the database's own reported
// expression via `normalizeMySqlIndexExpression` -- so idempotency is structural
// rather than a coincidence of two independently-written formatters agreeing.
//
//     CAST(appRolesJson->'$[*]' AS CHAR(64) ARRAY)
//
// The cast type AND its length are part of the index IDENTITY: `CHAR(64)` and
// `CHAR(255)` are different indexes, so both must appear in the signature.
const MULTI_VALUED_CANONICAL_REGEX =
	/^CAST\(([a-zA-Z_][a-zA-Z0-9_]*)->'([^']*)' AS (.+?) ARRAY\)$/i;

/**
 * Render a schema-def multi-valued index key part into the canonical shorthand.
 *
 * @param {object} spec
 * @param {string} spec.col the JSON column being indexed
 * @param {string} spec.path the JSON path, which must select an ARRAY (`$[*]`)
 * @param {string} spec.cast the cast type incl. length, e.g. `char(64)`
 * @returns {string} canonical shorthand
 */
function buildMultiValuedIndexExpression({ col, path, cast }) {
	return `CAST(${col}->'${path}' AS ${normalizeMySqlCastType(cast)} ARRAY)`;
}

/**
 * Parse the canonical multi-valued shorthand back into its parts.
 *
 * @param {string} col a column spec from an index definition
 * @returns {{col: string, path: string, cast: string}|null} null if not one
 */
function parseMultiValuedIndexExpression(col) {
	const match = `${col || ''}`.trim().match(MULTI_VALUED_CANONICAL_REGEX);
	if (!match) {
		return null;
	}
	const [, colName, path, cast] = match;
	return { col: colName, path, cast: normalizeMySqlCastType(cast) };
}

// MySQL's expanded form of a MULTI-VALUED index key part (8.0.17+):
//   cast(json_extract(`col`,_utf8mb4\'$[*]\') as char(64) array)
// Two things separate it from the single-value functional form below:
//   1. `json_unquote` is ABSENT -- a multi-valued index cannot use it.
//   2. There is a trailing ` array` keyword.
// The charset introducer (`_utf8mb4`) reflects the connection charset of the
// session that ran the DDL, so it is matched generically rather than pinned to
// one charset, and the quotes around the path arrive BACKSLASH-ESCAPED.
const MULTI_VALUED_EXPANDED_REGEX =
	/^\(*\s*cast\s*\(\s*json_extract\s*\(\s*`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s*,\s*(?:_[a-zA-Z0-9]+\s*)?\\?'([^']*?)\\?'\s*\)\s+as\s+([a-zA-Z]+(?:\s*\([^)]*\))?)\s+array\s*\)\)*\s*$/i;

function normalizeMySqlIndexExpression(expression) {
	if (!expression) {
		return expression;
	}

	const normalized = `${expression}`.replace(/\s+/g, ' ');

	// MULTI-VALUED indexes must be matched FIRST. The single-value branch below
	// keys on `json_extract(...)` alone, which is broad enough to also match this
	// shape -- and it would normalize it to `col->>"$[*]"`, silently discarding
	// BOTH the ` array` keyword and the cast type. The desired and introspected
	// signatures would then never be equal, so schema-sync would DROP AND
	// RECREATE the index on every single run, each rebuild holding a metadata
	// lock that blocks every write to the table. (Same failure as the FULLTEXT
	// prefix-length bug; see README.)
	const multiValuedMatch = normalized.match(MULTI_VALUED_EXPANDED_REGEX);
	if (multiValuedMatch) {
		const [, fieldName, rawPath, castType] = multiValuedMatch;
		return buildMultiValuedIndexExpression({
			col: fieldName,
			path: rawPath,
			cast: castType,
		});
	}

	// A multi-valued expression we could NOT parse must not fall through to the
	// lossy single-value branch, which would quietly conflate it with an entirely
	// different index. Returning it verbatim still mismatches, but it mismatches
	// VISIBLY -- the sync log names the index it is rebuilding -- instead of
	// looking like a correctly round-tripped single-value index forever.
	if (/\barray\s*\)/i.test(normalized) && /json_extract/i.test(normalized)) {
		return expression;
	}

	// MySQL stores JSON functional index expressions in expanded form:
	// (cast(json_unquote(json_extract(`col`,_utf8mb4'$.path')) as char(255) ...))
	// Convert this back to the schema-friendly shorthand used in definitions:
	// col->>"$.path"
	const jsonExtractMatch = normalized.match(
		/json_extract\s*\(\s*`?([a-zA-Z_][a-zA-Z0-9_]*)`?\s*,\s*([^)]+)\)/i,
	);
	if (jsonExtractMatch) {
		const [, fieldName, rawPathSpec] = jsonExtractMatch;
		const pathSpec = `${rawPathSpec}`
			.replace(/^\s*_utf8mb4/i, '')
			.replace(/^\\?['"]/, '')
			.replace(/\\?['"]\s*$/, '')
			.trim();
		const normalizedPath = `${pathSpec}`.startsWith('$')
			? `${pathSpec}`
			: `$.${`${pathSpec}`.replace(/^\.+/, '')}`;
		return `${fieldName}->>"${normalizedPath}"`;
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

	transformSql(sql, params) {
		// MySQL uses :name syntax natively with the mariadb driver, so there is
		// no placeholder rewriting to do here. The ONE normalization we do apply
		// is portability of string quoting: a caller-authored double-quoted
		// string literal is a string under default sql_mode but an IDENTIFIER
		// under ANSI_QUOTES, so the same SQL succeeds on the primary and 1054s
		// on an ANSI_QUOTES read replica depending purely on routing.
		// transformSqlForMySQL splices the original source rather than
		// reserializing it, so only the literals change -- whitespace, keyword
		// case and comments come back byte-for-byte. Anything that is not a DML
		// statement, or has no double-quoted string at all, is returned untouched.
		return transformSqlForMySQL({ sql, params }).sql;
	}

	// ============================================
	// Idempotent / Upsert SQL (MySQL native syntax)
	// ============================================

	buildInsertIgnoreSql({
		tableSql,
		columnsSql,
		valuesSql,
		firstColumnSql,
		// eslint-disable-next-line no-unused-vars
		conflictColumns,
	}) {
		// Deliberately NOT `INSERT IGNORE`: that downgrades NOT NULL / CHECK /
		// FK / data-truncation errors to warnings, which is far broader than
		// the "no-op on dup key" contract this method advertises.
		// `ON DUPLICATE KEY UPDATE <col>=<col>` only fires on UNIQUE/PK
		// conflicts and is a guaranteed no-op SET, matching the semantics
		// of `ON CONFLICT DO NOTHING` on SQLite/Postgres.
		return `INSERT INTO ${tableSql} (${columnsSql}) VALUES (${valuesSql}) ON DUPLICATE KEY UPDATE ${firstColumnSql}=${firstColumnSql}`;
	}

	buildUpsertSql({ tableSql, columnsSql, valuesSql, updateAssignmentsSql }) {
		// MySQL infers the conflict target from any matched UNIQUE index;
		// any caller-provided `conflictColumns` is ignored here on purpose
		// (the signature accepts it for cross-dialect parity).
		return `INSERT INTO ${tableSql} (${columnsSql}) VALUES (${valuesSql}) ON DUPLICATE KEY UPDATE ${updateAssignmentsSql}`;
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
			bigint: 'bigint',
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
			// Instead, use COLLATE utf8mb4_bin as recommended.
			// Sourced from the shared constant so opt-in link columns
			// (see def-to-schema resolveLinkColumnCollation) match BY CONSTRUCTION.
			type: 'char(36)',
			collation: CANONICAL_UUID_COLLATION,
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
				subPart: row.Sub_part,
				collation: row.Collation,
				seq: row.Seq_in_index,
			});
		}

		// Sort columns by sequence and return
		return Object.values(indexMap).map((idx) => ({
			...idx,
			columns: idx.columns
				.sort((a, b) => a.seq - b.seq)
				.map((c) => {
					if (c.name) {
						const lengthSpec = c.subPart ? `(${c.subPart})` : '';
						const directionSpec =
							`${c.collation || ''}`.toUpperCase() === 'D' ? ' DESC' : '';
						return `${c.name}${lengthSpec}${directionSpec}`;
					}
					return normalizeMySqlIndexExpression(c.expression);
				}),
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

	/**
	 * information_schema-based trigger read used by the declared-trigger
	 * reconciler (lib/sync-triggers.js). Distinct from `getTriggers()` above
	 * (legacy, `SHOW TRIGGERS`, current-DB only) for two reasons:
	 *
	 *  1. `SHOW TRIGGERS` implicitly scopes to whatever `USE <db>` set. That
	 *     is fine for the older callers that always run against the schema
	 *     already selected on the pool, but the reconciler needs to serve the
	 *     `db.table` form the schema-sync accepts everywhere else, so it must
	 *     pin the schema in the WHERE clause.
	 *  2. `SHOW TRIGGERS` does not expose `ACTION_ORDER`, which the
	 *     reconciler needs to detect order drift caused by prior DROP+CREATE
	 *     passes (see planTriggerReconciliation in lib/sync-triggers.js).
	 *
	 * Returns the raw catalog body verbatim; normalization for comparison
	 * happens ONE place (lib/sync-triggers.js normalizeTriggerBody), so the
	 * dialect never has to know about it.
	 */
	async getTableTriggers(handle, database, tableName) {
		const rows = await handle.query(
			`SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT, ACTION_ORDER
			 FROM information_schema.TRIGGERS
			 WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?`,
			[database, tableName],
		);
		return rows.map((row) => ({
			name: row.TRIGGER_NAME,
			timing: row.ACTION_TIMING,
			event: row.EVENT_MANIPULATION,
			body: row.ACTION_STATEMENT,
			order: row.ACTION_ORDER,
		}));
	}

	/**
	 * Emit a MySQL `CREATE TRIGGER` statement. The dialect owns:
	 *   - identifier quoting for name/table/database,
	 *   - up-casing timing/event to the canonical spelling MySQL echoes back
	 *     from information_schema (keeps DDL and round-trip byte-equal), and
	 *   - the ON clause + FOR EACH ROW keyword, so the body the author writes
	 *     is JUST the body -- no ${table} templating footgun.
	 *
	 * The body is passed through verbatim: MySQL preserves case in
	 * ACTION_STATEMENT so a literal `'Foo'` inside the body is semantically
	 * meaningful and must not be normalized here. Callers using DELIMITER can
	 * simply not use it -- yass-orm sends the whole CREATE TRIGGER as ONE
	 * statement over the driver, which handles BEGIN/END blocks fine on a
	 * modern mariadb driver connection. That is the entire reason this method
	 * replaces the old shell-out to the `mysql` CLI.
	 */
	generateCreateTrigger({
		name,
		timing,
		event,
		tableName,
		database,
		body,
		follows,
	}) {
		// Cross-schema note (MySQL error 1435, "Trigger in wrong schema"):
		// the trigger name and the target table MUST live in the same
		// schema. An unqualified `CREATE TRIGGER foo ON otherdb.t` fails
		// because MySQL parses `foo` as `<current_schema>.foo`. So when a
		// database is passed, we qualify BOTH sides with it -- otherwise
		// the DDL only works if the session's current DB happens to match
		// `database`, and that is exactly the kind of hidden dependency
		// this reconciler exists to remove.
		const quotedName = database
			? `${this.quoteIdentifier(database)}.${this.quoteIdentifier(name)}`
			: this.quoteIdentifier(name);
		const quotedTable = database
			? `${this.quoteIdentifier(database)}.${this.quoteIdentifier(tableName)}`
			: this.quoteIdentifier(tableName);
		const t = `${timing || ''}`.toUpperCase();
		const e = `${event || ''}`.toUpperCase();
		const followsClause = follows
			? ` FOLLOWS ${this.quoteIdentifier(follows)}`
			: '';
		return `CREATE TRIGGER ${quotedName} ${t} ${e} ON ${quotedTable} FOR EACH ROW${followsClause}\n${body}`;
	}

	/**
	 * `DROP TRIGGER IF EXISTS` is idempotent by construction, which matters
	 * because the reconciler drops a whole group before recreating it -- a
	 * transient failure between the two must not brick the next sync.
	 */
	generateDropTrigger({ name, database }) {
		const quotedName = database
			? `${this.quoteIdentifier(database)}.${this.quoteIdentifier(name)}`
			: this.quoteIdentifier(name);
		return `DROP TRIGGER IF EXISTS ${quotedName}`;
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
			// Truncate BEFORE escaping: the 1024-char cap applies to the STORED
			// (unescaped) comment, and escaping only grows the string.
			const truncatedDescription =
				_description.length > MAX_MYSQL_COMMENT_LEN
					? `${_description.slice(0, MAX_MYSQL_COMMENT_LEN)}...`
					: _description;
			const escapedDescription = truncatedDescription.replace(/'/g, "''");
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
				// MULTI-VALUED key part (MySQL 8.0.17+). Emitted from the canonical
				// shorthand so the DDL we write and the expression we later read back
				// out of the catalog reduce to the SAME string -- see
				// normalizeMySqlIndexExpression. The extra parentheses are required:
				// a functional key part is wrapped in its own parens inside the
				// index's column list.
				const multiValued = parseMultiValuedIndexExpression(col);
				if (multiValued) {
					return `(CAST(${this.quoteIdentifier(multiValued.col)}->'${
						multiValued.path
					}' AS ${multiValued.cast} ARRAY))`;
				}

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

	generateAlterAddColumns(tableName, fieldDataList) {
		const quotedTable = this.quoteIdentifier(tableName);
		const clauses = (fieldDataList || [])
			.map((fieldData) => `ADD ${this.generateFieldSpec(fieldData)}`)
			.join(', ');
		return `ALTER TABLE ${quotedTable} ${clauses}`;
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
			supportBigNumbers: true,
			bigNumberStrings: true,
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
			// Only forwarded when set: the driver defaults `minimumIdle` to
			// `connectionLimit` (so idleTimeout reaps nothing) and `acquireTimeout`
			// to 10s, and callers who never set these must keep that behavior.
			...(config.minimumIdle === undefined
				? {}
				: { minimumIdle: config.minimumIdle }),
			...(config.acquireTimeout === undefined
				? {}
				: { acquireTimeout: config.acquireTimeout }),
			// `=== undefined`, not `||`: a falsy check silently rewrites 0 to 600,
			// which is the same silent drop this ticket removed one layer up.
			idleTimeout: config.idleTimeout === undefined ? 600 : config.idleTimeout,
			connectTimeout: config.connectTimeout || 3000,
			allowPublicKeyRetrieval: true,
			supportBigNumbers: true,
			bigNumberStrings: true,
			...(config.ssl ? { ssl: config.ssl } : {}),
			// Timezone handling
			...(config.disableTimezone
				? {}
				: { timezone: 'Etc/GMT+0', skipSetTimezone: true }),
		});

		// Handle PlanetScale ONLY_FULL_GROUP_BY mode.
		//
		// This SET leases a connection from the pool, so on a slow/contended
		// server it can fail (e.g. "retrieve connection from pool timeout").
		// If it does, close the pool we just created before propagating —
		// otherwise the pool's connections are orphaned: never returned to the
		// caller, never cached, never closed. Under load + retries this stacks
		// up duplicate pools for the same key and exhausts max_connections.
		if (config.disableFullGroupByPerSession) {
			// This SET leases the pool's FIRST connection, so it doubles as the
			// lazy-pool-create / first-connect probe. It MUST be bounded: if the
			// server accepts TCP but never completes the handshake / never lets
			// the query out (the observed prod wedge), the mariadb driver's own
			// acquireTimeout has been seen NOT to fire, and this await would hang
			// forever — wedging every `withDbh()` caller (schema-sync included)
			// until an external watchdog kills the process. The yass-orm-owned
			// watchdog below rejects with errno 45028 regardless of the driver's
			// internal timer, and closes the pool so it is not orphaned.
			const acquireTimeout =
				config.acquireTimeout === undefined
					? DEFAULT_ACQUIRE_TIMEOUT_MS
					: config.acquireTimeout;
			try {
				await withAcquireTimeout(
					pool.query(
						`SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''))`,
					),
					acquireTimeout,
					{
						label: `createPool first-connect probe (SET sql_mode) for '${
							config.database || ''
						}'`,
					},
				);
			} catch (err) {
				// Single close for BOTH failure shapes: the query rejected, OR the
				// watchdog timed it out. (See MySQLDialect.createPool-cleanup.test.js
				// for the reject path and .createPool-acquire-timeout.test.js for the
				// wedge path — both must close the just-built pool exactly once.)
				try {
					await pool.end();
				} catch {
					// best-effort: the caller still gets the original error below
				}
				throw err;
			}
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

	get defaultFindOrCreateTransactionOptions() {
		return { isolationLevel: 'serializable', maxRetries: 2 };
	}

	async acquireTransactionConnection(handle) {
		const leased =
			typeof handle.getConnection === 'function'
				? await handle.getConnection()
				: handle;
		return {
			connection: this.wrapConnection(leased),
			release: async () => {
				if (leased !== handle && typeof leased.release === 'function') {
					await leased.release();
				}
			},
		};
	}

	async beginTransaction(connection, options) {
		if (options.isolationLevel) {
			await connection.query(
				`SET TRANSACTION ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`,
			);
		}
		if (options.readOnly) {
			await connection.query('START TRANSACTION READ ONLY');
		} else if (typeof connection.beginTransaction === 'function') {
			await connection.beginTransaction();
		} else {
			await connection.query('START TRANSACTION');
		}
	}

	async commitTransaction(connection) {
		if (typeof connection.commit === 'function') {
			await connection.commit();
		} else {
			await connection.query('COMMIT');
		}
	}

	async rollbackTransaction(connection) {
		if (typeof connection.rollback === 'function') {
			await connection.rollback();
		} else {
			await connection.query('ROLLBACK');
		}
	}

	// ============================================
	// Feature Flags
	// ============================================

	// eslint-disable-next-line class-methods-use-this
	get maxIdentifierLength() {
		return 64;
	}

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

	get supportsMultiClauseAlterAdd() {
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

	get supportsUuidIdTrigger() {
		// MySQL has a first-class uuid() function and inline BEFORE INSERT
		// trigger bodies, so the built-in yass-orm id trigger works as-is.
		return true;
	}

	get supportsDeclaredTriggers() {
		// The author-facing `triggers` block is reconciled against
		// information_schema.TRIGGERS with case/whitespace/comment
		// normalization; see lib/sync-triggers.js for the algorithm and
		// test/schemaSync.triggers.test.js for the live idempotency gate.
		return true;
	}

	get supportsReadReplicas() {
		return true;
	}

	/**
	 * MULTI-VALUED (JSON array) indexes, MySQL 8.0.17+.
	 *
	 * CAVEAT: this dialect also serves MariaDB, which has NO multi-valued index
	 * support at any version, and the same is true of MySQL before 8.0.17. There
	 * is no cheap, connection-free way to tell them apart here. That is
	 * deliberate rather than overlooked: on an unsupporting server the CREATE
	 * INDEX fails with a LOUD syntax error that lands in the sync's error list,
	 * which is a far better failure than the silent forever-churn this feature
	 * exists to prevent.
	 */
	get supportsMultiValuedIndexes() {
		return true;
	}
}

module.exports = {
	MySQLDialect,
	normalizeMySqlIndexExpression,
	normalizeMySqlCastType,
	buildMultiValuedIndexExpression,
	parseMultiValuedIndexExpression,
	withAcquireTimeout,
	DEFAULT_ACQUIRE_TIMEOUT_MS,
	ER_GET_CONNECTION_TIMEOUT,
};
