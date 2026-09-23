/* global describe, it */
const { expect } = require('chai');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { dbh } = require('../lib/dbh');

// The driver options behind the opt-in `timezone: 'utc'` config. The default
// (unset) must reach the driver exactly as before; the live, non-UTC-process
// coverage is in test/dbh.timezone-utc.test.js.
describe('MySQLDialect timezone options', () => {
	// eslint-disable-next-line global-require, import/no-extraneous-dependencies
	const mariadb = require('mariadb');

	async function captureDriverOptions(method, config) {
		const original = mariadb[method];
		let seen;
		mariadb[method] = async (opts) => {
			seen = opts;
			return { query: async () => [], end: async () => {} };
		};
		try {
			await new MySQLDialect()[method](config);
		} finally {
			mariadb[method] = original;
		}
		return seen;
	}

	['createPool', 'createConnection'].forEach((method) => {
		describe(method, () => {
			it('unset: UTC conversion in the driver, session zone untouched (unchanged)', async () => {
				const opts = await captureDriverOptions(method, { database: 'd' });
				expect(opts.timezone).to.equal('Etc/GMT+0');
				expect(opts.skipSetTimezone).to.equal(true);
				expect(opts).to.not.have.property('initSql');
				expect(opts).to.not.have.property('resetAfterUse');
			});

			it("timezone: 'utc' also sets each new connection's session to UTC", async () => {
				const opts = await captureDriverOptions(method, {
					database: 'd',
					timezone: 'utc',
				});
				expect(opts.timezone).to.equal('Etc/GMT+0');
				expect(opts.skipSetTimezone).to.equal(true);
				expect(opts.initSql).to.equal("SET time_zone = '+00:00'");
				// A pool must not reset sessions on release (MariaDB's
				// COM_RESET_CONNECTION would put the server's zone back).
				if (method === 'createPool') {
					expect(opts.resetAfterUse).to.equal(false);
				} else {
					expect(opts).to.not.have.property('resetAfterUse');
				}

				const upper = await captureDriverOptions(method, {
					database: 'd',
					timezone: 'UTC',
				});
				expect(upper.initSql).to.equal("SET time_zone = '+00:00'");
			});

			it('disableTimezone (unset timezone) still sends no timezone options', async () => {
				const opts = await captureDriverOptions(method, {
					database: 'd',
					disableTimezone: true,
				});
				expect(opts).to.not.have.property('timezone');
				expect(opts).to.not.have.property('initSql');
			});

			it('refuses utc together with disableTimezone', async () => {
				let error;
				try {
					await captureDriverOptions(method, {
						database: 'd',
						timezone: 'utc',
						disableTimezone: true,
					});
				} catch (err) {
					error = err;
				}
				expect(error).to.be.an('error');
				expect(error.message).to.match(/disableTimezone/);
			});

			it('ignores any other timezone value passed straight to the dialect, as before', async () => {
				const opts = await captureDriverOptions(method, {
					database: 'd',
					timezone: 'Etc/GMT+0',
				});
				expect(opts.timezone).to.equal('Etc/GMT+0');
				expect(opts).to.not.have.property('initSql');
			});
		});
	});

	describe('dbh() forwards it to the primary and read-replica pools', () => {
		async function capturePools(options) {
			const original = mariadb.createPool;
			const seen = [];
			mariadb.createPool = async (opts) => {
				seen.push(opts);
				return { query: async () => [], end: async () => {} };
			};
			try {
				await dbh({
					ignoreCachedConnections: true,
					dialect: 'mysql',
					host: 'tz-probe.invalid',
					readonlyNodes: [{ host: 'tz-replica.invalid' }],
					...options,
				});
			} finally {
				mariadb.createPool = original;
			}
			return seen;
		}

		it("timezone: 'utc' reaches every pool", async () => {
			const pools = await capturePools({ timezone: 'utc' });
			expect(pools.map((p) => p.host)).to.deep.equal([
				'tz-probe.invalid',
				'tz-replica.invalid',
			]);
			pools.forEach((p) =>
				expect(p.initSql).to.equal("SET time_zone = '+00:00'"),
			);
		});

		it('unset: every pool gets the same options as before', async () => {
			const pools = await capturePools({});
			expect(pools).to.have.length(2);
			pools.forEach((p) => {
				expect(p).to.not.have.property('initSql');
				expect(p.timezone).to.equal('Etc/GMT+0');
			});
		});

		it('rejects any other timezone value', async () => {
			// One at a time: capturePools swaps the driver's createPool.
			await ['local', 'America/Chicago', 'Z', true].reduce(
				(previous, timezone) =>
					previous.then(async () => {
						let error;
						try {
							await capturePools({ timezone });
						} catch (err) {
							error = err;
						}
						expect(error, JSON.stringify(timezone)).to.be.an('error');
						expect(error.message).to.match(/Unsupported `timezone`/);
					}),
				Promise.resolve(),
			);
		});

		it("timezone: 'utc' with disableTimezone is refused", async () => {
			let error;
			try {
				await capturePools({ timezone: 'utc', disableTimezone: true });
			} catch (err) {
				error = err;
			}
			expect(error).to.be.an('error');
			expect(error.message).to.match(/disableTimezone/);
		});
	});
});
