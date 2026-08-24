/* eslint-disable no-unused-expressions */
/* global describe, it, before, after */
const { expect } = require('chai');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');

// BDL-2700 — `searchOne`'s SECOND POSITIONAL.
//
// BDL-2646 gave `search()`'s second positional a validated options vocabulary
// (`limitOne, limit, offset, orderBy, orderDir`). `searchOne` was left alone:
// it hardcoded `true` into that validated slot and forwarded the caller's
// object into the THIRD slot, which is destructured for `tx` and nothing
// else. So an options bag handed to `searchOne` was a SILENT NO-OP — no
// ORDER BY, no throw, an arbitrary row.
//
// It could not be caught at compile time either: `PromisePoolMapConfig` has
// an open index signature (`[key: string]: any`), so excess-property checking
// can never fire on that slot.
//
// The two vocabularies are disjoint and both closed, so the second positional
// is now PARTITIONED rather than replaced: search-option keys are validated
// as search options, pool-config keys (`concurrency, debug, logger,
// throwErrors, yieldEvery`) still behave as a pool config, `tx` still routes
// a transaction, and anything else THROWS naming the key. That keeps the
// method's default argument (`this.promisePoolMapConfig`, a real pool config)
// working, which a naive "validate everything as search options" fix would
// have broken on EVERY plain `searchOne(fields)` call.
//
// Follows the dialect / `after()` conventions documented at the top of
// `obj.search-options.test.js`: MySQL (the suite default), and this file drops
// only its OWN table — never `closeAllConnections()`, which would poison every
// other suite sharing the process.
describe('#YASS-ORM Model.searchOne() options (BDL-2700)', function suite() {
	this.timeout(20000);

	let Widget;
	let conn;

	// Deliberately NOT sorted, NOT reverse-sorted, and not a rotation — so
	// "returned in insertion order" and "returned in reverse insertion order"
	// both produce a WRONG answer for every assertion below. Without this, a
	// dropped ORDER BY can still look correct.
	const JUMBLED_SORT_KEYS = [7, 2, 9, 0, 5, 8, 1, 6, 3, 4];

	before(async () => {
		conn = await dbh();
		await conn.query('DROP TABLE IF EXISTS yass_searchone_widget');
		await conn.query(`
			CREATE TABLE yass_searchone_widget (
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
				'INSERT INTO yass_searchone_widget (name, sortKey, isDeleted) VALUES (:name, :sortKey, 0)',
				{ name: `sow-${sortKey}`, sortKey },
			);
		}

		// Named class, not a bare `loadDefinition()` assignment — see the note in
		// obj.search-options.test.js: anonymous loadDefinition classes share one
		// id-keyed instance-cache bucket and hand back each other's rows.
		class SearchOneWidget extends YassORM.loadDefinition(({ types: t }) => ({
			table: 'yass_searchone_widget',
			schema: { id: t.idKey, name: t.string, sortKey: t.int },
		})) {}
		Widget = SearchOneWidget;
	});

	after(async () => {
		if (conn) {
			await conn.query('DROP TABLE IF EXISTS yass_searchone_widget');
		}
	});

	it('confirms the seed is genuinely jumbled, not accidentally sorted (control)', () => {
		const asc = [...JUMBLED_SORT_KEYS].sort((a, b) => a - b);
		expect(JUMBLED_SORT_KEYS).to.not.deep.equal(asc);
		expect(JUMBLED_SORT_KEYS).to.not.deep.equal([...asc].reverse());
	});

	describe('orderBy/orderDir are HONOURED (the bug: they were dropped)', () => {
		it('DESC returns the greatest sortKey', async () => {
			const one = await Widget.searchOne(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'DESC' },
			);
			expect(one).to.be.instanceOf(Widget);
			expect(one.sortKey).to.equal(9);
		});

		it('ASC returns the least sortKey', async () => {
			const one = await Widget.searchOne(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'ASC' },
			);
			expect(one.sortKey).to.equal(0);
		});

		it('ASC and DESC disagree — so neither result is a fixed row that happens to match', async () => {
			const asc = await Widget.searchOne(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'ASC' },
			);
			const desc = await Widget.searchOne(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'DESC' },
			);
			expect(asc.sortKey).to.not.equal(desc.sortKey);
		});

		it('bare orderBy defaults to ASC, matching search()', async () => {
			const one = await Widget.searchOne({ isDeleted: 0 }, { orderBy: 'sortKey' });
			expect(one.sortKey).to.equal(0);
		});
	});

	describe('unknown keys THROW instead of being swallowed', () => {
		it("throws naming 'sort' (the live GetAlgorithmStatus shape)", async () => {
			let caught;
			try {
				await Widget.searchOne({ isDeleted: 0 }, { sort: { sortKey: -1 } });
			} catch (err) {
				caught = err;
			}
			expect(caught, 'expected a throw for sort').to.be.an('error');
			expect(caught.message).to.match(/'sort'/);
		});

		it("throws naming 'sortBy'", async () => {
			let caught;
			try {
				await Widget.searchOne({ isDeleted: 0 }, { sortBy: ['-sortKey'] });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it("throws on a column-plus-direction string (the live bc2630 shape)", async () => {
			let caught;
			try {
				await Widget.searchOne({ isDeleted: 0 }, { orderBy: 'sortKey DESC' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/sortKey DESC/);
		});

		it("throws when orderBy names a column this model does not have", async () => {
			let caught;
			try {
				await Widget.searchOne({ isDeleted: 0 }, { orderBy: 'notAColumn' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/notAColumn/);
		});

		it("throws on 'limit', which contradicts searchOne's single-row shape", async () => {
			let caught;
			try {
				await Widget.searchOne({ isDeleted: 0 }, { limit: 5 });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/limit/);
		});
	});

	describe('error messages name the key the CALLER typed', () => {
		async function messageFor(opts) {
			try {
				await Widget.searchOne({ isDeleted: 0 }, opts);
			} catch (err) {
				return err.message;
			}
			return null;
		}

		it("rejects 'limit' by name, not via a limitOne complaint", async () => {
			// Forwarding `limit` to normalizeSearchOptions produced
			// "'limitOne' cannot be combined with 'limit'" — naming a key the
			// caller never wrote and cannot remove.
			const message = await messageFor({ limit: 5 });
			expect(message).to.match(/'limit'/);
			expect(message).to.not.match(/limitOne/);
		});

		it("rejects 'offset' by name, not via a 'requires limit' complaint", async () => {
			const message = await messageFor({ offset: 5 });
			expect(message).to.match(/'offset'/);
			expect(message).to.not.match(/requires/);
		});

		it("rejects 'limitOne' as implied by the method", async () => {
			const message = await messageFor({ limitOne: false });
			expect(message).to.match(/'limitOne'/);
		});

		it('is prefixed searchOne(), once — not search() and not both', async () => {
			const message = await messageFor({ sort: 1 });
			expect(message).to.match(/^yass-orm searchOne\(\):/);
			expect(message).to.not.match(/search\(\).*searchOne\(\)/);
		});

		it('does NOT advertise keys it rejects', async () => {
			// The advice line used to print search()'s vocabulary, so a caller
			// who followed it hit a second, contradictory throw.
			const message = await messageFor({ sort: 1 });
			expect(message).to.match(/orderBy/);
			expect(message).to.not.match(/limit\b/);
			expect(message).to.not.match(/offset/);
		});
	});

	describe('back-compatibility — the pool-config slot still works', () => {
		it('searchOne(fields) with NO second argument still returns a row', async () => {
			// Regression guard for the obvious wrong fix: the parameter's DEFAULT is
			// a real pool config (`{concurrency, debug, logger, throwErrors,
			// yieldEvery}`), so validating the slot as search options unconditionally
			// would make EVERY plain searchOne() throw "unknown option 'concurrency'".
			const one = await Widget.searchOne({ isDeleted: 0 });
			expect(one).to.be.instanceOf(Widget);
		});

		it('accepts a genuine pool config without throwing', async () => {
			const one = await Widget.searchOne(
				{ isDeleted: 0 },
				{ concurrency: 2, yieldEvery: 4, throwErrors: true },
			);
			expect(one).to.be.instanceOf(Widget);
		});

		it('accepts search options and pool config MIXED in the same object', async () => {
			const one = await Widget.searchOne(
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'DESC', concurrency: 2 },
			);
			expect(one.sortKey).to.equal(9);
		});

		it('returns null when nothing matches', async () => {
			const none = await Widget.searchOne({ name: 'does-not-exist' });
			expect(none).to.equal(null);
		});

		it('still routes tx from the second positional', async () => {
			const found = await Widget.withDbh(async (handle) =>
				handle.transaction(async (tx) =>
					Widget.searchOne({ isDeleted: 0 }, { tx }),
				),
			);
			expect(found).to.be.instanceOf(Widget);
		});

		it('still routes tx from the second positional ALONGSIDE order options', async () => {
			const found = await Widget.withDbh(async (handle) =>
				handle.transaction(async (tx) =>
					Widget.searchOne(
						{ isDeleted: 0 },
						{ tx, orderBy: 'sortKey', orderDir: 'DESC' },
					),
				),
			);
			expect(found.sortKey).to.equal(9);
		});

		it('still routes tx from the explicit THIRD positional', async () => {
			const found = await Widget.withDbh(async (handle) =>
				handle.transaction(async (tx) =>
					Widget.searchOne({ isDeleted: 0 }, undefined, { tx }),
				),
			);
			expect(found).to.be.instanceOf(Widget);
		});
	});
});
