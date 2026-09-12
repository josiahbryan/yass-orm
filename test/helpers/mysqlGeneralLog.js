/**
 * mysqlGeneralLog -- an INDEPENDENT witness of what the SERVER actually
 * executed, used alongside captureAlterStatements (which reports yass-orm's
 * own view). Two instruments with different failure modes: either alone could
 * agree with a bug, but not both in the same direction.
 *
 * Needs SUPER / SYSTEM_VARIABLES_ADMIN. When that is unavailable this returns
 * `{ available: false, reason }` and the caller must SAY SO rather than
 * silently reporting a clean result -- a skip that cannot say why it skipped
 * is indistinguishable from a test that does not exist.
 */

async function enable(conn) {
	try {
		await conn.pquery("SET GLOBAL log_output='TABLE'");
		await conn.pquery("SET GLOBAL general_log='ON'");
		await conn.pquery('TRUNCATE TABLE mysql.general_log');
		return { available: true };
	} catch (ex) {
		return { available: false, reason: `${(ex && ex.message) || ex}` };
	}
}

async function disable(conn) {
	try {
		await conn.pquery("SET GLOBAL general_log='OFF'");
	} catch (ex) {
		// best-effort restore
	}
}

/**
 * ALTER statements the server logged for one table. Filtered BY TABLE NAME, so
 * a concurrent suite on the same server cannot inflate the count.
 */
async function altersFor(conn, tableName) {
	const rows = await conn.pquery(
		`SELECT CONVERT(argument USING utf8mb4) AS q
		   FROM mysql.general_log
		  WHERE command_type = 'Query'
		    AND CONVERT(argument USING utf8mb4) LIKE 'ALTER TABLE%${tableName}%'`,
	);
	return (rows || []).map((r) => r.q);
}

module.exports = { mysqlGeneralLog: { enable, disable, altersFor } };
