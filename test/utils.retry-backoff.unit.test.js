/* global describe, it, afterEach */
/* eslint-disable no-param-reassign */
const { expect } = require('chai');
const {
	retryIfConnectionLost,
	setConnectRetryWindowMs,
	DEFAULT_CONNECT_RETRY_WINDOW_MS,
} = require('../lib/utils');
const { runTransaction } = require('../lib/transactions');

/**
 * BDL-4386: retryIfConnectionLost used to retry a lost connection exactly ONCE,
 * immediately, then call onReconnectRetryFailed (default: process.exit(1)).
 * A managed DB switchover that is unreachable for a few seconds therefore
 * killed every process with a query in flight.
 *
 * Now a lost connection is retried with exponential backoff for a bounded
 * wall-clock window (default 30s). No real sleeping: a fake clock is injected.
 */

// Driver-shaped errors (mariadb connector), not just message text.
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
const poolAcquireTimeout = () =>
	Object.assign(
		new Error(
			'(conn=-1, no: 45028, SQLState: HY000) retrieve connection from pool timeout after 10001ms',
		),
		{ errno: 45028, code: 'ER_GET_CONNECTION_TIMEOUT' },
	);
const connRefused = () =>
	Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:25060'), {
		errno: -111,
		code: 'ECONNREFUSED',
	});
const connReset = () =>
	Object.assign(new Error('read ECONNRESET'), {
		errno: -104,
		code: 'ECONNRESET',
	});

function fakeClock() {
	const clock = { t: 0, sleeps: [] };
	clock.now = () => clock.t;
	clock.sleep = async (ms) => {
		clock.sleeps.push(ms);
		clock.t += ms;
	};
	return clock;
}

// A handle factory that records the options each call received.
function recordingFactory(handleFor = () => ({})) {
	const calls = [];
	const factory = async (opts = {}) => {
		calls.push(opts);
		return handleFor(calls.length, opts);
	};
	factory.calls = calls;
	return factory;
}

// A callback that throws errors[i] on call i, then returns 'ok'.
function failingThen(errors, clock, costMs = 0) {
	const cb = async () => {
		cb.calls += 1;
		clock.t += costMs;
		if (cb.calls <= errors.length) throw errors[cb.calls - 1];
		return 'ok';
	};
	cb.calls = 0;
	return cb;
}

function handlerSpy() {
	const spy = (ex) => {
		spy.calls.push(ex);
		return 'handled';
	};
	spy.calls = [];
	return spy;
}

