/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const config = require('../lib/config');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// Per-model string primary-key width (`t.stringKey({ keyWidth })`): the default stays 36
// (CHAR(36) on MySQL, VARCHAR(36) on Postgres), a model may ask for a wider key, link
// columns that point at it take the same width, widening converges with no drift, and
// narrowing a key is refused (it could truncate ids) without touching the table.
//
//   npm run test:mysql-width   or   YASS_CONFIG=$PWD/.yass-orm.postgres.js mocha --exit test/schemaSync.stringKeyWidth.test.js

const DEFAULT_WIDTH = 36;
const WIDE = 64;
const WIDER = 96;
const SUFFIX_CHARS = 20;

const widthOf = async (conn, table, column) => {
	const q = (name) => conn.dialect.quoteIdentifier(name);
	const isPg = ['postgres', 'postgresql'].includes(config.dialect || 'mysql');
	const rows = isPg
		? await conn.pquery(
				`SELECT character_maximum_length AS w FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = :t AND column_name = :c`,
				{ t: table, c: column },
		  )
		: await conn.pquery(
				`SELECT character_maximum_length AS w FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = :t AND column_name = :c`,
				{ t: table, c: column },
		  );
	void q;
	return Number(rows[0].w);
};

describe('#schemaSync per-model string key width', function suite() {
	this.timeout(60000);
	const base = `yass_skw_${uuid().replace(/-/g, '').slice(0, SUFFIX_CHARS)}`;
	const parent = `${base}_p`;
	const child = `${base}_c`;
	const parentDef =
		(keyWidth) =>
		({ types: t }) => ({
			table: parent,
			objectIdPrefix: 'par',
			schema: {
				id: keyWidth === undefined ? t.stringKey : t.stringKey({ keyWidth }),
				name: t.string,
			},
		});
	const childDef =
		(keyWidth) =>
		({ types: t }) => ({
			table: child,
			objectIdPrefix: 'kid',
			schema: {
				id: t.stringKey,
				parent: t.linked('parent', keyWidth ? { keyWidth } : {}),
			},
		});
	const sync = (def) => syncSchemaToDb(YassORM.convertDefinition(def));
	let saved;
	before(() => {
		saved = config.stringLinkedIds;
		config.stringLinkedIds = true;
	});
	after(async () => {
		config.stringLinkedIds = saved;
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			for (const table of [child, parent])
				await conn.pquery(
					`DROP TABLE IF EXISTS ${conn.dialect.quoteIdentifier(table)}`,
				);
		} finally {
			await conn.end();
		}
	});

	it('keeps the default key at 36 and converges', async () => {
		const first = await sync(parentDef());
		expect(first.errors || []).to.deep.equal([]);
		const conn = await dbh();
		expect(await widthOf(conn, parent, 'id')).to.equal(DEFAULT_WIDTH);
		const again = await sync(parentDef());
		expect(again.applied).to.equal(0);
	});

	it('widens an existing key in place, keeps its rows, and converges', async () => {
		const conn = await dbh();
		const q = (name) => conn.dialect.quoteIdentifier(name);
		await conn.pquery(
			`INSERT INTO ${q(parent)} (${q('id')}, ${q('name')}) VALUES (:id, :name)`,
			{
				id: 'par_old',
				name: 'kept',
			},
		);
		const widened = await sync(parentDef(WIDE));
		expect(widened.errors || []).to.deep.equal([]);
		expect(widened.applied).to.be.greaterThan(0);
		expect(await widthOf(conn, parent, 'id')).to.equal(WIDE);
		const longId = `par_${'x'.repeat(WIDE - 'par_'.length)}`;
		await conn.pquery(
			`INSERT INTO ${q(parent)} (${q('id')}, ${q('name')}) VALUES (:id, :name)`,
			{
				id: longId,
				name: 'long',
			},
		);
		const rows = await conn.pquery(
			`SELECT ${q('id')} FROM ${q(parent)} ORDER BY ${q('name')}`,
		);
		expect(rows.map((r) => r.id).sort()).to.deep.equal(
			['par_old', longId].sort(),
		);
		const again = await sync(parentDef(WIDE));
		expect(again.errors || []).to.deep.equal([]);
		expect(again.applied).to.equal(0);
	});

	it('gives a link column the width of the key it holds, and converges', async () => {
		const made = await sync(childDef(WIDE));
		expect(made.errors || []).to.deep.equal([]);
		const conn = await dbh();
		expect(await widthOf(conn, child, 'parent')).to.equal(WIDE);
		expect(await widthOf(conn, child, 'id')).to.equal(DEFAULT_WIDTH);
		expect((await sync(childDef(WIDE))).applied).to.equal(0);
	});

	it('refuses to narrow a key, changes nothing, and keeps the long ids', async () => {
		const conn = await dbh();
		const result = await sync(parentDef(DEFAULT_WIDTH));
		expect((result.errors || []).length).to.be.greaterThan(0);
		expect(`${result.errors[0]}`).to.match(/narrow/i);
		expect(await widthOf(conn, parent, 'id')).to.equal(WIDE);
		const widerStill = await sync(parentDef(WIDER));
		expect(widerStill.errors || []).to.deep.equal([]);
		expect(await widthOf(conn, parent, 'id')).to.equal(WIDER);
	});

	it('rejects an unsafe width at definition time', () => {
		for (const keyWidth of [0, 35, 36.5, -1, '64', 100000]) {
			expect(
				() => YassORM.convertDefinition(parentDef(keyWidth)),
				String(keyWidth),
			).to.throw(/keyWidth/);
		}
		expect(() =>
			YassORM.convertDefinition(parentDef(DEFAULT_WIDTH)),
		).to.not.throw();
	});
});
