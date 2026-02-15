/* global describe, it, after */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');

const tempA = path.join('/tmp', `yass-cache-a-${process.pid}.sqlite`);
const tempB = path.join('/tmp', `yass-cache-b-${process.pid}.sqlite`);

describe('dbh SQLite cache key isolation', () => {
	after(async () => {
		await closeAllConnections();
		[tempA, tempB].forEach((file) => {
			try {
				fs.unlinkSync(file);
			} catch (err) {
				// ignore cleanup errors
			}
		});
	});

	it('should isolate cached handles by SQLite filename', async () => {
		const connA = await dbh({
			dialect: 'sqlite',
			filename: tempA,
			ignoreCachedConnections: true,
		});
		const connB = await dbh({
			dialect: 'sqlite',
			filename: tempB,
		});
		const connBAgain = await dbh({
			dialect: 'sqlite',
			filename: tempB,
		});

		expect(connA).to.not.equal(connB);
		expect(connBAgain).to.equal(connB);

		await connA.query('CREATE TABLE cache_test (id INTEGER PRIMARY KEY)');

		const rowsInA = await connA.query(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='cache_test'",
		);
		const rowsInB = await connB.query(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='cache_test'",
		);

		expect(rowsInA.length).to.equal(1);
		expect(rowsInB.length).to.equal(0);
	});
});