describe('#retryIfConnectionLost: bounded backoff (BDL-4386)', () => {
	afterEach(() => {
		if (setConnectRetryWindowMs)
			setConnectRetryWindowMs(DEFAULT_CONNECT_RETRY_WINDOW_MS);
	});

	it('defaults the retry window to 30s', () => {
		expect(DEFAULT_CONNECT_RETRY_WINDOW_MS).to.equal(30000);
	});

	it('(a) lost N times then success: returns the result after N+1 calls, delays increase, fresh pool each retry', async () => {
		const clock = fakeClock();
		const factory = recordingFactory();
		const cb = failingThen(
			[socketClosed(), socketClosed(), protocolLost()],
			clock,
		);
		const onReconnectRetryFailed = handlerSpy();

		const result = await retryIfConnectionLost(cb, {
			handleFactory: factory,
			sleep: clock.sleep,
			now: clock.now,
			onReconnectRetryFailed,
		});

		expect(result).to.equal('ok');
		expect(cb.calls).to.equal(4);
		expect(onReconnectRetryFailed.calls).to.have.length(0);
		expect(clock.sleeps).to.have.length(3);
		for (let i = 1; i < clock.sleeps.length; i += 1) {
			expect(clock.sleeps[i]).to.be.greaterThan(clock.sleeps[i - 1]);
		}
		// First attempt uses the cached pool; each retry replaces the dead one.
		expect(factory.calls[0]).to.deep.equal({});
		factory.calls.slice(1).forEach((opts) =>
			expect(opts).to.deep.equal({
				ignoreCachedConnections: true,
				closeReplacedPool: true,
			}),
		);
	});

	it('(b) lost past the window: failure handler called ONCE, only after the window is exhausted', async () => {
		const clock = fakeClock();
		const errors = Array.from({ length: 1000 }, socketClosed);
		const cb = failingThen(errors, clock, 100);
		const onReconnectRetryFailed = handlerSpy();

		const result = await retryIfConnectionLost(cb, {
			handleFactory: recordingFactory(),
			sleep: clock.sleep,
			now: clock.now,
			onReconnectRetryFailed,
		});

		expect(result).to.equal('handled');
		expect(onReconnectRetryFailed.calls).to.have.length(1);
		expect(onReconnectRetryFailed.calls[0].message).to.include(
			'socket has unexpectedly been closed',
		);
		expect(cb.calls).to.be.greaterThan(2);
		expect(clock.t).to.be.at.least(30000);
		expect(clock.t).to.be.below(30000 + 5000 + 200);
	});

	it('(c) transactionBegan: rethrown, never retried', async () => {
		const clock = fakeClock();
		const ex = Object.assign(socketClosed(), { transactionBegan: true });
		const cb = failingThen([ex], clock);
		const onReconnectRetryFailed = handlerSpy();
		let error;
		try {
			await retryIfConnectionLost(cb, {
				handleFactory: recordingFactory(),
				sleep: clock.sleep,
				now: clock.now,
				onReconnectRetryFailed,
			});
		} catch (err) {
			error = err;
		}
		expect(error).to.equal(ex);
		expect(cb.calls).to.equal(1);
		expect(clock.sleeps).to.have.length(0);
		expect(onReconnectRetryFailed.calls).to.have.length(0);
	});

	it('(c2) a transaction that began on a RETRY attempt is not re-run again', async () => {
		const clock = fakeClock();
		const state = { callbacks: 0, attempt: 0 };
		const makeHandle = () => {
			state.attempt += 1;
			const { attempt } = state;
			return {
				dialect: {
					normalizeTransactionOptions: (o) => o,
					acquireTransactionConnection: async () => {
						if (attempt === 1) throw socketClosed();
						return {
							connection: { query: async () => [] },
							release: async () => {},
						};
					},
					beginTransaction: async () => {},
					commitTransaction: async () => {
						throw socketClosed(); // lost after BEGIN on attempt 2
					},
					rollbackTransaction: async () => {},
					cleanupTransaction: async () => {},
				},
				transaction(callback, options) {
					return runTransaction(this, callback, options);
				},
			};
		};
		let error;
		try {
			await retryIfConnectionLost(
				(dbh) =>
					dbh.transaction(async (tx) => {
						state.callbacks += 1;
						await tx.query('INSERT INTO ledger VALUES (1)');
					}),
				{
					handleFactory: async () => makeHandle(),
					sleep: clock.sleep,
					now: clock.now,
					onReconnectRetryFailed: handlerSpy(),
				},
			);
		} catch (err) {
			error = err;
		}
		expect(error && error.transactionBegan).to.equal(true);
		expect(state.attempt).to.equal(2);
		expect(state.callbacks).to.equal(1);
	});

	it('(d) a non-connection error is thrown on the first call, no retry, no sleep', async () => {
		const clock = fakeClock();
		const ex = Object.assign(new Error("Unknown column 'x'"), {
			errno: 1054,
			code: 'ER_BAD_FIELD_ERROR',
		});
		const cb = failingThen([ex], clock);
		let error;
		try {
			await retryIfConnectionLost(cb, {
				handleFactory: recordingFactory(),
				sleep: clock.sleep,
				now: clock.now,
				onReconnectRetryFailed: handlerSpy(),
			});
		} catch (err) {
			error = err;
		}
		expect(error).to.equal(ex);
		expect(cb.calls).to.equal(1);
		expect(clock.sleeps).to.have.length(0);
	});

	['both', 'code', 'errno'].forEach((shape) => {
		it(`(e) pool-acquire timeout (${shape}) rejects once without reconnect delay`, async () => {
			const clock = fakeClock();
			const factory = recordingFactory();
			const ex = poolAcquireTimeout();
			if (shape === 'code') delete ex.errno;
			if (shape === 'errno') delete ex.code;
			const cb = failingThen([ex], clock, 300);
			const onReconnectRetryFailed = handlerSpy();
			let error;
			try {
				await retryIfConnectionLost(cb, {
					handleFactory: factory,
					sleep: clock.sleep,
					now: clock.now,
					onReconnectRetryFailed,
				});
			} catch (err) {
				error = err;
			}
			expect(error).to.equal(ex);
			expect(cb.calls).to.equal(1);
			expect(factory.calls).to.deep.equal([{}]);
			expect(clock.sleeps).to.have.length(0);
			expect(clock.t).to.equal(300);
			expect(onReconnectRetryFailed.calls).to.have.length(0);
		});
	});

	it('(f) a never-sent error past the window is RETHROWN, not handed to the exit handler', async () => {
		const clock = fakeClock();
		const errors = Array.from({ length: 1000 }, connRefused);
		const cb = failingThen(errors, clock, 10000);
		const onReconnectRetryFailed = handlerSpy();
		let error;
		try {
			await retryIfConnectionLost(cb, {
				handleFactory: recordingFactory(),
				sleep: clock.sleep,
				now: clock.now,
				onReconnectRetryFailed,
			});
		} catch (err) {
			error = err;
		}
		expect(error && error.code).to.equal('ECONNREFUSED');
		expect(onReconnectRetryFailed.calls).to.have.length(0);
		expect(cb.calls).to.be.greaterThan(1);
	});

	it('(g) ECONNREFUSED is retried', async () => {
		const clock = fakeClock();
		const cb = failingThen([connRefused()], clock);
		const result = await retryIfConnectionLost(cb, {
			handleFactory: recordingFactory(),
			sleep: clock.sleep,
			now: clock.now,
			onReconnectRetryFailed: handlerSpy(),
		});
		expect(result).to.equal('ok');
		expect(cb.calls).to.equal(2);
	});

	it('(h) ECONNRESET is NOT retried: an autocommit write may already have committed', async () => {
		const clock = fakeClock();
		const ex = connReset();
		const cb = failingThen([ex], clock);
		let error;
		try {
			await retryIfConnectionLost(cb, {
				handleFactory: recordingFactory(),
				sleep: clock.sleep,
				now: clock.now,
				onReconnectRetryFailed: handlerSpy(),
			});
		} catch (err) {
			error = err;
		}
		expect(error).to.equal(ex);
		expect(cb.calls).to.equal(1);
	});

	it('(i) a null handle on a retry is retried, not thrown immediately', async () => {
		const clock = fakeClock();
		const factory = recordingFactory((n) => (n === 2 ? null : {}));
		const cb = failingThen([socketClosed()], clock);
		const result = await retryIfConnectionLost(cb, {
			handleFactory: factory,
			sleep: clock.sleep,
			now: clock.now,
			onReconnectRetryFailed: handlerSpy(),
		});
		expect(result).to.equal('ok');
		expect(factory.calls).to.have.length(3);
	});

	it('(j) the window is configurable per call and globally', async () => {
		const run = async (opts) => {
			const clock = fakeClock();
			const cb = failingThen(
				Array.from({ length: 1000 }, socketClosed),
				clock,
				100,
			);
			const spy = handlerSpy();
			await retryIfConnectionLost(cb, {
				handleFactory: recordingFactory(),
				sleep: clock.sleep,
				now: clock.now,
				onReconnectRetryFailed: spy,
				...opts,
			});
			expect(spy.calls).to.have.length(1);
			return clock.t;
		};

		const perCall = await run({ retryWindowMs: 3000 });
		expect(perCall).to.be.at.least(3000);
		expect(perCall).to.be.below(9000);

		setConnectRetryWindowMs(2000);
		const global = await run({});
		expect(global).to.be.at.least(2000);
		expect(global).to.be.below(8000);
	});
	it('(k) a non-finite or negative window is refused at config time, never looped on', () => {
		// QA residual 3: NaN made `remaining` NaN, `NaN <= 0` is false, so the
		// loop retried forever with ~1ms sleeps. Refuse it where it is set.
		[NaN, undefined, null, Infinity, -1, '30000'].forEach((bad) => {
			expect(
				() => setConnectRetryWindowMs(bad),
				`setConnectRetryWindowMs(${String(bad)})`,
			).to.throw(TypeError, /retry window/);
		});
		// The previous valid value survives a refused set.
		setConnectRetryWindowMs(1234);
		expect(() => setConnectRetryWindowMs(NaN)).to.throw(TypeError);
	});

	it('(l) a non-finite per-call retryWindowMs rejects before the callback runs', async () => {
		const clock = fakeClock();
		// Bounded so the UNFIXED code terminates (it loops until the callback succeeds).
		const cb = failingThen(Array.from({ length: 200 }, socketClosed), clock);
		const spy = handlerSpy();
		let caught;
		try {
			await retryIfConnectionLost(cb, {
				handleFactory: recordingFactory(),
				retryWindowMs: NaN,
				sleep: clock.sleep,
				now: clock.now,
				onReconnectRetryFailed: spy,
			});
		} catch (ex) {
			caught = ex;
		}
		expect(caught, 'expected a TypeError').to.be.instanceOf(TypeError);
		expect(caught.message).to.match(/retry window/);
		expect(cb.calls).to.equal(0);
		expect(spy.calls).to.have.length(0);
	});
});
