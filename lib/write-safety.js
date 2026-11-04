/**
 * When retryIfConnectionLost may run its callback again (BDL-4470).
 *
 * A connection that dies mid-statement leaves the client unable to know
 * whether the server ran it: a write can have committed with only its reply
 * lost. Running such a callback again would apply the write twice. So the
 * retry decision depends on the error AND on what the attempt sent:
 *
 *   - errors that prove the statement never reached the server are always
 *     safe to retry;
 *   - a connection that died mid-flight is retried only when the attempt sent
 *     no write (only reads), or the caller marked the call idempotent.
 *
 * Every statement sent through a yass handle passes through the wrapper
 * trackStatements() puts on the handle's `query` / `execute` / `batch`. Inside
 * a retryIfConnectionLost attempt it notes each write in the attempt's retry
 * scope (lib/transactions.js), and in every scope enclosing it: re-running an
 * outer callback would re-run a nested one's writes too.
 */
const {
	inRetryScope,
	noteRetryScopeWriteSent,
	noteRetryScopeWriteSettled,
} = require('./transactions');

// The statement never reached the server: the connection was already closed
// (mariadb 45013 "Cannot execute new commands"), or no handle was had at all
// (NULL_HANDLE, thrown by retryIfConnectionLost before the callback runs).
// The connection is dead, so its pool is replaced on retry.
const NEVER_SENT_DEAD_CODES = new Set(['ER_CMD_CONNECTION_CLOSED']);
const NEVER_SENT_DEAD_ERRNOS = new Set([45013]);
const NEVER_SENT_DEAD_MESSAGES = [
	'Cannot execute new commands: connection closed',
	'NULL_HANDLE',
];

// The connection died while a statement may have been on the wire or running
// on the server. Its outcome is unknown.
const DIED_MID_FLIGHT_CODES = new Set([
	'PROTOCOL_CONNECTION_LOST',
	'ER_SOCKET_UNEXPECTED_CLOSE', // mariadb 45009
]);
const DIED_MID_FLIGHT_ERRNOS = new Set([45009]);
const DIED_MID_FLIGHT_MESSAGES = ['socket has unexpectedly been closed'];

// Connection refusal happens before a query is sent. The pool is not dead, so
// it is kept. A local pool-acquire timeout (45028) is deliberately excluded:
// its configured bound must not grow into the reconnect window. ECONNRESET is
// also excluded: the server may already have committed.
const REFUSED_CODES = new Set(['ECONNREFUSED']);

function matches(ex, codes, errnos, messages) {
	try {
		if (!ex) return false;
		const { code, errno, message } = ex;
		if (codes.has(code) || (errnos && errnos.has(errno))) return true;
		return (
			typeof message === 'string' && messages.some((m) => message.includes(m))
		);
	} catch {
		return false;
	}
}

const diedMidFlight = (ex) =>
	matches(
		ex,
		DIED_MID_FLIGHT_CODES,
		DIED_MID_FLIGHT_ERRNOS,
		DIED_MID_FLIGHT_MESSAGES,
	);
const neverSentOnDeadConnection = (ex) =>
	matches(
		ex,
		NEVER_SENT_DEAD_CODES,
		NEVER_SENT_DEAD_ERRNOS,
		NEVER_SENT_DEAD_MESSAGES,
	);
const isRefused = (ex) => matches(ex, REFUSED_CODES, null, []);

/** The connection is dead (mid-flight or not): replace its pool on retry. */
function isConnectionLost(ex) {
	return diedMidFlight(ex) || neverSentOnDeadConnection(ex);
}

/** The failed statement provably never reached the server. */
function provesNeverSent(ex) {
	return neverSentOnDeadConnection(ex) || isRefused(ex);
}

const WRITE_OUTCOME_UNKNOWN = 'ERR_WRITE_OUTCOME_UNKNOWN';

/**
 * Thrown by retryIfConnectionLost instead of running its callback again: the
 * connection was lost after the callback sent a write, so the write may have
 * been applied. `cause` is the driver's error.
 *
 * The message deliberately leaves out the driver's text, so this error is
 * never itself mistaken for a lost connection (and retried by an enclosing
 * retryIfConnectionLost).
 */
class WriteOutcomeUnknownError extends Error {
	constructor(cause) {
		const detail = (cause && (cause.code || cause.errno)) || 'connection lost';
		super(
			`[yass-orm] The database connection was lost after a write was sent, so the write may have been applied. Not retried: running it again could apply it twice. Check the data before retrying (cause: ${detail})`,
			{ cause },
		);
		this.name = 'WriteOutcomeUnknownError';
		this.code = WRITE_OUTCOME_UNKNOWN;
	}
}

const isWriteOutcomeUnknown = (ex) =>
	Boolean(ex && ex.code === WRITE_OUTCOME_UNKNOWN);

