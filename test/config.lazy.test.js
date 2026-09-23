/* global describe, it, before, after */
const { expect } = require('chai');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * `lib/config.js` finds and loads the config on first use, not at `require`.
 *
 * Each case runs in a fresh child process, because what is under test is what
 * happens at `require` time, and mocha's own process has long since loaded the
 * config.
 */
describe('#YASS-ORM config loaded on first use', function lazyConfigSuite() {
	this.timeout(30000);

	const libDir = path.resolve(__dirname, '../lib');
	let tmpDir;
	let fixtureConfig;
	let sqliteConfig;
	let sqliteFile;

	// Run `script` in a fresh node with none of the yass env variables set,
	// from a directory that holds no config file.
	const runChild = (script, env = {}) => {
		const childEnv = { ...process.env };
		['YASS_CONFIG', 'YASS_ENV', 'NODE_ENV', 'YASS_DEBUG'].forEach((key) => {
			delete childEnv[key];
		});
		const result = spawnSync(process.execPath, ['-e', script], {
			cwd: tmpDir,
			env: { ...childEnv, LIB: libDir, ...env },
			encoding: 'utf8',
		});
		return result;
	};

	// Parses the last stdout line the child printed with `emit(...)`.
	const EMIT = `const emit = (v) => process.stdout.write('\\n' + JSON.stringify(v));`;
	const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').pop());

	before(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yass-lazy-config-'));
		fixtureConfig = path.join(tmpDir, 'fixture.yass-orm.js');
		fs.writeFileSync(
			fixtureConfig,
			`module.exports = {
				development: {
					host: 'dev-host',
					schema: 'dev_schema',
					readBalanceStrategy: 'random',
				},
				production: { host: 'prod-host' },
				shared: { user: 'shared-user', schema: 'shared_schema' },
			};`,
		);
		sqliteFile = path.join(tmpDir, 'late.sqlite');
		sqliteConfig = path.join(tmpDir, 'sqlite.yass-orm.js');
		fs.writeFileSync(
			sqliteConfig,
			`module.exports = {
				development: { dialect: 'sqlite', filename: ${JSON.stringify(
					sqliteFile,
				)}, schema: 'main' },
				shared: {
					commonFields: (t) => ({ isDeleted: t.bool, lateCommon: t.string }),
				},
			};`,
		);
	});

	after(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('requiring yass or lib/config.js with an unknown env neither throws nor prints', () => {
		const result = runChild(
			`require(process.env.LIB); require(process.env.LIB + '/config.js');
			require(process.env.LIB + '/dbh'); require(process.env.LIB + '/sync-to-db');
			require(process.env.LIB + '/def-to-schema');`,
			{ NODE_ENV: 'bogus' },
		);
		expect(result.stderr).to.equal('');
		expect(result.stdout).to.equal('');
		expect(result.status).to.equal(0);
	});

	it('throws the unknown-env error on first use, and loads once the env is fixed', () => {
		const result = runChild(
			`${EMIT}
			const { config } = require(process.env.LIB);
			let error;
			try { config.host; } catch (e) { error = e.message; }
			process.env.NODE_ENV = 'development';
			process.env.YASS_CONFIG = ${JSON.stringify(fixtureConfig)};
			emit({ error, host: config.host });`,
			{ NODE_ENV: 'bogus' },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			error: 'Unknown config env for YassORM: bogus',
			host: 'dev-host',
		});
	});

	it('keeps working with a guarded lazy read (Rubber datastoreTier pattern)', () => {
		const result = runChild(
			`${EMIT}
			let host; let reason;
			try {
				const ormModule = process.env.LIB;
				const config = require(ormModule)?.config;
				host = config?.host;
			} catch (e) { reason = e.message; }
			emit({ host: host === undefined ? null : host, reason });`,
			{ NODE_ENV: 'test' },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			host: null,
			reason: 'Unknown config env for YassORM: test',
		});
	});

	it('honors YASS_CONFIG set after require but before first use', () => {
		const result = runChild(
			`${EMIT}
			const config = require(process.env.LIB + '/config.js');
			process.env.YASS_CONFIG = ${JSON.stringify(fixtureConfig)};
			emit({ host: config.host, user: config.user, schema: config.schema });`,
			{ NODE_ENV: 'development' },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			host: 'dev-host',
			user: 'shared-user',
			schema: 'dev_schema',
		});
	});

	it('prints the missing-config notice only on first use, and only once', () => {
		const result = runChild(
			`const config = require(process.env.LIB + '/config.js');
			process.stdout.write('REQUIRED\\n');
			config.host; config.schema; Object.keys(config);`,
			{
				NODE_ENV: 'development',
				YASS_CONFIG: path.join(os.tmpdir(), 'no-such-yass-config.js'),
			},
		);
		expect(result.status, result.stderr).to.equal(0);
		const lines = result.stdout.trim().split('\n');
		expect(lines[0]).to.equal('REQUIRED');
		expect(lines.slice(1)).to.have.length(1);
		expect(lines[1]).to.include("User config doesn't exist");
	});

	it('is one object: the `config` export and lib/config.js, with the eager values', () => {
		const result = runChild(
			`${EMIT}
			const { config } = require(process.env.LIB);
			const direct = require(process.env.LIB + '/config.js');
			emit({
				same: config === direct,
				keys: Object.keys(config),
				spreadKeys: Object.keys({ ...config }),
				json: JSON.parse(JSON.stringify(config)),
				spreadJson: JSON.parse(JSON.stringify({ ...config })),
				assigned: JSON.parse(JSON.stringify(Object.assign({}, config))),
				hasHost: 'host' in config,
				commonFields: typeof config.commonFields,
				inspected: require('util').inspect(config).includes("'dev-host'"),
			});`,
			{ NODE_ENV: 'development', YASS_CONFIG: fixtureConfig },
		);
		expect(result.status, result.stderr).to.equal(0);
		const out = lastJson(result.stdout);
		expect(out.same).to.equal(true);
		expect(out.keys).to.deep.equal(out.spreadKeys);
		expect(out.keys).to.include.members([
			'dialect',
			'host',
			'user',
			'password',
			'schema',
			'charset',
			'port',
			'commonFields',
			'readonlyNodes',
			'connectTimeout',
			'connectionLimit',
			'triggerLockWaitTimeout',
		]);
		expect(out.json).to.deep.equal(out.spreadJson);
		expect(out.json).to.deep.equal(out.assigned);
		expect(out.json).to.include({
			dialect: 'mysql',
			host: 'dev-host',
			user: 'shared-user',
			password: '',
			schema: 'dev_schema',
			charset: 'utf8mb4',
			port: 3306,
			connectTimeout: 3000,
			connectionLimit: 10,
			triggerLockWaitTimeout: 60,
		});
		expect(out.hasHost).to.equal(true);
		expect(out.commonFields).to.equal('function');
		expect(out.inspected).to.equal(true);
	});

	it('uses the production defaults and overrides for YASS_ENV=production and staging', () => {
		['production', 'staging'].forEach((yassEnv) => {
			const result = runChild(
				`${EMIT}
				const config = require(process.env.LIB + '/config.js');
				emit({ host: config.host, user: config.user, hasConnectTimeout: 'connectTimeout' in config });`,
				{ YASS_ENV: yassEnv, YASS_CONFIG: fixtureConfig },
			);
			expect(result.status, result.stderr).to.equal(0);
			// staging has no user section of its own, so it falls back to development's.
			expect(lastJson(result.stdout)).to.deep.equal({
				host: yassEnv === 'production' ? 'prod-host' : 'dev-host',
				user: 'shared-user',
				// The production defaults carry no connectTimeout; development's do.
				hasConnectTimeout: false,
			});
		});
	});

	it('writes and deletes through to the loaded config', () => {
		const result = runChild(
			`${EMIT}
			const config = require(process.env.LIB + '/config.js');
			config.uuidLinkedIds = true;
			delete config.host;
			emit({ uuid: config.uuidLinkedIds, hasHost: 'host' in config, schema: config.schema });`,
			{ NODE_ENV: 'development', YASS_CONFIG: fixtureConfig },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			uuid: true,
			hasHost: false,
			schema: 'dev_schema',
		});
	});

	it('takes the read-balance strategy from the config at use time, until something sets it', () => {
		const result = runChild(
			`${EMIT}
			const { loadBalancerManager } = require(process.env.LIB + '/dbh');
			process.env.YASS_CONFIG = ${JSON.stringify(fixtureConfig)};
			const fromConfig = [loadBalancerManager.strategy, loadBalancerManager.defaultStrategy];
			loadBalancerManager.strategy = 'roundRobin';
			emit({
				fromConfig,
				afterSet: [loadBalancerManager.strategy, loadBalancerManager.defaultStrategy],
			});`,
			{ NODE_ENV: 'development' },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			fromConfig: ['random', 'random'],
			afterSet: ['roundRobin', 'random'],
		});
	});

	it('does not copy the whole config on every dbh() call (the per-query path)', () => {
		// Wrap the config in a proxy that counts enumerations (spread,
		// Object.keys) before dbh.js requires it, then check that a cached
		// dbh() only reads the handful of values its cache key needs.
		const result = runChild(
			`${EMIT}
			const lib = process.env.LIB;
			const configPath = require.resolve(lib + '/config.js');
			const real = require(configPath);
			let enumerations = 0;
			require.cache[configPath].exports = new Proxy(real, {
				ownKeys: (t) => { enumerations += 1; return Reflect.ownKeys(real); },
			});
			const { dbh } = require(lib + '/dbh');
			(async () => {
				const first = await dbh();
				enumerations = 0;
				const second = await dbh();
				await dbh();
				emit({ same: first === second, enumerations });
				process.exit(0);
			})().catch((e) => { console.error(e); process.exit(1); });`,
			{ NODE_ENV: 'development', YASS_CONFIG: sqliteConfig },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			same: true,
			enumerations: 0,
		});
	});

	it('dbh, def-to-schema and schema sync read a config set after they were required', () => {
		const result = runChild(
			`${EMIT}
			const lib = process.env.LIB;
			const { dbh } = require(lib + '/dbh');
			const { syncSchemaToDb } = require(lib + '/sync-to-db');
			const { convertDefinition } = require(lib + '/def-to-schema');
			process.env.YASS_CONFIG = ${JSON.stringify(sqliteConfig)};
			(async () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'yass_late_config',
					includeCommonFields: true,
					schema: { id: t.idKey, name: t.string },
				}));
				await syncSchemaToDb(schema);
				const conn = await dbh();
				const columns = await conn.pquery("SELECT name FROM pragma_table_info('yass_late_config')");
				emit({ dialect: conn.dialect.name, columns: columns.map((c) => c.name).sort() });
				process.exit(0);
			})().catch((e) => { console.error(e); process.exit(1); });`,
			{ NODE_ENV: 'development' },
		);
		expect(result.status, result.stderr).to.equal(0);
		expect(lastJson(result.stdout)).to.deep.equal({
			dialect: 'sqlite',
			columns: ['id', 'isDeleted', 'lateCommon', 'name'],
		});
	});
});
