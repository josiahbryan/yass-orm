/* eslint-disable no-unused-expressions */
/* global describe, it, before, beforeEach */
const { expect } = require('chai');
const { loadDefinition } = require('../lib');
const { dbh } = require('../lib/dbh');
const {
	isPostgres,
	recreateTables,
	quoteTable,
	ROLLBACK,
	rollingBack,
	rejectionOf,
	eventually,
} = require('./helpers/characterize');

/**
 * Characterization (step 3 of the modernization plan): findOrCreate(),
 * search(), searchOne(), fromSql(), withDbh(), queryCallback(), and set() /
 * update() on a plain model, as they behave today. Live database: MySQL in
 * `npm test`, Postgres in `npm run test:postgres`.
 */
describe('#characterize finding and saving', function findSuite() {
	this.timeout(30000);

	const definition = ({ types: t }) => ({
		table: 'yass_char_find',
		schema: {
			id: t.idKey,
			name: t.string,
			points: t.int,
			note: t.string,
			createdAt: t.datetime,
			updatedAt: t.datetime,
		},
	});
	const uuidDefinition = ({ types: t }) => ({
		table: 'yass_char_find_uuid',
		schema: { id: t.uuidKey, name: t.string },
	});

	// Hooks recorded on a subclass, as a consumer would override them.
	const hooks = [];
	class Model extends loadDefinition(definition) {
		async afterCreateHook(options) {
			hooks.push(['afterCreateHook', options]);
			return super.afterCreateHook(options);
		}

		async afterChangeHook(options) {
			hooks.push(['afterChangeHook', options]);
			return super.afterChangeHook(options);
		}
	}
	const UuidModel = loadDefinition(uuidDefinition);

	let conn;
	const names = (rows) => rows.map(({ name }) => name);

	before(async () => {
		await recreateTables([definition, uuidDefinition]);
		conn = await dbh();
	});

	beforeEach(async () => {
		await Promise.all(
			[Model, UuidModel].map((M) =>
				conn.pquery(`DELETE FROM ${quoteTable(M.table())}`),
			),
		);
		Model.clearCache();
		UuidModel.clearCache();
		hooks.length = 0;
	});

	const seed = async () => {
		await Model.create({ name: 'a', points: 1 });
		await Model.create({ name: 'b', points: 5, note: 'x' });
		await Model.create({ name: 'c', points: 3, note: 'x' });
		hooks.length = 0;
	};

	describe('findOrCreate()', () => {
		it('creates from fields + patchIf + patchIfFalsey, stamps createdAt, and runs the hooks', async () => {
			const created = await Model.findOrCreate(
				{ name: 'a' },
				{ points: 1 },
				{ note: 'n' },
			);
			expect(created).to.include({ name: 'a', points: 1, note: 'n' });
			expect(created.createdAt).to.be.an.instanceOf(Date);
			expect(hooks).to.deep.equal([
				// From the createdAt patch.
				['afterChangeHook', { tx: undefined }],
				['afterCreateHook', { tx: undefined }],
				['afterChangeHook', { wasCreated: true, tx: undefined }],
			]);
			expect(await Model.getCachedId(created.id)).to.equal(created);
		});

		it('finds a match: the cached instance, no hooks when nothing changes', async () => {
			const created = await Model.findOrCreate({ name: 'a' }, { points: 1 });
			hooks.length = 0;

			// patchIfFalsey leaves a truthy value alone.
			const found = await Model.findOrCreate(
				{ name: 'a' },
				{ points: 1 },
				{ points: 9 },
			);
			expect(found).to.equal(created);
			expect(found.points).to.equal(1);
			expect(hooks).to.deep.equal([]);
		});

		it('finds a match and patches what differs: afterChangeHook({ wasCreated: false })', async () => {
			const created = await Model.findOrCreate({ name: 'a' }, { points: 1 });
			hooks.length = 0;

			const found = await Model.findOrCreate(
				{ name: 'a' },
				{ points: 2 },
				{ note: 'filled' },
			);
			expect(found).to.equal(created);
			expect(found).to.include({ points: 2, note: 'filled' });
			expect(hooks).to.deep.equal([
				['afterChangeHook', { wasCreated: false, tx: undefined }],
			]);
		});

		it("with { tx }, joins the caller's transaction", async () => {
			await rollingBack(
				conn.transaction(async (tx) => {
					const created = await Model.findOrCreate(
						{ name: 'in tx' },
						{},
						{},
						{ tx },
					);
					expect(
						await Model.findOrCreate({ name: 'in tx' }, {}, {}, { tx }),
					).to.equal(created);
					throw ROLLBACK;
				}),
			);
			expect(await Model.searchOne({ name: 'in tx' })).to.equal(null);
		});

		// Fixed bug (step 3 found it; fixed in step 7), MySQL: dbh.create()
		// generated an id only when config.uuidLinkedIds was set. Without it,
		// findOrCreate() on a t.uuidKey model inserted no id (the table's trigger
		// set one), then read the row back with `WHERE id = 0` (the insertId).
		// MySQL compares a char id with 0 as a number, so that matched any id
		// starting with a letter or with zeros: it returned ANOTHER row.
		it('findOrCreate() on a t.uuidKey model without uuidLinkedIds returns its own row', async () => {
			// On MySQL, '00000000-...' = 0 is true.
			await UuidModel.create({
				id: '00000000-0000-4000-8000-000000000000',
				name: 'other',
			});
			const created = await UuidModel.findOrCreate({ name: 'mine' });
			expect(created.name).to.equal('mine');
			expect(created.id).to.be.a('string').with.length(36);
			expect(await UuidModel.findOrCreate({ name: 'mine' })).to.equal(created);
		});
	});

	describe('search()', () => {
		beforeEach(seed);

		it('an array of instances, [] when nothing matches', async () => {
			expect(names(await Model.search({ note: 'x' })).sort()).to.deep.equal([
				'b',
				'c',
			]);
			expect(await Model.search({ name: 'none' })).to.deep.equal([]);
		});

		it('a null value matches IS NULL', async () => {
			expect(names(await Model.search({ note: null }))).to.deep.equal(['a']);
		});

		it('a field that is not in the schema is dropped, so it filters nothing', async () => {
			expect(await Model.search({ bogus: 1 })).to.have.length(3);
		});

		it('search(fields, true): one instance or null', async () => {
			expect((await Model.search({ name: 'b' }, true)).name).to.equal('b');
			expect(await Model.search({ name: 'none' }, true)).to.equal(null);
		});

		it('orderBy / orderDir, limit / offset', async () => {
			expect(
				names(await Model.search({}, { orderBy: 'points', orderDir: 'desc' })),
			).to.deep.equal(['b', 'c', 'a']);
			expect(
				names(
					await Model.search({}, { orderBy: 'points', limit: 1, offset: 1 }),
				),
			).to.deep.equal(['c']);
		});

		it('throws on an unknown option, and on an orderBy that is not a column', async () => {
			expect(
				(await rejectionOf(Model.search({}, { bogus: 1 }))).message,
			).to.include("unknown option 'bogus'");
			expect(
				(await rejectionOf(Model.search({}, { orderBy: 'nope' }))).message,
			).to.include("option 'orderBy' names 'nope'");
		});

		it('takes { tx } as the third or the fourth argument', async () => {
			await rollingBack(
				conn.transaction(async (tx) => {
					await Model.create({ name: 'tx row', note: 'tx' }, { tx });
					expect(
						names(await Model.search({ note: 'tx' }, false, { tx })),
					).to.deep.equal(['tx row']);
					expect(
						names(await Model.search({ note: 'tx' }, false, undefined, { tx })),
					).to.deep.equal(['tx row']);
					expect(await Model.search({ note: 'tx' })).to.deep.equal([]);
					throw ROLLBACK;
				}),
			);
		});
	});

	describe('searchOne()', () => {
		beforeEach(seed);

		it('the first match, or null', async () => {
			expect((await Model.searchOne({ name: 'a' })).name).to.equal('a');
			expect(await Model.searchOne({ name: 'none' })).to.equal(null);
		});

		it('with no fields returns null without querying', async () => {
			expect(await Model.searchOne({})).to.equal(null);
			expect(await Model.searchOne({}, { orderBy: 'points' })).to.equal(null);
		});

		it('orderBy picks which match', async () => {
			expect(
				(await Model.searchOne({ note: 'x' }, { orderBy: 'points' })).name,
			).to.equal('c');
			expect(
				(
					await Model.searchOne(
						{ note: 'x' },
						{ orderBy: 'points', orderDir: 'desc' },
					)
				).name,
			).to.equal('b');
		});

		it('throws on limit (use search())', async () => {
			const error = await rejectionOf(
				Model.searchOne({ name: 'a' }, { limit: 1 }),
			);
			expect(error.message).to.include("option 'limit' is not available");
		});

		it('takes { tx } in the options or as the third argument', async () => {
			await rollingBack(
				conn.transaction(async (tx) => {
					await Model.create({ name: 'tx row' }, { tx });
					expect(await Model.searchOne({ name: 'tx row' }, { tx })).to.exist;
					expect(await Model.searchOne({ name: 'tx row' }, undefined, { tx }))
						.to.exist;
					expect(await Model.searchOne({ name: 'tx row' })).to.equal(null);
					throw ROLLBACK;
				}),
			);
		});
	});

	describe('fromSql(), withDbh(), queryCallback()', () => {
		beforeEach(seed);

		it('fromSql(where, params): instances, [] when nothing matches', async () => {
			expect(
				names(await Model.fromSql('points > :min order by points', { min: 2 })),
			).to.deep.equal(['c', 'b']);
			expect(await Model.fromSql('points > :min', { min: 99 })).to.deep.equal(
				[],
			);
		});

		it('fromSql() with no arguments returns every row (MySQL)', async function everyRow() {
			if (isPostgres()) {
				this.skip();
			}
			expect(await Model.fromSql()).to.have.length(3);
		});

		// Fixed bug (step 3 found it; fixed in step 7): fromSql()'s default
		// where clause was '1', which Postgres rejects ("argument of WHERE must
		// be type boolean").
		it('fromSql() with no arguments returns every row (Postgres too)', async () => {
			expect(await Model.fromSql()).to.have.length(3);
		});

		it('withDbh(sql, params) runs the SQL; withDbh(fn) gets (dbh, table)', async () => {
			const rows = await Model.withDbh(
				`select name from ${quoteTable(Model.table())} where points = :points`,
				{ points: 5 },
			);
			expect(names(rows)).to.deep.equal(['b']);
			expect(await Model.withDbh((handle, table) => table)).to.equal(
				'yass_char_find',
			);
		});

		it('queryCallback(fn) runs the [sql, params] fn returns for the table', async () => {
			const rows = await Model.queryCallback((table) => [
				`select name from ${table} where points = :points`,
				{ points: 5 },
			]);
			expect(names(rows)).to.deep.equal(['b']);
		});
	});

	describe('set() and update() on a plain model', () => {
		// PATCH_DEFER_DELAY is 300ms: long enough for the save to have started.
		const afterAutoSave = () =>
			new Promise((resolve) => setTimeout(resolve, 400));

		// The row as stored, read past the instance cache.
		const stored = async (id) => {
			const [row] = await conn.pquery(
				`SELECT name, points FROM ${quoteTable(Model.table())} WHERE id = :id`,
				{ id },
			);
			return row && { name: row.name, points: row.points };
		};

		// Records each update() call, then runs the real one.
		const recordUpdates = (instance) => {
			const updates = [];
			const { update } = instance;
			// eslint-disable-next-line no-param-reassign
			instance.update = (...args) => {
				updates.push(args);
				return update.apply(instance, args);
			};
			return updates;
		};

		it('set() assigns at once and returns the instance; an object sets several', async () => {
			const instance = await Model.create({ name: 'a' });
			// No auto-save in this test.
			instance.update = async () => instance;
			expect(instance.set('name', 'b')).to.equal(instance);
			expect(instance.name).to.equal('b');
			instance.set({ name: 'c', points: 4 });
			expect(instance).to.include({ name: 'c', points: 4 });
		});

		it('set() calls this.update() once, 300ms later, with the fields it set', async () => {
			const instance = await Model.create({ name: 'a' });
			const updates = [];
			instance.update = async (...args) => {
				updates.push(args);
				return instance;
			};
			instance.set('name', 'b');
			instance.set('points', 2);
			expect(updates).to.deep.equal([]);
			await afterAutoSave();
			// Fixed bug 14: update() used to get no arguments (so patch(undefined)).
			expect(updates).to.deep.equal([[{ name: 'b', points: 2 }]]);
		});

		it('update(data) patches like patch(data)', async () => {
			const instance = await Model.create({ name: 'a' });
			await instance.update({ name: 'updated' });
			expect(instance.name).to.equal('updated');
			expect((await Model.get(instance.id)).name).to.equal('updated');
		});

		// Fixed bug 14 (plan, step 2): update() called patch(undefined), which
		// threw on a plain model, so set()'s auto-save never saved.
		it('set() auto-save on a plain model saves the field', async () => {
			const instance = await Model.create({ name: 'a' });
			const errors = [];
			instance.onAutoSaveError = (error) => errors.push(error);
			instance.set('name', 'saved by set');
			await eventually(async () =>
				expect(await stored(instance.id)).to.include({ name: 'saved by set' }),
			);
			expect(errors).to.deep.equal([]);
			Model.clearCache();
			expect((await Model.get(instance.id)).name).to.equal('saved by set');
		});

		it('a read of the row before the save does not undo the set(), and it is saved', async () => {
			const instance = await Model.create({ name: 'a', points: 1 });
			instance.set('name', 'x');
			// get() freshens the cached instance, which is this one.
			expect(await Model.get(instance.id)).to.equal(instance);
			expect(instance.name).to.equal('x');
			await eventually(async () =>
				expect(await stored(instance.id)).to.deep.equal({
					name: 'x',
					points: 1,
				}),
			);
			expect(instance.name).to.equal('x');
		});

		it('a patch() of another field before the save keeps the set() value; both are saved', async () => {
			const instance = await Model.create({ name: 'a', points: 1 });
			instance.set('name', 'x');
			await instance.patch({ points: 9 });
			expect(instance).to.include({ name: 'x', points: 9 });
			await eventually(async () =>
				expect(await stored(instance.id)).to.deep.equal({
					name: 'x',
					points: 9,
				}),
			);
			expect(instance).to.include({ name: 'x', points: 9 });
		});

		it('a patch() of the same field before the save is the later write: it wins', async () => {
			const instance = await Model.create({ name: 'a', points: 1 });
			const updates = recordUpdates(instance);
			instance.set('name', 'x');
			await instance.patch({ name: 'y' });
			await afterAutoSave();
			// Nothing was left to save.
			expect(updates).to.deep.equal([]);
			expect(instance.name).to.equal('y');
			expect(await stored(instance.id)).to.deep.equal({ name: 'y', points: 1 });
		});

		it('a patch() of the same field that fails does not drop the set(): it is still saved', async () => {
			const instance = await Model.create({ name: 'a' });
			instance.set('name', 'x');
			const { _runOn: runOn } = instance;
			instance._runOn = () => Promise.reject(new Error('write failed'));
			const error = await rejectionOf(instance.patch({ name: 'y' }));
			instance._runOn = runOn;
			expect(error.message).to.equal('write failed');
			await eventually(async () =>
				expect(await stored(instance.id)).to.include({ name: 'x' }),
			);
		});

		it('patchIf() of the unsaved value itself writes nothing (it compares with the instance); the set() is still saved', async () => {
			const instance = await Model.create({ name: 'a' });
			instance.set('name', 'x');
			await instance.patchIf({ name: 'x' });
			await eventually(async () =>
				expect(await stored(instance.id)).to.include({ name: 'x' }),
			);
			expect(instance.name).to.equal('x');
		});

		it('patchIf() that writes a field (ifFalsey) is the later write: it wins', async () => {
			const instance = await Model.create({ name: 'a' });
			const updates = recordUpdates(instance);
			instance.set('name', '');
			await instance.patchIf({}, { name: 'z' });
			await afterAutoSave();
			expect(updates).to.deep.equal([]);
			expect(instance.name).to.equal('z');
			expect(await stored(instance.id)).to.include({ name: 'z' });
		});

		it('a set() while the save runs is saved next; the first save does not undo it', async () => {
			const instance = await Model.create({ name: 'a' });
			const { patch } = instance;
			const saves = [];
			instance.patch = function patchWithSetDuringSave(...args) {
				// Inside the save: a patch override that awaits, then sets, is the
				// same case.
				if (!saves.length) this.set('name', 'second');
				const save = patch.apply(this, args);
				saves.push(save);
				return save;
			};
			instance.set('name', 'first');
			await eventually(() => expect(saves).to.have.length(1));
			await saves[0];
			// The first save's read-back said 'first'; the edit made during it
			// stays on top.
			expect(instance.name).to.equal('second');
			await eventually(async () =>
				expect(await stored(instance.id)).to.include({ name: 'second' }),
			);
			expect(saves).to.have.length(2);
			expect(instance.name).to.equal('second');
		});

		it("a transaction's write of another field, published at commit, does not undo the set()", async () => {
			const instance = await Model.create({ name: 'a', points: 1 });
			instance.set('name', 'x');
			await conn.transaction(async (tx) => {
				const inTx = await Model.get(instance.id, { tx });
				expect(inTx).to.not.equal(instance);
				await inTx.patch({ points: 5 }, { tx });
			});
			// The commit copied the transaction's row onto the shared instance.
			expect(await Model.getCachedId(instance.id)).to.equal(instance);
			expect(instance).to.include({ name: 'x', points: 5 });
			await eventually(async () =>
				expect(await stored(instance.id)).to.deep.equal({
					name: 'x',
					points: 5,
				}),
			);
		});

		it('reallyDelete() cancels the save of unsaved set()s', async () => {
			const instance = await Model.create({ name: 'a' });
			const updates = recordUpdates(instance);
			instance.set('name', 'x');
			await instance.reallyDelete();
			await afterAutoSave();
			expect(updates).to.deep.equal([]);
			expect(await stored(instance.id)).to.equal(undefined);
		});

		it('set() of a field not in the schema only assigns it: nothing is saved', async () => {
			const instance = await Model.create({ name: 'a' });
			const updates = [];
			instance.update = async (...args) => {
				updates.push(args);
				return instance;
			};
			instance.set('scratch', 1);
			expect(instance.scratch).to.equal(1);
			await afterAutoSave();
			expect(updates).to.deep.equal([]);
		});
	});
});
