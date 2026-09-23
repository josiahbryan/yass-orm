/* eslint-disable no-unused-expressions */
/* global describe, it, beforeEach */
const { expect } = require('chai');
const { loadDefinition, DatabaseObject } = require('../lib');
const { isPostgres } = require('./helpers/characterize');

/**
 * Characterization (step 3 of the modernization plan): how values are
 * inflated from rows and deflated for writes today, so hydration can move
 * into its own module (step 4) without changing it. No database needed.
 */
describe('#characterize hydration (inflate / deflate)', () => {
	const Model = loadDefinition(({ types: t }) => ({
		table: 'yass_char_hydrate',
		schema: {
			id: t.idKey,
			name: t.string,
			count: t.int,
			score: t.real,
			flag: t.bool,
			born: t.date,
			seen: t.datetime,
			meta: t.object,
			tags: t.array(t.string),
			status: t.enum(['a', 'b']),
			body: t.text,
			owner: t.linked('no-such-model'),
			shape: t.object({ x: t.int, y: t.string }),
		},
	}));

	const allFields = [
		'id',
		'name',
		'count',
		'score',
		'flag',
		'born',
		'seen',
		'meta',
		'tags',
		'status',
		'body',
		'owner',
		'shape',
		'isDeleted',
	];

	beforeEach(() => Model.clearCache());

	describe('the schema', () => {
		it('adds isDeleted after the declared fields; fields() follows fieldMap', () => {
			expect(Object.keys(Model.schema().fieldMap)).to.deep.equal(allFields);
			expect(Model.fields().map(({ field }) => field)).to.deep.equal(allFields);
		});

		it('idField() is id, table() is the table, on the class and the instance', async () => {
			expect(Model.idField()).to.equal('id');
			expect(Model.table()).to.equal('yass_char_hydrate');
			const instance = await Model.inflate({ id: 1 });
			expect(instance.idField()).to.equal('id');
			expect(instance.table()).to.equal('yass_char_hydrate');
		});

		it('a loadDefinition() class is an anonymous ModelClass extending DatabaseObject', () => {
			expect(Model.name).to.equal('ModelClass');
			expect(Object.getPrototypeOf(Model)).to.equal(DatabaseObject);
			expect(Model.basePath()).to.equal(__dirname);
		});
	});

	describe('inflateValues()', () => {
		it('converts each type from what a driver returns', async () => {
			const values = await Model.inflateValues({
				id: 5,
				name: 7,
				count: '3',
				score: '1.5',
				flag: 1,
				born: new Date('2020-01-02T00:00:00Z'),
				seen: '2020-01-02 03:04:05',
				meta: '{"a":1}',
				tags: '["x"]',
				status: 'b',
				body: 'hi',
				shape: '{"x":1,"y":"z"}',
				isDeleted: 0,
			});
			expect(values).to.deep.equal({
				id: 5,
				name: '7',
				count: 3,
				score: 1.5,
				flag: true,
				born: '2020-01-02',
				seen: new Date('2020-01-02T03:04:05.000Z'),
				meta: { a: 1 },
				tags: ['x'],
				status: 'b',
				body: 'hi',
				owner: undefined,
				shape: { x: 1, y: 'z' },
				isDeleted: false,
			});
		});

		it('returns every schema field (missing ones undefined) and drops unknown keys', async () => {
			const values = await Model.inflateValues({ id: 1, extra: 'x' });
			expect(Object.keys(values).sort()).to.deep.equal([...allFields].sort());
			expect(values.name).to.equal(undefined);
			expect(values).to.not.have.property('extra');
		});

		it('keeps null as null for every type', async () => {
			const values = await Model.inflateValues({
				id: 1,
				name: null,
				count: null,
				flag: null,
				seen: null,
				meta: null,
				owner: null,
			});
			['name', 'count', 'flag', 'seen', 'meta', 'owner'].forEach((field) =>
				expect(values[field], field).to.equal(null),
			);
		});

		it('numbers go through parseFloat, even for t.int', async () => {
			const values = await Model.inflateValues({ id: 1, count: '3.7' });
			expect(values.count).to.equal(3.7);
		});

		it("booleans: only a value == '1' is true", async () => {
			const inflate = async (flag) =>
				(await Model.inflateValues({ flag })).flag;
			expect(await inflate(1)).to.equal(true);
			expect(await inflate('1')).to.equal(true);
			expect(await inflate(true)).to.equal(true);
			expect(await inflate(0)).to.equal(false);
			expect(await inflate('0')).to.equal(false);
			expect(await inflate(2)).to.equal(false);
			expect(await inflate('true')).to.equal(false);
		});

		it('datetimes: a Date is copied (same instant); a string is read as UTC, fraction kept', async () => {
			const driverDate = new Date(1600000000123);
			const fromDate = (await Model.inflateValues({ seen: driverDate })).seen;
			expect(fromDate).to.not.equal(driverDate);
			expect(fromDate.getTime()).to.equal(1600000000123);

			const fromString = (
				await Model.inflateValues({ seen: '2020-01-02 03:04:05.250' })
			).seen;
			expect(fromString.toISOString()).to.equal('2020-01-02T03:04:05.250Z');
		});

		it('dates stay YYYY-MM-DD strings (a driver Date is cut to its UTC day)', async () => {
			expect((await Model.inflateValues({ born: '2020-01-02' })).born).to.equal(
				'2020-01-02',
			);
			expect(
				(await Model.inflateValues({ born: new Date('2020-01-02T23:00:00Z') }))
					.born,
			).to.equal('2020-01-02');
		});

		it('objects: parsed from JSON text, passed through when already parsed', async () => {
			const parsed = { a: 2 };
			expect((await Model.inflateValues({ meta: parsed })).meta).to.equal(
				parsed,
			);
		});

		it('objects: unparseable JSON is kept as the raw string, with a warning', async () => {
			const { warn } = console; // eslint-disable-line no-console
			const warnings = [];
			// eslint-disable-next-line no-console
			console.warn = (...args) => warnings.push(args.join(' '));
			let values;
			try {
				values = await Model.inflateValues({ id: 9, meta: 'not json' });
			} finally {
				// eslint-disable-next-line no-console
				console.warn = warn;
			}
			expect(values.meta).to.equal('not json');
			expect(warnings).to.have.length(1);
			expect(warnings[0]).to.include('yass_char_hydrate.meta#9');
		});
	});

	describe('deflateValues()', () => {
		it('converts each type for the database', () => {
			const deflated = Model.deflateValues({
				id: 5,
				name: 'n',
				count: 3,
				flag: true,
				born: '2020-01-02',
				meta: { a: 1 },
				tags: ['x'],
				owner: { id: 9 },
				shape: { x: 1, y: 'z' },
			});
			expect(deflated).to.deep.equal({
				id: 5,
				name: 'n',
				count: 3,
				flag: 1,
				born: '2020-01-02',
				meta: '{"a":1}',
				tags: '["x"]',
				owner: 9,
				shape: '{"x":1,"y":"z"}',
			});
		});

		it('datetimes: whole seconds on MySQL, the full ISO instant on Postgres', () => {
			const { seen } = Model.deflateValues({ seen: new Date(1600000000123) });
			if (isPostgres()) {
				expect(seen).to.equal('2020-09-13T12:26:40.123Z');
			} else {
				expect(seen).to.equal('2020-09-13 12:26:40');
			}
		});

		it('only keys present in the object, never unknown keys', () => {
			expect(Model.deflateValues({ name: 'n', extra: 1 })).to.deep.equal({
				name: 'n',
			});
			expect(Model.deflateValues({})).to.deep.equal({});
		});

		it('an undefined value is dropped; a null is kept', () => {
			expect(
				Model.deflateValues({ name: undefined, body: null, owner: null }),
			).to.deep.equal({ body: null, owner: null });
		});

		it('booleans: only true is 1; noUndefined turns an undefined boolean into 0', () => {
			expect(Model.deflateValues({ flag: false })).to.deep.equal({ flag: 0 });
			expect(Model.deflateValues({ flag: 'yes' })).to.deep.equal({ flag: 0 });
			expect(Model.deflateValues({ flag: 1 })).to.deep.equal({ flag: 0 });
			expect(Model.deflateValues({ flag: undefined })).to.deep.equal({});
			expect(Model.deflateValues({ flag: undefined }, true)).to.deep.equal({
				flag: 0,
			});
		});

		it('a link: an instance (or anything with an id) becomes its id; an id stays', async () => {
			const linked = await Model.inflate({ id: 77 });
			expect(Model.deflateValues({ owner: linked })).to.deep.equal({
				owner: 77,
			});
			expect(Model.deflateValues({ owner: 12 })).to.deep.equal({ owner: 12 });
		});

		it('instance.deflate() deflates the instance itself, or the data given', async () => {
			const instance = await Model.inflate({ id: 3, name: 'x', flag: true });
			const own = instance.deflate();
			expect(own).to.include({ id: 3, name: 'x', flag: 1 });
			expect(instance.deflate({ name: 'y' })).to.deep.equal({ name: 'y' });
		});
	});

	describe('inflate()', () => {
		it('makes an instance with every field', async () => {
			const instance = await Model.inflate({ id: 5, name: 'x' });
			expect(instance).to.be.an.instanceOf(Model);
			expect(instance.name).to.equal('x');
			allFields.forEach((field) => expect(instance).to.have.property(field));
			expect(instance.getId()).to.equal(5);
			expect(String(instance)).to.equal('5');
		});

		it('returns null for no data, and for data without an id (with a trace)', async () => {
			expect(await Model.inflate(null)).to.equal(null);
			expect(await Model.inflate(undefined)).to.equal(null);

			const { trace } = console; // eslint-disable-line no-console
			let traced = 0;
			// eslint-disable-next-line no-console
			console.trace = () => {
				traced += 1;
			};
			try {
				expect(await Model.inflate({ name: 'no id' })).to.equal(null);
			} finally {
				// eslint-disable-next-line no-console
				console.trace = trace;
			}
			expect(traced).to.equal(1);
		});

		it('the same id inflates into the same instance, freshened', async () => {
			const first = await Model.inflate({ id: 5, name: 'x' });
			const second = await Model.inflate({ id: 5, name: 'y' });
			expect(second).to.equal(first);
			expect(first.name).to.equal('y');
		});

		it('re-inflating with fewer fields clears the missing ones on the cached instance', async () => {
			const first = await Model.inflate({ id: 6, name: 'x', count: 2 });
			await Model.inflate({ id: 6, name: 'y' });
			expect(first.name).to.equal('y');
			expect(first.count).to.equal(undefined);
		});

		it('new Model() throws: instances only come from inflate()', () => {
			expect(() => new Model({ id: 1 })).to.throw(
				TypeError,
				'Call ClassName.inflate() instead of new ClassName()',
			);
		});
	});
});
