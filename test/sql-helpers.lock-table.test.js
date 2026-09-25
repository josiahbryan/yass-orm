/* eslint-disable no-unused-expressions */
/* global describe, it, before, after */
const path = require('path');
const { execFile } = require('child_process');
const { expect } = require('chai');
const sql = require('../lib/sql-helpers');
const { dbh } = require('../lib/dbh');
const {
	isPostgres,
	quoteTable,
	recreateTables,
} = require('./helpers/characterize');

const HELPER = path.join(__dirname, 'helpers', 'lockFreshProcess.js');
const REPO = path.join(__dirname, '..');

// A new node process (test/helpers/lockFreshProcess.js): nothing in it has
// made or seen the lock table, as in a service that just started.
const freshProcess = (mode, key) =>
	new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			[HELPER, mode, key],
			{ cwd: REPO, env: process.env, timeout: 60000 },
			(error, stdout, stderr) => {
				const line = `${stdout}`.trim().split('\n').pop();
				try {
					resolve(JSON.parse(line));
				} catch (parseError) {
					reject(error || new Error(`no result: ${stdout}\n${stderr}`));
				}
			},
		);
	});

/**
 * The table lockKey() locks rows of, `yass_locks`, on a FRESH database: it
 * must exist before a transaction that may lock is open. Made lazily, from
 * another connection, while the caller's transaction was open, MySQL refused
 * the caller's transaction ("Table definition has changed, please retry
 * transaction", ER_TABLE_DEF_CHANGED) once it had read anything. Live
 * database: MySQL in `npm test`, Postgres in `npm run test:postgres`.
 */
describe('#sql helpers: the lock table on a fresh database', function lockTableSuite() {
	this.timeout(120000);

	let conn;
	const T = () => quoteTable('yass_locks');
	const dropLockTable = () => conn.pquery(`DROP TABLE IF EXISTS ${T()}`);
	const lockTableExists = async () => {
		const rows = await conn.pquery(
			isPostgres()
				? `SELECT 1 AS present WHERE to_regclass('yass_locks') IS NOT NULL`
				: `SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'yass_locks'`,
		);
		return rows.length > 0;
	};

	before(async () => {
		// The table the fresh processes read from (test/helpers/lockFreshProcess.js).
		await recreateTables([
			({ types: t }) => ({
				table: 'yass_lock_fresh',
				schema: { id: t.stringKey, name: t.string },
			}),
		]);
		conn = await dbh();
	});

	after(async () => {
		// Leave the table the way other suites in this process expect it.
		await sql.ensureLockTable(conn);
		if (!(await lockTableExists())) {
			await conn.pquery(
				conn.dialect.createLockTableSql(
					conn.dialect.quoteIdentifier('yass_locks'),
				),
			);
		}
	});

	it('schema sync makes it: a service that syncs, reads, then locks, on a fresh database', async () => {
		await dropLockTable();
		const result = await freshProcess('sync', 'fresh:sync');
		expect(result).to.deep.equal({ ok: true });
		expect(await lockTableExists()).to.be.true;
	});

	it('ensureLockTable(db) makes it, for a service that does not sync', async () => {
		await dropLockTable();
		const result = await freshProcess('ensure', 'fresh:ensure');
		expect(result).to.deep.equal({ ok: true });
		expect(await lockTableExists()).to.be.true;
	});

	it('several processes starting at once on a fresh database all take their lock', async () => {
		await dropLockTable();
		const results = await Promise.all(
			['sync', 'ensure', 'sync', 'ensure', 'sync', 'ensure'].map((mode, i) =>
				freshProcess(mode, `fresh:many:${i % 2}`),
			),
		);
		expect(results).to.deep.equal(results.map(() => ({ ok: true })));
		expect(await lockTableExists()).to.be.true;
	});

	it('with neither, the first lockKey makes it outside the transaction, and a retry succeeds', async () => {
		await dropLockTable();
		const result = await freshProcess('none', 'fresh:none');
		expect(result).to.deep.equal({ ok: true });
		expect(await lockTableExists()).to.be.true;
	});

	it('a rolled-back transaction does not take the table with it', async () => {
		await dropLockTable();
		const result = await freshProcess('rollback', 'fresh:rollback');
		expect(result).to.deep.equal({ ok: true });
		expect(await lockTableExists()).to.be.true;
	});

	it('ensureLockTable() on an existing table reads the catalog and runs no DDL; then nothing, once per handle', async () => {
		await sql.ensureLockTable(conn);
		// A new root handle (its own memo) over the same pool, recording SQL.
		const statements = [];
		const handle = Object.create(conn);
		handle.pquery = (query, ...rest) => {
			statements.push(query);
			return conn.pquery(query, ...rest);
		};
		await sql.ensureLockTable(handle);
		await sql.ensureLockTable(handle);
		expect(statements).to.have.length(1);
		expect(statements[0]).to.match(/information_schema\.tables/);
		expect(statements.join(' ')).not.to.match(/CREATE/i);
	});

	it('does nothing on a transaction handle whose root has it, and never runs inside the transaction', async () => {
		await conn.transaction(async (tx) => {
			const txQueries = [];
			const original = tx.pquery;
			// eslint-disable-next-line no-param-reassign
			tx.pquery = (query, ...rest) => {
				txQueries.push(query);
				return original.call(tx, query, ...rest);
			};
			await sql.ensureLockTable(tx);
			expect(txQueries).to.deep.equal([]);
		});
	});
});
