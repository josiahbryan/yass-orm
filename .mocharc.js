// Every mocha run (npm test, test:postgres, test:dialects, a single file)
// first checks the configured database is a test one: see
// test/helpers/live-db-guard.js.
module.exports = {
	require: ['test/helpers/mocha-db-guard.js'],
};
