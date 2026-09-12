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
 *
 * NEVER `TRUNCATE mysql.general_log`. On a shared server that table can carry
 * a co-tenant's own captured log with no way back. Instead of clearing the
 * table, `enable()` stamps a `NOW(6)` cutoff BEFORE the caller's sync runs,
 * and `altersFor()` filters on `event_time >= <cutoff>` in addition to the
 * existing table-name LIKE -- a peer's pre-existing rows for the same table
 * name (or any name) simply predate the cutoff and cannot inflate the count.
 * Strictly better than truncating: it protects the peer's data AND survives
 * a hard kill between `enable()` and the `finally` (server-wide logging left
 * ON writes an unbounded table, but never destroys anyone else's rows).
 */

// Module-level, not per-call: `disable(conn)` is invoked with no arguments
// carrying the prior state (matching the existing call sites), so the value
// captured by `enable()` has to be remembered somewhere between the two calls.
// Safe under mocha's default sequential execution, where enable/disable calls
// are never interleaved across tests.
let priorState = null;
// The NOW(6) cutoff stamped by enable(), consumed by altersFor().
let cutoffAt = null;

async function enable(conn) {
	try {
		const rows = await conn.pquery(
			'SELECT @@global.general_log AS generalLog, @@global.log_output AS logOutput',
		);
		const row = (rows && rows[0]) || {};
		priorState = { generalLog: row.generalLog, logOutput: row.logOutput };

		await conn.pquery("SET GLOBAL log_output='TABLE'");
		await conn.pquery("SET GLOBAL general_log='ON'");

		// Stamp the cutoff AFTER logging is actually on, and BEFORE the
		// caller's sync runs (the caller awaits this return before doing
		// anything else) -- so no row the caller's own sync produces can
		// ever fall before the cutoff.
		const nowRows = await conn.pquery('SELECT NOW(6) AS ts');
		cutoffAt = (nowRows && nowRows[0] && nowRows[0].ts) || null;

		return { available: true };
	} catch (ex) {
		return { available: false, reason: `${(ex && ex.message) || ex}` };
	}
}

async function disable(conn) {
	try {
		const state = priorState;
		priorState = null;
		cutoffAt = null;
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
		}
		// else: no prior state captured -- enable() never ran (or its SELECT
		// failed before it could capture one). We do NOT know what the
		// globals were before whatever DID run, so leave them untouched
		// rather than forcing a hardcoded 'OFF' that could clobber a peer's
		// deliberately-enabled general_log.
	} catch (ex) {
		// best-effort restore
	}
}

/**
 * ALTER statements the server logged for one table. Filtered BY TABLE NAME
 * AND by the enable()-time cutoff, so neither a concurrent suite on the same
 * server nor a peer's pre-existing rows for a same-named table can inflate
 * the count.
 */
async function altersFor(conn, tableName) {
	const rows = await conn.pquery(
		`SELECT CONVERT(argument USING utf8mb4) AS q
		   FROM mysql.general_log
		  WHERE command_type = 'Query'
		    AND event_time >= ?
		    AND CONVERT(argument USING utf8mb4) LIKE ?`,
		[cutoffAt, `ALTER TABLE%${tableName}%`],
	);
	return (rows || []).map((r) => r.q);
}

module.exports = { mysqlGeneralLog: { enable, disable, altersFor } };
