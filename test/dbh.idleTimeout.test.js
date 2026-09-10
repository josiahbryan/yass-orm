/* global describe, it */
const { expect } = require('chai');
const { dbh } = require('../lib/dbh');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

// BDL-3565: `lib/dbh.js` used to hardcode `idleTimeout: 600` into BOTH pool
// config objects (the write pool and every readonlyNode), so a caller's value
// was silently discarded on the way to the driver. The default now lives in the
// dialect and `dbh.js` forwards the option only when it is set.
describe('dbh idleTimeout forwarding (BDL-3565)', () => {
	// Captures every options object handed to mariadb.createPool. NOTHING
	// connects: the stub replaces createPool before dbh() can ever call it.
	async function capturePools(options) {
		// eslint-disable-next-line global-require, import/no-extraneous-dependencies
		const mariadb = require('mariadb');
		const original = mariadb.createPool;
		const seen = [];
		mariadb.createPool = async (opts) => {
			seen.push(opts);
			return {
				query: async () => [],
				end: async () => {},
				on: () => {},
				escape: (s) => s,
				escapeId: (s) => s,
			};
		};
		try {
			await dbh({
				host: '127.0.0.1',
				db: 'bdl3565_probe',
				user: 'probe',
				pass: 'probe',
				port: 3306,
				// Bypasses the module-level connection cache (lib/dbh.js:440), so
				// these tests are deterministic and leave no cached pool behind.
				ignoreCachedConnections: true,
				disableFullGroupByPerSession: false,
				...options,
			});
		} finally {
			mariadb.createPool = original;
		}
		return seen;
	}

	// Same idea, one layer lower: drives the dialect directly so the DEFAULT can
	// be asserted as a number.
	async function captureDialectPool(config) {
		// eslint-disable-next-line global-require, import/no-extraneous-dependencies
		const mariadb = require('mariadb');
		const original = mariadb.createPool;
		let seen;
		mariadb.createPool = async (opts) => {
			seen = opts;
			return { query: async () => [], end: async () => {} };
		};
		try {
			await new MySQLDialect().createPool(config);
		} finally {
			mariadb.createPool = original;
		}
		return seen;
	}

	// Captures the config object `dbh.js` hands to the DIALECT -- one layer
	// ABOVE mariadb. This is where AC2(a)'s "the key must be absent" actually
	// lives: MySQLDialect.createPool ALWAYS puts `idleTimeout` on the object it
	// hands to mariadb (it owns the 600s default), so asserting absence at the
	// mariadb layer could never pass no matter what dbh.js did. Asserting it
	// here is AC2(a)'s stated intent verbatim -- "forwarding a literal
	// `undefined` from dbh.js must fail (a)" -- and it covers BOTH config
	// objects, because dbh.js calls dialect.createPool once for the write pool
	// and once per readonlyNodes entry.
	async function captureDialectConfigs(options) {
		const original = MySQLDialect.prototype.createPool;
		const seen = [];
		MySQLDialect.prototype.createPool = async function stubCreatePool(config) {
			seen.push(config);
			return {
				query: async () => [],
				end: async () => {},
				on: () => {},
				escape: (s) => s,
				escapeId: (s) => s,
			};
		};
		try {
			await dbh({
				host: '127.0.0.1',
				db: 'bdl3565_probe',
				user: 'probe',
				pass: 'probe',
				port: 3306,
				ignoreCachedConnections: true,
				disableFullGroupByPerSession: false,
				...options,
			});
		} finally {
			MySQLDialect.prototype.createPool = original;
		}
		return seen;
	}

	const RO_NODES = [
		{ host: '127.0.0.2', user: 'probe', password: 'probe', port: 3306 },
	];

	// AC1
	it('forwards a configured idleTimeout to BOTH the write pool and the RO pool', async () => {
		const pools = await capturePools({
			idleTimeout: 999,
			minimumIdle: 3, // POSITIVE CONTROL: a knob that already works today
			readonlyNodes: RO_NODES,
		});

		expect(pools).to.have.lengthOf(2);
		// Assert the control FIRST. If minimumIdle did not arrive, the harness is
		// broken and the idleTimeout assertion below proves nothing either way.
		expect(pools.map((p) => p.minimumIdle)).to.deep.equal([3, 3]);
		expect(pools.map((p) => p.idleTimeout)).to.deep.equal([999, 999]);
	});

	// AC2 (a) -- dbh.js must forward NOTHING when the option is unset: not a
	// literal, and not an explicit `undefined`. Asserted on the config dbh.js
	// hands the dialect, per the controller ruling; see captureDialectConfigs.
	it('forwards no idleTimeout key at all to the dialect when unset', async () => {
		const configs = await captureDialectConfigs({
			minimumIdle: 3,
			readonlyNodes: RO_NODES,
		});

		expect(configs).to.have.lengthOf(2);
		// POSITIVE CONTROL: a knob that already worked before this ticket. It must
		// arrive on BOTH configs -- if it does not, the capture is broken and the
		// absence assertion below would pass for the wrong reason.
		expect(configs.map((c) => c.minimumIdle)).to.deep.equal([3, 3]);
		configs.forEach((c) => {
			expect(c).to.not.have.property('idleTimeout');
		});
	});

	// AC2 (a)+(b) joined: with nothing set, the value that actually reaches the
	// driver through the WHOLE dbh -> dialect chain is exactly 600. (a) alone
	// would still pass if the default were dropped; this catches that.
	it('still delivers exactly 600 through the full dbh chain when unset', async () => {
		const pools = await capturePools({
			minimumIdle: 3,
			readonlyNodes: RO_NODES,
		});

		expect(pools).to.have.lengthOf(2);
		// POSITIVE CONTROL, asserted first: if minimumIdle did not arrive the
		// harness is broken and the 600 below proves nothing either way.
		expect(pools.map((p) => p.minimumIdle)).to.deep.equal([3, 3]);
		expect(pools.map((p) => p.idleTimeout)).to.deep.equal([600, 600]);
	});

	// AC2 (b) -- pins the NUMBER. (a) on its own is vacuous: it would still pass
	// if the default were dropped altogether.
	it('MySQLDialect still defaults idleTimeout to 600 when nothing is set', async () => {
		const opts = await captureDialectPool({ database: 'bdl3565_probe' });
		expect(opts.idleTimeout).to.equal(600);
	});

	// AC3 -- an invalid value must fail loudly. chai-as-promised is NOT a
	// devDependency here, so `.to.be.rejectedWith()` is unavailable; use the
	// explicit pattern below. A bare try/catch with the assertion INSIDE the
	// catch passes vacuously when nothing throws, which is the exact failure
	// this criterion exists to detect.
	describe('invalid idleTimeout values', () => {
		const INVALID = ['abc', -5, 0, NaN, 1.5, null];

		INVALID.forEach((value) => {
			it(`rejects ${typeof value} ${String(value)}, naming the option`, async () => {
				let caught;
				try {
					await capturePools({ idleTimeout: value });
				} catch (e) {
					caught = e;
				}
				// Assert the rejection HAPPENED before asserting anything about it.
				expect(
					caught,
					`expected dbh() to reject for idleTimeout=${String(value)}`,
				).to.be.instanceOf(Error);
				expect(caught.message).to.include('idleTimeout');
			});
		});

		// Without this, a validator that rejected EVERYTHING would pass the six
		// cases above.
		it('still accepts a valid positive integer', async () => {
			const pools = await capturePools({ idleTimeout: 900 });
			expect(pools).to.have.lengthOf(1);
			expect(pools[0].idleTimeout).to.equal(900);
		});
	});
});
