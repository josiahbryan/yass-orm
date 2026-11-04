/**
 * Driver error classifiers that depend on nothing else in yass-orm, so any
 * module can use them (utils.js re-exports them).
 */

/**
 * Recognize a UNIQUE/PRIMARY KEY violation across MySQL, MariaDB,
 * Postgres, and SQLite — including errors wrapped by yass-orm's
 * `wrapQueryError`, which preserves `.code`, `.errno`, `.sqlState`,
 * and `.cause` on the wrapped Error.
 *
 * Driver signatures recognized:
 *   - MySQL/MariaDB: `ER_DUP_ENTRY` / errno 1062 / sqlState 23000
 *   - Postgres:      sqlState 23505 (unique_violation); node-postgres puts
 *                    the SQLSTATE on `code`
 *   - SQLite:        `SQLITE_CONSTRAINT_UNIQUE`, `SQLITE_CONSTRAINT_PRIMARYKEY`
 */
function _matchesUniqueSignature(e) {
	if (!e || typeof e !== 'object') return false;
	const { code, errno, sqlState } = e;
	if (code === 'ER_DUP_ENTRY') return true;
	if (errno === 1062) return true;
	if (sqlState === '23000' || sqlState === '23505') return true;
	// Postgres via node-postgres: the SQLSTATE is `code`.
	if (code === '23505') return true;
	if (
		code === 'SQLITE_CONSTRAINT_UNIQUE' ||
		code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
	) {
		return true;
	}
	return false;
}

function isUniqueViolation(err) {
	if (!err || typeof err !== 'object') return false;
	if (_matchesUniqueSignature(err) || _matchesUniqueSignature(err.cause)) {
		return true;
	}
	// Last-resort message scan for drivers that strip codes.
	const msg = err.message || '';
	if (typeof msg === 'string') {
		if (/\bno:\s*1062\b/.test(msg)) return true;
		if (/\bSQLState:\s*230(00|05)\b/.test(msg)) return true;
	}
	return false;
}

/**
 * Recognize any constraint violation — UNIQUE/PK, CHECK, NOT NULL, FK.
 * Broader than `isUniqueViolation`; use when you want to catch
 * "anything the database rejected" rather than specifically dup-key.
 */
function _matchesConstraintSignature(e) {
	if (!e || typeof e !== 'object') return false;
	const { code, sqlState, errno } = e;
	// Postgres class 23: integrity constraint violation
	if (typeof sqlState === 'string' && sqlState.startsWith('23')) return true;
	// Postgres via node-postgres: the SQLSTATE is `code` (five characters).
	if (typeof code === 'string' && /^23[0-9A-Z]{3}$/.test(code)) return true;
	if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
		return true;
	}
	// MySQL: ER_BAD_NULL_ERROR (1048), ER_ROW_IS_REFERENCED_2 (1451),
	// ER_NO_REFERENCED_ROW_2 (1452), ER_CHECK_CONSTRAINT_VIOLATED (3819).
	if (errno === 1048 || errno === 1451 || errno === 1452 || errno === 3819) {
		return true;
	}
	return false;
}

function isConstraintError(err) {
	if (!err || typeof err !== 'object') return false;
	if (isUniqueViolation(err)) return true;
	return (
		_matchesConstraintSignature(err) || _matchesConstraintSignature(err.cause)
	);
}

module.exports = { isUniqueViolation, isConstraintError };
