/* eslint-disable no-unused-expressions */
/* global describe, it, before, after, beforeEach */
const { expect } = require('chai');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const {
	recreateTables,
	quoteTable,
	ROLLBACK,
	rollingBack,
	eventually,
} = require('./helpers/characterize');

const { calls, runAs } = require('./fixtures/characterize/rubber-base');
const Account = require('./fixtures/characterize/rubber-account');
const Note = require('./fixtures/characterize/rubber-note');

/**
 * Characterization (step 3 of the modernization plan): a model shaped like
 * Rubber's `_shared-base.js` (see the fixture), which overrides `get`,
 * `getCachedId(id, span)`, `setCachedId`, `removeCachedId`,
 * `afterChangeHook(txOptions)`, `afterCreateHook(txOptions)`, `patch` and
 * `findOrCreate`. yass must keep calling each of them, in this order, through
 * `this` (any override in the chain sees the call), when `obj.js` is split
 * (step 4). Live database: MySQL in `npm test`, Postgres in
 * `npm run test:postgres`.
 */
describe('#characterize a Rubber-style subclass', function rubberSuite() {
	this.timeout(30000);

	let conn;
	let savedUuidLinkedIds;

	/** The calls recorded since the last take, with their details. */
	const takeDetailed = () => calls.splice(0);
	/** Like takeDetailed(), as [class, method] only. */
	const take = () => takeDetailed().map(([model, method]) => [model, method]);

	before(async () => {
		// Rubber's config sets uuidLinkedIds. yass's own findOrCreate needs it for
		// a t.uuidKey model: without it dbh.create() generates no id (see
		// test/obj.characterize.find-search.test.js).
		savedUuidLinkedIds = config.uuidLinkedIds;
		config.uuidLinkedIds = true;
		await recreateTables([Account.definition, Note.definition]);
		conn = await dbh();
	});

	after(() => {
		config.uuidLinkedIds = savedUuidLinkedIds;
	});

	beforeEach(async () => {
		await Promise.all(
			[Account, Note].map((Model) =>
				conn.pquery(`DELETE FROM ${quoteTable(Model.table())}`),
			),
		);
		[Account, Note].forEach((Model) => Model.removeEntireCache());
		calls.length = 0;
	});

	const newAccount = async (name = 'Acme') => {
		const account = await Account.create({ name });
		calls.length = 0;
		return account;
	};

	describe('reads', () => {
		it('get() of an uncached id: get > inflate > getCachedId(id, span) > setCachedId twice', async () => {
			const { id } = await newAccount();
			Account.removeEntireCache();

			const loaded = await Account.get(id);
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'get', id],
				['RubberAccount', 'inflate', id],
				// The span is get()'s own.
				['RubberAccount', 'getCachedId', id, 'get'],
				// A miss: the new instance is stored, then set again once filled in.
				['RubberAccount', 'setCachedId', id],
				['RubberAccount', 'setCachedId', id],
			]);
			expect(await Account.getCachedId(id)).to.equal(loaded);
		});

		it('get() of a cached id still reads: one setCachedId, which freshens the cached one', async () => {
			const account = await newAccount();
			const again = await Account.get(account.id);
			expect(take()).to.deep.equal([
				['RubberAccount', 'get'],
				['RubberAccount', 'inflate'],
				['RubberAccount', 'getCachedId'],
				['RubberAccount', 'setCachedId'],
			]);
			expect(again).to.equal(account);
		});

		it('get(id, { allowCached: true }) of a cached id: get > getCachedId(id) only, no span', async () => {
			const account = await newAccount();
			expect(await Account.get(account.id, { allowCached: true })).to.equal(
				account,
			);
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'get', account.id],
				['RubberAccount', 'getCachedId', account.id, undefined],
			]);
		});

		it("a link resolves through the linked class's own get() override, allowCached", async () => {
			const account = await newAccount();
			const note = await Note.create({ body: 'hi', account: account.id });
			expect(note.account).to.equal(account);
			[Account, Note].forEach((Model) => Model.removeEntireCache());
			calls.length = 0;

			const loaded = await Note.get(note.id);
			expect(takeDetailed()).to.deep.equal([
				['RubberNote', 'get', note.id],
				['RubberNote', 'inflate', note.id],
				['RubberNote', 'getCachedId', note.id, 'get'],
				['RubberNote', 'setCachedId', note.id],
				// Resolving the link: allowCached first (a miss), then a read whose
				// span is the note's (it carries the link path in span.stack).
				['RubberAccount', 'get', account.id],
				['RubberAccount', 'getCachedId', account.id, undefined],
				['RubberAccount', 'inflate', account.id],
				['RubberAccount', 'getCachedId', account.id, 'get'],
				['RubberAccount', 'setCachedId', account.id],
				['RubberAccount', 'setCachedId', account.id],
				['RubberNote', 'setCachedId', note.id],
			]);
			expect(loaded.account).to.be.an.instanceOf(Account);
			expect(await Account.getCachedId(account.id)).to.equal(loaded.account);
		});

		it('jsonify() override (excludeLinked) leaves out links', async () => {
			const account = await newAccount();
			const note = await Note.create({ body: 'hi', account: account.id });
			expect(await note.jsonify()).to.deep.equal({ id: note.id, body: 'hi' });
		});
	});

	describe('writes', () => {
		it('create(): inflate, then afterCreateHook({ tx }), whose patch runs through the override, then afterChangeHook({ tx })', async () => {
			const account = await runAs('usr_1', () =>
				Account.create({ name: 'Acme' }),
			);
			const { id } = account;
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'create', undefined],
				['RubberAccount', 'inflate', id],
				['RubberAccount', 'getCachedId', id, 'create'],
				['RubberAccount', 'setCachedId', id],
				['RubberAccount', 'setCachedId', id],
				['RubberAccount', 'afterCreateHook', { tx: undefined }],
				// Rubber's afterCreateHook stamps createdBy through this.patch().
				['RubberAccount', 'patch', ['createdBy'], { tx: undefined }],
				['RubberAccount', 'setCachedId', id],
				// patch()'s own afterChangeHook, then create()'s.
				['RubberAccount', 'afterChangeHook', { tx: undefined }],
				['RubberAccount', 'afterChangeHook', { tx: undefined }],
			]);
			expect(account.createdBy).to.equal('usr_1');
			// The override's updatedBy (from the zone) rode along on that patch.
			expect(account.updatedBy).to.equal('usr_1');
		});

		it('patch(): the override runs first and adds to what reaches the database', async () => {
			const account = await newAccount();
			await runAs('usr_2', () => account.patch({ name: 'Acme 2' }));
			expect(take()).to.deep.equal([
				['RubberAccount', 'patch'],
				['RubberAccount', 'setCachedId'],
				['RubberAccount', 'afterChangeHook'],
			]);
			expect(account.name).to.equal('Acme 2');
			expect(account.updatedBy).to.equal('usr_2');

			const [row] = await conn.pquery(
				`SELECT updatedBy FROM ${quoteTable(Account.table())} WHERE id = :id`,
				{ id: account.id },
			);
			expect(row.updatedBy).to.equal('usr_2');
		});

		it('remove(): removeCachedId, then patch({ isDeleted: true }, { tx }) through the override', async () => {
			const account = await newAccount();
			await account.remove();
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'removeCachedId', account.id],
				['RubberAccount', 'patch', ['isDeleted'], { tx: undefined }],
				['RubberAccount', 'setCachedId', account.id],
				['RubberAccount', 'afterChangeHook', { tx: undefined }],
			]);
			expect(account.isDeleted).to.equal(true);
		});

		it('update(data) is this.patch(data), through the override, with no options', async () => {
			const account = await newAccount();
			await account.update({ name: 'Updated' });
			expect(takeDetailed()[0]).to.deep.equal([
				'RubberAccount',
				'patch',
				['name'],
				undefined,
			]);
			expect(account.name).to.equal('Updated');
		});

		it('set() schedules update(), which reaches the patch override through this', async () => {
			const account = await newAccount();
			account.set('name', 'via set');
			expect(account.name).to.equal('via set');
			// Wait for the whole save (it ends in afterChangeHook), so none of its
			// calls land in the next test's `calls`.
			const deadline = Date.now() + 5000;
			while (
				!calls.some(([, method]) => method === 'afterChangeHook') &&
				Date.now() < deadline
			) {
				// eslint-disable-next-line no-await-in-loop
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			// Fixed bug 14: the save carries the fields set() changed (it used to
			// be patch(undefined)), with no options, as update(data) does.
			expect(takeDetailed()[0]).to.deep.equal([
				'RubberAccount',
				'patch',
				['name'],
				undefined,
			]);
		});

		// Rubber's setCachedId copies fields itself (no _freshenInstance), so
		// these reach yass's own read paths: inflate() and a write's read-back.
		const storedName = async (id) => {
			const [row] = await conn.pquery(
				`SELECT name FROM ${quoteTable(Account.table())} WHERE id = :id`,
				{ id },
			);
			return row.name;
		};

		// Waits for the save to be stored and to end (in afterChangeHook), so
		// none of its calls land in the next test's `calls`.
		const saved = async (account, name, afterChangeHooks = 1) => {
			await eventually(async () => {
				expect(await storedName(account.id)).to.equal(name);
				expect(
					calls.filter(([, method]) => method === 'afterChangeHook'),
				).to.have.length(afterChangeHooks);
			});
		};

		// Fixed bug 14 (found writing these tests): update() called
		// patch(undefined). Rubber's override accepted that (no throw), then
		// patched only updatedAt and read the row back, so the field set()
		// changed reverted to its value on disk: the save never happened.
		it('set() auto-save through a Rubber-style patch saves the field', async () => {
			const account = await newAccount();
			account.set('name', 'via set');
			await saved(account, 'via set');
			expect(account.name).to.equal('via set');
		});

		it('a get() before the save does not undo the set(), and it is saved', async () => {
			const account = await newAccount();
			account.set('name', 'via set');
			expect(await Account.get(account.id)).to.equal(account);
			expect(account.name).to.equal('via set');
			await saved(account, 'via set');
			expect(account.name).to.equal('via set');
		});

		it('a patch() of another field before the save keeps the set() value; both are saved', async () => {
			const account = await newAccount();
			account.set('name', 'via set');
			await account.patch({ status: 'paused' });
			expect(account).to.include({ name: 'via set', status: 'paused' });
			// The explicit patch() and the save each end in afterChangeHook.
			await saved(account, 'via set', 2);
			expect(account).to.include({ name: 'via set', status: 'paused' });
		});
	});

	describe('findOrCreate()', () => {
		it('the override (model with createdBy/updatedBy): this.searchOne, then this.create with { tx }', async () => {
			const created = await runAs('usr_3', () =>
				Account.findOrCreate({ name: 'New Co' }, { status: 'paused' }),
			);
			const { id } = created;
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'findOrCreate', { name: 'New Co' }],
				['RubberAccount', 'searchOne', { name: 'New Co' }, { tx: undefined }],
				// search() inflates its empty (null) result through this.inflate too.
				['RubberAccount', 'inflate', null],
				['RubberAccount', 'create', { tx: undefined }],
				['RubberAccount', 'inflate', id],
				['RubberAccount', 'getCachedId', id, 'create'],
				['RubberAccount', 'setCachedId', id],
				['RubberAccount', 'setCachedId', id],
				['RubberAccount', 'afterCreateHook', { tx: undefined }],
				['RubberAccount', 'afterChangeHook', { tx: undefined }],
			]);
			expect(created.createdBy).to.equal('usr_3');
			expect(created.status).to.equal('paused');
		});

		it('the override finding a row: this.searchOne, then existing.patch(patch, { tx }) through the override', async () => {
			const created = await Account.findOrCreate(
				{ name: 'New Co' },
				{ status: 'paused' },
			);
			calls.length = 0;

			const found = await runAs('usr_4', () =>
				Account.findOrCreate({ name: 'New Co' }, { status: 'active' }),
			);
			expect(found).to.equal(created);
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'findOrCreate', { name: 'New Co' }],
				['RubberAccount', 'searchOne', { name: 'New Co' }, { tx: undefined }],
				['RubberAccount', 'inflate', created.id],
				['RubberAccount', 'getCachedId', created.id, 'search'],
				['RubberAccount', 'setCachedId', created.id],
				['RubberAccount', 'patch', ['status', 'updatedBy'], { tx: undefined }],
				['RubberAccount', 'setCachedId', created.id],
				['RubberAccount', 'afterChangeHook', { tx: undefined }],
			]);
			expect(found.status).to.equal('active');
			expect(found.updatedBy).to.equal('usr_4');
		});

		it("falls through to yass's findOrCreate (no createdBy/updatedBy): hooks through this", async () => {
			const created = await Note.findOrCreate({ body: 'x' });
			expect(takeDetailed()).to.deep.equal([
				['RubberNote', 'findOrCreate', { body: 'x' }],
				['RubberNote', 'inflate', created.id],
				['RubberNote', 'getCachedId', created.id, 'findOrCreate'],
				['RubberNote', 'setCachedId', created.id],
				['RubberNote', 'setCachedId', created.id],
				['RubberNote', 'afterCreateHook', { tx: undefined }],
				['RubberNote', 'afterChangeHook', { wasCreated: true, tx: undefined }],
			]);

			// Found, nothing to change: no hooks.
			const found = await Note.findOrCreate({ body: 'x' }, { body: 'x' });
			expect(found).to.equal(created);
			expect(take()).to.deep.equal([
				['RubberNote', 'findOrCreate'],
				['RubberNote', 'inflate'],
				['RubberNote', 'getCachedId'],
				['RubberNote', 'setCachedId'],
			]);
		});

		it("passes the caller's { tx } through to every call", async () => {
			await conn.transaction(async (tx) => {
				const created = await Account.findOrCreate(
					{ name: 'Tx Co' },
					{},
					{},
					{ tx },
				);
				const txBag = { tx };
				const detailed = takeDetailed();
				expect(detailed[1]).to.deep.equal([
					'RubberAccount',
					'searchOne',
					{ name: 'Tx Co' },
					txBag,
				]);
				expect(
					detailed.find(([, method]) => method === 'create'),
				).to.deep.equal(['RubberAccount', 'create', txBag]);
				// Inside the transaction the shared cache is not touched.
				expect(
					detailed.filter(([, method]) => /CachedId$/.test(method)),
				).to.deep.equal([]);
				expect(created.name).to.equal('Tx Co');
			});
		});
	});

	describe('transactions', () => {
		it('inside: get/patch skip getCachedId/setCachedId and hooks get { tx }; commit publishes through setCachedId then getCachedId', async () => {
			const account = await newAccount();
			await conn.transaction(async (tx) => {
				const inTx = await Account.get(account.id, { tx });
				await inTx.patch({ name: 'in tx' }, { tx });
				expect(takeDetailed()).to.deep.equal([
					['RubberAccount', 'get', account.id],
					['RubberAccount', 'inflate', account.id],
					['RubberAccount', 'patch', ['name'], { tx }],
					['RubberAccount', 'afterChangeHook', { tx }],
				]);
			});
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'setCachedId', account.id],
				['RubberAccount', 'getCachedId', account.id, undefined],
			]);
			// The override freshened the instance it already held.
			expect(account.name).to.equal('in tx');
		});

		it('rollback of a write through the cached instance: removeCachedId only', async () => {
			const account = await newAccount();
			await rollingBack(
				conn.transaction(async (tx) => {
					await account.patch({ name: 'rolled back' }, { tx });
					calls.length = 0;
					throw ROLLBACK;
				}),
			);
			expect(takeDetailed()).to.deep.equal([
				['RubberAccount', 'removeCachedId', account.id],
			]);
			expect(await Account.getCachedId(account.id)).to.equal(undefined);
		});
	});
});
