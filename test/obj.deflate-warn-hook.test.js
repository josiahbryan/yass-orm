/* eslint-disable no-unused-expressions */
/* global describe, it */
const { expect } = require('chai');
const YassORM = require('../lib');

// BDL-2700 arm B — `warnOnInvalidDeflateKey` was UNREACHABLE, not merely off.
//
// `deflateValues` is a STATIC method, so inside it `this` IS the class. It read
// the hook as `this.constructor.warnOnInvalidDeflateKey`, and a class's
// `.constructor` is `Function` — so the lookup walked PAST the class the caller
// configured and always resolved to `undefined`. No model could ever turn the
// diagnostic on, by any documented path.
//
// This is deliberately scoped to REACHABILITY. It does NOT change the
// ignore-unknown-keys-by-default behaviour, which is intended (the existence of
// an opt-in warn hook is the evidence of that intent) and whose blast radius —
// how many field objects monorepo-wide carry a non-schema key — nobody has
// measured.
//
// No DB: `deflateValues` is pure over the schema.
describe('#YASS-ORM deflateValues warnOnInvalidDeflateKey (BDL-2700)', () => {
	function makeModel() {
		class DeflateHookWidget extends YassORM.loadDefinition(({ types: t }) => ({
			table: 'yass_deflate_hook_widget',
			schema: { id: t.idKey, name: t.string },
		})) {}
		return DeflateHookWidget;
	}

	it('fires the hook for a key that is not a column', () => {
		const Model = makeModel();
		const fired = [];
		Model.warnOnInvalidDeflateKey = (message, meta) => fired.push({ message, meta });

		Model.deflateValues({ name: 'ok', totallyNotAColumn: 'zzz' });

		expect(fired, 'hook should have fired exactly once').to.have.length(1);
		expect(fired[0].message).to.match(/totallyNotAColumn/);
		expect(fired[0].meta.patchKey).to.equal('totallyNotAColumn');
	});

	it('does NOT fire when every key is a real column (negative control)', () => {
		// Without this arm, a hook that fired unconditionally would pass the test
		// above while telling every caller their valid fields are invalid.
		const Model = makeModel();
		const fired = [];
		Model.warnOnInvalidDeflateKey = () => fired.push(1);

		Model.deflateValues({ name: 'ok' });

		expect(fired).to.have.length(0);
	});

	it('is silent when no model declares the hook (the default is unchanged)', () => {
		const Model = makeModel();
		expect(Model.warnOnInvalidDeflateKey).to.equal(undefined);
		expect(() => Model.deflateValues({ name: 'ok', nope: 1 })).to.not.throw();
	});

	it('still DROPS the unknown key rather than throwing — warn-only, by design', () => {
		const Model = makeModel();
		Model.warnOnInvalidDeflateKey = () => {};
		const out = Model.deflateValues({ name: 'ok', nope: 1 });
		expect(Object.keys(out)).to.not.include('nope');
		expect(out.name).to.equal('ok');
	});
});
