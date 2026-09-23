/* global describe, it, before, after */
const { expect } = require('chai');
const YassORM = require('../lib');
const config = require('../lib/config');
const { timeOrderedId, prefixedId } = require('../lib/objectId');
const {
	mapFieldToTsType,
	mapFieldToZodSchema,
} = require('../lib/generate-types');

// `t.stringKey`: an app-generated string primary key (e.g. `chat_0mfq3k2z1...`)
// that works on every dialect. On MySQL a `t.uuidKey` CHAR(36) column could
// already hold such ids, but on Postgres `t.uuidKey` is a native UUID column that
// rejects them -- this is the portable spelling. No database needed here.

describe('#stringKey + prefixed time-ordered ids', () => {
	describe('timeOrderedId()', () => {
		it('is 25 lowercase base-36 chars', () => {
			expect(timeOrderedId()).to.match(/^[0-9a-z]{25}$/);
		});

		it('sorts by creation time (fixed-width time part first)', () => {
			const earlier = timeOrderedId(1_000_000);
			const later = timeOrderedId(1_000_001);
			expect(earlier < later).to.equal(true);
			// ...and across a base-36 digit rollover, which is where a
			// variable-width encoding would sort wrongly.
			expect(timeOrderedId(35) < timeOrderedId(36)).to.equal(true);
		});

		it('stays fixed-width far into the future (9 time chars covers year 5000+)', () => {
			const y5000 = Date.UTC(5000, 0, 1);
			expect(timeOrderedId(y5000)).to.have.length(25);
		});

		it('does not repeat within the same millisecond', () => {
			const ids = new Set(
				Array.from({ length: 1000 }, () => timeOrderedId(42)),
			);
			expect(ids.size).to.equal(1000);
		});
	});

	describe('prefixedId()', () => {
		it('joins prefix and time-ordered id with an underscore, fitting 36 chars', () => {
			const id = prefixedId('chat');
			expect(id).to.match(/^chat_[0-9a-z]{25}$/);
			expect(prefixedId('abcdefghij')).to.have.length(36);
		});

		it('rejects a prefix that would not fit or is not lowercase alphanumeric', () => {
			expect(() => prefixedId('abcdefghijk')).to.throw(/objectIdPrefix/);
			expect(() => prefixedId('Chat')).to.throw(/objectIdPrefix/);
			expect(() => prefixedId('')).to.throw(/objectIdPrefix/);
		});
	});

	describe('t.stringKey', () => {
		const def = ({ types: t }) => ({
			table: 'string_key_unit',
			objectIdPrefix: 'thing',
			schema: { id: t.stringKey, name: t.string },
		});

		it('is a uuidKey (same create/sync paths) flagged as a string id', () => {
			const schema = YassORM.convertDefinition(def);
			const id = schema.fields.find((f) => f.field === 'id');
			expect(id.type).to.equal('uuidKey');
			expect(id.stringId).to.equal(true);
		});

		it('generateObjectId() uses the def objectIdPrefix', () => {
			const Model = YassORM.loadDefinition(def);
			expect(Model.generateObjectId()).to.match(/^thing_[0-9a-z]{25}$/);
		});

		it('generateObjectId() still makes a uuid when no prefix is declared', () => {
			const Model = YassORM.loadDefinition(({ types: t }) => ({
				table: 'uuid_key_unit',
				schema: { id: t.uuidKey },
			}));
			expect(Model.generateObjectId()).to.match(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		});
	});

	describe('t.linked under stringLinkedIds', () => {
		let saved;
		before(() => {
			saved = config.stringLinkedIds;
			config.stringLinkedIds = true;
		});
		after(() => {
			config.stringLinkedIds = saved;
		});

		it('makes link columns varchar(36), not char(36) or int', () => {
			const schema = YassORM.convertDefinition(({ types: t }) => ({
				table: 'string_link_unit',
				schema: { id: t.stringKey, parent: t.linked('parent') },
			}));
			const parent = schema.fields.find((f) => f.field === 'parent');
			expect(parent.type).to.equal('varchar(36)');
			expect(parent.linkedModel).to.equal('parent');
		});
	});
});

describe('#stringKey type generation', () => {
	it('types a t.stringKey id as a plain string (no uuid() check)', () => {
		const field = { field: 'id', type: 'uuidKey', stringId: true };
		expect(mapFieldToTsType(field)).to.equal('string');
		expect(mapFieldToZodSchema(field)).to.equal('z.string()');
	});

	it('keeps z.string().uuid() for a real uuidKey', () => {
		expect(mapFieldToZodSchema({ field: 'id', type: 'uuidKey' })).to.equal(
			'z.string().uuid()',
		);
	});

	it('types a sized varchar (e.g. a string link column) as a string', () => {
		const field = { field: 'code', type: 'varchar(36)' };
		expect(mapFieldToTsType(field)).to.equal('string');
		expect(mapFieldToZodSchema(field)).to.equal('z.string()');
	});
});
