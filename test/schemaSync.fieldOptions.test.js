/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { getDialect } = require('../lib/dialects');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// `t.datetime.precision(n)` and `t.string.exact()` against a live database:
// the column each dialect creates, a re-sync that applies no DDL, and what
// the options are for (milliseconds that survive a round trip; look-alike
// strings that do not match). Runs on the configured dialect: MySQL by
// default, and Postgres in `npm run test:postgres`.

const isMysql = () => ['mysql', 'mariadb'].includes(config.dialect || 'mysql');

describe('#schemaSync field options: precision and exact', function suite() {
	this.timeout(30000);

	const dialect = getDialect(config.dialect || 'mysql');
	const suffix = uuid().replace(/-/g, '').slice(0, 12);
	const table = `yass_field_opts_${suffix}`;
	const adoptTable = `yass_field_opts_adopt_${suffix}`;

	const def = ({ types: t }) => ({
		table,
		schema: {
			id: t.idKey,
			at: t.datetime.precision(3),
			plain: t.datetime,
			email: t.string.exact(),
			nick: t.string,
			legacy: t.string({ collation: 'utf8mb4_bin' }),
		},
		options: { indexes: { uniqueEmail: { unique: true, cols: ['email'] } } },
	});

	// An existing column that later opts into `exact`.
	const adoptDef =
		(exact) =>
		({ types: t }) => ({
			table: adoptTable,
			schema: { id: t.idKey, email: exact ? t.string.exact() : t.string },
		});

	let Model;

	const columns = async (name) => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const cols = await dialect.getTableColumns(conn, name);
			return Object.fromEntries(
				cols.map((c) => [
					c.name,
					{ type: `${c.type}`.toLowerCase(), collation: c.collation },
				]),
			);
		} finally {
			await conn.end();
		}
	};

	before(async () => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(result.errors).to.deep.equal([]);
		Model = YassORM.loadDefinition(def);
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(table)}`,
			);
			await conn.pquery(
				`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(adoptTable)}`,
			);
		} finally {
			await conn.end();
		}
	});

	it('creates the columns each dialect needs', async () => {
		const cols = await columns(table);
		if (isMysql()) {
			expect(cols.at.type).to.equal('datetime(3)');
			expect(cols.plain.type).to.equal('datetime');
			expect(cols.email.collation).to.equal('utf8mb4_bin');
			expect(cols.nick.collation).to.not.equal('utf8mb4_bin');
			expect(cols.legacy.collation).to.equal('utf8mb4_bin');
		} else {
			// Postgres keeps microseconds in every timestamptz, and compares
			// strings exactly under its default (deterministic) collation.
			expect(cols.at.type).to.equal('timestamp with time zone');
			expect(cols.email.type).to.equal('character varying(255)');
		}
	});

	it('re-syncing applies no DDL', async () => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(result.errors).to.deep.equal([]);
		expect(result.applied).to.equal(0);
	});

	it('a precision(3) datetime keeps its milliseconds; a plain one is unchanged', async () => {
		const when = new Date('2026-01-15T12:34:56.789Z');
		const row = await Model.create({
			at: when,
			plain: when,
			email: 'ms@example.com',
		});
		Model.clearCache();
		const back = await Model.get(row.id);
		expect(back.at.toISOString()).to.equal('2026-01-15T12:34:56.789Z');
		expect(back.plain.toISOString()).to.equal(
			isMysql() ? '2026-01-15T12:34:56.000Z' : '2026-01-15T12:34:56.789Z',
		);

		// And a search by that instant finds the row.
		const found = await Model.search({ at: when });
		expect(found.map((r) => r.id)).to.deep.equal([row.id]);
	});

	it('an exact column matches neither case nor accent look-alikes', async () => {
		await Model.create({ email: 'josé@example.com' });
		await Model.create({ email: 'Bob@Example.com' });

		expect(await Model.search({ email: 'jose@example.com' })).to.have.length(0);
		expect(await Model.search({ email: 'bob@example.com' })).to.have.length(0);
		expect(await Model.search({ email: 'josé@example.com' })).to.have.length(1);
	});

	it('an exact unique column holds values an accent-insensitive one would call equal', async () => {
		await Model.create({ email: 'strasse@example.com' });
		await Model.create({ email: 'straße@example.com' });
		await Model.create({ email: 'JOSÉ@example.com' });
		expect(await Model.search({ email: 'straße@example.com' })).to.have.length(
			1,
		);
	});

	it('an existing column that opts into exact is changed, then converges', async () => {
		const created = await syncSchemaToDb(
			YassORM.convertDefinition(adoptDef(false)),
		);
		expect(created.errors).to.deep.equal([]);

		const adopted = await syncSchemaToDb(
			YassORM.convertDefinition(adoptDef(true)),
		);
		expect(adopted.errors).to.deep.equal([]);
		if (isMysql()) {
			expect(adopted.applied).to.be.greaterThan(0);
			expect((await columns(adoptTable)).email.collation).to.equal(
				'utf8mb4_bin',
			);
		} else {
			expect(adopted.applied).to.equal(0);
		}

		const again = await syncSchemaToDb(
			YassORM.convertDefinition(adoptDef(true)),
		);
		expect(again.errors).to.deep.equal([]);
		expect(again.applied).to.equal(0);
	});
});