// Leading whitespace, comments and opening parentheses, before the verb. A
// MySQL executable comment (`/*! ... */`) is SQL, not a comment: not skipped.
const LEADING_NOISE =
	/^(?:\s+|\/\*(?!!)[\s\S]*?\*\/|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\()*/;
const READ_VERB = /^(?:select|show|describe|desc)\b/i;
const WITH_VERB = /^with\b/i;
// `replace(` is MySQL's string function, not REPLACE INTO.
const DML_WORD = /\b(?:insert|update|delete|merge|replace(?!\s*\())\b/i;
// Anywhere in a read verb's text, any of these makes it a write: a second
// statement, a row lock, `INTO` (a variable, a file, or a new table on
// Postgres), a variable assignment, an executable comment, and the built-in
// functions that change state (locks, sequences, LAST_INSERT_ID(expr)). A
// match inside a string literal also counts: that only costs a retry.
const SIDE_EFFECT = new RegExp(
	[
		';\\s*\\S',
		'\\bfor\\s+(?:update|share|no\\s+key\\s+update|key\\s+share)\\b',
		'\\block\\s+in\\s+share\\s+mode\\b',
		'\\binto\\b',
		':=',
		'\\/\\*!',
		'\\b(?:get_lock|release_lock|release_all_locks|nextval|setval|set_config|pg_notify|pg_(?:try_)?advisory_\\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_switch_wal|lo_\\w+)\\s*\\(',
		'\\blast_insert_id\\s*\\(\\s*[^)\\s]',
	].join('|'),
	'i',
);

/**
 * True when `sql` only reads: SELECT, SHOW, DESCRIBE, or a WITH query with
 * no data-changing statement in it, and none of the SIDE_EFFECT shapes above.
 * Anything else, unknown text included, is treated as a write (fail closed).
 * A SELECT that calls a user-defined function with side effects cannot be
 * told from its text and counts as a read: run such a call in a transaction,
 * or outside retryIfConnectionLost.
 *
 * @param {string} sql
 * @returns {boolean}
 */
function isReadStatement(sql) {
	if (typeof sql !== 'string') return false;
	const text = sql.replace(LEADING_NOISE, '');
	if (READ_VERB.test(text)) return !SIDE_EFFECT.test(text);
	return (
		WITH_VERB.test(text) && !DML_WORD.test(text) && !SIDE_EFFECT.test(text)
	);
}

// The server answered with a constraint error: the statement did not apply.
// (Required lazily: utils.js requires this module.)
const rejectedByServer = (error) =>
	// eslint-disable-next-line global-require
	require('./utils').isConstraintError(error);

// The SQL of a driver call's first argument: a string, mariadb's `{ sql }`,
// or node-postgres's `{ text }`.
function statementText(sqlOrOptions) {
	if (typeof sqlOrOptions === 'string') return sqlOrOptions;
	return sqlOrOptions && (sqlOrOptions.sql || sqlOrOptions.text);
}

const TRACKED = Symbol('yass-orm.trackStatements');
const TRACKED_METHODS = ['query', 'execute', 'batch'];

function trackedMethod(send) {
	function tracked(...args) {
		if (!inRetryScope() || isReadStatement(statementText(args[0]))) {
			return send.apply(this, args);
		}
		const scopes = noteRetryScopeWriteSent();

		// A write that fails with proof it never went out, or that the server
		// rejected (duplicate key, constraint), did not land.
		const settle = (error) =>
			noteRetryScopeWriteSettled(
				scopes,
				!error || !(provesNeverSent(error) || rejectedByServer(error)),
			);
		let result;
		try {
			result = send.apply(this, args);
		} catch (err) {
			settle(err);
			throw err;
		}
		if (!result || typeof result.then !== 'function') {
			settle();
			return result;
		}
		return result.then(
			(value) => {
				settle();
				return value;
			},
			(err) => {
				settle(err);
				throw err;
			},
		);
	}
	tracked[TRACKED] = true;
	return tracked;
}

/**
 * Wraps `conn`'s `query`, `execute` and `batch` (those it has) so the writes
 * they send are noted in the enclosing retry scopes. Wraps each once.
 *
 * @param {Object} conn A connection or pool
 * @returns {Object} `conn`
 */
function trackStatements(conn) {
	if (!conn) return conn;
	TRACKED_METHODS.forEach((name) => {
		const send = conn[name];
		if (typeof send === 'function' && !send[TRACKED]) {
			// eslint-disable-next-line no-param-reassign
			conn[name] = trackedMethod(send);
		}
	});
	return conn;
}

module.exports = {
	isConnectionLost,
	isRefused,
	provesNeverSent,
	isReadStatement,
	trackStatements,
	WriteOutcomeUnknownError,
	WRITE_OUTCOME_UNKNOWN,
	isWriteOutcomeUnknown,
};
