/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require */
const fs = require('fs');
const util = require('util');
const findConfig = require('find-config');

// The config is found and loaded on first use (the first time any property of
// the exported object is read, written, listed or inspected), not at
// `require` time. So requiring yass never throws or prints, and YASS_CONFIG,
// YASS_ENV and NODE_ENV may still be set after `require` and before first use.

const defaultConfig = {
	// Users can set custom base class here,
	// which loadDefinition would then inherit from
	// instead of straight from DatabaseObject
	baseClass: undefined,

	development: {
		// Database dialect: 'mysql' (default), 'mariadb', 'sqlite', 'sqlite3', 'postgres', 'postgresql'
		// For SQLite, use 'filename' instead of host/user/password
		dialect: 'mysql',
		host: 'localhost',
		user: 'root',
		password: '',
		schema: '',
		charset: 'utf8mb4',
		ssl: false,
		port: 3306,
		// OPT-IN (default OFF), MySQL/MariaDB: 'utc' sets every connection's
		// session time zone to UTC, so NOW() agrees with the UTC times yass
		// writes. Unset = the server's zone, as always. See README "Time zones".
		timezone: undefined,
		// SQLite-specific: path to database file (use ':memory:' for in-memory)
		// filename: ':memory:',
		// uuidLinkedIds is required for id: t.uuidKey to work with t.linked - applies to ALL fields
		uuidLinkedIds: false,
		// OPT-IN (default OFF): give char(36) `t.linked` / `t.uuid` columns (and the
		// varchar(36) link columns of `stringLinkedIds`) the SAME collation as the id
		// PRIMARY KEY (utf8mb4_bin) so cross-column JOINs stay index-sargable and exact.
		// OFF = zero behavior change (no collation emitted).
		//   true            -> canonical utf8mb4_bin (matches the PK by construction)
		//   '<collation>'   -> explicit override
		// NOTE: enabling this changes NEW columns immediately, but EXISTING columns are
		// only reported (not rebuilt) by schema-sync unless migrateLinkCollation is set --
		// use the resumable batch runner (bin/migrate-link-collation) for existing data.
		// (Existing varchar(36) stringLinkedIds link columns are not deferred: schema-sync
		// changes them directly.)
		linkColumnCollation: undefined,
		// OPT-IN (default OFF): allow ordinary schema-sync to APPLY the collation-only
		// canonicalization on existing columns (a full-table rebuild each). Leave OFF and
		// use the dedicated resumable batch runner for a controlled/overnight migration.
		migrateLinkCollation: undefined,
		// Off by default, opt-in, if true, then you can override default schema in
		// schema definition files with dot notation, such as "schema.tableName"
		// This has the knock-on effect of requiring you to update any tables where
		// you use dot notation to specify the ID field, like "foobar.foobarId" to also
		// include the schema name if you enable this field. So that example would
		// become: "foobarSchema.foobar.foobarId"
		enableAlternateSchemaInTableName: false,
		commonFields: (t) => {
			return {
				isDeleted: t.bool,
				nonce: t.string,
				createdAt: t.datetime,
				updatedAt: t.datetime,
			};
		},

		// If provided, any non-disabled readonlyNodes will be used for
		// SELECT queries, and only the master node (above) will be
		// used for UPDATE/INSERT queries
		readonlyNodes: [
			{
				disabled: true,
				host: 'localhost',
				user: 'root',
				password: '',
				ssl: false,
				port: 3306,
			},
		],

		// New option - default for most connections was 1s by the libraries.
		// Increasing to 3s for more reliable connections for intercontinental connections (e.g. India>SF)
		// (If not specified in config, our DBH code will default to 3sec)
		connectTimeout: 3_000,

		// Connection pool limit - default is 10, can be increased for high-concurrency applications
		// or applications dealing with large objects that take longer to process.
		// Each connection in the pool can handle one query at a time.
		// Increase this if you see "retrieve connection from pool timeout" errors.
		connectionLimit: 10,
		// Floor of connections the pool keeps open. The mariadb driver defaults
		// this to `connectionLimit`, which means `idleTimeout` never reaps
		// anything -- the pool grows to its limit and holds it for the life of
		// the process. Leave undefined to keep that driver default; set it lower
		// (e.g. 0) when a long-lived process or a test suite should hand idle
		// connections back to the server.
		minimumIdle: undefined,
		// How long an acquire waits for a free connection before failing with
		// errno 45028. Undefined = driver default (10s).
		acquireTimeout: undefined,
		// SESSION lock_wait_timeout (SECONDS) applied around every trigger
		// DDL statement schema-sync emits (CREATE/DROP TRIGGER take a
		// metadata lock and would otherwise queue behind long writes on a
		// hot table). Restored to the prior value in a finally, so a hang
		// surfaces as an error in the sync's error list, not a stall. Set
		// to 0 to leave the session default in place. See the `Declared
		// triggers` section of README.md for the reconciler this gates.
		triggerLockWaitTimeout: 60,
	},

	production: {
		// Database dialect: 'mysql' (default), 'mariadb', 'sqlite', 'sqlite3', 'postgres', 'postgresql'
		dialect: 'mysql',
		host: 'localhost',
		user: 'root',
		password: '',
		schema: '',
		charset: 'utf8mb4',
		ssl: false,
		port: 3306,
		// OPT-IN, MySQL/MariaDB: 'utc' = every session in UTC. See development above.
		timezone: undefined,
		// uuidLinkedIds is required for id: t.uuidKey to work with t.linked - applies to ALL fields
		uuidLinkedIds: false,
		// OPT-IN (default OFF): give char(36) `t.linked` / `t.uuid` columns (and the
		// varchar(36) link columns of `stringLinkedIds`) the SAME collation as the id
		// PRIMARY KEY (utf8mb4_bin) so cross-column JOINs stay index-sargable and exact.
		// OFF = zero behavior change (no collation emitted).
		//   true            -> canonical utf8mb4_bin (matches the PK by construction)
		//   '<collation>'   -> explicit override
		// NOTE: enabling this changes NEW columns immediately, but EXISTING columns are
		// only reported (not rebuilt) by schema-sync unless migrateLinkCollation is set --
		// use the resumable batch runner (bin/migrate-link-collation) for existing data.
		// (Existing varchar(36) stringLinkedIds link columns are not deferred: schema-sync
		// changes them directly.)
		linkColumnCollation: undefined,
		// OPT-IN (default OFF): allow ordinary schema-sync to APPLY the collation-only
		// canonicalization on existing columns (a full-table rebuild each). Leave OFF and
		// use the dedicated resumable batch runner for a controlled/overnight migration.
		migrateLinkCollation: undefined,
		// Off by default, opt-in, if true, then you can override default schema in
		// schema definition files with dot notation, such as "schema.tableName"
		// This has the knock-on effect of requiring you to update any tables where
		// you use dot notation to specify the ID field, like "foobar.foobarId" to also
		// include the schema name if you enable this field. So that example would
		// become: "foobarSchema.foobar.foobarId"
		enableAlternateSchemaInTableName: false,
		commonFields: (t) => {
			return {
				isDeleted: t.bool,
				nonce: t.string,
				createdAt: t.datetime,
				updatedAt: t.datetime,
			};
		},

		// If provided, any non-disabled readonlyNodes will be used for
		// SELECT queries, and only the master node (above) will be
		// used for UPDATE/INSERT queries
		readonlyNodes: [
			{
				disabled: true,
				host: 'localhost',
				user: 'root',
				password: '',
				ssl: false,
				port: 3306,
			},
		],

		// Connection pool limit - default is 10, can be increased for high-concurrency applications
		// or applications dealing with large objects that take longer to process.
		// Each connection in the pool can handle one query at a time.
		// Increase this if you see "retrieve connection from pool timeout" errors.
		connectionLimit: 10,
		// Floor of connections the pool keeps open. The mariadb driver defaults
		// this to `connectionLimit`, which means `idleTimeout` never reaps
		// anything -- the pool grows to its limit and holds it for the life of
		// the process. Leave undefined to keep that driver default; set it lower
		// (e.g. 0) when a long-lived process or a test suite should hand idle
		// connections back to the server.
		minimumIdle: undefined,
		// How long an acquire waits for a free connection before failing with
		// errno 45028. Undefined = driver default (10s).
		acquireTimeout: undefined,
		// SESSION lock_wait_timeout (SECONDS) applied around every trigger
		// DDL statement schema-sync emits. See development config above.
		triggerLockWaitTimeout: 60,
	},
};

