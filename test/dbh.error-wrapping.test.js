/* eslint-disable no-console */
/* global describe, it, before, after */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const tempFile = path.join('/tmp', `yass-errwrap-${process.pid}.sqlite`);

describe('pquery error wrapping preserves structured fields', () => {
	let conn;

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});
		await conn.query(
			'CREATE TABLE errwrap_test (id INTEGER PRIMARY KEY, name TEXT UNIQUE)',
		);
		// Seed once. Tests below don't mutate this seed.
		await conn.pquery(
			'INSERT INTO errwrap_test (id, name) VALUES (:id, :name)',
			{ id: 1, name: 'alice' },
		);
	});

	after(async () => {
		await closeAllConnections();
		try {
			fs.unlinkSync(tempFile);
		} catch (err) {
			/* ignore */
		}
	});

	it('Happy path: a successful query still works after the new wrapping logic', async () => {
		const rows = await conn.pquery('SELECT * FROM errwrap_test WHERE id=:id', {
			id: 1,
		});
		expect(rows).to.have.length(1);
		expect(rows[0].name).to.equal('alice');
	});

	it('Sad path: wrapped error preserves driver code (cause) and stable message prefix', async () => {
		let thrown;
		await captureConsoleError.during(async () => {
			try {
				// Force a UNIQUE violation against the pre-seeded 'alice' row.
				await conn.pquery(
					'INSERT INTO errwrap_test (id, name) VALUES (:id, :name)',
					{ id: 999, name: 'alice' },
				);
			} catch (err) {
				thrown = err;
			}
		});

		expect(thrown).to.be.an.instanceof(Error);
		expect(thrown.message).to.match(/^Error in query:/);

		expect(thrown.cause).to.exist;
		expect(thrown.cause).to.be.an.instanceof(Error);
		expect(thrown.cause.code, 'cause should expose driver code').to.be.a(
			'string',
		);

		// Driver code hoisted onto the wrapped error too.
		expect(thrown.code).to.equal(thrown.cause.code);

		// Stack trace not jammed into .message (used to be).
		expect(thrown.message).to.not.include('original stack:');
		expect(thrown.message).to.not.include('\n    at ');
	});

	it('Sad path: non-driver errors still wrap cleanly without throwing', async () => {
		let thrown;
		await captureConsoleError.during(async () => {
			try {
				await conn.pquery('SELECT * FROM nonexistent_table_xyz', {});
			} catch (err) {
				thrown = err;
			}
		});

		expect(thrown).to.be.an.instanceof(Error);
		expect(thrown.message).to.match(/^Error in query:/);
		expect(thrown.cause).to.exist;
	});
});
