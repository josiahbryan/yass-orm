/* global describe, it */
const { expect } = require('chai');
const { assertKnownFields } = require('../lib/reject-unknown-fields');

const FIELD_MAP = {
	id: {},
	name: {},
	sortKey: {},
};

const CONTEXT = { className: 'Widget', methodName: 'patch', argName: 'data' };

describe('#YASS-ORM assertKnownFields', () => {
	it('does not throw for an object containing only real schema keys (positive control)', () => {
		expect(() =>
			assertKnownFields({ name: 'a', sortKey: 1 }, FIELD_MAP, CONTEXT),
		).to.not.throw();
	});

	it('does not throw for an empty object', () => {
		expect(() => assertKnownFields({}, FIELD_MAP, CONTEXT)).to.not.throw();
	});

	it('no-ops for undefined/null input (mirrors deflateValues default handling)', () => {
		expect(() =>
			assertKnownFields(undefined, FIELD_MAP, CONTEXT),
		).to.not.throw();
		expect(() => assertKnownFields(null, FIELD_MAP, CONTEXT)).to.not.throw();
	});

	it('throws naming a single unknown key', () => {
		expect(() => assertKnownFields({ sortBy: 'label' }, FIELD_MAP, CONTEXT))
			.to.throw(Error)
			.that.matches(/'sortBy'/);
	});

	it('throws naming the unknown key in a PARTIAL-DROP case (one real key + one unknown key)', () => {
		// This is the actual shape of the original BDL-2697 defect: a
		// legitimate query key (`name`) alongside a smuggled key (`sortBy`).
		// A test that only covers "fully unknown object" would not catch it.
		expect(() =>
			assertKnownFields({ name: 'a', sortBy: 'label' }, FIELD_MAP, CONTEXT),
		)
			.to.throw(Error)
			.that.matches(/'sortBy'/);
	});

	it('names every unknown key when there is more than one', () => {
		expect(() =>
			assertKnownFields({ sortBy: 'label', limit: 5 }, FIELD_MAP, CONTEXT),
		)
			.to.throw(Error)
			.that.matches(/(sortBy.*limit|limit.*sortBy)/s);
	});

	it('includes the class/method/arg context and the known-fields list in the message', () => {
		expect(() =>
			assertKnownFields({ sortBy: 'label' }, FIELD_MAP, CONTEXT),
		).to.throw(/Widget\.patch\(\).*'data'.*id, name, sortKey/s);
	});
});
