/* eslint-disable no-console */
/* global describe, it, before, after, afterEach */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const {
	resolveDdlLockWaitSettings,
	runDdl,
	syncSchemaToDb,
} = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');

/**
 * Schema-sync DDL must not wait on a metadata lock for long: every query on
 * the table queues behind a pending ALTER, and MySQL's default
 * lock_wait_timeout is a year. So DDL runs under a short SESSION
 * lock_wait_timeout, set on the very connection that runs it, and a timeout
 * is retried a bounded number of times before it is reported.
 */
const lockWaitError = () =>
	Object.assign(new Error('Lock wait timeout exceeded'), {
		errno: 1205,
		code: 'ER_LOCK_WAIT_TIMEOUT',
		sqlState: 'HY000',
	});

describe('#schemaSync DDL lock-wait settings', () => {
	it('defaults to a 10 second timeout and 2 retries', () => {
		expect(resolveDdlLockWaitSettings({ config: {}, env: {} })).to.deep.equal({
			timeoutSeconds: 10,
			retries: 2,
			retryDelayMs: 2000,
		});
	});

	it('takes overrides from config, and from the environment over config', () => {
		const fromConfig = {
			ddlLockWaitTimeout: 5,
			ddlLockWaitRetries: 0,
			ddlLockWaitRetryDelayMs: 50,
		};
		expect(
			resolveDdlLockWaitSettings({ config: fromConfig, env: {} }),
		).to.deep.equal({ timeoutSeconds: 5, retries: 0, retryDelayMs: 50 });
		expect(
			resolveDdlLockWaitSettings({
				config: fromConfig,
				env: {
					YASS_DDL_LOCK_WAIT_TIMEOUT: '30',
					YASS_DDL_LOCK_WAIT_RETRIES: '4',
				},
			}),
		).to.deep.equal({ timeoutSeconds: 30, retries: 4, retryDelayMs: 50 });
	});

	// There is no off switch: a value that is not a positive whole number of
	// seconds is the default, never "no timeout".
	it('cannot be turned off', () => {
		[0, -1, false, null, 'off', '', 1.5, Infinity].forEach((value) => {
			expect(
				resolveDdlLockWaitSettings({
					config: { ddlLockWaitTimeout: value },
					env: {},
				}).timeoutSeconds,
				`ddlLockWaitTimeout: ${value}`,
			).to.equal(10);
		});
		expect(
			resolveDdlLockWaitSettings({
				config: {},
				env: { YASS_DDL_LOCK_WAIT_TIMEOUT: '0' },
			}).timeoutSeconds,
		).to.equal(10);
	});
});

