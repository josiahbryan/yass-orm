/* global describe, it, afterEach */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');

const tempFile = path.join('/tmp', `yass-stampede-${process.pid}.sqlite`);

/**
 * Regression: BC-3587.
 *
 * `dbh()` is async and there are several `await`s between the cache LOOKUP and
 * the cache WRITE. Without in-flight memoization, N callers that ask for the
 * same handle before the first one resolves each build their OWN pool, and only
 * the last one to finish wins the cache slot. The other N-1 pools are orphaned:
 * never returned from the cache, never closed by `closeAllConnections()`, and
 * never reaped (mariadb keeps `minimumIdle` == `connectionLimit` connections
 * open forever). Server-side connection count then ramps monotonically until
 * `max_connections` is hit and every acquire times out (errno 45028).
 *
 * Measured against a local MySQL before the fix: 20 concurrent `dbh()` calls
 * produced 20 distinct pools, and three cold-cache rounds leaked 39 -> 114 ->
 * 220 connections that `closeAllConnections()` could not reclaim.
 */
describe('dbh concurrent cache stampede', () => {
	afterEach(async () => {
		await closeAllConnections();
		try {
			fs.unlinkSync(tempFile);
		} catch (err) {
			// ignore cleanup errors
		}
	});

	it('should hand every concurrent caller the SAME pooled handle', async () => {
		const handles = await Promise.all(
			Array.from({ length: 25 }, () =>
				dbh({ dialect: 'sqlite', filename: tempFile }),
			),
		);

		expect(new Set(handles).size).to.equal(
			1,
			'concurrent dbh() calls for one key must share a single pool',
		);
	});

	it('should let closeAllConnections() reclaim every pool it created', async () => {
		await Promise.all(
			Array.from({ length: 25 }, () =>
				dbh({ dialect: 'sqlite', filename: tempFile }),
			),
		);

		const { closed, failed } = await closeAllConnections();
		expect(failed || 0).to.equal(0);
		expect(closed).to.equal(1, 'exactly one pool should exist to close');

		// Nothing orphaned: a fresh handle after teardown is usable.
		const conn = await dbh({ dialect: 'sqlite', filename: tempFile });
		await conn.query('SELECT 1');
	});

	it('should still hand out an extra pool when ignoreCachedConnections is set', async () => {
		const shared = await dbh({ dialect: 'sqlite', filename: tempFile });
		const extra = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});

		expect(extra).to.not.equal(shared);
		await extra.end();

		// The shared, cached handle must survive the throwaway being ended.
		const again = await dbh({ dialect: 'sqlite', filename: tempFile });
		expect(again).to.equal(shared);
		await again.query('SELECT 1');
	});
});
