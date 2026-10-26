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

	// A qualified `db.table` target (MySQL: a second database; Postgres: a second schema): the refusal must look at
	// the same catalog table the DDL would change.
	it('refuses to narrow a key in a qualified db.table, with no other change applied', async () => {
		const isPg = ['postgres', 'postgresql'].includes(config.dialect || 'mysql');
		const conn = await dbh();
		const q = (n) => conn.dialect.quoteIdentifier(n);
		const name = `${base}_q`;
		const qualifiedSchema = isPg ? `${base}_s` : config.schema2;
		const target = `${qualifiedSchema}.${name}`;
		const saved2 = config.enableAlternateSchemaInTableName;
		config.enableAlternateSchemaInTableName = true;
		const def =
			(keyWidth, extra) =>
			({ types: t }) => ({
				table: target,
				objectIdPrefix: 'qua',
				schema: {
					id: keyWidth === undefined ? t.stringKey : t.stringKey({ keyWidth }),
					note: t.string,
					...(extra ? { extra: t.string } : {}),
				},
			});
		const columnsOf = async () =>
			(
				await conn.pquery(
					`SELECT column_name AS c, character_maximum_length AS w FROM information_schema.columns WHERE table_schema = :s AND table_name = :t ORDER BY column_name`,
					{ s: qualifiedSchema, t: name },
				)
			).map((r) => `${r.c}:${r.w}`);
		try {
			// A secondary-database table is provisioned by hand (sync creates new tables in the configured database).
			if (isPg) {
				await conn.pquery(`CREATE SCHEMA IF NOT EXISTS ${q(qualifiedSchema)}`);
				await conn.pquery(
					`CREATE TABLE ${q(qualifiedSchema)}.${q(
						name,
					)} (id varchar(${WIDE}) NOT NULL PRIMARY KEY, note varchar(255), "isDeleted" int NOT NULL DEFAULT 0)`,
				);
			} else {
				await conn.pquery(
					`CREATE TABLE ${q(qualifiedSchema)}.${q(
						name,
					)} (id varchar(${WIDE}) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY, note varchar(255), isDeleted int(1) NOT NULL DEFAULT 0) CHARACTER SET utf8mb4`,
				);
			}
			const before = await columnsOf();
			expect(before).to.include(`id:${WIDE}`);
			const refused = await sync(def(undefined, true));
			expect((refused.errors || []).length).to.be.greaterThan(0);
			expect(`${refused.errors[0]}`).to.match(/narrow/i);
			expect(refused.applied).to.equal(0);
			expect(await columnsOf()).to.deep.equal(before);
		} finally {
			config.enableAlternateSchemaInTableName = saved2;
			await conn.pquery(
				`DROP TABLE IF EXISTS ${q(qualifiedSchema)}.${q(name)}`,
			);
			if (isPg)
				await conn.pquery(`DROP SCHEMA IF EXISTS ${q(qualifiedSchema)}`);
		}
	});

	// SEC4c P3: widening an EXISTING link column keeps its rows and, on MySQL with linkColumnCollation, its binary collation.
	it('widens an existing link column in place, keeps its collation, and converges', async () => {
		const isPg = ['postgres', 'postgresql'].includes(config.dialect || 'mysql');
		const conn = await dbh();
		const q = (n) => conn.dialect.quoteIdentifier(n);
		const name = `${base}_l`;
		const savedCollation = config.linkColumnCollation;
		config.linkColumnCollation = true;
		const def =
			(keyWidth) =>
			({ types: t }) => ({
				table: name,
				objectIdPrefix: 'lnk',
				schema: {
					id: t.stringKey,
					owner: t.linked('parent', keyWidth ? { keyWidth } : {}),
				},
			});
		const collationOf = async () =>
			isPg
				? null
				: (
						await conn.pquery(
							`SELECT collation_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = :t AND column_name = 'owner'`,
							{ t: name },
						)
				  )[0].c;
		try {
			expect((await sync(def())).errors || []).to.deep.equal([]);
			// A new link column is made at the server's default; the flag's exact collation is adopted by the next sync.
			expect((await sync(def())).errors || []).to.deep.equal([]);
			expect(await widthOf(conn, name, 'owner')).to.equal(DEFAULT_WIDTH);
			const collation = await collationOf();
			if (!isPg) expect(collation).to.equal('utf8mb4_bin');
			await conn.pquery(
				`INSERT INTO ${q(name)} (${q('id')}, ${q(
					'owner',
				)}) VALUES ('lnk_1', 'par_kept')`,
			);
			const widened = await sync(def(WIDE));
			expect(widened.errors || []).to.deep.equal([]);
			expect(widened.applied).to.be.greaterThan(0);
			expect(await widthOf(conn, name, 'owner')).to.equal(WIDE);
			expect(await collationOf()).to.equal(collation);
			const rows = await conn.pquery(
				`SELECT ${q('owner')} AS o FROM ${q(name)}`,
			);
			expect(rows.map((r) => r.o)).to.deep.equal(['par_kept']);
			expect((await sync(def(WIDE))).applied).to.equal(0);
		} finally {
			config.linkColumnCollation = savedCollation;
			await conn.pquery(`DROP TABLE IF EXISTS ${q(name)}`);
		}
	});
});