describe('#schemaSync MySQLDialect.withSchemaChangeSession', () => {
	const mysql = new MySQLDialect();

	// A pool whose own .query() answers on "some" connection, and whose leased
	// connection records what ran on it.
	const fakePool = ({ failOn } = {}) => {
		const events = [];
		const leased = {
			query: async (sql) => {
				events.push(`leased: ${sql}`);
				if (failOn && failOn.test(sql)) throw new Error(`refused: ${sql}`);
				return [];
			},
			release: async () => {
				events.push('release');
			},
		};
		const pool = {
			getConnection: async () => {
				events.push('lease');
				return leased;
			},
			query: async (sql) => {
				events.push(`pool: ${sql}`);
				return [];
			},
			pquery(sql) {
				return this.query(sql);
			},
		};
		return { pool, events };
	};

	it('sets the timeout on ONE leased connection and runs the DDL on that same connection', async () => {
		const { pool, events } = fakePool();
		await mysql.withSchemaChangeSession(
			pool,
			{ lockWaitTimeout: 7 },
			(session) => session.pquery('ALTER TABLE `t` ADD `a` int'),
		);
		expect(events).to.deep.equal([
			'lease',
			'leased: SET @yass_prior_lock_wait_timeout = @@SESSION.lock_wait_timeout, SESSION lock_wait_timeout = 7',
			'leased: ALTER TABLE `t` ADD `a` int',
			'leased: SET SESSION lock_wait_timeout = @yass_prior_lock_wait_timeout',
			'release',
		]);
	});

	it('restores the session and releases the connection when the DDL throws', async () => {
		const { pool, events } = fakePool({ failOn: /^ALTER/ });
		let caught;
		try {
			await mysql.withSchemaChangeSession(
				pool,
				{ lockWaitTimeout: 7 },
				(session) => session.pquery('ALTER TABLE `t` ADD `a` int'),
			);
		} catch (ex) {
			caught = ex;
		}
		expect(caught && caught.message).to.include('refused: ALTER');
		expect(events.slice(-2)).to.deep.equal([
			'leased: SET SESSION lock_wait_timeout = @yass_prior_lock_wait_timeout',
			'release',
		]);
	});

	it('destroys, rather than releases, a connection whose timeout could not be restored', async () => {
		const { pool, events } = fakePool({ failOn: /^SET SESSION/ });
		const leased = await pool.getConnection();
		leased.destroy = async () => {
			events.push('destroy');
		};
		events.length = 0;
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			await mysql.withSchemaChangeSession(
				pool,
				{ lockWaitTimeout: 7 },
				(session) => session.pquery('ALTER TABLE `t` ADD `a` int'),
			);
		} finally {
			console.warn = originalWarn;
		}
		expect(events[events.length - 1]).to.equal('destroy');
		expect(events).to.not.include('release');
	});

	// Same as the trigger reconciler: a host that refuses the SET does not
	// abort the sync; the DDL still runs (on the leased connection).
	it('warns and still runs the DDL when the SET is refused', async () => {
		const { pool, events } = fakePool({ failOn: /^SET @yass_prior/ });
		const originalWarn = console.warn;
		const warned = [];
		console.warn = (...args) => warned.push(args.join(' '));
		try {
			await mysql.withSchemaChangeSession(
				pool,
				{ lockWaitTimeout: 7 },
				(session) => session.pquery('ALTER TABLE `t` ADD `a` int'),
			);
		} finally {
			console.warn = originalWarn;
		}
		expect(warned.join('\n')).to.include('lock_wait_timeout');
		expect(events.slice(-2)).to.deep.equal([
			'leased: ALTER TABLE `t` ADD `a` int',
			'release',
		]);
	});

	it('uses a single connection as it is (nothing to lease or release)', async () => {
		const events = [];
		const single = {
			query: async (sql) => {
				events.push(sql);
				return [];
			},
			pquery(sql) {
				return this.query(sql);
			},
		};
		await mysql.withSchemaChangeSession(
			single,
			{ lockWaitTimeout: 7 },
			(session) => session.pquery('DROP INDEX `i` ON `t`'),
		);
		expect(events).to.have.length(3);
		expect(events[1]).to.equal('DROP INDEX `i` ON `t`');
	});

	it('recognises a lock wait timeout, wrapped or not', () => {
		expect(mysql.isLockWaitTimeoutError(lockWaitError())).to.equal(true);
		expect(
			mysql.isLockWaitTimeoutError({ code: 'ER_LOCK_WAIT_TIMEOUT' }),
		).to.equal(true);
		const wrapped = new Error('Error in query: ...');
		wrapped.cause = lockWaitError();
		expect(mysql.isLockWaitTimeoutError(wrapped)).to.equal(true);
		expect(mysql.isLockWaitTimeoutError({ errno: 1062 })).to.equal(false);
		expect(mysql.isLockWaitTimeoutError(undefined)).to.equal(false);
	});

	it('is a pass-through on a dialect without the hook', async () => {
		const sqlite = new SQLiteDialect();
		const handle = { pquery: async (sql) => `ran ${sql}` };
		expect(
			await sqlite.withSchemaChangeSession(
				handle,
				{ lockWaitTimeout: 7 },
				(session) => session.pquery('x'),
			),
		).to.equal('ran x');
		expect(sqlite.isLockWaitTimeoutError(lockWaitError())).to.equal(false);
	});
});

