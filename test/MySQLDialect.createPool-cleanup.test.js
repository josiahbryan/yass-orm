/* global describe, it */
const { expect } = require('chai');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

// Regression test for the orphaned-pool leak inside MySQLDialect.createPool.
//
// createPool() creates the mariadb pool, then (for PlanetScale ONLY_FULL_GROUP_BY
// mode) runs `SET sql_mode=...`. That query leases a connection, so on a slow or
// contended server it can fail with "retrieve connection from pool timeout".
// Before this fix, that error was thrown WITHOUT closing the pool it had just
// created — the pool's connections were never returned to the caller, never
// cached, never closed, and lingered server-side until idle-timeout. Under load
// + retries this stacked up duplicate pools for the same key and exhausted the
// server's max_connections (observed on the CI bastion: a SET-query timeout on
// the first metrics write orphaned a ~140-connection pool; the retry created a
// second one → 281 live connections for one key).
//
// Contract: if a post-create setup step fails, createPool MUST close the pool
// before propagating the error.

describe('MySQLDialect.createPool closes the pool when post-create setup fails', () => {
	it('ends the just-created pool if the SET sql_mode setup query throws', async () => {
		// eslint-disable-next-line global-require, import/no-extraneous-dependencies
		const mariadb = require('mariadb');

		let endCalls = 0;
		const fakePool = {
			query: async () => {
				throw new Error('retrieve connection from pool timeout after 20000ms');
			},
			end: async () => {
				endCalls += 1;
			},
		};

		const originalCreatePool = mariadb.createPool;
		mariadb.createPool = async () => fakePool;

		try {
			const dialect = new MySQLDialect();
			let threw = false;
			try {
				await dialect.createPool({
					database: 'testdb',
					// Force the post-create SET sql_mode path that leases a connection.
					disableFullGroupByPerSession: true,
				});
			} catch (err) {
				threw = true;
				// The original setup error must still propagate.
				expect(err.message).to.contain('retrieve connection from pool timeout');
			}

			expect(threw).to.equal(true);
			// The pool must have been closed, not orphaned.
			expect(endCalls).to.equal(1);
		} finally {
			mariadb.createPool = originalCreatePool;
		}
	});
});
