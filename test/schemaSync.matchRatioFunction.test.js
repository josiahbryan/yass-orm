/* eslint-disable no-console */
/* global describe, it, before, after, beforeEach, afterEach */

/**
 * Live-MySQL tests for installing the `match_ratio()` stored function.
 *
 * It used to be installed by writing the SQL to /tmp and shelling out to the
 * `mysql` CLI with `--password=<pass>` on the command line, and that command
 * (password included) was printed to the console. These tests pin the
 * replacement: the function is created over the existing driver connection,
 * with no child process, and the password never reaches console output.
 */

const { expect } = require('chai');
const childProcess = require('child_process');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const syncUtil = require('../lib/sync-to-db');

const isMysql = () => (config.dialect || 'mysql') === 'mysql';

async function withConn(fn) {
	const conn = await dbh({ ignoreCachedConnections: true });
	try {
		return await fn(conn);
	} finally {
		await conn.end();
	}
}

const dropMatchRatio = () =>
	withConn((conn) => conn.pquery('DROP FUNCTION IF EXISTS `match_ratio`'));

const functionExists = () =>
	withConn(async (conn) => {
		const rows = await conn.pquery(
			`SELECT ROUTINE_NAME FROM information_schema.ROUTINES
			WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = 'match_ratio' AND ROUTINE_TYPE = 'FUNCTION'`,
			[config.schema],
		);
		return rows.length > 0;
	});

/**
 * Capture everything written through console.log/warn/error/info/debug and
 * process.stdout/stderr while `fn` runs.
 */
async function captureOutput(fn) {
	const out = [];
	const methods = ['log', 'warn', 'error', 'info', 'debug'];
	const origConsole = {};
	methods.forEach((m) => {
		origConsole[m] = console[m];
		console[m] = (...args) => out.push(args.map(String).join(' '));
	});
	const origStdout = process.stdout.write;
	const origStderr = process.stderr.write;
	process.stdout.write = (chunk, ...rest) => {
		out.push(String(chunk));
		return origStdout.call(process.stdout, chunk, ...rest);
	};
	process.stderr.write = (chunk, ...rest) => {
		out.push(String(chunk));
		return origStderr.call(process.stderr, chunk, ...rest);
	};
	let error;
	try {
		await fn();
	} catch (ex) {
		error = ex;
	} finally {
		methods.forEach((m) => {
			console[m] = origConsole[m];
		});
		process.stdout.write = origStdout;
		process.stderr.write = origStderr;
	}
	return { out: out.join('\n'), error };
}

describe('#schemaSync match_ratio() function install', () => {
	let execSyncCalls;
	let origExecSync;

	before(function beforeMatchRatioSuite() {
		if (!isMysql()) {
			this.skip();
		}
	});

	beforeEach(() => {
		execSyncCalls = [];
		origExecSync = childProcess.execSync;
		childProcess.execSync = (...args) => {
			execSyncCalls.push(args);
			return Buffer.from('');
		};
	});

	afterEach(() => {
		childProcess.execSync = origExecSync;
	});

	after(async () => {
		if (!isMysql()) {
			return;
		}
		// Leave the function installed for the rest of the suite (finder
		// tests call match_ratio()).
		if (!(await functionExists())) {
			await syncUtil.uploadMatchRatioFunction();
		}
	});

	it('installs a working match_ratio() over the driver connection, without a shell and without printing the password', async () => {
		expect(config.password, 'test config must have a password').to.be.a(
			'string',
		);
		await dropMatchRatio();
		expect(await functionExists()).to.equal(false);

		const { out, error } = await captureOutput(() =>
			syncUtil.uploadMatchRatioFunction(),
		);

		expect(error, error && error.stack).to.equal(undefined);
		expect(execSyncCalls, 'execSync must not be called').to.have.length(0);
		expect(out).to.not.include(config.password);
		expect(await functionExists()).to.equal(true);

		const rows = await withConn((conn) =>
			conn.pquery(
				`SELECT
					match_ratio('hello world', 'hello', '%hello%') AS contains,
					match_ratio('hello world', 'xyz', '%world%') AS fallback,
					match_ratio('hello world', 'xyz', '%abc%') AS none`,
			),
		);
		// contains: round((1 - |11-5|/11) * 100) = 45
		// fallback: s2 misses; s3 stripped of % is 'world' (5 chars):
		//           round((1 - |11-5|/11) * .5 * 100) = 23
		expect(Number(rows[0].contains)).to.equal(45);
		expect(Number(rows[0].fallback)).to.equal(23);
		expect(Number(rows[0].none)).to.equal(0);
	});

	it('is a no-op when the function already exists', async () => {
		if (!(await functionExists())) {
			await syncUtil.uploadMatchRatioFunction();
		}
		const { out, error } = await captureOutput(() =>
			syncUtil.uploadMatchRatioFunction(),
		);
		expect(error, error && error.stack).to.equal(undefined);
		expect(execSyncCalls).to.have.length(0);
		expect(out).to.not.include(config.password);
		expect(await functionExists()).to.equal(true);
	});

	it('returns a promise, so callers can await it', () => {
		const result = syncUtil.uploadMatchRatioFunction();
		expect(result).to.be.an.instanceOf(Promise);
		return result;
	});

	it('rejects (instead of an unhandled rejection) when the install fails', async () => {
		const { out, error } = await captureOutput(() =>
			syncUtil.uploadMatchRatioFunctionFactory(
				config.host,
				'yass_no_such_db_match_ratio',
				config.user || 'root',
				config.password,
				config.port || 3306,
			),
		);
		expect(error, 'expected a rejection').to.be.an.instanceOf(Error);
		expect(execSyncCalls).to.have.length(0);
		expect(out).to.not.include(config.password);
		expect(String(error && error.message)).to.not.include(config.password);
	});
});
