/* global describe, it, after */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');

// Regression test for the orphaned-pool connection leak.
//
// `retryIfConnectionLost` (utils.js) recovers from a dead connection by asking
// for a fresh pool via `ignoreCachedConnections: true`, which overwrites
// `connCache[key]`. The previously cached pool was simply dropped — its open
// connections were never closed, so they lingered server-side (`Sleep`) until
// idle-timeout. Under load this doubles the live connection count and exhausts
// `max_connections` (observed on the CI bastion: two ~160-connection pools for
// the same key crossing the 300 cap → "Too many connections").
//
// The fix is OPT-IN via `closeReplacedPool: true`, because plain
// `ignoreCachedConnections` is also used to hand out an additional fresh
// handle WITHOUT invalidating existing references (test setup, schema-sync) —
// closing the old pool there would yank it out from under live callers. Only
// the known-bad-connection recovery path opts in.

const tempFile = path.join('/tmp', `yass-orphan-pool-${process.pid}.sqlite`);
const tempFile2 = path.join('/tmp', `yass-orphan-pool2-${process.pid}.sqlite`);

describe('dbh closeReplacedPool option', () => {
	after(async () => {
		await closeAllConnections();
		[tempFile, tempFile2].forEach((f) => {
			try {
				fs.unlinkSync(f);
			} catch (err) {
				// ignore cleanup errors
			}
		});
	});

	it('closes the replaced pool when closeReplacedPool is set (no orphaned connections)', async () => {
		const first = await dbh({ dialect: 'sqlite', filename: tempFile });

		let firstEndCalls = 0;
		const originalEnd = first.end.bind(first);
		first.end = async (...args) => {
			firstEndCalls += 1;
			return originalEnd(...args);
		};

		const second = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
			closeReplacedPool: true,
		});

		expect(second).to.not.equal(first); // genuinely a new pool
		expect(firstEndCalls).to.equal(1); // old pool closed, not orphaned
	});

	it('does NOT close the replaced pool on plain ignoreCachedConnections (preserves the reuse contract)', async () => {
		const first = await dbh({ dialect: 'sqlite', filename: tempFile2 });

		let firstEndCalls = 0;
		const originalEnd = first.end.bind(first);
		first.end = async (...args) => {
			firstEndCalls += 1;
			return originalEnd(...args);
		};

		const second = await dbh({
			dialect: 'sqlite',
			filename: tempFile2,
			ignoreCachedConnections: true,
		});

		expect(second).to.not.equal(first);
		// Old pool must stay open — callers may still hold and use it.
		expect(firstEndCalls).to.equal(0);
	});
});
