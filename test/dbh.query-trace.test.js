/* global describe, it, before, after */
// pquery's caller stack: a successful query doesn't format one
// (it cost ~0.1 ms of CPU per query); a failed query still carries its
// caller's frames on `.originalStack`, and an enabled QueryLogger still gets
// `trace` on each line.
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections, QueryLogger } = require('../lib/dbh');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const tempFile = path.join('/tmp', `yass-qtrace-${process.pid}.sqlite`);

/** Counts the stacks formatted while `fn` runs. */
async function countFormattedStacks(fn) {
	const was = Error.prepareStackTrace;
	let formatted = 0;
	Error.prepareStackTrace = (error, frames) => {
		formatted += 1;
		return `${error}\n${frames.map((f) => `    at ${f}`).join('\n')}`;
	};
	try {
		await fn();
	} finally {
		Error.prepareStackTrace = was;
	}
	return formatted;
}

describe('pquery caller stack', () => {
	let conn;

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});
		await conn.query('CREATE TABLE qtrace_test (id INTEGER PRIMARY KEY)');
	});

	after(async () => {
		QueryLogger.disable();
		await closeAllConnections();
		try {
			fs.unlinkSync(tempFile);
		} catch (err) {
			/* ignore */
		}
	});

	it('a successful query formats no stack', async () => {
		const formatted = await countFormattedStacks(async () => {
			for (let i = 0; i < 20; i += 1) {
				// eslint-disable-next-line no-await-in-loop
				await conn.pquery('SELECT 1 AS one', {});
			}
		});
		expect(formatted).to.equal(0);
	});

	it("a failed query's originalStack names its caller", async () => {
		// An awaiting caller: V8's async stack trace names it.
		async function namedCallerOfFailingQuery() {
			// eslint-disable-next-line no-return-await
			return await conn.pquery('SELECT * FROM qtrace_missing_table', {});
		}
		let thrown;
		await captureConsoleError.during(async () => {
			try {
				await namedCallerOfFailingQuery();
			} catch (err) {
				thrown = err;
			}
		});
		expect(thrown).to.be.an.instanceof(Error);
		expect(thrown.message).to.match(/^Error in query:/);
		expect(thrown.originalStack).to.be.a('string');
		expect(thrown.originalStack).to.include('namedCallerOfFailingQuery');
	});

	it('an enabled QueryLogger still gets a trace on each line', async () => {
		const lines = [];
		const listener = (line) => lines.push(line);
		async function namedCallerOfLoggedQuery() {
			return conn.pquery('SELECT 2 AS two', {});
		}
		QueryLogger.enable();
		QueryLogger.attachListener(listener);
		try {
			await namedCallerOfLoggedQuery();
		} finally {
			QueryLogger.removeListener(listener);
			QueryLogger.disable();
		}
		expect(lines).to.have.length(1);
		expect(lines[0].trace).to.be.a('string');
		expect(lines[0].trace).to.include('namedCallerOfLoggedQuery');
	});
});
