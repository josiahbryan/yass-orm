/* eslint-disable no-console */
/* global describe, it, before, after, beforeEach, afterEach */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const tempFile = path.join('/tmp', `yass-silence-${process.pid}.sqlite`);

describe('silenceErrors threads through high-level dbh methods', () => {
	let conn;
	let cap;

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});
		await conn.query(
			'CREATE TABLE silence_test (id TEXT PRIMARY KEY, name TEXT UNIQUE)',
		);
		// One seed row used to force a conflict in every test that needs one.
		await conn.pquery(
			'INSERT INTO silence_test (id, name) VALUES (:id, :name)',
			{ id: 'seed', name: 'seed-name' },
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

	beforeEach(() => {
		cap = captureConsoleError.install();
	});
	afterEach(() => {
		cap.restore();
	});

	it('Happy path baseline: failing pquery without silenceErrors logs the banner', async () => {
		try {
			await conn.pquery(
				'INSERT INTO silence_test (id, name) VALUES (:id, :name)',
				{ id: 'baseline', name: 'seed-name' }, // dup name
			);
		} catch (err) {
			/* expected */
		}
		expect(cap.loudCount()).to.equal(1);
	});

	it('Sad path: failing pquery WITH silenceErrors=true does not log', async () => {
		try {
			await conn.pquery(
				'INSERT INTO silence_test (id, name) VALUES (:id, :name)',
				{ id: 'silent', name: 'seed-name' }, // dup name
				{ silenceErrors: true },
			);
		} catch (err) {
			/* expected */
		}
		expect(cap.loudCount()).to.equal(0);
	});

	it('Sad path: conn.create with silenceErrors=true silences duplicate-key errors', async () => {
		try {
			await conn.create(
				'silence_test',
				{ id: 'create-silent', name: 'seed-name' }, // dup name
				{ silenceErrors: true },
			);
		} catch (err) {
			/* expected */
		}
		expect(cap.loudCount()).to.equal(0);
	});

	it('Happy path: conn.create with silenceErrors=true still returns the row on success', async () => {
		const row = await conn.create(
			'silence_test',
			{ id: 'create-ok', name: 'create-ok-name' },
			{ silenceErrors: true },
		);
		expect(row).to.exist;
		expect(row.id).to.equal('create-ok');
		expect(cap.loudCount()).to.equal(0);
	});

	it('Sad path: conn.findOrCreate with silenceErrors=true does not log on race conflict', async () => {
		try {
			// id is novel (won't match the seed via PK), but name conflicts with
			// the seed via the UNIQUE constraint, forcing the internal create to fail.
			await conn.findOrCreate(
				'silence_test',
				{ id: 'foc-race-id', name: 'seed-name' },
				{},
				{},
				{ silenceErrors: true },
			);
		} catch (err) {
			/* expected */
		}
		expect(cap.loudCount()).to.equal(0);
	});

	it('Sad path: conn.search with silenceErrors=true silences SQL errors', async () => {
		try {
			await conn.search(
				'silence_test',
				{ nonexistent_column: 'foo' },
				false,
				{ silenceErrors: true },
			);
		} catch (err) {
			/* expected */
		}
		expect(cap.loudCount()).to.equal(0);
	});
});
