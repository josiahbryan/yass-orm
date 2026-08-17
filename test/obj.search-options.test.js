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

	// BDL-2646 review FIX 4: the tests above insert rows in ALREADY-SORTED
	// order (sortKey 0..24, ascending, by insertion/id order), so a query that
	// returns them unordered — e.g. by primary-key/insertion order, which
	// MySQL commonly does with no ORDER BY — can still LOOK sorted for ASC and
	// happens to look reverse-sorted for a small DESC page. That is not proof
	// `orderBy`/`orderDir` are wired at the MODEL layer; it is proof the dbh
	// layer emits the right SQL (asserted elsewhere, on generated SQL text).
	// This block seeds a JUMBLED insertion order in its own table so natural
	// insertion order and requested order provably DIFFER, and asserts on the
	// hydrated INSTANCES `search()` returns — the thing callers actually
	// depend on — not on generated SQL.
	describe('acceptance criterion 3/6 — orderBy/orderDir actually order the HYDRATED INSTANCES (jumbled seed)', () => {
		let JumbledWidget;

		// Deliberately NOT sorted, NOT reverse-sorted, and not a simple rotation
		// — a false pass from "returns in insertion order" or "returns in
		// reverse insertion order" is impossible against this sequence.
		const JUMBLED_SORT_KEYS = [7, 2, 9, 0, 5, 8, 1, 6, 3, 4];

		before(async () => {
			await conn.query('DROP TABLE IF EXISTS yass_search_widget_jumbled');
			await conn.query(`
				CREATE TABLE yass_search_widget_jumbled (
					id INT PRIMARY KEY AUTO_INCREMENT,
					name VARCHAR(255),
					sortKey INT,
					isDeleted TINYINT DEFAULT 0
				) ENGINE=InnoDB
			`);
			// eslint-disable-next-line no-restricted-syntax
			for (const sortKey of JUMBLED_SORT_KEYS) {
				// eslint-disable-next-line no-await-in-loop
				await conn.pquery(
					'INSERT INTO yass_search_widget_jumbled (name, sortKey, isDeleted) VALUES (:name, :sortKey, 0)',
					{ name: `jw-${sortKey}`, sortKey },
				);
			}

			// NOTE: intentionally a NAMED class extending loadDefinition(), not a bare
			// `YassORM.loadDefinition(...)` assignment like `Widget` above. The
			// object-instance cache in lib/obj.js (`_getClassCache`) keys purely on
			// `this.name`, and `loadDefinition()`'s returned class expression is
			// anonymous (`this.name === ''`) since it's returned through a function
			// call rather than a direct `const X = class {}` — JS only infers a name
			// in the latter case. Two anonymous loadDefinition() classes therefore
			// SHARE one cache bucket keyed by numeric id, and this table's ids
			// (1..10, fresh AUTO_INCREMENT) collide with Widget's (1..25) already
			// cached above, silently handing back stale Widget instances. A named
			// class gets its own `this.name` and its own bucket, matching the
			// documented ES6 usage (`class MyModel extends loadDefinition(...) {}`).
			class JumbledWidgetModel extends YassORM.loadDefinition(
				({ types: t }) => ({
					table: 'yass_search_widget_jumbled',
					schema: {
						id: t.idKey,
						name: t.string,
						sortKey: t.int,
					},
				}),
			) {}
			JumbledWidget = JumbledWidgetModel;
		});

		after(async () => {
			await conn.query('DROP TABLE IF EXISTS yass_search_widget_jumbled');
		});

		it('confirms the seed is genuinely jumbled, not accidentally sorted (control)', () => {
			const ascSorted = [...JUMBLED_SORT_KEYS].sort((a, b) => a - b);
			expect(JUMBLED_SORT_KEYS).to.not.deep.equal(ascSorted);
			expect(JUMBLED_SORT_KEYS).to.not.deep.equal([...ascSorted].reverse());
		});

		it('orderDir ASC returns hydrated instances in ascending sortKey order', async () => {
			const rows = await JumbledWidget.search(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'ASC' },
			);
			expect(rows).to.have.length(JUMBLED_SORT_KEYS.length);
			rows.forEach((row) => expect(row).to.be.instanceOf(JumbledWidget));
			expect(rows.map((r) => r.sortKey)).to.deep.equal([
				0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
			]);
		});

		it('orderDir DESC returns hydrated instances in descending sortKey order', async () => {
			const rows = await JumbledWidget.search(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'DESC' },
			);
			expect(rows).to.have.length(JUMBLED_SORT_KEYS.length);
			rows.forEach((row) => expect(row).to.be.instanceOf(JumbledWidget));
			expect(rows.map((r) => r.sortKey)).to.deep.equal([
				9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
			]);
		});

		it('ASC and DESC results are true reverses of each other, not two coincidental matches', async () => {
			const asc = await JumbledWidget.search(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'ASC' },
			);
			const desc = await JumbledWidget.search(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'DESC' },
			);
			expect(desc.map((r) => r.sortKey)).to.deep.equal(
				[...asc.map((r) => r.sortKey)].reverse(),
			);
		});
	});
});
