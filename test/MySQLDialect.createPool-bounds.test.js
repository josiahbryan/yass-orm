/* global describe, it */
const { expect } = require('chai');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

// BC-3587: the mariadb driver defaults `minimumIdle` to `connectionLimit`, so
// `idleTimeout` reaps nothing and a pool holds its full limit open for the life
// of the process. `minimumIdle` and `acquireTimeout` are the two levers that
// bound that, so they must reach the driver when set -- and must be ABSENT when
// unset, so existing deployments keep the driver defaults exactly.
describe('MySQLDialect.createPool connection-bound options', () => {
	async function capturePoolConfig(config) {
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

	it('forwards minimumIdle and acquireTimeout when set', async () => {
		const opts = await capturePoolConfig({
			database: 'testdb',
			connectionLimit: 20,
			minimumIdle: 0,
			acquireTimeout: 30000,
		});

		expect(opts.connectionLimit).to.equal(20);
		expect(opts.minimumIdle).to.equal(0);
		expect(opts.acquireTimeout).to.equal(30000);
	});

	it('omits them entirely when unset, preserving driver defaults', async () => {
		const opts = await capturePoolConfig({ database: 'testdb' });

		expect(opts).to.not.have.property('minimumIdle');
		expect(opts).to.not.have.property('acquireTimeout');
		expect(opts.connectionLimit).to.equal(10);
	});
});
