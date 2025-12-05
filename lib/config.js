/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require */
const fs = require('fs');
const findConfig = require('find-config');

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

const defaultConfig = {
	// Users can set custom base class here,
	// which loadDefinition would then inherit from
	// instead of straight from DatabaseObject
	baseClass: undefined,

	development: {
		host: 'localhost',
		user: 'root',
		password: '',
		schema: '',
		charset: 'utf8mb4',
		ssl: false,
		port: 3306,
		// uuidLinkedIds is required for id: t.uuidKey to work with t.linked - applies to ALL fields
		uuidLinkedIds: false,
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
	},

	production: {
		host: 'localhost',
		user: 'root',
		password: '',
		schema: '',
		charset: 'utf8mb4',
		ssl: false,
		port: 3306,
		// uuidLinkedIds is required for id: t.uuidKey to work with t.linked - applies to ALL fields
		uuidLinkedIds: false,
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
	},
};

// Just copy prod config for now
defaultConfig.staging = defaultConfig.production;

const configInstance = {
	// Load default config for env first, or use development of no matching env
	...(defaultConfig[env] || defaultConfig.development || {}),
	// Apply user's shared configs for all envs
	...(userConfig.shared || {}),
	// Finally, apply user's env-specific configs
	...(userConfig[env] || userConfig.development || {}),
};

module.exports = configInstance;

// Used to extract config from schema-sync
if (process.argv[1] === __filename) {
	console.log(JSON.stringify(configInstance));
}
