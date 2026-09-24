/* eslint-disable no-console */
/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { getDialect } = require('../lib/dialects');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const { idTriggerName } = require('../lib/identifiers');

// A table whose name is as long as the dialect allows. On MySQL the built-in id
// trigger, `before_insert_<table>_set_id`, used to be longer than 64 characters
// for any table over 43, and schema sync failed with "Identifier name ... is too
// long". Its name is now fitted (a prefix plus a hash), and the fitted name must
// still be recognised as the id trigger: never dropped, duplicated or rebuilt on
// a second sync. Postgres makes no per-table trigger or function; its indexes
// are fitted already. Runs on the configured dialect (MySQL by default; also in
// `npm run test:postgres`).

const WRITE_TRIGGER_LOG = '(re)Creating trigger group';

async function captureLogs(fn) {
	const logs = [];
	const origLog = console.log;
	console.log = (...args) => {
		logs.push(args.join(' '));
	};
	try {
		return { result: await fn(), logs };
	} finally {
		console.log = origLog;
	}
}

describe('#schemaSync: a table name at the identifier limit', () => {
	const dialect = getDialect(config.dialect || 'mysql');
	const isMysql = dialect.name === 'mysql';
	const limit = dialect.maxIdentifierLength;
	const longName = (tag) => {
		const base = `yass_long_${tag}_${uuid().replace(/-/g, '').slice(0, 8)}_`;
		return base.padEnd(limit, 'x');
	};
	const plainTable = longName('p');
	const declaredTable = longName('d');
	const tables = [plainTable, declaredTable];

	const withConn = async (fn) => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			return await fn(conn);
		} finally {
			await conn.end();
		}
	};

	const triggerNames = (table) =>
		withConn(async (conn) => {
			if (isMysql) {
				const rows = await dialect.getTableTriggers(conn, config.schema, table);
				return rows
					.slice()
					.sort((a, b) => a.order - b.order)
					.map((t) => t.name);
			}
			const rows = await conn.pquery(
				`SELECT tgname FROM pg_trigger WHERE tgrelid = '${dialect.quoteIdentifier(
					table,
				)}'::regclass AND NOT tgisinternal`,
			);
			return rows.map((r) => r.tgname);
		});

	const uuidDef =
		(table, extra = {}) =>
		({ types: t }) => ({
			table,
			schema: { id: t.uuidKey, name: t.string, copyOfId: t.string },
			...extra,
		});

	after(async () => {
		await withConn((conn) =>
			Promise.all(
				tables.map((table) =>
					conn.pquery(`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(table)}`),
				),
			),
		);
	});

	it(`syncs a uuidKey table named with ${limit} characters`, async () => {
		expect(plainTable).to.have.lengthOf(limit);
		const result = await syncSchemaToDb(
			YassORM.convertDefinition(uuidDef(plainTable)),
		);
		expect(result.errors).to.deep.equal([]);

		const names = await triggerNames(plainTable);
		if (isMysql) {
			const idName = idTriggerName(plainTable, limit);
			expect(idName).to.have.lengthOf(limit);
			expect(names).to.deep.equal([idName]);
		} else {
			expect(names).to.deep.equal([]);
		}
	});

	it('the second sync applies nothing', async () => {
		const { result, logs } = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(uuidDef(plainTable))),
		);
		expect(result.errors).to.deep.equal([]);
		expect(result.applied).to.equal(0);
		expect(logs.filter((l) => l.includes(WRITE_TRIGGER_LOG))).to.deep.equal([]);
	});

	it('a model on it creates and reads back a row', async () => {
		const LongModel = YassORM.defineModel({
			table: plainTable,
			schema: (t) => ({ id: t.uuidKey, name: t.string, copyOfId: t.string }),
		});
		const created = await LongModel.create({ name: 'long' });
		expect(created.id).to.be.a('string').and.not.equal('');
		const read = await LongModel.get(created.id);
		expect(read.name).to.equal('long');
	});

	if (isMysql) {
		it('MySQL: the fitted id trigger sets the id of a raw INSERT', async () => {
			const row = await withConn(async (conn) => {
				await conn.pquery(
					`INSERT INTO \`${plainTable}\` (name) VALUES ('raw-insert')`,
				);
				const [found] = await conn.pquery(
					`SELECT id FROM \`${plainTable}\` WHERE name = 'raw-insert'`,
				);
				return found;
			});
			expect(row.id).to.match(/^[0-9a-f-]{36}$/i);
		});

		const copyId = {
			copy_id_to_copy_field: {
				timing: 'before',
				event: 'insert',
				body: `BEGIN
					SET NEW.copyOfId = NEW.id;
				END`,
			},
		};

		it('MySQL: a declared BEFORE INSERT trigger fires after the fitted id trigger', async () => {
			const def = uuidDef(declaredTable, { triggers: copyId });
			const result = await syncSchemaToDb(YassORM.convertDefinition(def));
			expect(result.errors).to.deep.equal([]);

			const idName = idTriggerName(declaredTable, limit);
			expect(await triggerNames(declaredTable)).to.deep.equal([
				idName,
				'copy_id_to_copy_field',
			]);
			const row = await withConn(async (conn) => {
				await conn.pquery(
					`INSERT INTO \`${declaredTable}\` (name) VALUES ('copy')`,
				);
				const [found] = await conn.pquery(
					`SELECT id, copyOfId FROM \`${declaredTable}\` WHERE name = 'copy'`,
				);
				return found;
			});
			expect(row.copyOfId).to.equal(row.id);
		});

		it('MySQL: a def that owns its triggers keeps the fitted id trigger, and re-syncs to nothing', async () => {
			const def = uuidDef(declaredTable, { triggers: copyId });
			const { result, logs } = await captureLogs(() =>
				syncSchemaToDb(YassORM.convertDefinition(def)),
			);
			expect(result.errors).to.deep.equal([]);
			expect(result.applied).to.equal(0);
			expect(logs.filter((l) => l.includes(WRITE_TRIGGER_LOG))).to.deep.equal(
				[],
			);

			const emptyDef = uuidDef(declaredTable, { triggers: {} });
			const emptied = await syncSchemaToDb(YassORM.convertDefinition(emptyDef));
			expect(emptied.errors).to.deep.equal([]);
			expect(await triggerNames(declaredTable)).to.deep.equal([
				idTriggerName(declaredTable, limit),
			]);
		});

		it('MySQL: switching the table to t.idKey drops the fitted id trigger', async () => {
			const intDef = ({ types: t }) => ({
				table: plainTable,
				schema: { id: t.idKey, name: t.string, copyOfId: t.string },
			});
			expect(await triggerNames(plainTable)).to.deep.equal([
				idTriggerName(plainTable, limit),
			]);
			// Empty, so the char(36) id can become an int.
			await withConn((conn) => conn.pquery(`DELETE FROM \`${plainTable}\``));
			const result = await syncSchemaToDb(YassORM.convertDefinition(intDef));
			expect(result.errors).to.deep.equal([]);
			expect(await triggerNames(plainTable)).to.deep.equal([]);
		});
	}
});