// Just copy prod config for now
defaultConfig.staging = defaultConfig.production;

function loadConfig() {
	const userConfigFile =
		process.env.YASS_CONFIG ||
		findConfig('.yass-orm.cjs') ||
		findConfig('.yass-orm.js') ||
		findConfig('.yass-orm.cjs', { cwd: __dirname }) ||
		findConfig('.yass-orm.js', { cwd: __dirname });

	let userConfig = {};
	if (userConfigFile && fs.existsSync(userConfigFile)) {
		userConfig = require(userConfigFile);
	} else {
		console.log(
			`[YASS-ORM] User config doesn't exist at ${userConfigFile} using defaults`,
		);
	}

	if (!process.env.NODE_ENV) {
		console.warn(
			'NODE_ENV should be set for YassORM configs to work correctly in prod - assuming running in development',
		);
	}

	// Allow dedicated override for just Yass for the env
	const env = process.env.YASS_ENV || process.env.NODE_ENV || 'development';

	if (!['development', 'staging', 'production'].includes(env)) {
		throw new Error(`Unknown config env for YassORM: ${env}`);
	}

	return {
		// Load default config for env first, or use development of no matching env
		...(defaultConfig[env] || defaultConfig.development || {}),
		// Apply user's shared configs for all envs
		...(userConfig.shared || {}),
		// Finally, apply user's env-specific configs
		...(userConfig[env] || userConfig.development || {}),
	};
}

// The proxy's target IS the config: empty until first use, then filled in
// once. Every trap loads first and then does the default thing to the target,
// so reads, writes, `in`, Object.keys, spread and JSON all behave exactly as
// they did on the plain object this module used to export. A failed load
// (unknown env) is not remembered, so the next use tries again.
const configInstance = {};
let loaded = false;
const ensureLoaded = () => {
	if (!loaded) {
		Object.assign(configInstance, loadConfig());
		loaded = true;
	}
	return configInstance;
};

// util.inspect (console.log) looks at a proxy's target without going through
// the traps, so it would show `{}` before first use. Non-enumerable, so keys,
// spread and JSON never see it.
Object.defineProperty(configInstance, util.inspect.custom, {
	value: ensureLoaded,
});

const lazyTrap =
	(trap) =>
	(target, ...args) =>
		Reflect[trap](ensureLoaded(), ...args);

module.exports = new Proxy(
	configInstance,
	Object.fromEntries(
		[
			'get',
			'set',
			'has',
			'deleteProperty',
			'ownKeys',
			'getOwnPropertyDescriptor',
			'defineProperty',
		].map((trap) => [trap, lazyTrap(trap)]),
	),
);

// Used to extract config from schema-sync
if (process.argv[1] === __filename) {
	const { jsonSafeStringify } = require('./jsonSafeStringify');
	console.log(jsonSafeStringify(module.exports, 0));
}
