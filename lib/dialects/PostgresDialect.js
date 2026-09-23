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

const { BaseDialect, isFalseLiteral } = require('./BaseDialect.js');
const {
	convertJsonAccessorsToPostgres,
} = require('../sql-transform/postgresJsonPath.js');

const { requireOptional } = require('../optional-dependency.js');

const FEATURE = 'the PostgreSQL dialect';

// pg, and node-sql-parser under the SQL transformer, are optional peer
// dependencies: loaded on first use, so other dialects run without them.
const getPg = () => requireOptional('pg', { feature: FEATURE });
// Memoized: transformSql runs on every query.
let transformSqlForPostgres;
const getPostgresTransformer = () => {
	if (!transformSqlForPostgres) {
		// eslint-disable-next-line global-require
		({
			transformSqlForPostgres,
		} = require('../sql-transform/PostgresSqlTransformer.js'));
	}
	return transformSqlForPostgres;
};

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
 * Convert a schema JSON accessor into the Postgres form.
 *
 * Schema definitions use MySQL's JSONPath spelling (`meta->>'$.valence'`, or with
 * double quotes). Postgres' `->>` takes a KEY NAME, not a path -- so emitting the
 * MySQL form verbatim produced an index on a key literally named `$.valence`,
 * which no row can ever have. Worse, it was silent: the DDL is valid Postgres, so
 * the index built successfully and simply indexed NULL forever.
 *
 * `PostgresSqlTransformer` already strips the `$.` prefix on the QUERY side, so
 * the index expression has to be normalized identically or the planner can never
 * match the two.
 *
 * @param {string} col a schema column spec containing `->>`
 * @returns {string} the Postgres-form accessor, e.g. `meta->>'valence'`
 */
function normalizePostgresJsonAccessor(col) {
	// Delegates to the SAME converter the query transformer uses, so an index
	// expression and a query expression cannot drift. Handles both quote styles
	// and promotes a nested path to the `#>>` operator with a text[] literal.
	return convertJsonAccessorsToPostgres(col);
}

/**
 * Normalize a Postgres functional-index expression back to the schema shorthand
 * used for signature comparison (`col->>"$.path"`).
 *
 * `pg_get_indexdef()` renders the expression its own way -- `((meta ->> 'valence'
 * ::text))` -- which would never equal the schema spec, so the index would be
 * dropped and recreated on every sync. This is the Postgres counterpart to
 * MySQLDialect's `normalizeMySqlIndexExpression`.
 *
 * @param {string} expression the parenthesized expression from pg_get_indexdef()
 * @returns {string} canonical shorthand, or the input unchanged
 */
function normalizePostgresIndexExpression(expression) {
	if (!expression) {
		return expression;
	}
	const normalized = `${expression}`.replace(/\s+/g, ' ');

	// Nested path form: (meta #>> '{a,b}'::text[]) -> meta->>"$.a.b"
	const pathMatch = normalized.match(
		/["(]?\b([a-zA-Z_][a-zA-Z0-9_]*)"?\s*#>>?\s*'\{([^}]*)\}'(?:::\s*text\s*\[\s*\])?/i,
	);
	if (pathMatch) {
		const [, fieldName, rawKeys] = pathMatch;
		const keys = rawKeys
			.split(',')
			.map((k) => k.trim())
			.filter((k) => k.length > 0);
		return `${fieldName}->>"$.${keys.join('.')}"`;
	}

	// Single key form: (meta ->> 'valence'::text) -> meta->>"$.valence"
	const accessorMatch = normalized.match(
		/["(]?\b([a-zA-Z_][a-zA-Z0-9_]*)"?\s*->>\s*'([^']+)'(?:::\s*text)?/i,
	);
	if (accessorMatch) {
		const [, fieldName, rawPath] = accessorMatch;
		const normalizedPath = rawPath.startsWith('$')
			? rawPath
			: `$.${rawPath.replace(/^\.+/, '')}`;
		return `${fieldName}->>"${normalizedPath}"`;
	}
	return expression;
}

/**
 * Extract the column-list text of an index from a `pg_get_indexdef()` string.
 *
 * Walks balanced parentheses from the `(` that follows `USING <method>`, rather
 * than matching `/\((.+)\)$/`. That old heuristic was greedy from the FIRST paren
 * to the LAST one, so a PARTIAL index --
 *
 *   CREATE INDEX i ON t USING btree (status) WHERE ("isDeleted" = false)
 *
 * -- yielded the column list `status) WHERE ("isDeleted" = false`, i.e. garbage
 * columns that could never match the schema, so the index churned on every sync.
 * Balanced walking also handles nested parens inside expression indexes.
 *
 * @param {string} indexDef the full `pg_get_indexdef()` string
 * @returns {string} the text between the column-list parentheses
 */