describe('#schemaSync runDdl (lock-wait retry)', () => {
	const settings = { timeoutSeconds: 10, retries: 2, retryDelayMs: 100 };
	const sql = 'ALTER TABLE `widgets` CHANGE `body` `body` longtext';

	// A dialect that hands the handle straight through, and a handle that
	// fails with the given errors before it succeeds.
	const harness = (failures) => {
		const attempts = [];
		const sleeps = [];
		const sessions = [];
		const queue = [...failures];
		return {
			attempts,
			sleeps,
			sessions,
			args: {
				dialect: {
					withSchemaChangeSession: (handle, opts, fn) => {
						sessions.push(opts);
						return fn(handle);
					},
					isLockWaitTimeoutError: (err) => err.errno === 1205,
				},
				handle: {
					pquery: async (statement, params, opts) => {
						attempts.push({ statement, opts });
						if (queue.length) throw queue.shift();
						return 'ok';
					},
				},
				sql,
				table: '`widgets`',
				settings,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		};
	};
	const quietly = async (fn) => {
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			return await fn();
		} finally {
			console.warn = originalWarn;
		}
	};

	it('runs the statement once, under the configured timeout, when it succeeds', async () => {
		const h = harness([]);
		expect(await runDdl(h.args)).to.equal('ok');
		expect(h.attempts).to.deep.equal([
			{ statement: sql, opts: { silenceErrors: true } },
		]);
		expect(h.sessions).to.deep.equal([{ lockWaitTimeout: 10 }]);
		expect(h.sleeps).to.deep.equal([]);
	});

	it('retries a lock wait timeout with a doubling backoff, then succeeds', async () => {
		const h = harness([lockWaitError(), lockWaitError()]);
		expect(await quietly(() => runDdl(h.args))).to.equal('ok');
		expect(h.attempts).to.have.length(3);
		expect(h.sleeps).to.deep.equal([100, 200]);
	});

	it('gives up after the configured retries with an error naming the table and the statement', async () => {
		const h = harness([lockWaitError(), lockWaitError(), lockWaitError()]);
		let caught;
		try {
			await quietly(() => runDdl(h.args));
		} catch (ex) {
			caught = ex;
		}
		expect(h.attempts).to.have.length(3);
		expect(h.sleeps).to.deep.equal([100, 200]);
		expect(caught).to.be.an('error');
		expect(caught.message).to.include('`widgets`');
		expect(caught.message).to.include(sql);
		expect(caught.message).to.match(/3 attempts/);
		expect(caught.message).to.match(/lock_wait_timeout = 10/);
		// Still recognisable as the driver's error.
		expect(caught.errno).to.equal(1205);
		expect(caught.code).to.equal('ER_LOCK_WAIT_TIMEOUT');
		expect(caught.cause).to.be.an('error');
	});

	// A table-copy ALTER takes its exclusive lock at the END of the copy. One
	// that times out there has already done the copy; a retry would do it again.
	it('does not retry a statement that timed out only after running for a long time', async () => {
		const h = harness([lockWaitError()]);
		let clock = 0;
		const { pquery } = h.args.handle;
		h.args.handle.pquery = async (...args) => {
			clock += 600000;
			return pquery(...args);
		};
		let caught;
		try {
			await runDdl({ ...h.args, now: () => clock });
		} catch (ex) {
			caught = ex;
		}
		expect(h.attempts).to.have.length(1);
		expect(h.sleeps).to.deep.equal([]);
		expect(caught.message).to.match(/after running for 600s/);
		expect(caught.message).to.include(sql);
		expect(caught.errno).to.equal(1205);
	});

	it('does not retry any other error', async () => {
		const duplicate = Object.assign(new Error('Duplicate column name'), {
			errno: 1060,
		});
		const h = harness([duplicate]);
		let caught;
		try {
			await runDdl(h.args);
		} catch (ex) {
			caught = ex;
		}
		expect(caught).to.equal(duplicate);
		expect(h.attempts).to.have.length(1);
	});
});

