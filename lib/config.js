"use strict";
const fs = require('fs');
const findConfig = require('find-config');
const userConfigFile = findConfig('.yass-orm.js');

let userConfig = {};
if(userConfigFile && fs.existsSync(userConfigFile)) {
	userConfig = require(userConfigFile);
} else {
	console.log(`[YASS-ORM] User config doesn't exist at ${userConfigFile} using defaults`);
}

const env = process.env.NODE_ENV || 'development';

const defaultConfig = {
	development: {
		host: 'localhost',
		user: 'root',
		password: '',
		schema: '',
		charset: 'utf8mb4',
		commonFields: t => {
			return {
				isDeleted: t.bool,
				createdAt: t.datetime,
				updatedAt: t.datetime,
			}
		}
	},

	production: {
		host: 'localhost',
		user: 'root',
		password: '',
		schema: '',
		charset: 'utf8mb4',
		commonFields: t => {
			return {
				isDeleted: t.bool,
				createdAt: t.datetime,
				updatedAt: t.datetime,
			}
		}
	}
}

const configInstance = { 
	// Load default config for env first, or use development of no matching env
	...(defaultConfig[env] || defaultConfig.development || {}),
	// Apply user's shared configs for all envs
	...(userConfig.shared  || {}),
	// Finally, apply user's env-specific configs
	...(userConfig[env]    || userConfig.development    || {})
}

module.exports = configInstance;

// Used to extract config from schema-sync
if(process.argv[1] === __filename) {
	console.log(JSON.stringify(configInstance));
}