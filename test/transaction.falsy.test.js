/* global describe, it, before, after */
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');
const { quoteTable } = require('./helpers/characterize');

const table = `yass_tx_falsy_${process.pid}`;
describe('transaction falsy rejections (live dialect)', () => {
	let conn;
	before(async () => {
		conn = await dbh();
		await conn.query(
			`CREATE TABLE ${quoteTable(table)} (id INTEGER PRIMARY KEY)`,
		);
	});
	after(async () => {
		if (conn) await conn.query(`DROP TABLE ${quoteTable(table)}`);
		await closeAllConnections();
	});

	[undefined, null, false, 0, '', NaN].forEach((expected) => {
		it(`rolls back and preserves ${String(expected)}`, async () => {
			let rejected = false;
			let caught;
			try {
				await conn.transaction(async (tx) => {
					await tx.query(`INSERT INTO ${quoteTable(table)} (id) VALUES (1)`);
					throw expected;
				});
			} catch (error) {
				rejected = true;
				caught = error;
			}
			expect(rejected).to.equal(true);
			expect(Object.is(caught, expected)).to.equal(true);
			const rows = await conn.query(
				`SELECT COUNT(*) AS n FROM ${quoteTable(table)}`,
			);
			expect(Number(rows[0].n)).to.equal(0);
		});
	});
});
