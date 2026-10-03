/**
 * Refuses to run the suite against a database that may hold real data. The
 * tests drop and recreate tables, so the configured database must say it is
 * a test database (`test` as a word of its name: `test`, `yass_test`,
 * `test2`), and a server's default port (MySQL 3306, Postgres 5432, where a
 * live server usually listens; on r730, 5432 is live dev data) needs an
 * explicit opt-in: YASS_TEST_ALLOW_PORT=<port>. SQLite is not checked.
 *
 * Loaded by mocha before any test file (.mocharc.js `require`). It reads the
 * config file itself, as lib/config.js would find it, rather than through
 * lib/config.js, so it doesn't load yass's config early (the lazy-config
 * tests depend on that).
 */
const findConfig = require('find-config');

const DEFAULT_PORTS = {
	mysql: 3306,
	mariadb: 3306,
	postgres: 5432,
	postgresql: 5432,
};
const TEST_NAME = /(?:^|[_-])test(?:s|\d+)?(?:$|[_-])/i;

// The development config the suite connects with (tests run as development)
function testConfig(env = process.env) {
	const file =
		env.YASS_CONFIG ||
		findConfig('.yass-orm.cjs') ||
		findConfig('.yass-orm.js');
	if (!file) return null;
	// eslint-disable-next-line global-require, import/no-dynamic-require
	const user = require(file);
	const yassEnv = env.YASS_ENV || env.NODE_ENV || 'development';
	return {
		...(user.shared || {}),
		...(user[yassEnv] || user.development || {}),
		file,
	};
}

/**
 * @returns {string|null} Why the suite must not run against `config`, or null
 */
function refusal(config, env = process.env) {
	const dialect = `${config.dialect || 'mysql'}`.toLowerCase();
	if (!(dialect in DEFAULT_PORTS)) return null; // SQLite: a local file

	const names = [config.schema, config.schema2].filter((n) => n !== undefined);
	if (!names.length) names.push('');
	const bad = names.find((name) => !TEST_NAME.test(`${name}`));
	if (bad !== undefined) {
		return `database "${bad}" does not look like a test database (its name needs "test" as a word, like yass_test or test2)`;
	}

	const port = Number(config.port || DEFAULT_PORTS[dialect]);
	if (
		port === DEFAULT_PORTS[dialect] &&
		Number(env.YASS_TEST_ALLOW_PORT) !== port
	) {
		return `port ${port} is ${dialect}'s default port, where a live server usually runs; point the config at a test server, or set YASS_TEST_ALLOW_PORT=${port} if this one is safe`;
	}
	return null;
}

function guard() {
	const config = testConfig();
	if (!config) return;
	const why = refusal(config);
	if (why) {
		throw new Error(
			`[yass-orm tests] refusing to run: ${why} (config: ${config.file})`,
		);
	}
}

module.exports = { guard, refusal, testConfig };
