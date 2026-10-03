/* global describe, it */
const path = require('path');
const { execFile } = require('child_process');
const { expect } = require('chai');
const { refusal } = require('./helpers/live-db-guard');

const REPO = path.join(__dirname, '..');

/**
 * The suite refuses to run against a database that may hold real data: one
 * whose name doesn't say it is a test database, or one on a server's default
 * port (3306, 5432; where a live server usually is), unless that port is
 * opted into with YASS_TEST_ALLOW_PORT. (On r730, 5432 is live dev data.)
 */
describe('live database guard', () => {
	const mysql = { dialect: 'mysql', port: 13306, schema: 'yass_test' };

	it('allows a test database on a non-default port', () => {
		expect(refusal(mysql, {})).to.equal(null);
		expect(
			refusal({ ...mysql, schema: 'test', schema2: 'test2' }, {}),
		).to.equal(null);
		expect(
			refusal(
				{ dialect: 'postgres', port: 15432, schema: 'yass_cancel_test' },
				{},
			),
		).to.equal(null);
	});

	it('refuses a database whose name does not say test', () => {
		expect(refusal({ ...mysql, schema: 'rubber' }, {})).to.match(
			/"rubber".*test/,
		);
		expect(refusal({ ...mysql, schema2: 'prod_copy' }, {})).to.match(
			/"prod_copy"/,
		);
		expect(refusal({ ...mysql, schema: '' }, {})).to.be.a('string');
		expect(refusal({ ...mysql, schema: 'contest' }, {})).to.be.a('string');
	});

	it('refuses a default port (or none) unless that port is opted into', () => {
		const pg = { dialect: 'postgres', port: 5432, schema: 'test' };
		expect(refusal(pg, {})).to.match(/5432.*YASS_TEST_ALLOW_PORT=5432/);
		expect(refusal(pg, { YASS_TEST_ALLOW_PORT: '5432' })).to.equal(null);
		expect(refusal(pg, { YASS_TEST_ALLOW_PORT: '3306' })).to.be.a('string');
		expect(refusal({ ...mysql, port: 3306 }, {})).to.match(/3306/);
		expect(refusal({ ...mysql, port: undefined }, {})).to.match(/3306/);
		expect(refusal({ dialect: 'postgresql', schema: 'test' }, {})).to.match(
			/5432/,
		);
		expect(refusal({ ...mysql, port: '3306' }, {})).to.match(/3306/);
	});

	it('never checks SQLite', () => {
		expect(refusal({ dialect: 'sqlite', schema: 'anything' }, {})).to.equal(
			null,
		);
	});

	it('stops mocha before any test runs with the tracked Postgres config (port 5432)', function stops(done) {
		this.timeout(30000);
		const env = {
			...process.env,
			YASS_CONFIG: path.join(REPO, '.yass-orm.postgres.js'),
		};
		delete env.YASS_TEST_ALLOW_PORT;
		execFile(
			process.execPath,
			[require.resolve('mocha/bin/mocha'), '--exit', 'test/globals.test.js'],
			{ cwd: REPO, env, timeout: 30000 },
			(error, stdout, stderr) => {
				expect(error).to.not.equal(null);
				expect(`${stdout}${stderr}`).to.match(/refusing to run.*5432/is);
				expect(`${stdout}`).to.not.match(/passing/);
				done();
			},
		);
	});
});
