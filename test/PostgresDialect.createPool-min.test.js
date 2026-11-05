/* global describe, it, before, after */
const { expect } = require('chai');
const config = require('../lib/config');
const { PostgresDialect } = require('../lib/dialects/PostgresDialect');

// `minimumIdle` on Postgres. dbh forwards it to every dialect, but
// PostgresDialect.createPool dropped it, so pg-pool always ran with its own
// `min` of 0 and closed every session after `idleTimeout`. A session holds its
// prepared statements and their cached plans, and its catalog caches; a pool
// that empties itself makes the next request plan from cold. Now `minimumIdle`
// is pg-pool's `min`: that many sessions stay open past `idleTimeout`, and the
// ones above it still close. Unset keeps pg-pool's default (0).

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

// pg-pool's own reap delay after the timeout fires.
const REAP_GRACE_MS = 500;

const sleep = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

describe('PostgresDialect.createPool minimumIdle', () => {
	describe('options handed to pg.Pool (no server)', () => {
		const captured = async (poolConfig) => {
			const pg = require('pg'); // eslint-disable-line global-require
			const Original = pg.Pool;
			let seen;
			pg.Pool = function StubPool(options) {
				seen = options;
			};
			try {
				await new PostgresDialect().createPool(poolConfig);
			} finally {
				pg.Pool = Original;
			}
			return seen;
		};

		it('forwards minimumIdle as min', async () => {
			const options = await captured({ minimumIdle: 4, connectionLimit: 10 });
			expect(options.min).to.equal(4);
			expect(options.max).to.equal(10);
		});

		it('forwards a minimumIdle of 0 as 0, not as unset', async () => {
			const options = await captured({ minimumIdle: 0 });
			expect(options).to.have.property('min', 0);
		});

		it("leaves min out when minimumIdle is unset (pg-pool's default)", async () => {
			const options = await captured({});
			expect(options).to.not.have.property('min');
		});
	});

	describe('live (Postgres only)', () => {
		const IDLE_TIMEOUT_S = 1;
		let pool;

		before(async function beforeSuite() {
			if (!isPostgres()) {
				this.skip();
				return;
			}
			pool = await new PostgresDialect().createPool({
				host: config.host,
				port: config.port,
				user: config.user,
				password: config.password,
				database: config.schema,
				connectionLimit: 3,
				minimumIdle: 1,
				idleTimeout: IDLE_TIMEOUT_S,
			});
		});

		after(async () => {
			if (pool) await pool.end();
		});

		it('keeps minimumIdle sessions, with their prepared statements, past idleTimeout and closes the rest', async function keeps() {
			this.timeout(10_000);
			const clients = await Promise.all([
				pool.connect(),
				pool.connect(),
				pool.connect(),
			]);
			// A named statement on each session: the session keeps it (and its plan)
			// while it lives.
			const pids = await Promise.all(
				clients.map(async (client) => {
					const { rows } = await client.query({
						name: 'yass_pool_min_pid',
						text: 'SELECT pg_backend_pid() AS pid',
					});
					return Number(rows[0].pid);
				}),
			);
			clients.forEach((client) => client.release());
			expect(pool.totalCount).to.equal(3);

			await sleep(IDLE_TIMEOUT_S * 1000 + REAP_GRACE_MS);

			expect(pool.totalCount, 'sessions above minimumIdle close').to.equal(1);
			const client = await pool.connect();
			try {
				const { rows } = await client.query(
					"SELECT pg_backend_pid() AS pid, (SELECT count(*) FROM pg_prepared_statements WHERE name = 'yass_pool_min_pid') AS kept",
				);
				expect(
					pids,
					'the kept session is one the pool opened before',
				).to.include(Number(rows[0].pid));
				expect(
					Number(rows[0].kept),
					'it still holds its prepared statement',
				).to.equal(1);
			} finally {
				client.release();
			}
		});
	});
});
