/* global describe, it */
/* eslint-disable no-param-reassign */
const { expect } = require('chai');
const { runTransaction } = require('../lib/transactions');
const { retryIfConnectionLost } = require('../lib/utils');
const { DatabaseObject } = require('../lib');

/**
 * Bug 16 (modernization plan): a transaction run inside retryIfConnectionLost
 * (`Model.withDbh((dbh) => dbh.transaction(...))`, `findOrCreate()`) was
 * re-run from the start when the connection dropped at any point, including
 * after COMMIT was sent but before its reply came back: a double apply.
 *
 * Now a lost connection is retried only when it happens before the
 * transaction began (leasing the connection, or BEGIN itself). From BEGIN on,
 * the error is surfaced and the callback never runs a second time.
 *
 * No database needed: a fake dialect loses the connection at each point.
 */

const lostConnection = () =>
	new Error(
		'(conn=42, no: 45009, SQLState: 08S01) socket has unexpectedly been closed',
	);

// A fake handle whose transaction loses its connection at `failAt` (once).
function createHandle(failAt, state) {
	const failOnce = (point) => {
		if (failAt === point && !state.failed) {
			state.failed = true;
			throw lostConnection();
		}
	};
	const connection = {
		query: async (sql) => {
			failOnce('body');
			state.queries.push(sql);
			return [];
		},
	};
	const dialect = {
		normalizeTransactionOptions: (options) => options,
		acquireTransactionConnection: async () => {
			failOnce('acquire');
			return {
				connection,
				release: async () => failOnce('release'),
			};
		},
		beginTransaction: async () => failOnce('begin'),
		commitTransaction: async () => {
			// The server commits; only the reply is lost.
			state.commits += 1;
			failOnce('commit');
		},
		rollbackTransaction: async () => {},
		cleanupTransaction: async () => {},
	};
	return {
		dialect,
		transaction(callback, options) {
			return runTransaction(this, callback, options);
		},
	};
}

function createState() {
	return { failed: false, handles: 0, callbacks: 0, commits: 0, queries: [] };
}

function handleFactoryFor(failAt, state) {
	return async () => {
		state.handles += 1;
		return createHandle(failAt, state);
	};
}

const body = (state) => async (tx) => {
	state.callbacks += 1;
	await tx.query('INSERT INTO ledger VALUES (1)');
	return 'done';
};

async function runThroughRetry(failAt) {
	const state = createState();
	let result;
	let error;
	try {
		result = await retryIfConnectionLost(
			(dbh) => dbh.transaction(body(state)),
			{ handleFactory: handleFactoryFor(failAt, state) },
		);
	} catch (err) {
		error = err;
	}
	return { state, result, error };
}

describe('#transactions: a lost connection never re-runs a transaction that began (bug 16)', () => {
	describe('before the transaction began: retried on a fresh connection', () => {
		it('lost while leasing the connection', async () => {
			const { state, result, error } = await runThroughRetry('acquire');
			expect(error).to.equal(undefined);
			expect(result).to.equal('done');
			expect(state.handles).to.equal(2);
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(1);
		});

		it('lost on BEGIN', async () => {
			const { state, result, error } = await runThroughRetry('begin');
			expect(error).to.equal(undefined);
			expect(result).to.equal('done');
			expect(state.handles).to.equal(2);
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(1);
		});
	});

	describe('after the transaction began: surfaced, never re-run', () => {
		it('lost inside the callback', async () => {
			const { state, error } = await runThroughRetry('body');
			expect(error).to.be.an('error');
			expect(error.message).to.include('socket has unexpectedly been closed');
			expect(error.transactionBegan).to.equal(true);
			expect(state.handles).to.equal(1);
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(0);
		});

		it('lost after COMMIT was sent, before its reply (the double apply)', async () => {
			const { state, error } = await runThroughRetry('commit');
			expect(error).to.be.an('error');
			expect(error.message).to.include('socket has unexpectedly been closed');
			expect(error.transactionBegan).to.equal(true);
			expect(state.handles).to.equal(1);
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(1);
		});

		it('lost while releasing the connection after COMMIT', async () => {
			const { state, error } = await runThroughRetry('release');
			expect(error).to.be.an('error');
			expect(error.transactionCommitted).to.equal(true);
			expect(error.transactionBegan).to.equal(true);
			expect(state.handles).to.equal(1);
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(1);
		});
	});

	it('a model transaction through withDbh() is not re-run after COMMIT', async () => {
		const state = createState();
		class Ledger extends DatabaseObject {
			static dbh() {
				return handleFactoryFor('commit', state)();
			}

			static table() {
				return 'ledger';
			}
		}
		let error;
		try {
			await Ledger.withDbh((dbh) => dbh.transaction(body(state)));
		} catch (err) {
			error = err;
		}
		expect(error).to.be.an('error');
		expect(state.handles).to.equal(1);
		expect(state.callbacks).to.equal(1);
		expect(state.commits).to.equal(1);
	});

	describe('a transaction that already committed in the same callback', () => {
		// The callback is re-run as a whole on a retry, so a transaction that
		// committed earlier in it would run again.
		const lostOnce = () => {
			let lost = false;
			return () => {
				if (!lost) {
					lost = true;
					throw lostConnection();
				}
			};
		};

		it('is not re-run when a later statement loses the connection', async () => {
			const state = createState();
			const loseAfter = lostOnce();
			let error;
			try {
				await retryIfConnectionLost(
					async (dbh) => {
						await dbh.transaction(body(state));
						loseAfter();
					},
					{ handleFactory: handleFactoryFor(null, state) },
				);
			} catch (err) {
				error = err;
			}
			expect(error).to.be.an('error');
			expect(error.transactionBegan).to.equal(true);
			expect(state.handles).to.equal(1);
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(1);
		});

		it('is not re-run when it ran under an inner retryIfConnectionLost', async () => {
			const state = createState();
			const loseAfter = lostOnce();
			const handleFactory = handleFactoryFor(null, state);
			let error;
			try {
				await retryIfConnectionLost(
					async () => {
						await retryIfConnectionLost((dbh) => dbh.transaction(body(state)), {
							handleFactory,
						});
						loseAfter();
					},
					{ handleFactory },
				);
			} catch (err) {
				error = err;
			}
			expect(error).to.be.an('error');
			expect(state.callbacks).to.equal(1);
			expect(state.commits).to.equal(1);
		});
	});

	it('a thrown non-Error value is surfaced as is, not retried', async () => {
		const state = createState();
		let calls = 0;
		let error = 'unset';
		try {
			await retryIfConnectionLost(
				async () => {
					calls += 1;
					throw null; // eslint-disable-line no-throw-literal
				},
				{ handleFactory: handleFactoryFor(null, state) },
			);
		} catch (err) {
			error = err;
		}
		expect(error).to.equal(null);
		expect(calls).to.equal(1);
	});

	it('a lost connection outside any transaction is still retried', async () => {
		const state = createState();
		let calls = 0;
		const result = await retryIfConnectionLost(
			async () => {
				calls += 1;
				if (calls === 1) throw lostConnection();
				return 'ok';
			},
			{ handleFactory: handleFactoryFor(null, state) },
		);
		expect(result).to.equal('ok');
		expect(calls).to.equal(2);
	});
});
