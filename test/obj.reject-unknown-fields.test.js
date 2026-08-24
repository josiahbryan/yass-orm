/* eslint-disable no-unused-expressions */
/* global describe, it, before */
const { expect } = require('chai');
const YassORM = require('../lib');

// This suite intentionally requires NO DATABASE. Every entry-point method
// under test (search/searchOne/findOrCreate/create/patch/patchIf) normally
// ends by opening a database connection — but `rejectUnknownFields`
// validates the CALLER-SUPPLIED object BEFORE any of that code runs (at
// the very top of each entry point, before `_runOn`/`dbh()` is ever
// reached), so a REJECTED call throws synchronously with NO DB touch at
// all. Those cases (negative + partial-drop) are asserted directly below.
//
// A call with ONLY real schema keys (the "positive control") is
// different: once validation passes, these methods proceed to open a real
// DB connection to finish — which this suite deliberately does not
// require or configure. So the positive-control assertions below are
// scoped to exactly what a no-DB suite CAN prove: whatever the call
// throws (if anything — e.g. a connection error, since no DB is
// configured here), it is never OUR validator's error. That is precisely
// the property this ticket's guard needs: a validator that ALSO rejects
// valid input would throw the SAME "unknown field" shape here, and this
// suite would catch it.
const UNKNOWN_FIELD_ERROR = /unknown (field|fields)/;