function extractPostgresIndexColumnList(indexDef) {
	const def = `${indexDef || ''}`;
	const usingMatch = def.match(/\sUSING\s+[a-z0-9_]+\s*/i);
	const searchFrom = usingMatch ? usingMatch.index + usingMatch[0].length : 0;
	const open = def.indexOf('(', searchFrom);
	if (open === -1) {
		return '';
	}
	let depth = 0;
	for (let i = open; i < def.length; i += 1) {
		if (def[i] === '(') {
			depth += 1;
		} else if (def[i] === ')') {
			depth -= 1;
			if (depth === 0) {
				return def.slice(open + 1, i);
			}
		}
	}
	// Unbalanced (should not happen with pg_get_indexdef output)
	return def.slice(open + 1);
}

/**
 * Extract the predicate of a PARTIAL index from a `pg_get_indexdef()` string.
 *
 * The `WHERE` clause is the last thing in the definition, after the column list.
 * Reported so schema-sync can detect a CHANGED predicate; the raw text is
 * returned and normalized by the caller, since Postgres re-renders predicates
 * (adding parens, quoting identifiers, casting literals).
 *
 * @param {string} indexDef the full `pg_get_indexdef()` string
 * @returns {string|undefined} the raw predicate, or undefined if not partial
 */
function parsePostgresIndexPredicate(indexDef) {
	const match = `${indexDef || ''}`.match(/\)\s+WHERE\s+(.+)$/is);
	return match ? match[1].trim() : undefined;
}

/**
 * Extract the text-search configuration from a `to_tsvector()` call in a
 * `pg_get_indexdef()` string, e.g. `'english'::regconfig` -> `english`.
 *
 * Reported so schema-sync can notice a CHANGED config (english -> spanish) and
 * rebuild; without it, switching languages would silently leave the old index in
 * place, since the column list and flags are unchanged.
 *
 * @param {string} indexDef the full `pg_get_indexdef()` string
 * @returns {string|undefined} the config name, or undefined if none is present
 */
function parsePostgresTextSearchConfig(indexDef) {
	const match = `${indexDef || ''}`.match(
		/to_tsvector\(\s*'([^']+)'(?:::\s*regconfig)?\s*,/i,
	);
	return match ? match[1] : undefined;
}

/**
 * Extract the source columns of a Postgres FULLTEXT (GIN over `to_tsvector`)
 * index, in index order.
 *
 * Multi-column full-text indexes concatenate one `to_tsvector()` call per column
 * with `||`, so every call contributes one column. The regconfig argument
 * (`'english'::regconfig`) is skipped when present.
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

// pg type OID for a naive `timestamp without time zone`.
const PG_TIMESTAMP_OID = 1114;

/**
 * Per-connection type parsers. yass-orm writes naive TIMESTAMP values as UTC
 * wall clocks, but the pg driver parses a naive TIMESTAMP as LOCAL time --
 * correct only while the process TZ is UTC (which lib/dbh.js forces,
 * globally). Parse them as UTC here, so reads are right whatever TZ is.
 * Everything else (and 'infinity' / BC values) keeps the driver's parser.
 * Scoped to our connections, not pg's process-wide `types.setTypeParser`, so
 * other pg users in the process are untouched.
 *
 * @param {number} oid pg type OID
 * @param {string} [format] 'text' | 'binary'
 * @returns {Function} value parser
 */
function getPgTypeParser(oid, format) {
	const fallback = getPg().types.getTypeParser(oid, format);
	if (oid !== PG_TIMESTAMP_OID || format === 'binary') {
		return fallback;
	}
	return (text) =>
		/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)
			? new Date(`${text.replace(' ', 'T')}Z`)
			: fallback(text);
}

/**
 * A `t.linked()` column under `uuidLinkedIds` carries the MySQL storage type
 * CHAR(36), but the `t.uuidKey` it points at is a native UUID on Postgres, and
 * Postgres has no `uuid = character` operator -- so every join from a link to its
 * row failed with "operator does not exist". Such a column is a UUID here too.
 *
 * Existing CHAR(36) link columns are left alone: schema-sync treats
 * `character(36)` and `char(36)` as equal, so no ALTER is emitted for them.
 *
 * @param {object} fieldData a schema field
 * @returns {boolean} true for a link column that stores uuids
 */
