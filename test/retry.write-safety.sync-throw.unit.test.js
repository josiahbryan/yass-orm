/* global describe, it */
const { expect } = require('chai');
const { retryIfConnectionLost } = require('../lib/utils');
const {
	trackStatements,
	WriteOutcomeUnknownError,
} = require('../lib/write-safety');
const { protocolLost } = require('./helpers/driver-errors');

/**
 * BDL-4470: a driver whose query throws SYNCHRONOUSLY, inside a callback that
 * is not async, must get the same write safety as one that rejects. The
 * attempt's retry scope has to reach retryIfConnectionLost even when the
 * callback throws before it returns, or the write it counted is lost and the
 * callback is re-run: the write lands twice.
 */

const noSleep = async () => {};

/**
 * A synchronous fake driver: `query` returns or throws, never a promise. The
 * first statement matching `dies` lands (when `lands`) and then throws a lost
 * connection, once.
 */
function syncDb({ dies, lands = true }) {
	const db = { sent: [], landed: [] };
	let died = false;
	db.query = (sql) => {
		db.sent.push(sql);
		const dying = !died && dies.test(sql);
		if (dying) died = true;
		if ((!dying || lands) && !/^select/i.test(sql)) db.landed.push(sql);
		if (dying) throw protocolLost();
		return 'ok';
	};
	return trackStatements(db);
}

/** One retryIfConnectionLost call with a SYNCHRONOUS callback. */
async function run(callback, db, options = {}) {
	let attempts = 0;
	try {
		const result = await retryIfConnectionLost(
			(dbh) => {
				attempts += 1;
				return callback(dbh);
			},
			{
				handleFactory: async () => db,
				sleep: noSleep,
				retryWindowMs: 50,
				onReconnectRetryFailed: (ex) => {
					throw ex;
				},
				...options,
			},
		);
		return { attempts, result };
	} catch (error) {
		return { attempts, error };
	}
}

describe('retryIfConnectionLost: a driver that throws synchronously (BDL-4470)', () => {
	it('a write that landed, then threw synchronously, is not replayed: typed error', async () => {
		const db = syncDb({ dies: /^INSERT/ });
		const { attempts, error } = await run(
			(h) => h.query('INSERT INTO t VALUES (1)'),
			db,
		);
		expect(attempts).to.equal(1);
		expect(error).to.be.instanceOf(WriteOutcomeUnknownError);
		expect(error.cause.code).to.equal('PROTOCOL_CONNECTION_LOST');
		expect(db.landed).to.deep.equal(['INSERT INTO t VALUES (1)']);
	});

	it('a read that threw synchronously is still retried', async () => {
		const db = syncDb({ dies: /^SELECT/ });
		const { attempts, result, error } = await run(
			(h) => h.query('SELECT 1'),
			db,
		);
		expect(error).to.equal(undefined);
		expect(attempts).to.equal(2);
		expect(result).to.equal('ok');
	});

	it('the same write marked { idempotent: true } is replayed', async () => {
		const db = syncDb({ dies: /^INSERT/ });
		const { attempts, error } = await run(
			(h) => h.query('INSERT INTO t VALUES (1)'),
			db,
			{ idempotent: true },
		);
		expect(error).to.equal(undefined);
		expect(attempts).to.equal(2);
	});

	it('a callback that throws synchronously before any statement keeps the old retry', async () => {
		let calls = 0;
		const db = syncDb({ dies: /^$/ });
		const { attempts, error } = await run(() => {
			calls += 1;
			if (calls === 1) throw protocolLost();
			return 'ok';
		}, db);
		expect(error).to.equal(undefined);
		expect(attempts).to.equal(2);
	});

	it('the callback still starts synchronously (no tick before the first statement)', async () => {
		const db = syncDb({ dies: /^$/ });
		let ranBeforeTick = false;
		let tick = false;
		const pending = retryIfConnectionLost(
			(h) => {
				ranBeforeTick = !tick;
				return h.query('SELECT 1');
			},
			{ handleFactory: () => db, sleep: noSleep },
		);
		// handleFactory is awaited, so the callback runs on the microtask after it.
		await Promise.resolve();
		await Promise.resolve();
		tick = true;
		await pending;
		expect(ranBeforeTick).to.equal(true);
	});

	describe('nested calls', () => {
		it('a synchronous write that threw in an inner call is not replayed by the outer call', async () => {
			const db = syncDb({ dies: /^UPDATE/ });
			let outer = 0;
			let inner = 0;
			let error;
			try {
				await retryIfConnectionLost(
					async () => {
						outer += 1;
						return retryIfConnectionLost(
							(h) => {
								inner += 1;
								return h.query('UPDATE t SET a = 1');
							},
							{ handleFactory: async () => db, sleep: noSleep },
						);
					},
					{ handleFactory: async () => db, sleep: noSleep },
				);
			} catch (ex) {
				error = ex;
			}
			expect(error).to.be.instanceOf(WriteOutcomeUnknownError);
			expect(outer).to.equal(1);
			expect(inner).to.equal(1);
			expect(db.landed).to.deep.equal(['UPDATE t SET a = 1']);
		});

		it('an outer synchronous callback whose inner call wrote, then threw synchronously itself, is not replayed', async () => {
			const db = syncDb({ dies: /^SELECT 2/ });
			let outer = 0;
			const { error } = await run((h) => {
				outer += 1;
				h.query('INSERT INTO t VALUES (1)');
				return h.query('SELECT 2');
			}, db);
			expect(outer).to.equal(1);
			expect(error).to.be.instanceOf(WriteOutcomeUnknownError);
			expect(db.landed).to.deep.equal(['INSERT INTO t VALUES (1)']);
		});
	});
});
