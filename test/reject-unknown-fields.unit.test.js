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

	it('treats a PROTOTYPE-CHAIN key as unknown, not as a real field (discriminating control)', () => {
		// fieldMap is a plain object, so fieldMap['constructor'], fieldMap['toString'],
		// fieldMap['hasOwnProperty'] etc are all truthy via Object.prototype — a bracket
		// lookup (fieldMap[key]) would silently treat these as "known" and let them
		// through. Object.keys(fieldMap) never includes them (they're not OWN
		// properties of fieldMap), so a caller-supplied object containing one of these
		// as an OWN key must still be rejected.
		expect(() =>
			assertKnownFields({ name: 'a', constructor: 'evil' }, FIELD_MAP, CONTEXT),
		)
			.to.throw(Error)
			.that.matches(/'constructor'/);
		expect(() =>
			assertKnownFields({ toString: 'evil' }, FIELD_MAP, CONTEXT),
		)
			.to.throw(Error)
			.that.matches(/'toString'/);
	});

	it('treats an OWN `__proto__` key (e.g. from JSON.parse on untrusted input) as unknown', () => {
		// Object.defineProperty forces a real OWN enumerable `__proto__` key —
		// this is the shape JSON.parse('{"__proto__": "evil"}') produces, as
		// opposed to the special [[Prototype]] internal slot that a literal
		// `{ __proto__: x }` normally sets instead.
		const maliciousObject = {};
		Object.defineProperty(maliciousObject, '__proto__', {
			value: 'evil',
			enumerable: true,
			configurable: true,
		});
		expect(() =>
			assertKnownFields(maliciousObject, FIELD_MAP, CONTEXT),
		)
			.to.throw(Error)
			.that.matches(/'__proto__'/);
	});
});
