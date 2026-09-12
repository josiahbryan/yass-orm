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
 *
 * `enable`/`disable` mutate GLOBAL server state (`general_log`, `log_output`),
 * which is shared with every other connection on the server -- including a
 * concurrent suite/agent on a shared dev MySQL. `disable` must restore what
 * was ACTUALLY there before `enable` ran, not a hardcoded `'OFF'` -- a bare
 * `'OFF'` would clobber a peer's own already-enabled `general_log`/
 * `log_output` (e.g. a DBA debugging session, or another test run) the moment
 * this suite's `after()` fires.
 */

// Module-level, not per-call: `disable(conn)` is invoked with no arguments
// carrying the prior state (matching the existing call sites), so the value
// captured by `enable()` has to be remembered somewhere between the two calls.
// Safe under mocha's default sequential execution, where enable/disable calls
// are never interleaved across tests.
let priorState = null;

async function enable(conn) {
	try {
		const rows = await conn.pquery(
			'SELECT @@global.general_log AS generalLog, @@global.log_output AS logOutput',
		);
		const row = (rows && rows[0]) || {};
		priorState = { generalLog: row.generalLog, logOutput: row.logOutput };

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
		const state = priorState;
		priorState = null;
		if (state) {
			// Restore GENERAL_LOG before LOG_OUTPUT: leaving general_log ON
			// while log_output is mid-restore is a safe intermediate state;
			// the reverse order is not.
			await conn.pquery(
				`SET GLOBAL general_log=${state.generalLog ? "'ON'" : "'OFF'"}`,
			);
			if (state.logOutput) {
				await conn.pquery(`SET GLOBAL log_output='${state.logOutput}'`);
			}
		} else {
			// No prior state captured -- enable() never ran (or its SELECT
			// failed before it could capture one). Fall back to the old
			// unconditional OFF so disable() stays safe to call regardless.
			await conn.pquery("SET GLOBAL general_log='OFF'");
		}
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
