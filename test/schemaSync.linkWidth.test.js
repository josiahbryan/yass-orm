/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const config = require('../lib/config');
const { syncSchemaToDb, reportSyncResults } = require('../lib/sync-to-db');

// A link column holds the ids of the model it points at. `t.stringKey({ keyWidth })` widens a key and
// `t.linked(name, { keyWidth })` its links, by hand. Schema-sync checks the two together:
//  - a link column left narrower than the wide key it points at is REPORTED (result.warnings), because an id
//    longer than the link fails on insert (strict MySQL, Postgres) or is silently cut short (non-strict MySQL);
//  - narrowing a link column is REFUSED by name before any DDL, like the key.
//
//   npm run test:mysql-width   or   YASS_CONFIG=$PWD/.yass-orm.postgres.js mocha --exit test/schemaSync.linkWidth.test.js

const DEFAULT_WIDTH = 36;
const WIDE = 64;
const SUFFIX_CHARS = 20;
const isPg = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

const widthOf = async (conn, table, column) => {
	const scope = isPg() ? 'current_schema()' : 'DATABASE()';
	const rows = await conn.pquery(
		`SELECT character_maximum_length AS w FROM information_schema.columns WHERE table_schema = ${scope} AND table_name = :t AND column_name = :c`,
		{ t: table, c: column },
	);
	return Number(rows[0].w);
};

describe('#schemaSync link width against the key it points at', function suite() {
	this.timeout(60000);
	const base = `yass_lw_${uuid().replace(/-/g, '').slice(0, SUFFIX_CHARS)}`;
	const parent = `${base}_p`;
	const child = `${base}_c`;
	const registryName = `lw-${base}`;
	const parentDef = ({ types: t }) => ({
		table: parent,
		objectIdPrefix: 'par',
		schema: { id: t.stringKey({ keyWidth: WIDE }), name: t.string },
	});
	const childDef =
		(keyWidth) =>
		({ types: t }) => ({
			table: child,
			objectIdPrefix: 'kid',
			schema: {
				id: t.stringKey,
				owner: t.linked(
					registryName,
					keyWidth === undefined ? {} : { keyWidth },
				),
			},
		});
	const sync = (def) => syncSchemaToDb(YassORM.convertDefinition(def));
	let saved;
	let unregister;
	before(async () => {
		saved = config.stringLinkedIds;
		config.stringLinkedIds = true;
		const Parent = YassORM.loadDefinition(parentDef);
		unregister = YassORM.registerModel(registryName, Parent);
		expect((await sync(parentDef)).errors || []).to.deep.equal([]);
	});
	after(async () => {
		config.stringLinkedIds = saved;
		unregister();
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

	it('reports a link narrower than the wide key it points at, naming both widths, and still syncs', async () => {
		const result = await sync(childDef());
		expect(result.errors || []).to.deep.equal([]);
		expect(result.applied).to.be.greaterThan(0);
		expect(result.warnings, 'the result carries warnings')
			.to.be.an('array')
			.with.length(1);
		expect(result.warnings[0]).to.match(new RegExp(`${child}\\.owner`));
		expect(result.warnings[0]).to.include(String(DEFAULT_WIDTH));
		expect(result.warnings[0]).to.include(String(WIDE));
		expect(await widthOf(await dbh(), child, 'owner')).to.equal(DEFAULT_WIDTH);
	});

	it('is silent for a link as wide as its key, and the widening converges', async () => {
		const widened = await sync(childDef(WIDE));
		expect(widened.errors || []).to.deep.equal([]);
		expect(widened.warnings || []).to.deep.equal([]);
		expect(await widthOf(await dbh(), child, 'owner')).to.equal(WIDE);
		const again = await sync(childDef(WIDE));
		expect(again.applied).to.equal(0);
		expect(again.warnings || []).to.deep.equal([]);
	});

	it('refuses to narrow a link column by name, before any DDL, and keeps its rows', async () => {
		const conn = await dbh();
		const q = (name) => conn.dialect.quoteIdentifier(name);
		const longId = `par_${'x'.repeat(WIDE - 'par_'.length)}`;
		await conn.pquery(
			`INSERT INTO ${q(child)} (${q('id')}, ${q(
				'owner',
			)}) VALUES ('kid_1', :owner)`,
			{
				owner: longId,
			},
		);
		const refused = await sync(childDef());
		expect((refused.errors || []).length).to.be.greaterThan(0);
		expect(refused.errors[0].description).to.match(/narrow/i);
		expect(refused.errors[0].description).to.include('owner');
		// schema-sync counts a refusal: its exit code is 1 and its summary names it (a result without `failed` is not counted)
		expect(refused.failed).to.equal(refused.errors.length);
		expect(reportSyncResults([refused])).to.equal(1);
		expect(refused.applied).to.equal(0);
		expect(await widthOf(conn, child, 'owner')).to.equal(WIDE);
		const rows = await conn.pquery(
			`SELECT ${q('owner')} AS o FROM ${q(child)}`,
		);
		expect(rows.map((r) => r.o)).to.deep.equal([longId]);
	});

	// The hazard the report exists for, on a live server: a link left at 36 under a 64 key.
	it('what a too-narrow link does to a long id: Postgres refuses it, non-strict MySQL cuts it short', async function hazard() {
		const table = `${base}_h`;
		const conn = await dbh();
		const q = (name) => conn.dialect.quoteIdentifier(name);
		await conn.pquery(
			`CREATE TABLE ${q(
				table,
			)} (id varchar(36) NOT NULL PRIMARY KEY, owner varchar(${DEFAULT_WIDTH}))`,
		);
		const longId = `par_${'x'.repeat(WIDE - 'par_'.length)}`;
		try {
			if (isPg()) {
				let failure;
				try {
					await conn.pquery(
						`INSERT INTO ${q(table)} (id, owner) VALUES ('h1', :owner)`,
						{ owner: longId },
					);
				} catch (error) {
					failure = error;
				}
				expect(`${failure}`).to.match(/too long|value too long/i);
			} else {
				const mariadb = require('mariadb');
				const raw = await mariadb.createConnection({
					host: config.host,
					port: config.port,
					user: config.user,
					password: config.password,
					database: config.schema,
					allowPublicKeyRetrieval: true,
				});
				try {
					await raw.query("SET SESSION sql_mode=''");
					await raw.query(
						`INSERT INTO \`${table}\` (id, owner) VALUES ('h1', ?)`,
						[longId],
					);
					const [row] = await raw.query(
						`SELECT CHAR_LENGTH(owner) AS n FROM \`${table}\``,
					);
					expect(Number(row.n), 'cut short without an error').to.equal(
						DEFAULT_WIDTH,
					);
				} finally {
					await raw.end();
				}
			}
		} finally {
			await conn.pquery(`DROP TABLE IF EXISTS ${q(table)}`);
		}
	});
});
