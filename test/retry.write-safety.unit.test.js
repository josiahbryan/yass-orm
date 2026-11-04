/* global describe, it */
const { expect } = require('chai');
const { retryIfConnectionLost, isConnectionLost } = require('../lib/utils');
const {
	trackStatements,
	isReadStatement,
	WriteOutcomeUnknownError,
	WRITE_OUTCOME_UNKNOWN,
} = require('../lib/write-safety');

/**
 * BDL-4470: the retry decision depends on the error AND on what the attempt
 * sent. No database: a fake connection, wrapped by the same trackStatements()
 * dbh() applies to every pool, fails each statement as told.
 *
 * - Errors that prove the statement never reached the server (ECONNREFUSED,
 *   NULL_HANDLE, 45013 / ER_CMD_CONNECTION_CLOSED) are retried.
 * - A connection that died mid-statement (PROTOCOL_CONNECTION_LOST, 45009,
 *   "socket has unexpectedly been closed") is retried only when the attempt
 *   sent no write, or the call is marked { idempotent: true }. Otherwise the
 *   caller gets WriteOutcomeUnknownError (code ERR_WRITE_OUTCOME_UNKNOWN), the
 *   driver error as its cause.
 * - Any write that landed in the attempt blocks the replay, whatever the
 *   error: the retry re-runs the whole callback.
 */

const socketClosed = () =>
	Object.assign(
		new Error(
			'(conn=42, no: 45009, SQLState: 08S01) socket has unexpectedly been closed',
		),
		{ errno: 45009, code: 'ER_SOCKET_UNEXPECTED_CLOSE' },
	);
const protocolLost = () =>
	Object.assign(
		new Error('Connection lost: The server closed the connection.'),
		{
			code: 'PROTOCOL_CONNECTION_LOST',
		},
	);
const cmdConnectionClosed = () =>
	Object.assign(
		new Error(
			'(conn=42, no: 45013, SQLState: 08S01) Cannot execute new commands: connection closed',
		),
		{ errno: 45013, code: 'ER_CMD_CONNECTION_CLOSED' },
	);
const connRefused = () =>
	Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:25060'), {
		errno: -111,
		code: 'ECONNREFUSED',
	});

const noSleep = async () => {};

/**
 * A fake pool. `failures` maps a statement prefix to a list of errors, one
 * per call; `commitsBeforeFailing` makes a matching write land first (the
 * reply is what is lost).
 */
function fakeDb({ failures = {}, commitsBeforeFailing = false } = {}) {
	const db = { sent: [], committed: [] };
	db.query = async (sqlOrOptions) => {
		const sql =
			typeof sqlOrOptions === 'string' ? sqlOrOptions : sqlOrOptions.sql;
		db.sent.push(sql);
		const key = Object.keys(failures).find((prefix) => sql.startsWith(prefix));
		const error = key && failures[key].shift();
		if (error && !commitsBeforeFailing) throw error;
		if (!/^select/i.test(sql)) db.committed.push(sql);
		if (error) throw error;
		return [];
	};
	return trackStatements(db);
}

const factoryFor = (db) => {
	const factory = async () => {
		factory.calls += 1;
		return db;
	};
	factory.calls = 0;
	return factory;
};

async function run(callback, db, options = {}) {
	const state = { attempts: 0 };
	let result;
	let error;
	try {
		result = await retryIfConnectionLost(
			async (conn) => {
				state.attempts += 1;
				return callback(conn);
			},
			{ handleFactory: factoryFor(db), sleep: noSleep, ...options },
		);
	} catch (err) {
		error = err;
	}
	return { ...state, result, error };
}

