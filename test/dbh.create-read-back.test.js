/* global describe, it, before, beforeEach, after */
const { expect } = require('chai');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const {
	isPostgres,
	recreateTables,
	quoteTable,
	rejectionOf,
} = require('./helpers/characterize');

/**
 * dbh.create() / createIgnore() read the new row back by its id. When the
 * fields carry no id and the insert reports none (a t.uuidKey table on MySQL,
 * whose trigger fills the id in, reports insertId 0), there is nothing to read
 * back by. They used to read back `WHERE id = 0`, which MySQL compares as a
 * number, so it matched ANOTHER row whose id starts with a letter or zeros
 * (step 3's known bug 11). Live database: MySQL in `npm test`, Postgres in
 * `npm run test:postgres`.
 */
describe('dbh.create() reads back its own row', function suite() {
	this.timeout(30000);

	const definition = ({ types: t }) => ({
		table: 'yass_create_read_back',
		schema: { id: t.uuidKey, name: t.string },
	});
	const { table } = YassORM.convertDefinition(definition);
	// On MySQL, '00000000-...' = 0 is true.
	const OTHER_ID = '00000000-0000-4000-8000-000000000000';
	const MINE_ID = '11111111-1111-4111-8111-111111111111';

	let conn;
	let savedUuidLinkedIds;

	before(async () => {
		await recreateTables([definition]);
		conn = await dbh();
		savedUuidLinkedIds = config.uuidLinkedIds;
	});

	beforeEach(async () => {
		config.uuidLinkedIds = savedUuidLinkedIds;
		await conn.pquery(`DELETE FROM ${quoteTable(table)}`);
		await conn.create(table, { id: OTHER_ID, name: 'other' });
	});

	after(() => {
		config.uuidLinkedIds = savedUuidLinkedIds;
	});

	it('without an id or an insert id, never returns another row', async () => {
		// With uuidLinkedIds create() would make an id itself.
		config.uuidLinkedIds = false;
		if (isPostgres()) {
			// The id column defaults to gen_random_uuid(), and the insert
			// returns it: the row comes back.
			expect(
				(await conn.create(table, { name: 'mine' }, { silenceErrors: true }))
					.name,
			).to.equal('mine');
			return;
		}
		const error = await rejectionOf(
			conn.create(table, { name: 'mine' }, { silenceErrors: true }),
		);
		expect(error, 'create() resolved').to.be.an('error');
		expect(error.message).to.include('no id to read the new row back by');
	});

	it('createIgnore(): never returns another row either', async () => {
		// With uuidLinkedIds create() would make an id itself.
		config.uuidLinkedIds = false;
		if (isPostgres()) {
			expect(
				(
					await conn.createIgnore(
						table,
						{ name: 'mine' },
						{
							conflictColumns: ['id'],
						},
					)
				).name,
			).to.equal('mine');
			return;
		}
		// MySQL reports a skipped duplicate like an insert (affectedRows 1,
		// insertId 0), so with no id to read back by, createIgnore() cannot
		// tell them apart: it answers null (nothing it can return), as for a
		// conflict, never another row.
		expect(await conn.createIgnore(table, { name: 'mine' })).to.equal(null);
	});

	it('createIgnore() on an auto-increment table: null on a conflict, the row otherwise', async () => {
		const autoTable = 'yass_create_ignore_auto';
		const q = quoteTable(autoTable);
		await conn.pquery(`DROP TABLE IF EXISTS ${q}`);
		await conn.pquery(
			isPostgres()
				? `CREATE TABLE ${q} (id SERIAL PRIMARY KEY, name VARCHAR(64) UNIQUE)`
				: `CREATE TABLE ${q} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) UNIQUE)`,
		);
		const first = await conn.createIgnore(
			autoTable,
			{ name: 'dup' },
			{ conflictColumns: ['name'] },
		);
		expect(first).to.include({ name: 'dup' });
		expect(Number(first.id)).to.be.above(0);
		expect(
			await conn.createIgnore(
				autoTable,
				{ name: 'dup' },
				{ conflictColumns: ['name'] },
			),
		).to.equal(null);
		await conn.pquery(`DROP TABLE ${q}`);
	});

	it('generateId: true makes the id with idGenerator, without uuidLinkedIds', async () => {
		config.uuidLinkedIds = false;
		const row = await conn.create(
			table,
			{ name: 'mine' },
			{ generateId: true, idGenerator: () => MINE_ID },
		);
		expect(row).to.deep.include({ id: MINE_ID, name: 'mine' });
	});

	it('findOrCreate() passes generateId on to create()', async () => {
		config.uuidLinkedIds = false;
		const row = await conn.findOrCreate(
			table,
			{ name: 'mine' },
			{},
			{},
			{ generateId: true, idGenerator: () => MINE_ID },
		);
		expect(row).to.deep.include({ id: MINE_ID, name: 'mine' });
	});

	it('uuidLinkedIds (Rubber) still generates the id when none is given', async () => {
		config.uuidLinkedIds = true;
		const row = await conn.create(
			table,
			{ name: 'mine' },
			{ idGenerator: () => MINE_ID },
		);
		expect(row).to.deep.include({ id: MINE_ID, name: 'mine' });
	});

	it('an id given in the fields is used as is', async () => {
		const row = await conn.create(table, { id: MINE_ID, name: 'mine' });
		expect(row).to.deep.include({ id: MINE_ID, name: 'mine' });
	});
});
