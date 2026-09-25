/**
 * SQL helpers: the patterns raw SQL repeats that MySQL and Postgres spell
 * differently, written once. Each takes `db`, a yass handle (`await dbh()`,
 * a transaction's `tx`, or `Model.withDbh`'s argument) or a dialect, and
 * either returns a SQL fragment to put in your query or runs the statements
 * itself. The per-dialect SQL lives on the dialect classes
 * (lib/dialects/BaseDialect.js and its overrides); this module is the one
 * public place to reach it:
 *
 *   const { sqlHelpers: sql } = require('yass-orm');
 *   // or: require('yass-orm/lib/sql-helpers')
 *
 * Fragments:
 * - `inList(name, values)`: `IN (:name_0, ...)` plus its params;
 * - `now(db)`: the database clock, in UTC;
 * - `addInterval(db, expr, amount, unit)` / `subtractInterval(...)`;
 * - `nullSafeEqual(db, a, b)` / `nullSafeNotEqual(db, a, b)`;
 * - `nullsLast(db, expr, direction)`: an ORDER BY term;
 * - `count(db, expr)`: COUNT that reads back as a JS number;
 * - `forUpdate(db, { skipLocked, noWait })`: the row-lock clause.
 *
 * Runners:
 * - `lockKey(tx, key)`: a lock on a name until the transaction ends (in
 *   place of Postgres's `pg_advisory_xact_lock`);
 * - `ensureLockTable(db)`: makes lockKey's table, before any transaction
 *   (schema sync does it too);
 * - `upsertWhere(db, table, { values, conflictColumns, update, where })`:
 *   insert, or update where a condition holds (`ON CONFLICT ... DO UPDATE
 *   ... WHERE`);
 * - `readBack(db, { write, read, readFirst })`: a write and a read in one
 *   transaction (in place of `RETURNING`, which MySQL lacks).
 */
const crypto = require('crypto');
const { isUniqueViolation } = require('./utils');

// MySQL errnos that share SQLSTATE 23000 with a duplicate key (which
// isUniqueViolation accepts): NOT NULL, foreign keys, CHECK.
const MYSQL_NON_UNIQUE_CONSTRAINT_ERRNOS = [1048, 1451, 1452, 3819];

/**
 * A duplicate key, and not another constraint MySQL reports with the same
 * SQLSTATE: the row upsertWhere() should update exists.
 * @param {*} error
 * @returns {boolean}
 */
const isDuplicateKey = (error) =>
	isUniqueViolation(error) &&
	![error, error && error.cause].some(
		(e) => e && MYSQL_NON_UNIQUE_CONSTRAINT_ERRNOS.includes(e.errno),
	);

const INTERVAL_UNITS = [
	'second',
	'minute',
	'hour',
	'day',
	'week',
	'month',
	'year',
];

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The dialect of a handle, or the dialect itself.
 * @param {Object} db A yass handle, a transaction, or a dialect
 * @returns {import('./dialects/BaseDialect').BaseDialect}
 */
const dialectOf = (db) => {
	const dialect = db && db.dialect ? db.dialect : db;
	if (!dialect || typeof dialect.nowSql !== 'function') {
		throw new TypeError(
			'[yass-orm] sql helpers take a yass handle (or transaction) or a dialect',
		);
	}
	return dialect;
};

/**
 * `IN (:name_0, :name_1, ...)` and the params that go with it, one bound
 * parameter per value. An empty list gives `IN (NULL)`, which matches no row
 * (and `NOT IN (NULL)` none either).
 *
 * @param {string} name Param name prefix (a plain identifier)
 * @param {Array} values
 * @returns {{ sql: string, params: Object }}
 */
const inList = (name, values) => {
	if (!PLAIN_NAME.test(`${name}`)) {
		throw new TypeError(
			`[yass-orm] inList: the param name must be a plain identifier, got '${name}'`,
		);
	}
	const params = {};
	const placeholders = [...values].map((value, index) => {
		params[`${name}_${index}`] = value;
		return `:${name}_${index}`;
	});
	return {
		sql: `IN (${placeholders.length ? placeholders.join(', ') : 'NULL'})`,
		params,
	};
};

/**
 * The database clock, in UTC: `UTC_TIMESTAMP()` on MySQL (NOW() follows the
 * session time zone), `now()` on Postgres (the transaction's start time).
 * @param {Object} db
 * @returns {string}
 */
const now = (db) => dialectOf(db).nowSql();

const interval = (db, expr, amount, unit, subtract) => {
	const canonical = `${unit}`.toLowerCase().replace(/s$/, '');
	if (!INTERVAL_UNITS.includes(canonical)) {
		throw new Error(
			`[yass-orm] interval unit '${unit}' is not one of ${INTERVAL_UNITS.join(
				', ',
			)}`,
		);
	}
	return dialectOf(db).intervalSql(expr, amount, canonical, subtract);
};