describe('#retryIfConnectionLost: retry by (error, statement) (BDL-4470)', () => {
	describe('the synthetic probe: commit, then lose the reply', () => {
		[
			['45009 socket closed', socketClosed],
			['PROTOCOL_CONNECTION_LOST', protocolLost],
		].forEach(([label, makeError]) => {
			it(`${label} after an INSERT committed: not replayed, typed error`, async () => {
				const db = fakeDb({
					failures: { 'INSERT INTO ledger': [makeError()] },
					commitsBeforeFailing: true,
				});
				const { attempts, error } = await run(
					(conn) => conn.query('INSERT INTO ledger VALUES (1)'),
					db,
				);

				expect({ attempts, writes: db.committed.length }).to.deep.equal({
					attempts: 1,
					writes: 1,
				});
				expect(error).to.be.instanceOf(WriteOutcomeUnknownError);
				expect(error.code).to.equal(WRITE_OUTCOME_UNKNOWN);
				expect(error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
				expect(error.cause.code).to.equal(makeError().code);
				expect(isConnectionLost(error)).to.equal(false);
			});
		});

		it('the same write marked { idempotent: true } is replayed', async () => {
			const db = fakeDb({
				failures: { 'UPDATE ledger': [socketClosed()] },
				commitsBeforeFailing: true,
			});
			const { attempts, error } = await run(
				(conn) => conn.query('UPDATE ledger SET a=1 WHERE id=1'),
				db,
				{ idempotent: true },
			);
			expect(error).to.equal(undefined);
			expect(attempts).to.equal(2);
		});

		it('the window running out on an ambiguous write still throws the typed error, not the failure handler', async () => {
			const handled = [];
			const db = fakeDb({
				failures: { 'INSERT INTO ledger': [socketClosed()] },
				commitsBeforeFailing: true,
			});
			const { error } = await run(
				(conn) => conn.query('INSERT INTO ledger VALUES (1)'),
				db,
				{ retryWindowMs: 0, onReconnectRetryFailed: (ex) => handled.push(ex) },
			);
			expect(error && error.code).to.equal(WRITE_OUTCOME_UNKNOWN);
			expect(handled).to.have.length(0);
		});
	});

	describe('positive arms: never-sent errors are retried', () => {
		[
			['45013 ER_CMD_CONNECTION_CLOSED', cmdConnectionClosed],
			['ECONNREFUSED', connRefused],
		].forEach(([label, makeError]) => {
			it(`${label} on an INSERT: the write never went out, so it is retried`, async () => {
				const db = fakeDb({
					failures: { 'INSERT INTO ledger': [makeError()] },
				});
				const { attempts, error } = await run(
					(conn) => conn.query('INSERT INTO ledger VALUES (1)'),
					db,
				);
				expect(error).to.equal(undefined);
				expect(attempts).to.equal(2);
				expect(db.committed).to.have.length(1);
			});
		});

		it('NULL_HANDLE (the handle factory returned null) is retried', async () => {
			let calls = 0;
			const db = fakeDb();
			const factory = async () => {
				calls += 1;
				return calls === 1 ? null : db;
			};
			const { attempts, error } = await run(
				(conn) => conn.query('INSERT INTO ledger VALUES (1)'),
				db,
				{ handleFactory: factory },
			);
			expect(error).to.equal(undefined);
			expect(attempts).to.equal(1);
			expect(calls).to.equal(2);
		});

		it('45013 still swaps in a fresh pool (the connection is dead)', async () => {
			const options = [];
			const db = fakeDb({ failures: { SELECT: [cmdConnectionClosed()] } });
			const factory = async (opts) => {
				options.push(opts);
				return db;
			};
			await run((conn) => conn.query('SELECT 1'), db, {
				handleFactory: factory,
			});
			expect(options[1]).to.deep.equal({
				ignoreCachedConnections: true,
				closeReplacedPool: true,
			});
		});
	});

	describe('reads', () => {
		it('a SELECT whose connection died mid-flight is retried', async () => {
			const db = fakeDb({
				failures: { SELECT: [socketClosed(), protocolLost()] },
			});
			const { attempts, error } = await run(
				(conn) => conn.query({ sql: 'SELECT * FROM ledger' }),
				db,
			);
			expect(error).to.equal(undefined);
			expect(attempts).to.equal(3);
		});

		it('a callback that sends nothing through a yass handle keeps the old retry', async () => {
			let calls = 0;
			const { attempts, error } = await run(async () => {
				calls += 1;
				if (calls === 1) throw socketClosed();
				return 'ok';
			}, fakeDb());
			expect(error).to.equal(undefined);
			expect(attempts).to.equal(2);
		});
	});

	describe('a write landed earlier in the attempt', () => {
		it('a read then dying mid-flight is not replayed', async () => {
			const db = fakeDb({ failures: { SELECT: [socketClosed()] } });
			const { attempts, error } = await run(async (conn) => {
				await conn.query('INSERT INTO ledger VALUES (1)');
				return conn.query('SELECT 1');
			}, db);
			expect(error && error.code).to.equal(WRITE_OUTCOME_UNKNOWN);
			expect(attempts).to.equal(1);
			expect(db.committed).to.have.length(1);
		});

		it('a read then failing never-sent is not replayed either (the INSERT would run again)', async () => {
			const db = fakeDb({ failures: { SELECT: [cmdConnectionClosed()] } });
			const { attempts, error } = await run(async (conn) => {
				await conn.query('INSERT INTO ledger VALUES (1)');
				return conn.query('SELECT 1');
			}, db);
			expect(error && error.code).to.equal(WRITE_OUTCOME_UNKNOWN);
			expect(attempts).to.equal(1);
		});

		it('a write still in flight when a read dies blocks the replay', async () => {
			let release;
			const db = trackStatements({
				query: (sql) => {
					if (sql.startsWith('INSERT'))
						return new Promise((resolve) => {
							release = resolve;
						});
					return Promise.reject(socketClosed());
				},
			});
			const { attempts, error } = await run(
				(conn) =>
					Promise.all([
						conn.query('INSERT INTO ledger VALUES (1)'),
						conn.query('SELECT 1'),
					]),
				db,
			);
			release();
			expect(error && error.code).to.equal(WRITE_OUTCOME_UNKNOWN);
			expect(attempts).to.equal(1);
		});

		it('a write under a nested retryIfConnectionLost blocks the outer replay', async () => {
			const db = fakeDb({ failures: { SELECT: [socketClosed()] } });
			const { attempts, error } = await run(async (conn) => {
				await retryIfConnectionLost(
					(inner) => inner.query('INSERT INTO ledger VALUES (1)'),
					{ handleFactory: factoryFor(db), sleep: noSleep },
				);
				return conn.query('SELECT 1');
			}, db);
			expect(error && error.code).to.equal(WRITE_OUTCOME_UNKNOWN);
			expect(attempts).to.equal(1);
			expect(db.committed).to.have.length(1);
		});

		it('an inner typed error is passed through by the outer retry, not wrapped again', async () => {
			const db = fakeDb({
				failures: { 'INSERT INTO ledger': [socketClosed()] },
				commitsBeforeFailing: true,
			});
			const { attempts, error } = await run(
				() =>
					retryIfConnectionLost(
						(inner) => inner.query('INSERT INTO ledger VALUES (1)'),
						{ handleFactory: factoryFor(db), sleep: noSleep },
					),
				db,
			);
			expect(attempts).to.equal(1);
			expect(error.cause.code).to.equal('ER_SOCKET_UNEXPECTED_CLOSE');
		});
	});

	describe('isReadStatement', () => {
		it('classifies reads', () => {
			[
				'SELECT 1',
				'  select * from t',
				'(select 1) union (select 2)',
				'/* trace */ SELECT 1',
				'-- note\nselect 1',
				'SHOW TABLES',
				'DESCRIBE t',
				'with x as (select 1) select * from x',
			].forEach((sql) => expect(isReadStatement(sql), sql).to.equal(true));
		});

		it('treats everything else as a write', () => {
			[
				'INSERT INTO t VALUES (1)',
				'update t set a=1',
				'DELETE FROM t',
				'REPLACE INTO t VALUES (1)',
				'with x as (select 1) delete from t where id in (select * from x)',
				'with x as (select 1) insert into t select * from x',
				'EXPLAIN ANALYZE DELETE FROM t',
				'CALL proc()',
				'LOCK TABLES t WRITE',
				'',
				undefined,
				null,
			].forEach((sql) =>
				expect(isReadStatement(sql), String(sql)).to.equal(false),
			);
		});
	});

	describe('trackStatements', () => {
		it('wraps a connection once', () => {
			const db = { query: async () => [] };
			const once = trackStatements(db).query;
			expect(trackStatements(db).query).to.equal(once);
		});

		it('passes results and errors through outside a retry', async () => {
			const boom = new Error('boom');
			const db = trackStatements({
				query: async (sql) => {
					if (sql === 'bad') throw boom;
					return ['row'];
				},
			});
			expect(await db.query('INSERT INTO t VALUES (1)')).to.deep.equal(['row']);
			let caught;
			try {
				await db.query('bad');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.equal(boom);
		});

		it('keeps a synchronous query synchronous', () => {
			const db = trackStatements({ query: () => 'sync' });
			expect(db.query('INSERT INTO t VALUES (1)')).to.equal('sync');
		});
	});
});