function isUuidLinkField(fieldData) {
	return Boolean(
		fieldData &&
			fieldData.linkedModel &&
			/^char\(36\)$/i.test(`${fieldData.type}`),
	);
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

	/**
	 * A Date is sent as its ISO instant (with the `Z` and milliseconds), so a
	 * raw pquery param means the same instant whatever the session time zone
	 * (the base's naive `YYYY-MM-DD HH:MM:SS` was read in the session's zone
	 * by a TIMESTAMPTZ column). A naive TIMESTAMP column takes its UTC wall
	 * clock, as yass writes it. Models already deflate dates this way.
	 */
	deflateValue(value) {
		if (value instanceof Date) {
			return Number.isNaN(value.getTime()) ? null : value.toISOString();
		}
		return super.deflateValue(value);
	}

	/** The transaction's start time, as the lab's SQL has always used. */
	nowSql() {
		return 'now()';
	}

	/** Postgres counts in bigint, which pg returns as a string. */
	countSql(expr) {
		return `CAST(COUNT(${expr}) AS INTEGER)`;
	}

	transformSql(sql, params) {
		return getPostgresTransformer()({ sql, params });
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
			// An absolute instant. (Naive TIMESTAMP columns made by older versions
			// are left as they are -- see sync-to-db's comparator -- and read as UTC.)
			datetime: 'TIMESTAMPTZ',
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
			TIMESTAMPTZ: 'TIMESTAMPTZ',
			TIME: 'TIME',
			JSONB: 'JSONB',
			BYTEA: 'BYTEA',
		};
		if (typeMap[yassType]) {
			return typeMap[yassType];
		}
		// Sized varchars (`varchar(36)` string link columns, say) keep their size
		// rather than falling through to TEXT.
		const sized = /^varchar\((\d+)\)$/i.exec(`${yassType}`);
		return sized ? `VARCHAR(${sized[1]})` : 'TEXT';
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

	// A native UUID column rejects prefixed string ids, so `t.stringKey` is a
	// VARCHAR(36) (a 10-char prefix + '_' + 25-char time-ordered id fits exactly).
	// No DEFAULT: the id is always generated app-side, by generateObjectId().
	// eslint-disable-next-line class-methods-use-this
	getStringPrimaryKeyAttrs() {
		return {
			type: 'VARCHAR(36)',
			key: 'PRI',
			null: 0,
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
					// Test the COLUMN LIST for a JSON accessor, not the whole definition:
					// a PARTIAL index's predicate can contain `->>` while the indexed
					// columns are perfectly ordinary (`(status, priority) WHERE (meta ->>
					// 'x') = 'y'`). Matching on `def` reported the whole list as ONE
					// pseudo-column ('status, priority'), which could never equal the
					// schema's two columns -- churn on every sync.
					const columnList = extractPostgresIndexColumnList(def);
					if (columnList.includes('->>') || columnList.includes('#>>')) {
						// Functional JSON index: normalize back to the schema shorthand so
						// the signature can match (otherwise it churns on every sync).
						columns = [normalizePostgresIndexExpression(columnList)];
					} else {
						// Parse columns from the index's column list. Balanced-paren
						// extraction keeps a PARTIAL index's WHERE clause out of the column
						// list -- the old greedy `/\((.+)\)$/` swallowed it.
						columns = columnList
							.split(',')
							.map((c) => c.trim().replace(/^"|"$/g, ''))
							.filter((c) => c.length > 0);
					}
				}

				return {
					name: row.index_name,
					columns,
					unique: row.is_unique,
					type: isFullText ? 'FULLTEXT' : method,
					textSearchConfig: isFullText
						? parsePostgresTextSearchConfig(def)
						: undefined,
					where: parsePostgresIndexPredicate(def),
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
		return isFalseLiteral(value) ? 'false' : 'true';
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

	/**
	 * Resolve the column type for a schema field.
	 *
	 * `t.object` (and its `t.array` alias) carry `{ type: 'longtext', isObject:
	 * true }` -- the MySQL storage type -- which would land in TEXT here, throwing
	 * away JSONB's native operators and indexing for the field type that most wants
	 * them. `t.json` already mapped to JSONB, so the two spellings disagreed about
	 * where the same data belongs.
	 *
	 * @param {object} fieldData a schema field
	 * @returns {string} the Postgres column type
	 */
	resolveColumnType(fieldData) {
		if (fieldData && fieldData.isObject) {
			return 'JSONB';
		}
		if (isUuidLinkField(fieldData)) {
			return 'UUID';
		}
		return this.mapType(fieldData ? fieldData.type : undefined);
	}

	generateFieldSpec(fieldData, options = {}) {
		const { ignore: ignoreList = [] } = options;
		const ignoreMap = Object.fromEntries(
			(ignoreList || []).map((k) => [k, true]),
		);

		const { field, key, default: defaultVal } = fieldData;

		// Map yass-orm type to PG type
		const type = this.resolveColumnType(fieldData);

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
			// The text-search config selects the language's stemming and stopword
			// rules, so it is a real schema decision, not a constant. Set it per index
			// (`{ fulltext: true, cols: [...], textSearchConfig: 'spanish' }`) or
			// globally via `config.textSearchConfig`.
			const tsConfig = this.resolveTextSearchConfig(options.textSearchConfig);
			const tsvectorColumns = columns
				.map(
					(col) => `to_tsvector('${tsConfig}', ${this.quoteIdentifier(col)})`,
				)
				.join(' || ');
			// Postgres' index_elem grammar accepts a bare column name or a bare
			// function call, but ANY other expression must be parenthesized. A
			// multi-column full-text index concatenates tsvectors (`a || b`), which is
			// an operator expression -- unparenthesized, that is a syntax error. An
			// extra pair of parens around a lone function call is always legal, so
			// wrap unconditionally rather than branching on column count.
			//
			// A GIN/full-text index can be PARTIAL too, and the predicate has to be
			// emitted here as well: schema-sync puts `where` in the desired signature
			// for any dialect that `supportsPartialIndexes`, so returning without it
			// would build an unfiltered index whose introspected `where` is undefined
			// -- permanently unequal to the desired signature, i.e. a drop + full
			// FULLTEXT rebuild on every single sync.
			return `CREATE INDEX ${quotedIndex} ON ${quotedTable} USING GIN ((${tsvectorColumns}))${
				where ? ` WHERE ${where}` : ''
			}`;
		}

		const indexType = unique ? 'UNIQUE INDEX' : 'INDEX';

		// Regex to extract column name and any modifiers (DESC, ASC, (255), etc.)
		const colNameExtractRegex = /^([a-zA-Z_][a-zA-Z0-9_]*)([\s(].*)?$/;

		const columnList = columns
			.map((col) => {
				// Handle JSON functional indexes. The schema spells the path MySQL-style
				// (`meta->>'$.valence'`); Postgres' `->>` takes a key name, and the query
				// transformer strips the `$.` prefix -- so normalize identically here or
				// the index can never be matched to a query.
				if (`${col || ''}`.includes('->>')) {
					return `(${normalizePostgresJsonAccessor(col)})`;
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

	generateAlterAddColumns(tableName, fieldDataList) {
		const quotedTable = this.quoteIdentifier(tableName);
		const clauses = (fieldDataList || [])
			.map((fieldData) => `ADD COLUMN ${this.generateFieldSpec(fieldData)}`)
			.join(', ');
		return `ALTER TABLE ${quotedTable} ${clauses}`;
	}

	generateAlterModifyColumn(tableName, fieldData) {
		const quotedTable = this.quoteIdentifier(tableName);
		const quotedField = this.quoteIdentifier(fieldData.field);
		const type = this.alterableType(this.resolveColumnType(fieldData));

		// PostgreSQL requires separate ALTER COLUMN statements for TYPE, NOT NULL, and DEFAULT
		const statements = [];

		// Change type. Postgres will not cast text to jsonb implicitly, so a column
		// created under the older TEXT mapping needs an explicit USING clause. The
		// cast is a no-op when the column is already jsonb, so it is unconditional.
		// A CHAR(36) uuid link column needs the same explicit cast to become UUID
		// (blank strings, which CHAR pads, become NULL rather than a cast error).
		const usingClauses = {
			JSONB: ` USING ${quotedField}::jsonb`,
			UUID: ` USING NULLIF(TRIM(${quotedField}::text), '')::uuid`,
		};
		const usingClause = usingClauses[type] || '';
		statements.push(
			`ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedField} TYPE ${type}${usingClause}`,
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
			types: { getTypeParser: getPgTypeParser },
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
			// `=== undefined`, not `||` -- see MySQLDialect.createPool (BDL-3565).
			idleTimeoutMillis:
				(config.idleTimeout === undefined ? 600 : config.idleTimeout) * 1000,
			connectionTimeoutMillis: config.connectTimeout || 3000,
			types: { getTypeParser: getPgTypeParser },
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

		return this.createConnectionWrapper({
			label: 'PostgreSQL',
			props: { _conn: conn },
			// Answers like mariadb: rows for a read, { affectedRows, insertId }
			// for a write. An INSERT gets `RETURNING *` (unless it has one) so
			// the insertId can come from the new row.
			async run(sql, params) {
				const upperSql = sql.trim().toUpperCase();
				const returning =
					upperSql.startsWith('INSERT') && !upperSql.includes('RETURNING');
				const result = await conn.query(
					returning ? `${sql} RETURNING *` : sql,
					params,
				);

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
			end: async () => conn.end(),
		});
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

	/**
	 * Default text-search configuration for full-text indexes, used when neither
	 * the index spec nor `config.textSearchConfig` names one.
	 *
	 * @returns {string} a Postgres regconfig name
	 */
	// eslint-disable-next-line class-methods-use-this
	get defaultTextSearchConfig() {
		return 'english';
	}

	/**
	 * Validate and resolve a text-search config name.
	 *
	 * The value is interpolated into DDL as a literal, so it is restricted to the
	 * shape of a Postgres identifier -- a config name arriving from a schema file
	 * must not be able to smuggle SQL into a CREATE INDEX.
	 *
	 * @param {string} [requested] config name from the index spec or global config
	 * @returns {string} the resolved config name
	 */
	resolveTextSearchConfig(requested) {
		if (requested === undefined || requested === null || requested === '') {
			return this.defaultTextSearchConfig;
		}
		const value = `${requested}`.trim();
		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
			throw new Error(
				`Invalid Postgres textSearchConfig '${requested}' - must be a plain identifier like 'english' or 'simple'`,
			);
		}
		return value;
	}

	get supportsJsonOperators() {
		return true; // Native JSONB operators ->>, ->, @>, etc.
	}

	// eslint-disable-next-line class-methods-use-this
	get supportsPartialIndexes() {
		return true; // CREATE INDEX ... WHERE <predicate>
	}

	// eslint-disable-next-line class-methods-use-this
	get prefixIndexNamesWithTable() {
		// An index is a relation in pg_class, unique per schema -- NOT scoped to its
		// table as on MySQL. Without prefixing, two tables declaring `idx_status`
		// collide: `relation "idx_status" already exists`.
		return true;
	}

	// eslint-disable-next-line class-methods-use-this
	get maxIdentifierLength() {
		// NAMEDATALEN - 1. Postgres truncates beyond this with only a NOTICE.
		return 63;
	}

	get supportsStoredFunctions() {
		return false; // PL/pgSQL exists but yass-orm uses MySQL-specific SHOW FUNCTION STATUS syntax
	}

	get supportsAlterColumn() {
		return true; // ALTER TABLE ... ALTER COLUMN ... TYPE
	}

	get supportsMultiClauseAlterAdd() {
		return true; // ALTER TABLE t ADD COLUMN a ..., ADD COLUMN b ...
	}

	get supportsNamedPlaceholders() {
		return false; // Uses positional $1, $2, ...
	}

	get supportsConnectionPooling() {
		return true; // pg.Pool
	}

	get supportsTriggers() {
		// Postgres supports triggers as a database capability. The
		// yass-orm-specific features on top of that (UUID id trigger, declared
		// trigger reconciler) are gated by their own flags below.
		return true;
	}

	get supportsUuidIdTrigger() {
		// The MySQL-style `BEFORE INSERT ... SET NEW.id = uuid()` shape does
		// not exist in PG (no inline body, no `uuid()` without the pgcrypto
		// / gen_random_uuid() dance). Skip and rely on JS UUID generation.
		return false;
	}

	get supportsDeclaredTriggers() {
		// Deferred until a schema needs it. A PG implementation must generate
		// a CREATE FUNCTION + CREATE OR REPLACE TRIGGER (PG 14+) and compare
		// drift against pg_proc.prosrc and pg_get_triggerdef(), both of
		// which PG reformats -- so its normalizer has to be built against a
		// live PG server, not guessed.
		return false;
	}

	get supportsReadReplicas() {
		return true;
	}
}

module.exports = { PostgresDialect };