describe('#YASS-ORM rejectUnknownFields (BDL-2697)', () => {
	let Widget;
	let StrictWidget;

	before(() => {
		const definition = ({ types: t }) => ({
			table: 'yass_reject_unknown_fields_widget',
			schema: {
				id: t.idKey,
				name: t.string,
				sortKey: t.int,
			},
		});

		// Default behaviour: flag is off unless a subclass opts in.
		Widget = YassORM.loadDefinition(definition);

		// A NAMED class (not a bare loadDefinition() assignment) — the
		// object-instance cache in obj.js keys purely on `this.name`, so two
		// anonymous loadDefinition() classes would share one cache bucket.
		// See test/obj.search-options.test.js for the same pattern.
		class StrictWidgetModel extends YassORM.loadDefinition(definition) {
			static rejectUnknownFields = true;
		}
		StrictWidget = StrictWidgetModel;
	});

	describe('default is OFF (acceptance criterion 4)', () => {
		it('rejectUnknownFields defaults to false on the base class', () => {
			expect(Widget.rejectUnknownFields).to.equal(false);
		});
	});

	describe('search(fields) / searchOne(fields) — negative + partial-drop', () => {
		it('search() throws naming a fully-unknown key, with NO DB touch', async () => {
			let caught;
			try {
				await StrictWidget.search({ sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught, 'expected a throw').to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('search() throws in the PARTIAL-DROP shape (real key + unknown key)', async () => {
			let caught;
			try {
				await StrictWidget.search({ name: 'a', sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught, 'expected a throw').to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('searchOne() throws too (delegates to search())', async () => {
			let caught;
			try {
				await StrictWidget.searchOne({ sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught, 'expected a throw').to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('a call with only real keys never throws the VALIDATOR error (positive control)', async () => {
			try {
				await StrictWidget.search({ name: 'a' });
			} catch (err) {
				expect(err.message).to.not.match(UNKNOWN_FIELD_ERROR);
			}
		});

		it('the SAME unknown-key object does NOT throw the validator error when the flag is off (default-off regression)', async () => {
			try {
				await Widget.search({ sortBy: 'label' });
			} catch (err) {
				expect(err.message).to.not.match(UNKNOWN_FIELD_ERROR);
			}
		});
	});

	describe('findOrCreate(fields, patchIf, patchIfFalsey) — all three slots', () => {
		it('throws naming the unknown key in `fields` (partial-drop)', async () => {
			let caught;
			try {
				await StrictWidget.findOrCreate({ name: 'a', sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('throws naming the unknown key in `patchIf`', async () => {
			let caught;
			try {
				await StrictWidget.findOrCreate({ name: 'a' }, { sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('throws naming the unknown key in `patchIfFalsey`', async () => {
			let caught;
			try {
				await StrictWidget.findOrCreate({ name: 'a' }, {}, { sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('a call with only real keys in all three never throws the VALIDATOR error', async () => {
			try {
				await StrictWidget.findOrCreate(
					{ name: 'a' },
					{ name: 'b' },
					{ name: 'c' },
				);
			} catch (err) {
				expect(err.message).to.not.match(UNKNOWN_FIELD_ERROR);
			}
		});
	});

	describe('create(data) — negative + partial-drop', () => {
		it('throws naming the unknown key', async () => {
			let caught;
			try {
				await StrictWidget.create({ name: 'a', sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('a call with only real keys never throws the VALIDATOR error', async () => {
			try {
				await StrictWidget.create({ name: 'a' });
			} catch (err) {
				expect(err.message).to.not.match(UNKNOWN_FIELD_ERROR);
			}
		});
	});

	describe('patch(data) / patchIf(values, ifFalsey) — instance methods', () => {
		let instance;
		let strictInstance;

		before(async () => {
			// inflate() is pure — no DB touch for a schema with no linked
			// fields (it only hits the in-memory cache and transforms field
			// values, never opens a connection).
			instance = await Widget.inflate({ id: '1', name: 'seed', sortKey: 1 });
			strictInstance = await StrictWidget.inflate({
				id: '2',
				name: 'seed',
				sortKey: 1,
			});
		});

		it('patch() throws naming the unknown key, with NO DB touch', async () => {
			let caught;
			try {
				await strictInstance.patch({ name: 'a', sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('patch() with only real keys never throws the VALIDATOR error', async () => {
			try {
				await strictInstance.patch({ name: 'a' });
			} catch (err) {
				expect(err.message).to.not.match(UNKNOWN_FIELD_ERROR);
			}
		});

		it('patchIf() throws naming the unknown key in `values`', async () => {
			let caught;
			try {
				await strictInstance.patchIf({ name: 'a', sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('patchIf() throws naming the unknown key in `ifFalsey`', async () => {
			let caught;
			try {
				await strictInstance.patchIf({ name: 'a' }, { sortBy: 'label' });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});

		it('the SAME unknown-key patch does NOT throw the validator error when the flag is off', async () => {
			try {
				await instance.patch({ sortBy: 'label' });
			} catch (err) {
				expect(err.message).to.not.match(UNKNOWN_FIELD_ERROR);
			}
		});

		describe('discriminating control — scope correctness (acceptance criterion 3)', () => {
			it('an instance carrying the internal `_patchDeferTid` property can still be patch()ed without throwing on it', async () => {
				// `.set()` is the real production path that adds a non-schema
				// own-property to the instance (`_deferPatch()`,
				// PATCH_DEFER_DELAY=300ms). Clear the resulting timer
				// immediately so it can't fire `update()` after this test ends.
				strictInstance.set('name', 'via-set');
				clearTimeout(strictInstance._patchDeferTid);
				expect(strictInstance).to.have.property('_patchDeferTid');

				try {
					await strictInstance.patch({ name: 'b' });
				} catch (err) {
					// Any error here must not be about `_patchDeferTid` —
					// proving the guard only inspects the CALLER-SUPPLIED
					// `data` argument, never `this`.
					expect(err.message).to.not.match(/_patchDeferTid/);
				}
			});

			it('deflateValues() on the raw instance (the exact shape create()/findOrCreate() use internally) does not throw', () => {
				// create()/findOrCreate()'s global-change-hook payloads call
				// deflateValues(instance, true) directly — NOT through any
				// public entry point this ticket validates. This pins that
				// deflateValues() itself is untouched by this change.
				strictInstance.set('name', 'via-set-2');
				clearTimeout(strictInstance._patchDeferTid);
				expect(() =>
					StrictWidget.deflateValues(strictInstance, true),
				).to.not.throw();
			});
		});
	});
});
