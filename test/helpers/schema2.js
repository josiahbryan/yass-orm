const config = require('../../lib/config');

/**
 * The second database the tests use (cross-database tables and trigger
 * scoping). `schema2` in the test config, so parallel runs can each have
 * their own; defaults to `yass_test2`. It must exist beforehand, like the
 * main schema: `CREATE DATABASE yass_test2`.
 *
 * @returns {string}
 */
const schema2 = () => config.schema2 || 'yass_test2';

module.exports = { schema2 };