/**
 * `expr` plus `amount` `unit`s. `amount` is SQL: a number or a `:param`.
 * @param {Object} db
 * @param {string} expr e.g. now(db), or a quoted column
 * @param {string|number} amount
 * @param {string} unit second, minute, hour, day, week, month or year
 * @returns {string}
 */
const addInterval = (db, expr, amount, unit) =>
	interval(db, expr, amount, unit, false);

/**
 * `expr` minus `amount` `unit`s. See addInterval().
 * @returns {string}
 */
const subtractInterval = (db, expr, amount, unit) =>
	interval(db, expr, amount, unit, true);

/**
 * `a = b` where NULL equals NULL: `<=>` on MySQL, `IS NOT DISTINCT FROM`
 * on Postgres.
 * @returns {string}
 */
const nullSafeEqual = (db, a, b) => dialectOf(db).nullSafeEqualSql(a, b);

/**
 * `a <> b` where NULL differs from any value: `NOT (a <=> b)` on MySQL,
 * `IS DISTINCT FROM` on Postgres.
 * @returns {string}
 */
const nullSafeNotEqual = (db, a, b) =>
	dialectOf(db).nullSafeEqualSql(a, b, true);

/**
 * An ORDER BY term that puts NULLs last (MySQL sorts them first ascending,
 * Postgres first descending).
 * @param {Object} db
 * @param {string} expr
 * @param {string} [direction='ASC']
 * @returns {string}
 */
const nullsLast = (db, expr, direction = 'ASC') => {
	const dir = `${direction}`.toUpperCase();
	if (dir !== 'ASC' && dir !== 'DESC') {
		throw new Error(
			`[yass-orm] nullsLast: direction must be ASC or DESC, got '${direction}'`,
		);
	}
	return dialectOf(db).nullsLastSql(expr, dir);
};

/**
 * COUNT(expr) that reads back as a JS number (Postgres counts in bigint,
 * which pg returns as a string).
 * @param {Object} db
 * @param {string} [expr='*']
 * @returns {string}
 */
const count = (db, expr = '*') => dialectOf(db).countSql(expr);

/**
 * The row-lock clause to end a SELECT with: `FOR UPDATE`, or with
 * `SKIP LOCKED` / `NOWAIT` (MySQL 8 and Postgres). Empty on SQLite, which
 * has no row locks (one writer at a time).
 * @param {Object} db
 * @param {Object} [opts]
 * @param {boolean} [opts.skipLocked]
 * @param {boolean} [opts.noWait]
 * @returns {string}
 */
const forUpdate = (db, { skipLocked = false, noWait = false } = {}) => {
	if (skipLocked && noWait) {
		throw new Error('[yass-orm] forUpdate: skipLocked or noWait, not both');
	}
	return dialectOf(db).forUpdateSql({ skipLocked, noWait });
};

const isTransaction = (db) => Boolean(db && db._transactionContext);

// The handle a transaction was opened on, for statements that must commit
// on their own (DDL, which commits a MySQL transaction implicitly).
const rootHandle = (tx) => {
	let handle = tx;
	while (handle && isTransaction(handle)) {
		handle = Object.getPrototypeOf(handle);
	}
	return handle;
};

const LOCK_TABLE = 'yass_locks';
const LOCK_NAME_LENGTH = 191;
// Per root handle: the lock table exists (a promise, shared by concurrent
// callers; dropped on failure so the next call tries again).
const lockTableReady = new WeakMap();
// Per root handle: key names whose row this process has made sure of. Rows
// are never deleted, so the INSERT (a second pool connection, which on MySQL
// waits behind the transaction holding the key) runs once per key.
const lockNamesKnown = new WeakMap();

const lockTableExists = async (root, dialect) => {
	const rows = await root.pquery(dialect.tableExistsHereSql(), {
		name: LOCK_TABLE,
	});
	return Boolean(rows && rows.length);
};

// Looks first, and creates only when missing: CREATE TABLE IF NOT EXISTS on
// an existing table still waits (on MySQL) for the transactions using it.
const createLockTable = async (root, dialect) => {
	if (await lockTableExists(root, dialect)) {
		return;
	}
	try {
		await root.pquery(
			dialect.createLockTableSql(dialect.quoteIdentifier(LOCK_TABLE)),
		);
	} catch (error) {
		// Processes starting at once on a fresh database: on Postgres, the
		// loser's CREATE TABLE IF NOT EXISTS can fail on the catalog's unique
		// index while the winner's is committing. The table is there all the same.
		if (await lockTableExists(root, dialect)) {
			return;
		}
		throw error;
	}
};

