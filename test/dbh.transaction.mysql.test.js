/* global describe, it, before, after, beforeEach */
const { expect } = require('chai');
const {
	dbh,
	closeAllConnections,
	FIND_OR_CREATE_META,
} = require('../lib/dbh');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const table = `yass_transaction_${process.pid}`;

describe('dbh transactions (live MySQL/MariaDB)', () => {
	let conn;

	before(async () => {
		conn = await dbh();
		await conn.query(`DROP TABLE IF EXISTS ${conn.escapeId(table)}`);
		await conn.query(`
			CREATE TABLE ${conn.escapeId(table)} (
				id VARCHAR(80) PRIMARY KEY,
				value VARCHAR(255) NOT NULL
			) ENGINE=InnoDB
		`);
	});

	beforeEach(async () => {
		await conn.query(`DELETE FROM ${conn.escapeId(table)}`);
	});

	after(async () => {
		if (conn) await conn.query(`DROP TABLE IF EXISTS ${conn.escapeId(table)}`);
		await closeAllConnections();
	});

	it('commits on one leased connection and reads uncommitted work via roQuery', async () => {
		const returned = await conn.transaction(
			async (tx) => {
				await tx.pquery(
					`INSERT INTO ${tx.escapeId(
						table,
					)} (id, value) VALUES (:id, :value)`,
					{ id: 'committed', value: 'yes' },
				);
				const rows = await tx.roQuery(
					`SELECT value FROM ${tx.escapeId(table)} WHERE id = :id`,
					{ id: 'committed' },
				);
				expect(rows).to.deep.equal([{ value: 'yes' }]);
				return 'callback-value';
			},
			{ isolationLevel: 'read committed' },
		);

		expect(returned).to.equal('callback-value');
		expect(await conn.get(table, 'committed')).to.include({ value: 'yes' });
	});

	it('rolls back callback failures', async () => {
		const expected = new Error('rollback mysql');
		let caught;
		try {
			await conn.transaction(async (tx) => {
				await tx.create(table, { id: 'rolled-back', value: 'no' });
				throw expected;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(expected);
		expect(await conn.get(table, 'rolled-back')).to.equal(null);
	});

	it('uses savepoints for nested work', async () => {
		await conn.transaction(async (tx) => {
			await tx.create(table, { id: 'outer', value: 'kept' });
			try {
				await tx.transaction(async (nestedTx) => {
					await nestedTx.create(table, { id: 'inner', value: 'discarded' });
					throw new Error('rollback inner');
				});
			} catch (err) {
				expect(err.message).to.equal('rollback inner');
			}
		});

		expect(await conn.get(table, 'outer')).to.exist;
		expect(await conn.get(table, 'inner')).to.equal(null);
	});

	it('makes concurrent findOrCreate calls converge on one row', async () => {
		const fields = { id: 'same-row', value: 'same-value' };
		const cap = captureConsoleError.install();
		let first;
		let second;
		try {
			[first, second] = await Promise.all([
				conn.findOrCreate(table, fields),
				conn.findOrCreate(table, fields),
			]);
		} finally {
			cap.restore();
		}

		expect(first).to.deep.equal(second);
		expect(cap.loudCount()).to.equal(0);
		expect(
			[first[FIND_OR_CREATE_META].lastAction, second[FIND_OR_CREATE_META].lastAction]
				.sort(),
		).to.deep.equal(['create', 'get']);
		expect(
			[first[FIND_OR_CREATE_META].wasCreated, second[FIND_OR_CREATE_META].wasCreated]
				.sort(),
		).to.deep.equal([false, true]);
		expect(Object.getOwnPropertySymbols(first)).to.include(FIND_OR_CREATE_META);
		expect(
			Object.getOwnPropertyDescriptor(first, FIND_OR_CREATE_META).enumerable,
		).to.equal(false);
		const rows = await conn.pquery(
			`SELECT COUNT(*) AS count FROM ${conn.escapeId(table)} WHERE id = :id`,
			{ id: 'same-row' },
		);
		expect(Number(rows[0].count)).to.equal(1);
	});
});
