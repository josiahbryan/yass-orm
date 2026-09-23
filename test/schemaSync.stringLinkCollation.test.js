/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { getDialect } = require('../lib/dialects');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// Bug 17 against a live database: under `stringLinkedIds` + `linkColumnCollation`
// a link column compares exactly, like the `t.stringKey` id it holds. Before the
// fix MySQL left it at the server default (utf8mb4_0900_ai_ci), so a link
// matched an id that differs only in case. Runs on the configured dialect
// (MySQL by default, Postgres in `npm run test:postgres`, whose default
// collation is already exact).

const isMysql = () => ['mysql', 'mariadb'].includes(config.dialect || 'mysql');

describe('#schemaSync stringLinkedIds link collation (bug 17)', function suite() {
	this.timeout(30000);

	const dialect = getDialect(config.dialect || 'mysql');
	const suffix = uuid().replace(/-/g, '').slice(0, 12);
	const parentTable = `yass_slc_parent_${suffix}`;
	const childTable = `yass_slc_child_${suffix}`;
	const q = (name) => dialect.quoteIdentifier(name);

	const parentDef = ({ types: t }) => ({
		table: parentTable,
		objectIdPrefix: 'par',
		schema: { id: t.stringKey, name: t.string },
	});
	const childDef = ({ types: t }) => ({
		table: childTable,
		objectIdPrefix: 'kid',
		schema: { id: t.stringKey, parent: t.linked('parent'), label: t.string },
	});

	const sync = async (def) => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(result.errors).to.deep.equal([]);
		return result.applied;
	};

	const withConn = async (fn) => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			return await fn(conn);
		} finally {
			await conn.end();
		}
	};

	const linkCollation = () =>
		withConn(async (conn) => {
			const cols = await dialect.getTableColumns(conn, childTable);
			return cols.find((c) => c.name === 'parent').collation;
		});

	let saved;
	before(() => {
		saved = {
			stringLinkedIds: config.stringLinkedIds,
			linkColumnCollation: config.linkColumnCollation,
		};
		config.stringLinkedIds = true;
	});

	after(async () => {
		Object.assign(config, saved);
		await withConn(async (conn) => {
			await conn.pquery(`DROP TABLE IF EXISTS ${q(childTable)}`);
			await conn.pquery(`DROP TABLE IF EXISTS ${q(parentTable)}`);
		});
	});

	it('an existing inexact link column is changed once the flag is on, then converges', async () => {
		// Without the flag: the column the pre-fix version created.
		config.linkColumnCollation = undefined;
		await sync(parentDef);
		await sync(childDef);
		if (isMysql()) {
			expect(await linkCollation()).to.not.equal('utf8mb4_bin');
		}

		config.linkColumnCollation = true;
		const adopted = await sync(childDef);
		if (isMysql()) {
			expect(adopted).to.be.greaterThan(0);
			expect(await linkCollation()).to.equal('utf8mb4_bin');
		} else {
			expect(adopted).to.equal(0);
		}
	});

	it('re-syncing applies no DDL', async () => {
		config.linkColumnCollation = true;
		expect([await sync(parentDef), await sync(childDef)]).to.deep.equal([0, 0]);
	});

	it('a link matches its id exactly, not a case variant of it', async () => {
		config.linkColumnCollation = true;
		const id = 'par_0abcdefghijklmnopqrstuvwxy';
		await withConn(async (conn) => {
			await conn.pquery(
				`INSERT INTO ${q(childTable)} (id, parent, label) ` +
					`VALUES ('kid_0abcdefghijklmnopqrstuvwxy', '${id}', 'c')`,
			);
			const labels = async (value) =>
				(
					await conn.pquery(
						`SELECT label FROM ${q(childTable)} WHERE parent = '${value}'`,
					)
				).map((r) => r.label);
			expect(await labels(id)).to.deep.equal(['c']);
			expect(await labels(id.toUpperCase())).to.deep.equal([]);
		});
	});
});
