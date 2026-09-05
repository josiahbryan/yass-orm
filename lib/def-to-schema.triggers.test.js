/* eslint-disable no-unused-expressions, global-require */
/* global describe, it */

/**
 * def-to-schema: the `triggers` block plumbing.
 *
 * The reconciler in lib/sync-triggers.js does the heavy lifting; this suite
 * only pins the contract between what the AUTHOR writes in a def and what
 * lib/sync-to-db.js receives on `schema.options.triggers` -- specifically the
 * two ways to spell the block and the opt-in sentinel that gates the
 * drop-undeclared pass downstream.
 */

const { expect } = require('chai');
const { convertDefinition } = require('./def-to-schema');

describe('#def-to-schema triggers block', () => {
	it('accepts a top-level `triggers` block and places it on options.triggers', () => {
		// Sibling of `indexes` (which already works this way) so authors have
		// one obvious place to put both.
		const def = ({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
			triggers: {
				set_upper: {
					timing: 'before',
					event: 'insert',
					body: 'BEGIN SET NEW.name = UPPER(NEW.name); END',
				},
			},
		});
		const schema = convertDefinition(def);
		expect(schema.options.triggers).to.have.property('set_upper');
		expect(schema.options.triggers.set_upper.timing).to.equal('before');
	});

	it('also accepts `options.triggers` (same shape, no priority split)', () => {
		// Matching the way `indexes` can live either place, so authors are not
		// tripped up by copy-pasting an old def.
		const def = ({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
			options: {
				triggers: {
					t1: {
						timing: 'before',
						event: 'insert',
						body: 'BEGIN END',
					},
				},
			},
		});
		const schema = convertDefinition(def);
		expect(schema.options.triggers).to.have.property('t1');
	});

	it('sets `options.hasTriggersDeclared` to true when the def declares `triggers` (opt-in sentinel for drop-undeclared)', () => {
		// This is the sentinel that gates the drop-undeclared-triggers pass in
		// sync-to-db.js. It must be TRUE even when the block is EMPTY, because
		// "declared triggers: none" is a valid, opinionated statement.
		const withEmpty = convertDefinition(({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
			triggers: {},
		}));
		expect(withEmpty.options.hasTriggersDeclared).to.equal(true);

		const withOne = convertDefinition(({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
			triggers: {
				t1: { timing: 'before', event: 'insert', body: 'BEGIN END' },
			},
		}));
		expect(withOne.options.hasTriggersDeclared).to.equal(true);
	});

	it('leaves `options.hasTriggersDeclared` false/undefined when the def has no `triggers` key', () => {
		// This is the guarantee that upgrading yass-orm changes NOTHING for
		// existing defs: no `triggers` key -> the drop-undeclared pass is
		// never armed and hand-created triggers on the table survive syncs.
		const schema = convertDefinition(({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
		}));
		expect(schema.options.hasTriggersDeclared).to.not.equal(true);
	});

	it('throws at convert time on a malformed trigger spec (typo fails LOUDLY)', () => {
		// Same failure mode as an invalid multiValued index spec: a typo must
		// surface as a load-time error, not as a silent no-op that shows up
		// one deploy later as a missing trigger.
		expect(() =>
			convertDefinition(({ types: t }) => ({
				table: 'demo',
				schema: { id: t.uuidKey, name: t.string },
				triggers: {
					bad: { timing: 'instead of', event: 'insert', body: 'x' },
				},
			})),
		).to.throw(/timing/);
	});

	it('preserves JS declaration order (used as firing order downstream)', () => {
		// Object.keys() preserves insertion order per ES2015+ for string keys,
		// and the reconciler relies on that to sequence the desired firing
		// order (id trigger first, then declaration order). Pinned here so a
		// future refactor of def-to-schema does not quietly re-sort them.
		const schema = convertDefinition(({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
			triggers: {
				b_second: { timing: 'before', event: 'insert', body: 'BEGIN END' },
				a_first_alphabetically_but_declared_third: {
					timing: 'before',
					event: 'insert',
					body: 'BEGIN END',
				},
				c_third: { timing: 'before', event: 'insert', body: 'BEGIN END' },
			},
		}));
		expect(Object.keys(schema.options.triggers)).to.deep.equal([
			'b_second',
			'a_first_alphabetically_but_declared_third',
			'c_third',
		]);
	});

	it('does not leak `triggers` onto the top-level schema (only options.triggers)', () => {
		// Otherwise `...passThruProps` in toSchema would duplicate it to the
		// top level and downstream code could accidentally read from the wrong
		// place. Belt-and-suspenders check for the destructure.
		const schema = convertDefinition(({ types: t }) => ({
			table: 'demo',
			schema: { id: t.uuidKey, name: t.string },
			triggers: {
				t: { timing: 'before', event: 'insert', body: 'BEGIN END' },
			},
		}));
		expect(schema).to.not.have.property('triggers');
	});
});