/**
 * Makes sure `yass_locks`, the table lockKey() locks rows of, exists, from
 * outside any transaction. Call it at startup, before the first transaction
 * that may lock, when you don't run schema sync (syncSchemaToDb() calls it).
 * Once per handle and process; a catalog read when the table exists (no DDL),
 * and safe with several processes starting at once. Does nothing on SQLite.
 *
 * Why before: on MySQL a table created after a transaction's first read is
 * refused to it ("Table definition has changed, please retry transaction"),
 * so lockKey() can't make the table mid-transaction for a transaction that
 * has read something.
 *
 * @param {Object} db A yass handle (a transaction's `tx` works: the table is
 *   made on the handle it was opened on, never inside the transaction)
 * @returns {Promise<void>}
 */
const ensureLockTable = async (db) => {
	const dialect = dialectOf(db);
	if (!dialect.supportsRowLocks) {
		return;
	}
	const root = rootHandle(db);
	if (!lockTableReady.has(root)) {
		lockTableReady.set(
			root,
			createLockTable(root, dialect).catch((error) => {
				lockTableReady.delete(root);
				throw error;
			}),
		);
	}
	await lockTableReady.get(root);
};

/**
 * Locks `key` until the transaction `tx` ends (commit or rollback): another
 * transaction that locks the same key waits. The portable replacement for
 * Postgres's `pg_advisory_xact_lock` (MySQL's GET_LOCK is held by the session,
 * not the transaction).
 *
 * It locks a row of a small table, `yass_locks` (one row per key), with
 * `SELECT ... FOR UPDATE`. Schema sync creates the table; a service that
 * doesn't sync calls ensureLockTable(db) at startup (see there for why it
 * must exist before the transaction). The key's row is inserted outside
 * the transaction (once per key and process), so two transactions taking a
 * new key don't deadlock. Rows are never deleted: use keys from a bounded or
 * slowly growing set (one per user is fine). Keys longer than 191 characters
 * are hashed. On SQLite, which has one writer at a time, it does nothing.
 *
 * @param {Object} tx A transaction handle
 * @param {string} key
 * @returns {Promise<void>}
 */
const lockKey = async (tx, key) => {
	if (!isTransaction(tx)) {
		throw new Error(
			'[yass-orm] lockKey must run inside a transaction: it holds the lock until the transaction ends',
		);
	}
	const dialect = dialectOf(tx);
	if (!dialect.supportsRowLocks) {
		return;
	}
	const root = rootHandle(tx);
	const tableSql = dialect.quoteIdentifier(LOCK_TABLE);
	// Schema sync or ensureLockTable() made it before any transaction; if
	// neither ran, it's made here, on the root handle (never inside `tx`). On
	// MySQL a transaction that has read something is then refused the new
	// table (ER_TABLE_DEF_CHANGED), a retryable error: `maxRetries` recovers.
	await ensureLockTable(root);
	if (!lockNamesKnown.has(root)) {
		lockNamesKnown.set(root, new Set());
	}
	const known = lockNamesKnown.get(root);

	const name =
		`${key}`.length > LOCK_NAME_LENGTH
			? `sha256:${crypto.createHash('sha256').update(`${key}`).digest('hex')}`
			: `${key}`;
	const nameSql = dialect.quoteIdentifier('name');
	const ensureRow = async () => {
		await root.pquery(
			dialect.buildInsertIgnoreSql({
				tableSql,
				columnsSql: nameSql,
				valuesSql: ':name',
				firstColumnSql: nameSql,
				conflictColumns: ['name'],
			}),
			{ name },
		);
		known.add(name);
	};
	const lockRow = () =>
		tx.pquery(
			`SELECT ${nameSql} FROM ${tableSql} WHERE ${nameSql} = :name ${dialect.forUpdateSql()}`,
			{ name },
		);

	if (!known.has(name)) {
		await ensureRow();
	}
	let rows = await lockRow();
	if (!rows || !rows.length) {
		// The row went away (the table was emptied): make it again.
		known.delete(name);
		await ensureRow();
		rows = await lockRow();
	}
	if (!rows || !rows.length) {
		// Postgres REPEATABLE READ / SERIALIZABLE: a row committed after the
		// transaction's snapshot is invisible to it, so nothing was locked.
		throw new Error(
			`[yass-orm] lockKey could not lock '${name}': its row is not visible to the transaction (on Postgres, call lockKey before the first query of a REPEATABLE READ or SERIALIZABLE transaction)`,
		);
	}
};

