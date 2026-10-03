/* eslint-disable no-unused-expressions */
/* global describe, it, before, afterEach */
const { expect } = require('chai');
const sql = require('../lib/sql-helpers');
const config = require('../lib/config');
const { dbh, DEFAULT_LOCK_KEY_POOL_SIZE } = require('../lib/dbh');
const { isPostgres, eventually } = require('./helpers/characterize');

/**
 * lockKey() inserts a new key's row outside the caller's transaction. It
 * used to take that connection from the caller's own pool, which the
 * transaction already holds one of: at pool size 1 the first lockKey of a
 * new key waited on itself, and P transactions each locking a new key on a
 * pool of P waited on each other. The insert now runs on the handle's own
 * small lock-key pool. Live database: MySQL in `npm test`, Postgres in
 * `npm run test:postgres`.
 */
describe('#sql helpers: lockKey on its own pool (never the caller pool)', function lockPoolSuite() {
	this.timeout(30000);

	// The pool acquire timeout of the small handles, and the bound on each
	// test's work: an acquire that can never be served fails the test, never
	// hangs it.
	const ACQUIRE_TIMEOUT_MS = 2000;
	const BOUND_MS = 10000;
	const HOLD_MS = 200;
	const CLOSE_WAIT_MS = 5000;
	// Transactions per pool connection, in the oversubscribed test
	const OVERSUBSCRIBE = 3;
	// The bucket burst: a key set the size of a caller's buckets, each new
	// bucket taken by BUCKET_PASSES transactions, on a small pool
	const BUCKETS = 256;
	const BUCKET_PASSES = 2;
	const BURST_POOL_SIZE = 3;

	let conn;
	const opened = [];
	let counter = 0;
	// A key no process has locked before
	const newKey = (label) => {
		counter += 1;
		return `lock-pool:${label}:${process.pid}:${Date.now()}:${counter}`;
	};

	const smallHandle = async (connectionLimit, extra = {}) => {
		const handle = await dbh({
			ignoreCachedConnections: true,
			connectionLimit,
			minimumIdle: connectionLimit,
			acquireTimeout: ACQUIRE_TIMEOUT_MS,
			...extra,
		});
		opened.push(handle);
		return handle;
	};

	const bounded = (promise, label) => {
		let timer;
		const limit = new Promise((resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label}: not done after ${BOUND_MS}ms`)),
				BOUND_MS,
			);
		});
		return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
	};

	// The server sessions connected to the test database (the asking one too:
	// the next query may run on another of the pool, so it stays in `before`)
	const sessions = async () => {
		const rows = await conn.pquery(
			isPostgres()
				? 'SELECT pid AS id FROM pg_stat_activity WHERE datname = current_database()'
				: 'SELECT ID AS id FROM information_schema.PROCESSLIST WHERE DB = DATABASE()',
		);
		return rows.map((row) => `${row.id}`);
	};
	const added = (before, after) => after.filter((id) => !before.includes(id));

	before(async () => {
		conn = await dbh();
		await sql.ensureLockTable(conn);
		// The mariadb pool opens its `minimumIdle` (= connectionLimit)
		// connections in the background: let it finish, so the session counts
		// below see only the handles under test.
		if (typeof conn.totalConnections === 'function') {
			await eventually(() => {
				expect(conn.totalConnections()).to.equal(config.connectionLimit);
			}, CLOSE_WAIT_MS);
		}
	});

	afterEach(async () => {
		await Promise.all(opened.splice(0).map((handle) => handle.end()));
	});

	it('at pool size 1, a transaction locks a key never seen before (the table made at startup)', async () => {
		const small = await smallHandle(1);
		await sql.ensureLockTable(small);
		await bounded(
			small.transaction((tx) => sql.lockKey(tx, newKey('one'))),
			'lockKey at pool size 1',
		);
	});

	it("at pool size 1, the handle's first lockKey (no ensureLockTable) finishes too", async () => {
		const small = await smallHandle(1);
		await bounded(
			small.transaction((tx) => sql.lockKey(tx, newKey('one'))),
			'lockKey at pool size 1',
		);
	});

	it('P transactions on a pool of P, each locking a new key, all finish (and the lock pool stays bounded)', async () => {
		const P = 3;
		const before = await sessions();
		const pool = await smallHandle(P);
		// Every transaction holds its connection before any of them locks.
		let arrived = 0;
		let allArrived;
		const everyoneIn = new Promise((resolve) => {
			allArrived = resolve;
		});
		const done = await bounded(
			Promise.all(
				Array.from({ length: P }, (_, i) =>
					pool.transaction(async (tx) => {
						await tx.pquery('SELECT 1 AS one');
						arrived += 1;
						if (arrived === P) allArrived();
						await everyoneIn;
						await sql.lockKey(tx, newKey(`p${i}`));
						return i;
					}),
				),
			),
			`${P} new-key transactions on a pool of ${P}`,
		);
		expect(done).to.deep.equal([0, 1, 2]);
		const opens = added(before, await sessions());
		expect(opens.length).to.be.at.most(P + DEFAULT_LOCK_KEY_POOL_SIZE);
	});

	it('at the default pool size, more transactions than connections, each locking a new key, all finish', async () => {
		const pool = await smallHandle(config.connectionLimit);
		const count = OVERSUBSCRIBE * config.connectionLimit;
		const done = await bounded(
			Promise.all(
				Array.from({ length: count }, (_, i) =>
					pool.transaction(async (tx) => {
						await sql.lockKey(tx, newKey(`many${i}`));
						return i;
					}),
				),
			),
			`${count} new-key transactions on a pool of ${config.connectionLimit}`,
		);
		expect(done).to.have.length(count);
	});

	it('a burst over a bucket key set (two transactions per never-seen bucket) all finish, one row per bucket', async () => {
		const pool = await smallHandle(BURST_POOL_SIZE);
		const prefix = newKey('bucket');
		const bucket = (i) => `${prefix}:${i % BUCKETS}`;
		const count = BUCKET_PASSES * BUCKETS;
		const done = await bounded(
			Promise.all(
				Array.from({ length: count }, (_, i) =>
					pool.transaction(async (tx) => {
						await sql.lockKey(tx, bucket(i));
						return i;
					}),
				),
			),
			`${count} transactions over ${BUCKETS} new bucket keys on a pool of ${BURST_POOL_SIZE}`,
		);
		expect(done).to.have.length(count);
		const nameSql = conn.escapeId('name');
		const [{ n }] = await conn.pquery(
			`SELECT ${sql.count(conn)} AS n FROM ${conn.escapeId(
				'yass_locks',
			)} WHERE ${nameSql} LIKE :prefix`,
			{ prefix: `${prefix}:%` },
		);
		expect(n).to.equal(BUCKETS);
	});

	it('still serializes two transactions racing to lock the same new key', async () => {
		const pool = await smallHandle(2);
		const key = newKey('same');
		const events = [];
		let holders = 0;
		let mostHolders = 0;
		const take = (label) =>
			pool.transaction(async (tx) => {
				await sql.lockKey(tx, key);
				holders += 1;
				mostHolders = Math.max(mostHolders, holders);
				events.push(`${label} in`);
				await new Promise((resolve) => {
					setTimeout(resolve, HOLD_MS);
				});
				events.push(`${label} out`);
				holders -= 1;
			});
		await bounded(Promise.all([take('a'), take('b')]), 'same-key race');
		expect(mostHolders).to.equal(1);
		expect(events).to.have.length(4);
		expect(events[1]).to.equal(events[0].replace(' in', ' out'));
	});

	it("closing the handle closes its lock pool's connections", async () => {
		const before = await sessions();
		const small = await smallHandle(1, { lockKeyPoolSize: 1 });
		await bounded(
			small.transaction((tx) => sql.lockKey(tx, newKey('close'))),
			'lockKey before close',
		);
		const opens = added(before, await sessions());
		// One for the handle's pool, one for its lock pool
		expect(opens).to.have.length(2);
		await small.end();
		opened.splice(opened.indexOf(small), 1);
		await eventually(async () => {
			const still = (await sessions()).filter((id) => opens.includes(id));
			expect(still, 'sessions left open after end()').to.deep.equal([]);
		}, CLOSE_WAIT_MS);
	});
});
