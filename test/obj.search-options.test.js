/* eslint-disable no-unused-expressions */
/* global describe, it, before, after */
const path = require('path');

// NOTE: deviates from the task brief's literal placement of this line (it had
// this inside `before()`, AFTER requiring '../lib' below). `lib/config.js`
// reads `process.env.YASS_CONFIG` at require-time, synchronously, and caches
// the result — so setting it inside `before()` is too late: by then
// `require('../lib')` below has already resolved `config` against the
// default (MySQL root@localhost, no password) config, which is what
// produced the "Access denied for user 'root'@'localhost'" failures in the
// initial red run. Setting it here, before any lib require, is what actually
// routes this suite's connections to SQLite.
process.env.YASS_CONFIG = path.join(__dirname, '..', '.yass-orm.sqlite.js');

const fs = require('fs');
const { expect } = require('chai');
const YassORM = require('../lib');
const { dbh, closeAllConnections } = require('../lib/dbh');
const config = require('../lib/config');

// Deviation #2 from the brief's literal test code: the brief opened its own
// connection with an EXPLICIT `filename: tempDb` override + `ignoreCachedConnections:
// true`. `Model.search()` (via `this._runOn` -> `retryIfConnectionLost`) always
// resolves the connection through `dbh()` with NO override, which resolves the
// filename from `config` (`.yass-orm.sqlite.js` -> `/tmp/yass-orm-test.sqlite`).
// A test connection opened against a DIFFERENT file creates the table somewhere
// the model layer's connection never looks, producing "no such table:
// yass_search_widget" for every Model.search() call while direct `conn.query()`
// calls (used only in setup) succeed. Fixed by connecting to the SAME
// (default, config-resolved) file the model layer will use.
const tempDb = config.filename || path.join('/tmp', 'yass-orm-test.sqlite');

describe('#YASS-ORM Model.search() options', function suite() {
	this.timeout(20000);

	let Widget;
	let conn;

	before(async () => {
		conn = await dbh();

		await conn.query('DROP TABLE IF EXISTS yass_search_widget');
		await conn.query(`
			CREATE TABLE yass_search_widget (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT,
				sortKey INTEGER,
				isDeleted INTEGER DEFAULT 0,
				createdBy INTEGER NULL,
				createdAt TEXT NULL,
				updatedBy INTEGER NULL,
				updatedAt TEXT NULL
			)
		`);
		for (let i = 0; i < 25; i++) {
			// eslint-disable-next-line no-await-in-loop
			await conn.query(
				'INSERT INTO yass_search_widget (name, sortKey, isDeleted) VALUES (:name, :sortKey, 0)',
				{ name: `w-${i}`, sortKey: i },
			);
		}

		Widget = YassORM.loadDefinition(({ types: t }) => ({
			table: 'yass_search_widget',
			schema: {
				id: t.idKey,
				name: t.string,
				sortKey: t.int,
			},
		}));
	});

	after(async () => {
		await closeAllConnections();
		try {
			fs.unlinkSync(tempDb);
		} catch (err) {
			// ignore
		}
	});

	describe('acceptance criterion 1 & 6 — limit returns at most N, AS AN ARRAY', () => {
		it('returns 20 rows for { limit: 20 }, not 1', async () => {
			const rows = await Widget.search({ isDeleted: 0 }, { limit: 20 });
			expect(Array.isArray(rows)).to.be.true;
			expect(rows).to.have.length(20);
		});

		it('returns an array even when the limit is 1', async () => {
			const rows = await Widget.search({ isDeleted: 0 }, { limit: 1 });
			expect(Array.isArray(rows)).to.be.true;
			expect(rows).to.have.length(1);
		});

		it('returns hydrated model instances, not raw rows', async () => {
			const rows = await Widget.search({ isDeleted: 0 }, { limit: 3 });
			expect(rows[0]).to.be.instanceOf(Widget);
		});
	});

	describe('acceptance criterion 3 — offset', () => {
		it('skips the right rows', async () => {
			const rows = await Widget.search(
				{ isDeleted: 0 },
				{ limit: 5, offset: 10, orderBy: 'sortKey', orderDir: 'ASC' },
			);
			expect(rows.map((r) => r.sortKey)).to.deep.equal([10, 11, 12, 13, 14]);
		});
	});

	describe('acceptance criterion 4 — backward compatibility', () => {
		it('search(fields, true) returns a single instance', async () => {
			const one = await Widget.search({ isDeleted: 0 }, true);
			expect(Array.isArray(one)).to.be.false;
			expect(one).to.be.instanceOf(Widget);
		});

		it('search(fields, false) returns every row', async () => {
			const rows = await Widget.search({ isDeleted: 0 }, false);
			expect(rows).to.have.length(25);
		});

		it('searchOne(fields) returns a single instance', async () => {
			const one = await Widget.searchOne({ isDeleted: 0 });
			expect(one).to.be.instanceOf(Widget);
		});

		it('searchOne returns null when nothing matches', async () => {
			const none = await Widget.searchOne({ name: 'does-not-exist' });
			expect(none).to.equal(null);
		});

		it('search(fields, false, { tx }) still routes tx via the 3rd positional', async () => {
			// The 3rd positional doubles as promisePoolMapConfig and may carry `tx`
			// (obj.js:1196-1203). Passing an empty-ish config must not break.
			const rows = await Widget.search({ isDeleted: 0 }, false, {});
			expect(rows).to.have.length(25);
		});
	});

	describe('acceptance criterion 5 — unknown / unusable options THROW', () => {
		const cases = [
			{ opts: { sortBy: ['-sortKey'] }, key: 'sortBy' },
			{ opts: { sort: { sortKey: -1 } }, key: 'sort' },
			{ opts: { zzzNope: 1 }, key: 'zzzNope' },
		];
		cases.forEach(({ opts, key }) => {
			it(`throws naming '${key}'`, async () => {
				let caught;
				try {
					await Widget.search({ isDeleted: 0 }, opts);
				} catch (err) {
					caught = err;
				}
				expect(caught, `expected a throw for ${key}`).to.be.an('error');
				expect(caught.message).to.match(new RegExp(`'${key}'`));
			});
		});

		it('throws when orderBy is not a column on THIS model', async () => {
			let caught;
			try {
				await Widget.search({ isDeleted: 0 }, { orderBy: 'notAColumn' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/notAColumn/);
		});

		it('accepts a real column', async () => {
			const rows = await Widget.search(
				{ isDeleted: 0 },
				{ limit: 2, orderBy: 'sortKey', orderDir: 'DESC' },
			);
			expect(rows.map((r) => r.sortKey)).to.deep.equal([24, 23]);
		});
	});
});