/**
 * Inserts `values` as a new row, or, when a row with the same
 * `conflictColumns` exists, updates it only where `where` holds: Postgres's
 * `INSERT ... ON CONFLICT (...) DO UPDATE SET ... WHERE ...`, on both.
 *
 * Two statements (an INSERT, then on a unique violation a conditional
 * UPDATE), so the condition reads the row as it is, on every dialect. A
 * violation of another unique key than `conflictColumns` updates nothing
 * (`{ inserted: false, updated: false }`). Pass a transaction to make the
 * pair atomic against a concurrent delete.
 *
 * @param {Object} db
 * @param {string} table Table name (unquoted)
 * @param {Object} args
 * @param {Object} args.values Column values to insert (bound as `:column`)
 * @param {string[]} args.conflictColumns The unique key to match an existing row on
 * @param {string[]|Object} args.update Columns to set from `values`, or `{ column: 'SQL' }` (RAW SQL, may use the `:column` and `params` names)
 * @param {string} [args.where] SQL condition on the existing row
 * @param {Object} [args.params] More params for `update` and `where` (not named like a column in `values`)
 * @returns {Promise<{ inserted: boolean, updated: boolean }>} `updated`: the condition held (the row may be unchanged)
 */
const upsertWhere = async (
	db,
	table,
	{ values, conflictColumns, update, where, params = {} } = {},
) => {
	const dialect = dialectOf(db);
	if (!conflictColumns || !conflictColumns.length) {
		throw new Error(
			'[yass-orm] upsertWhere needs conflictColumns (the unique key to match an existing row on)',
		);
	}
	const shadowed = Object.keys(params).find((name) => name in values);
	if (shadowed) {
		throw new Error(
			`[yass-orm] upsertWhere: params.${shadowed} would shadow the value of column '${shadowed}'`,
		);
	}
	const allParams = { ...values, ...params };

	// A plain INSERT, in its own transaction (a savepoint inside one), and a
	// unique violation means the row exists. Not an insert that skips a
	// conflict: MySQL reports a skipped duplicate like an insert.
	const { tableSql, columnsSql, valuesSql } = db._buildInsertParts(
		table,
		values,
	);
	const inserted = await db
		.transaction(async (tx) => {
			await tx.pquery(
				`INSERT INTO ${tableSql} (${columnsSql}) VALUES (${valuesSql})`,
				values,
				{ silenceErrors: true },
			);
			return true;
		})
		.catch((error) => {
			if (isDuplicateKey(error)) return false;
			throw error;
		});
	if (inserted) {
		return { inserted: true, updated: false };
	}

	const assignments = Array.isArray(update)
		? update.map((column) => [column, `:${column}`])
		: Object.entries(update || {});
	if (!assignments.length) {
		return { inserted: false, updated: false };
	}
	const q = (name) => dialect.quoteIdentifier(name);
	const setSql = assignments
		.map(([column, expr]) => `${q(column)} = ${expr}`)
		.join(', ');
	const keySql = conflictColumns
		.map((column) => `${q(column)} = :${column}`)
		.join(' AND ');
	const result = await db.pquery(
		`UPDATE ${tableSql} SET ${setSql} WHERE ${keySql}${
			where ? ` AND (${where})` : ''
		}`,
		allParams,
	);
	return { inserted: false, updated: Boolean(result && result.affectedRows) };
};

/**
 * Runs a write and a read in one transaction (joining `db` if it is one), in
 * place of `RETURNING`: `write` then `read` (an UPDATE, then a SELECT of the
 * rows it changed), or with `readFirst`, `read` with a row lock and then
 * `write` (a SELECT, then the DELETE of those rows).
 *
 * @param {Object} db
 * @param {Object} args
 * @param {Array} args.write `[sql, params]`
 * @param {Array} args.read `[sql, params]`, a SELECT; with readFirst, without its own lock clause
 * @param {boolean} [args.readFirst=false]
 * @returns {Promise<{ rows: Object[], affectedRows: number }>}
 */
const readBack = (db, { write, read, readFirst = false }) => {
	const dialect = dialectOf(db);
	const [writeSql, writeParams] = write;
	const [readSql, readParams] = read;
	const lock = readFirst ? dialect.forUpdateSql() : '';
	return db.transaction(async (tx) => {
		let rows;
		if (readFirst) {
			rows = await tx.pquery(`${readSql} ${lock}`.trim(), readParams);
		}
		const result = await tx.pquery(writeSql, writeParams);
		if (!readFirst) {
			rows = await tx.pquery(readSql, readParams);
		}
		return { rows, affectedRows: (result && result.affectedRows) || 0 };
	});
};

module.exports = {
	inList,
	now,
	addInterval,
	subtractInterval,
	nullSafeEqual,
	nullSafeNotEqual,
	nullsLast,
	count,
	forUpdate,
	ensureLockTable,
	lockKey,
	upsertWhere,
	readBack,
};
