/* eslint-disable no-unused-expressions */
/* global describe, it, before, after */
const { expect } = require('chai');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');

// NOTE: this suite runs against the SAME (default, MySQL) dialect as every
// other file in `test/**/*.test.js` — it deliberately does NOT try to force
// SQLite for just this file via `process.env.YASS_CONFIG`.
//
// `lib/config.js` reads `process.env.YASS_CONFIG` at require-time and
// destructures the resolved values into module-level consts inside
// `lib/dbh.js` (`configDialect`, `configFilename`, ...) the FIRST time
// `lib/dbh.js` is required in the process. Under the full multi-file `mocha
// test/**/*.test.js` glob, some other test file requires `../lib/dbh` before
// this one is required (mocha requires every matching file up front), so by
// the time this file's top-level code ran, the dialect was already latched to
// whatever the first-required file resolved — setting the env var here was a
// no-op that only ever worked when this file happened to run standalone.
// `Model.search()` always resolves its connection through `dbh()` with no
// per-call override (see obj.js `_runOn` / `retryIfConnectionLost`), so there
// is no way to hand it a different dialect from inside a single test file in
// a shared process. Using MySQL (the suite default, and the dialect every
// other `test/obj.*.test.js` file already exercises) sidesteps the whole
// problem instead of racing it.
//
// The `after()` hook also no longer calls the process-wide
// `closeAllConnections()` — that closed EVERY cached pool, including the ones
// later test files in the same `mocha` run depend on, which is what produced
// the cascading "pool is closed" failures across ~20 unrelated tests once
// this suite's `after()` ran. Every other file in this suite (e.g.
// `obj.transaction.test.js`) only drops its own tables in `after()` and
// leaves the shared cached pool alone; this file now does the same.
describe('#YASS-ORM Model.search() options', function suite() {
	this.timeout(20000);

	let Widget;
	let conn;

	before(async () => {
		conn = await dbh();

		await conn.query('DROP TABLE IF EXISTS yass_search_widget');
		await conn.query(`
			CREATE TABLE yass_search_widget (
				id INT PRIMARY KEY AUTO_INCREMENT,
				name VARCHAR(255),
				sortKey INT,
				isDeleted TINYINT DEFAULT 0,
				createdBy INT NULL,
				createdAt DATETIME NULL,
				updatedBy INT NULL,
				updatedAt DATETIME NULL
			) ENGINE=InnoDB
		`);
		for (let i = 0; i < 25; i++) {
			// eslint-disable-next-line no-await-in-loop
			await conn.pquery(
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
		if (conn) {
			await conn.query('DROP TABLE IF EXISTS yass_search_widget');
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
