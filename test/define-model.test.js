/* eslint-disable no-unused-expressions, global-require */
/* global describe, it, before, after, afterEach */
const { expect } = require('chai');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { isModelClass } = require('../lib/model/registry');
const { loadZod } = require('../lib/model/zod');
const {
	recreateTables,
	dropTable,
	quoteTable,
} = require('./helpers/characterize');

const { defineModel, applyTableNames, registerModels, checkLinks } = YassORM;

/**
 * defineModel(): a model from an inline schema, its TypeScript types inferred
 * (test-d/define-model.test-d.ts proves those), its table name settable
 * before first use, and `Model.zod`. Live database: MySQL in `npm test`,
 * Postgres in `npm run test:postgres`.
 */
describe('#YASS-ORM defineModel', function defineModelSuite() {
	this.timeout(30000);

	// The fixtures use t.stringKey ids, so their link columns hold strings.
	// Link column types are read when a model's schema is first built.
	let savedStringLinkedIds;
	before(() => {
		savedStringLinkedIds = config.stringLinkedIds;
		config.stringLinkedIds = true;
	});
	after(() => {
		config.stringLinkedIds = savedStringLinkedIds;
	});

	let cleanup = [];
	afterEach(() => {
		cleanup.forEach((fn) => fn());
		cleanup = [];
	});

	describe('the model class', () => {
		it('is a model class built on DatabaseObject, with the schema given', () => {
			const Thing = defineModel({
				table: 'yass_dm_thing',
				schema: (t) => ({ id: t.idKey, name: t.string, count: t.int }),
			});
			expect(isModelClass(Thing)).to.be.true;
			expect(Thing.prototype).to.be.an.instanceOf(YassORM.DatabaseObject);
			expect(Thing.table()).to.equal('yass_dm_thing');
			expect(Thing.defaultTable).to.equal('yass_dm_thing');
			expect(Thing.idField()).to.equal('id');
			expect(Thing.fields().map(({ field }) => field)).to.deep.equal([
				'id',
				'name',
				'count',
				'isDeleted',
			]);
		});

		it('builds the same schema a definition function does', () => {
			const schema = (t) => ({
				id: t.stringKey,
				name: t.string.default('x'),
				plan: t.enum(['a', 'b']),
				owner: t.linked('some-model'),
			});
			const Thing = defineModel({
				table: 'yass_dm_same',
				indexes: { byName: ['name'] },
				schema,
			});
			// Less `schema`: the converted schema keeps the field builders as
			// given, and each call makes new ones.
			const converted = (definition) => {
				const result = { ...YassORM.convertDefinition(definition) };
				delete result.schema;
				return result;
			};
			const expected = converted(({ types: t }) => ({
				table: 'yass_dm_same',
				indexes: { byName: ['name'] },
				schema: schema(t),
			}));
			const { schema: builders, ...built } = Thing.schema();
			expect(built).to.deep.equal(expected);
			expect(Object.keys(builders)).to.deep.equal([
				'id',
				'name',
				'plan',
				'owner',
			]);
			// Model.definition is that definition function, and
			// convertDefinition() takes the model itself (so schema-sync and
			// generate-types can load a file whose default export is a model).
			expect(converted(Thing.definition)).to.deep.equal(expected);
			expect(converted(Thing)).to.deep.equal(expected);
			expect(converted({ default: Thing })).to.deep.equal(expected);
		});

		it('gives prefixed, time-ordered ids for `prefix`', () => {
			const Thing = defineModel({
				table: 'yass_dm_prefixed',
				prefix: 'thg',
				schema: (t) => ({ id: t.stringKey }),
			});
			expect(Thing.generateObjectId()).to.match(/^thg_[0-9a-z]{25}$/);
			expect(Thing.schema().objectIdPrefix).to.equal('thg');
		});

		it('builds its schema on first use, not when defined', () => {
			let calls = 0;
			const Thing = defineModel({
				table: 'yass_dm_lazy',
				schema: (t) => {
					calls += 1;
					return { name: t.string };
				},
			});
			expect(calls).to.equal(0);
			Thing.schema();
			Thing.fields();
			expect(calls).to.equal(1);
		});

		it('extends the configured baseClass, as loadDefinition does', () => {
			const saved = config.baseClass;
			class Base extends YassORM.DatabaseObject {
				static fromBase() {
					return 'base';
				}
			}
			config.baseClass = Base;
			cleanup.push(() => {
				config.baseClass = saved;
			});
			const Thing = defineModel({
				table: 'yass_dm_base',
				schema: (t) => ({ name: t.string }),
			});
			expect(Thing.prototype).to.be.an.instanceOf(Base);
			expect(Thing.fromBase()).to.equal('base');
		});

		it('rejects a definition without a table or a schema function', () => {
			expect(() => defineModel({ schema: (t) => ({ a: t.string }) })).to.throw(
				/defineModel: `table` must be a non-empty string/,
			);
			expect(() => defineModel({ table: 'x', schema: {} })).to.throw(
				/defineModel\('x'\): `schema` must be a function/,
			);
			expect(() => defineModel()).to.throw(/defineModel: `table`/);
		});
	});

	describe('table names', () => {
		const makeModel = (table = 'yass_dm_rename') =>
			defineModel({ table, schema: (t) => ({ name: t.string }) });

		it('useTable() renames the table before first use, for the model and its subclasses', () => {
			const Thing = makeModel();
			class Sub extends Thing {}
			expect(Thing.useTable('tessera_thing')).to.equal(Thing);
			expect(Thing.table()).to.equal('tessera_thing');
			expect(Sub.table()).to.equal('tessera_thing');
			expect(Thing.defaultTable).to.equal('yass_dm_rename');
			expect(Thing.definition({ types: {} }).table).to.equal('tessera_thing');
		});

		it('useTable() after the schema is built throws, unless the name is the same', () => {
			const Thing = makeModel();
			Thing.useTable('first');
			Thing.table();
			expect(Thing.useTable('first')).to.equal(Thing);
			expect(() => Thing.useTable('second')).to.throw(
				/useTable\('second'\): the model's table is already 'first'/,
			);
			expect(() => makeModel().useTable('')).to.throw(
				/useTable: the table name must be a non-empty string/,
			);
		});

		it('applyTableNames() renames by default table name or prefix, and returns the map', () => {
			const A = makeModel('dm_users');
			const B = makeModel('dm_chats');
			const C = makeModel('dm_files');
			expect(
				applyTableNames([A, B, C], {
					tables: { dm_users: 'tessera_users' },
					tablePrefix: 'app_',
				}),
			).to.deep.equal({
				dm_users: 'tessera_users',
				dm_chats: 'app_dm_chats',
				dm_files: 'app_dm_files',
			});
			expect(A.table()).to.equal('tessera_users');
			expect(B.table()).to.equal('app_dm_chats');

			const D = makeModel('dm_other');
			expect(applyTableNames({ D }, {})).to.deep.equal({
				dm_other: 'dm_other',
			});
		});

		it('applyTableNames() rejects a name for no model, and two models on one table', () => {
			const A = makeModel('dm_a');
			const B = makeModel('dm_b');
			expect(() => applyTableNames([A, B], { tables: { dm_c: 'x' } })).to.throw(
				/applyTableNames: no model has the default table 'dm_c'/,
			);
			expect(() =>
				applyTableNames([A, B], { tables: { dm_a: 'same', dm_b: 'same' } }),
			).to.throw(
				/applyTableNames: 'dm_a' and 'dm_b' would both use table 'same'/,
			);
			// Nothing was renamed by a call that threw.
			expect(A.table()).to.equal('dm_a');
			expect(() =>
				applyTableNames(
					[
						A,
						YassORM.loadDefinition(({ types: t }) => ({
							table: 'dm_x',
							schema: { a: t.string },
						})),
					],
					{},
				),
			).to.throw(/applyTableNames: not a defineModel\(\) model/);
		});

		it('applyTableNames() renames nothing when a model to rename was already read', () => {
			const A = makeModel('dm_early_a');
			const B = makeModel('dm_early_b');
			B.table();
			expect(() => applyTableNames([A, B], { tablePrefix: 'app_' })).to.throw(
				/useTable\('app_dm_early_b'\): the model's table is already 'dm_early_b'/,
			);
			expect(A.table()).to.equal('dm_early_a');
		});

		it('reading Model.zod leaves the table renamable', () => {
			const Thing = makeModel('dm_zod_first');
			expect(typeof Thing.zod.parse).to.equal('function');
			Thing.useTable('dm_zod_renamed');
			expect(Thing.table()).to.equal('dm_zod_renamed');
		});
	});

	describe('on the database', () => {
		const OrgModel = require('./fixtures/define-model/org');
		const Member = require('./fixtures/define-model/member');
		const Team = require('./fixtures/define-model/team');

		let unregister;
		before(async () => {
			unregister = registerModels({ 'dm-team': Team });
			await recreateTables([OrgModel, Member, Team]);
		});
		after(() => unregister());

		it('creates and reads back every field type', async () => {
			const foundedAt = new Date('2024-05-06T07:08:09.123Z');
			const org = await OrgModel.create({
				name: 'Acme',
				slug: 'acme',
				seats: 3,
				active: true,
				plan: 'pro',
				settings: { theme: 'dark' },
				tags: ['a', 'b'],
				foundedAt,
			});
			expect(org).to.be.an.instanceOf(OrgModel);
			expect(org.id).to.match(/^org_/);

			OrgModel.clearCache();
			const read = await OrgModel.get(org.id);
			expect(read).to.be.an.instanceOf(OrgModel);
			expect(read).to.not.equal(org);
			expect(read.name).to.equal('Acme');
			expect(read.slug).to.equal('acme');
			expect(read.seats).to.equal(3);
			expect(read.active).to.equal(true);
			expect(read.plan).to.equal('pro');
			expect(read.settings).to.deep.equal({ theme: 'dark' });
			expect(read.tags).to.deep.equal(['a', 'b']);
			expect(read.foundedAt.getTime()).to.equal(foundedAt.getTime());
			expect(read.parent).to.equal(null);
			expect(read.isDeleted).to.equal(false);
			// The subclass's methods.
			expect(read.label).to.equal('Acme (3)');
			expect((await OrgModel.bySlug('acme')).id).to.equal(org.id);
		});

		it('loads links by lazy reference (to a subclass, and to itself) and by registered name', async () => {
			const parent = await OrgModel.create({ name: 'Parent', slug: 'p' });
			const child = await OrgModel.create({
				name: 'Child',
				slug: 'c',
				parent,
			});
			const team = await Team.create({ name: 'Core' });
			const member = await Member.create({
				email: 'a@example.com',
				org: child,
				team: team.id,
			});
			await team.patch({ lead: member });

			OrgModel.clearCache();
			Member.clearCache();
			Team.clearCache();
			const read = await Member.get(member.id);
			expect(read.org).to.be.an.instanceOf(OrgModel);
			expect(read.org.label).to.equal('Child (0)');
			expect(read.org.parent).to.be.an.instanceOf(OrgModel);
			expect(read.org.parent.id).to.equal(parent.id);
			expect(read.team).to.be.an.instanceOf(Team);
			expect(read.team.name).to.equal('Core');
			expect(read.team.lead).to.equal(read);
		});

		it('checkLinks() resolves every link of defined models', async () => {
			const report = await checkLinks({ models: [OrgModel, Member, Team] });
			expect(report).to.deep.equal({ ok: true, checked: 4, problems: [] });
		});

		it('reads and writes the renamed table', async () => {
			const Renamed = defineModel({
				table: 'yass_dm_default_name',
				schema: (t) => ({ id: t.stringKey, name: t.string }),
			});
			applyTableNames([Renamed], { tablePrefix: 'yass_app_' });
			expect(Renamed.table()).to.equal('yass_app_yass_dm_default_name');
			await dropTable('yass_dm_default_name');
			await recreateTables([Renamed]);

			const row = await Renamed.create({ id: 'r1', name: 'renamed' });
			const conn = await dbh();
			const rows = await conn.pquery(
				`SELECT name FROM ${quoteTable('yass_app_yass_dm_default_name')}`,
			);
			expect(rows.map(({ name }) => name)).to.deep.equal(['renamed']);
			expect((await Renamed.get(row.id)).name).to.equal('renamed');
		});
	});

	describe('Model.zod', () => {
		const Thing = defineModel({
			table: 'yass_dm_zod',
			schema: (t) => ({
				id: t.stringKey,
				name: t.string.default('').minLength(2),
				email: t.string.email(),
				seats: t.int.min(0),
				ratio: t.real,
				active: t.bool,
				plan: t.enum(['free', 'pro']),
				at: t.datetime,
				day: t.date,
				settings: t.object({ theme: t.string }),
				stamped: t.object({ at: t.datetime }),
				loose: t.object(),
				tags: t.array(t.string),
				kinds: t.array(t.enum(['x', 'y'])),
				steps: t.array(t.object({ label: t.string })),
				anything: t.any,
				owner: t.linked('someone'),
				members: t.hasMany('member'),
			}),
		});

		it('is a zod schema for the model data, built once', () => {
			expect(Thing.zod).to.equal(Thing.zod);
			expect(typeof Thing.zod.parse).to.equal('function');
			const data = {
				id: 'thing_1',
				name: 'Al',
				email: 'al@example.com',
				seats: 2,
				ratio: 0.5,
				active: true,
				plan: 'pro',
				at: new Date('2024-01-01T00:00:00Z'),
				day: '2024-01-01',
				settings: { theme: 'dark' },
				loose: { any: 1 },
				tags: ['a'],
				kinds: ['x'],
				steps: [{ label: 'one' }],
				anything: [1, 'two'],
				owner: 'usr_1',
				isDeleted: false,
			};
			expect(Thing.zod.parse(data)).to.deep.equal(data);
			// Every field is optional.
			expect(Thing.zod.parse({})).to.deep.equal({});
		});

		it('takes null only where the column is nullable', () => {
			expect(Thing.zod.safeParse({ email: null, seats: null }).success).to.be
				.true;
			expect(Thing.zod.safeParse({ plan: null, owner: null }).success).to.be
				.true;
			expect(Thing.zod.safeParse({ name: null }).success).to.be.false;
			expect(Thing.zod.safeParse({ active: null }).success).to.be.false;
			// A NOT NULL datetime takes no null (z.coerce.date() made it 1970).
			const Stamp = defineModel({
				table: 'yass_dm_zod_stamp',
				schema: (t) => ({ at: t.datetime.default('2024-01-01 00:00:00') }),
			});
			expect(Stamp.zod.safeParse({ at: null }).success).to.be.false;
			expect(Stamp.zod.parse({ at: '2024-01-01T00:00:00Z' }).at).to.deep.equal(
				new Date('2024-01-01T00:00:00Z'),
			);
			expect(Thing.zod.safeParse({ at: null }).success).to.be.true;
		});

		it('checks types, enums and the chained validations', () => {
			const fails = (data) => Thing.zod.safeParse(data).success === false;
			expect(fails({ name: 5 })).to.be.true;
			expect(fails({ name: 'A' })).to.be.true; // minLength(2)
			expect(fails({ email: 'nope' })).to.be.true;
			expect(fails({ seats: -1 })).to.be.true; // min(0)
			expect(fails({ seats: 1.5 })).to.be.true; // an integer
			expect(fails({ plan: 'enterprise' })).to.be.true;
			// t.array(t.enum([...])) keeps no options (def-to-schema reads the
			// enum's varchar type first), so its items are plain strings, here
			// and in generate-types.
			expect(fails({ kinds: ['z'] })).to.be.false;
			expect(fails({ kinds: [1] })).to.be.true;
			expect(fails({ steps: [{ label: 3 }] })).to.be.true;
			expect(fails({ at: 'not a date' })).to.be.true;
			expect(fails({ owner: {} })).to.be.true;
			// Inside JSON a datetime is the ISO string JSON gives back.
			expect(fails({ stamped: { at: '2024-01-01T00:00:00.000Z' } })).to.be
				.false;
			expect(fails({ stamped: { at: new Date() } })).to.be.true;
			// A link is its id: a string or a number.
			expect(fails({ owner: 12 })).to.be.false;
			// Keys that aren't columns are dropped (t.hasMany is a hint).
			expect(Thing.zod.parse({ members: [], nope: 1 })).to.deep.equal({});
		});

		it("says so when zod isn't installed", () => {
			expect(() => loadZod([])).to.throw(/Model\.zod needs the 'zod' package/);
		});
	});
});
