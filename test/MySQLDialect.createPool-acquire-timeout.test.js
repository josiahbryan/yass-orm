/* global describe, it */
const { expect } = require('chai');
const {
	MySQLDialect,
	DEFAULT_ACQUIRE_TIMEOUT_MS,
} = require('../lib/dialects/MySQLDialect');

// P1 (rubber CI deploy-wedge): the first-connect probe inside createPool could
// hang FOREVER. For MySQL/MariaDB, createPool runs `SET sql_mode=...` right
// after building the pool (the ONLY_FULL_GROUP_BY path, which rubber prod +
// schema-sync always take via `disableFullGroupByPerSession: true`). That query
// leases the pool's first connection, so it IS the lazy-pool-create /
// first-connect step. The mariadb driver is supposed to bound that acquire with
// `acquireTimeout` (errno 45028), but in production the driver's own timer did
// NOT fire: a connection reached ESTAB, no query went out, and the await never
// settled — three CI ticks wedged until the external 3h watchdog killed them.
//
// Contract now: the SET probe is bounded by a yass-orm-owned watchdog that is
// INDEPENDENT of the driver's internal timer. If it does not settle within
// `acquireTimeout` (default 45s; overridable per call), createPool REJECTS with
// errno 45028 and CLOSES the pool it just built (never orphan it — see
// MySQLDialect.createPool-cleanup.test.js).
describe('MySQLDialect.createPool bounds the first-connect probe (no infinite hang)', () => {
	it('rejects with errno 45028 (does not hang) when the SET sql_mode probe never settles', async () => {
		// eslint-disable-next-line global-require, import/no-extraneous-dependencies
		const mariadb = require('mariadb');

		let endCalls = 0;
		const fakePool = {
			// Never resolves and never rejects: models the observed prod wedge
			// (connection ESTAB, no query in flight, promise never settles).
			query: () => new Promise(() => {}),
			end: async () => {
				endCalls += 1;
			},
		};

		const original = mariadb.createPool;
		mariadb.createPool = async () => fakePool;

		const start = Date.now();
		try {
			let threw = false;
			let caught;
			try {
				await new MySQLDialect().createPool({
					database: 'testdb',
					// Forces the post-create SET sql_mode first-connect probe.
					disableFullGroupByPerSession: true,
					// Small bound so the test is fast; the point is that a bound
					// applies at all — the driver's own timer demonstrably did not.
					acquireTimeout: 200,
				});
			} catch (err) {
				threw = true;
				caught = err;
			}
			const elapsed = Date.now() - start;

			expect(threw, 'createPool must reject, not hang').to.equal(true);
			expect(caught.errno, 'surfaces the pool-acquire-timeout errno').to.equal(
				45028,
			);
			// Bounded: waited roughly the timeout, nowhere near forever.
			expect(elapsed).to.be.at.least(150);
			expect(elapsed).to.be.below(3000);
			// The pool it built must be closed, not orphaned.
			expect(endCalls, 'pool closed on timeout').to.equal(1);
		} finally {
			mariadb.createPool = original;
		}
	});

	it('exposes a finite, sane default watchdog bound for the unset path', () => {
		// When the caller sets no acquireTimeout, the watchdog must still engage
		// with a bounded default — not Infinity / 0 (== wait forever). We assert
		// the exported default rather than waiting the full window in a test.
		expect(DEFAULT_ACQUIRE_TIMEOUT_MS).to.be.a('number');
		expect(Number.isFinite(DEFAULT_ACQUIRE_TIMEOUT_MS)).to.equal(true);
		expect(DEFAULT_ACQUIRE_TIMEOUT_MS).to.be.at.least(10000); // tens of seconds
		expect(DEFAULT_ACQUIRE_TIMEOUT_MS).to.be.below(600000);
	});
});