describe('#schemaSync DDL lock-wait timeout (db-backed)', function lockTimeoutSuite() {
	this.timeout(180000);

	const WATCHDOG_MS = 45000;
	const tables = [];
	const blockers = [];
	const overridden = [
		'ddlLockWaitTimeout',
		'ddlLockWaitRetries',
		'ddlLockWaitRetryDelayMs',
	];
	const original = {};

	const sync = (def) => syncSchemaToDb(YassORM.convertDefinition(def));
	const base =
		(table) =>
		({ types: t }) => ({ table, schema: { id: t.idKey, name: t.string } });
	const plusNotice =
		(table) =>
		({ types: t }) => ({
			table,
			schema: { id: t.idKey, name: t.string, notice: t.string },
		});
	const hasColumn = async (table, column) =>
		(await (await dbh()).pquery(`SHOW COLUMNS FROM \`${table}\``)).some(
			(r) => r.Field === column,
		);

	/**
	 * Hold a shared metadata lock on `table`, the way any open transaction that
	 * has read it does: an ALTER waits for it until release(). A watchdog
	 * releases it regardless, so the suite fails (rather than hangs) on a sync
	 * that waits without a timeout.
	 */
	const holdMetadataLock = async (table) => {
		const pool = await dbh({ ignoreCachedConnections: true });
		const conn = await pool.getConnection();
		await conn.query('START TRANSACTION');
		await conn.query(`SELECT * FROM \`${table}\` LIMIT 1`);
		const blocker = { releasedByWatchdog: false, released: false };
		blocker.release = async () => {
			if (blocker.released) return;
			blocker.released = true;
			clearTimeout(blocker.timer);
			await conn.query('ROLLBACK');
			await conn.release();
			await pool.end();
		};
		blocker.timer = setTimeout(() => {
			blocker.releasedByWatchdog = true;
			blocker.release().catch(() => {});
		}, WATCHDOG_MS);
		blockers.push(blocker);
		return blocker;
	};

	before(function beforeLockTimeoutSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
		overridden.forEach((key) => {
			original[key] = config[key];
		});
	});

	afterEach(async () => {
		overridden.forEach((key) => {
			config[key] = original[key];
		});
		// eslint-disable-next-line no-restricted-syntax
		for (const blocker of blockers.splice(0)) {
			// eslint-disable-next-line no-await-in-loop
			await blocker.release();
		}
	});

	after(async () => {
		const conn = await dbh();
		// eslint-disable-next-line no-restricted-syntax
		for (const table of tables) {
			// eslint-disable-next-line no-await-in-loop
			await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
		}
	});

	it('runs the DDL under the short timeout on its own connection, and leaves the pool as it found it', async () => {
		const handle = await dbh();
		const [{ globalTimeout }] = await handle.pquery(
			'SELECT @@GLOBAL.lock_wait_timeout AS globalTimeout',
		);
		const rows = await runDdl({
			dialect: handle.dialect,
			handle,
			sql: 'SELECT @@SESSION.lock_wait_timeout AS sessionTimeout',
			settings: { timeoutSeconds: 7, retries: 0, retryDelayMs: 0 },
		});
		expect(Number(rows[0].sessionTimeout)).to.equal(7);

		// Every connection in the pool, the one just used included.
		const leased = await Promise.all(
			Array.from({ length: handle.totalConnections() }, () =>
				handle.getConnection(),
			),
		);
		try {
			const timeouts = await Promise.all(
				leased.map(async (conn) =>
					Number(
						(
							await conn.query('SELECT @@SESSION.lock_wait_timeout AS v')
						)[0].v,
					),
				),
			);
			expect(timeouts).to.have.length.greaterThan(0);
			expect([...new Set(timeouts)]).to.deep.equal([Number(globalTimeout)]);
		} finally {
			await Promise.all(leased.map((conn) => conn.release()));
		}
	});

	it('errors out, naming the table and the statement, when the metadata lock cannot be had', async () => {
		const table = `yass_ddl_lock_a_${uuid().replace(/-/g, '')}`;
		tables.push(table);
		await sync(base(table));

		config.ddlLockWaitTimeout = 1;
		config.ddlLockWaitRetries = 1;
		config.ddlLockWaitRetryDelayMs = 50;

		const blocker = await holdMetadataLock(table);
		const originalError = console.error;
		const originalWarn = console.warn;
		const warned = [];
		console.error = () => {};
		console.warn = (...args) => warned.push(args.map((a) => `${a}`).join(' '));
		let result;
		try {
			result = await sync(plusNotice(table));
		} finally {
			console.error = originalError;
			console.warn = originalWarn;
		}

		expect(
			blocker.releasedByWatchdog,
			'the sync waited on the metadata lock until the watchdog released it',
		).to.equal(false);
		// One error: the ALTER. Not a second one from re-issuing it to "heal"
		// the missing column, which would only wait on the same lock again.
		expect(result.errors, JSON.stringify(result.errors)).to.have.length(1);
		const [{ error, sql }] = result.errors;
		expect(sql).to.match(/^ALTER TABLE .* ADD `notice`/);
		expect(error.errno).to.equal(1205);
		expect(error.message).to.include(table);
		expect(error.message).to.include('ADD `notice`');
		expect(error.message).to.match(/2 attempts/);
		expect(
			warned.filter((line) => /lock wait timeout.*retry/i.test(line)),
		).to.have.length(1);

		await blocker.release();
		expect(await hasColumn(table, 'notice')).to.equal(false);

		// With the lock gone the next sync applies it.
		expect((await sync(plusNotice(table))).errors).to.deep.equal([]);
		expect(await hasColumn(table, 'notice')).to.equal(true);
	});

	it('retries, and succeeds once the lock is released', async () => {
		const table = `yass_ddl_lock_b_${uuid().replace(/-/g, '')}`;
		tables.push(table);
		await sync(base(table));

		config.ddlLockWaitTimeout = 1;
		config.ddlLockWaitRetries = 5;
		config.ddlLockWaitRetryDelayMs = 500;

		const blocker = await holdMetadataLock(table);
		const originalWarn = console.warn;
		const retryWarnings = [];
		// Release the lock as soon as the first attempt has timed out, so the
		// retry is what applies the change.
		console.warn = (...args) => {
			const line = args.map((a) => `${a}`).join(' ');
			if (/lock wait timeout.*retry/i.test(line)) {
				retryWarnings.push(line);
				blocker.release().catch(() => {});
			}
		};
		let result;
		try {
			result = await sync(plusNotice(table));
		} finally {
			console.warn = originalWarn;
		}

		expect(
			blocker.releasedByWatchdog,
			'the sync waited on the metadata lock until the watchdog released it',
		).to.equal(false);
		expect(retryWarnings).to.have.length.greaterThan(0);
		expect(result.errors).to.deep.equal([]);
		expect(await hasColumn(table, 'notice')).to.equal(true);
	});
});
