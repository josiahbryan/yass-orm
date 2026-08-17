/* eslint-disable no-unused-expressions */
/* global it, describe */
const path = require('path');
const { expect } = require('chai');
const {
	singularize,
	toPascalCase,
	enumLiteralMembers,
	mapFieldToTsType,
	mapFieldToZodSchema,
	generateTypesContent,
} = require('../lib/generate-types');

describe('#generate-types singularization', () => {
	describe('singularize()', () => {
		it('should handle words ending in -xes (inboxes → inbox)', () => {
			expect(singularize('chat_inboxes')).to.equal('chat_inbox');
			expect(singularize('boxes')).to.equal('box');
		});

		it('should handle words ending in -sses (glasses → glass)', () => {
			expect(singularize('glasses')).to.equal('glass');
			expect(singularize('classes')).to.equal('class');
		});

		it('should handle words ending in -ches (matches → match)', () => {
			expect(singularize('matches')).to.equal('match');
			expect(singularize('batches')).to.equal('batch');
		});

		it('should handle words ending in -shes (wishes → wish)', () => {
			expect(singularize('wishes')).to.equal('wish');
			expect(singularize('dishes')).to.equal('dish');
		});

		it('should handle words ending in -zes (buzzes → buzz)', () => {
			expect(singularize('buzzes')).to.equal('buzz');
			expect(singularize('fizzes')).to.equal('fizz');
		});

		it('should handle words ending in -ies (categories → category)', () => {
			expect(singularize('categories')).to.equal('category');
			expect(singularize('entries')).to.equal('entry');
		});

		it('should handle regular plurals ending in -s (users → user)', () => {
			expect(singularize('users')).to.equal('user');
			expect(singularize('messages')).to.equal('message');
			expect(singularize('vehicles')).to.equal('vehicle');
			expect(singularize('places')).to.equal('place');
		});

		it('should handle snake_case table names', () => {
			expect(singularize('user_devices')).to.equal('user_device');
			expect(singularize('account_places')).to.equal('account_place');
			expect(singularize('time_dept_rates')).to.equal('time_dept_rate');
		});
	});

	describe('toPascalCase() + singularize() integration', () => {
		it('should produce correct type names for -xes tables', () => {
			expect(toPascalCase(singularize('chat_inboxes'))).to.equal('ChatInbox');
		});

		it('should produce correct type names for -ies tables', () => {
			expect(toPascalCase(singularize('categories'))).to.equal('Category');
		});

		it('should produce correct type names for regular tables', () => {
			expect(toPascalCase(singularize('users'))).to.equal('User');
			expect(toPascalCase(singularize('messages'))).to.equal('Message');
		});

		it('should produce correct type names for snake_case tables', () => {
			expect(toPascalCase(singularize('user_devices'))).to.equal('UserDevice');
			expect(toPascalCase(singularize('chat_inboxes'))).to.equal('ChatInbox');
		});
	});
});

describe('#generate-types search() overload emission (BDL-2646)', () => {
	// `generateTypesContent` is the function that renders the per-model .d.ts,
	// including the `search()` static overloads at lib/generate-types.js:805-812.
	// Reuse the existing nested-schema fixture rather than inventing a new one.
	const fixturePath = path.join(
		__dirname,
		'fixtures',
		'test-nested-schema.js',
	);

	it('emits the SearchOptions overload for search()', () => {
		const generated = generateTypesContent(fixturePath);
		expect(generated).to.match(
			/search\(\s*query: Record<string, unknown>,\s*options: import\('yass-orm'\)\.SearchOptions/,
		);
	});
});

// A def may list `null` as an enum value so it becomes the column default:
//   t.enum([null, 'a', 'b'], { defaultValue: null })
// yass-orm uses the first value as the default; here that default is a genuine
// SQL NULL. The generated TYPES must NOT turn that `null` into the string-literal
// member `'null'` — every enum type is already `| null` for nullability, so a
// `'null'` member is both redundant and a bug (it fails to satisfy consumers that
// expect the real value union, and the Zod schema would validate the STRING
// "null" as a legal value). See enumLiteralMembers().
describe('#generate-types null-in-enum default marker', () => {
	describe('enumLiteralMembers()', () => {
		it('quotes plain values and appends nothing', () => {
			expect(enumLiteralMembers(['a', 'b'])).to.deep.equal(["'a'", "'b'"]);
		});

		it("DROPS a leading null default-marker (not stringified to 'null')", () => {
			expect(enumLiteralMembers([null, 'a', 'b'])).to.deep.equal([
				"'a'",
				"'b'",
			]);
		});

		it('drops null/undefined anywhere in the list', () => {
			expect(enumLiteralMembers(['a', null, 'b', undefined])).to.deep.equal([
				"'a'",
				"'b'",
			]);
		});

		it('applies the optional format wrapper to each surviving literal', () => {
			expect(
				enumLiteralMembers([null, 'a', 'b'], (lit) => `| ${lit}`),
			).to.deep.equal(["| 'a'", "| 'b'"]);
		});
	});

	describe('mapFieldToTsType() — TS union', () => {
		it("a null-default enum yields the value union + a single | null (no 'null' member)", () => {
			const ts = mapFieldToTsType({
				_type: 'enum',
				options: [null, 'claude', 'codex'],
			});
			expect(ts).to.equal("'claude' | 'codex' | null");
			expect(ts).to.not.contain("'null'");
		});

		it('a plain enum is unchanged', () => {
			expect(mapFieldToTsType({ _type: 'enum', options: ['a', 'b'] })).to.equal(
				"'a' | 'b' | null",
			);
		});

		it('array-of-enums drops the null marker too', () => {
			const ts = mapFieldToTsType({
				isArray: true,
				arrayItemType: 'enum',
				arrayItemEnumOptions: [null, 'x', 'y'],
			});
			expect(ts).to.equal("Array<'x' | 'y' | null>");
			expect(ts).to.not.contain("'null'");
		});
	});

	describe('mapFieldToZodSchema() — Zod schema', () => {
		it("a null-default enum yields z.enum([values]).nullable() (no 'null' member)", () => {
			const zod = mapFieldToZodSchema({
				_type: 'enum',
				options: [null, 'claude', 'codex'],
			});
			expect(zod).to.equal("z.enum(['claude', 'codex']).nullable()");
			expect(zod).to.not.contain("'null'");
		});

		it('array-of-enums drops the null marker too', () => {
			const zod = mapFieldToZodSchema({
				isArray: true,
				arrayItemType: 'enum',
				arrayItemEnumOptions: [null, 'x', 'y'],
			});
			expect(zod).to.equal("z.array(z.enum(['x', 'y']).nullable())");
			expect(zod).to.not.contain("'null'");
		});
	});
});
