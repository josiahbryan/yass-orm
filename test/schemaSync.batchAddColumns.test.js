/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { buildAddColumnPlan } = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');

describe('#schemaSync buildAddColumnPlan', () => {
	const mysql = new MySQLDialect();
	const sqlite = new SQLiteDialect();
	const twoFields = [
		{ field: 'notice', type: 'varchar(255)' },
		{ field: 'noticeDetail', type: 'text' },
	];

	it('batches N>1 columns into exactly ONE statement on an opted-in dialect', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.statements).to.have.length(1);
		expect(plan.statements[0]).to.include('notice');
		expect(plan.statements[0]).to.include('noticeDetail');
	});

	// AC7 -- the coupling most likely to be dropped. verifyAndHealColumns
	// replays entry.sql PER COLUMN, so a shared batched string there would
	// replay every ADD to heal one, i.e. a second full table rebuild.
	it('keeps the heal ledger SINGLE-COLUMN even when batching', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.ledger).to.have.length(2);

		const [first, second] = plan.ledger;
		expect(first.col).to.equal('notice');
		expect(first.type).to.equal('ADD');
		expect(first.sql).to.include('notice');
		expect(first.sql).to.not.include('noticeDetail');

		expect(second.col).to.equal('noticeDetail');
		expect(second.sql).to.include('noticeDetail');
		// A single-column ledger entry names exactly ONE column.
		expect(second.sql.match(/ADD /g)).to.have.length(1);
	});

	it('N=1 emits one statement byte-identical to the single-column generator', () => {
		const one = [{ field: 'notice', type: 'varchar(255)' }];
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: one,
		});
		expect(plan.statements).to.have.length(1);
		expect(plan.statements[0]).to.equal(
			mysql.generateAlterAddColumn('widgets', one[0]),
		);
	});

	it('N=0 emits NOTHING (never an empty ALTER TABLE with no clauses)', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: [],
		});
		expect(plan.statements).to.deep.equal([]);
		expect(plan.ledger).to.deep.equal([]);
	});

	// AC6 -- a dialect that has not opted in keeps today's exact behaviour.
	it('falls back to one statement per column on a non-opted-in dialect', () => {
		const plan = buildAddColumnPlan({
			dialect: sqlite,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.statements).to.have.length(2);
		expect(plan.statements[0]).to.equal(
			sqlite.generateAlterAddColumn('widgets', twoFields[0]),
		);
		expect(plan.statements[1]).to.equal(
			sqlite.generateAlterAddColumn('widgets', twoFields[1]),
		);
	});

	it('preserves schema order in both statements and ledger', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.ledger.map((e) => e.col)).to.deep.equal([
			'notice',
			'noticeDetail',
		]);
		expect(plan.statements[0].indexOf('notice')).to.be.lessThan(
			plan.statements[0].indexOf('noticeDetail'),
		);
	});
});

const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const {
	captureAlterStatements,
} = require('./helpers/captureAlterStatements');
const { mysqlGeneralLog } = require('./helpers/mysqlGeneralLog');

describe('#schemaSync batched ADD COLUMN (db-backed)', function batchedAddSuite() {
	this.timeout(60000);

	const tableA = `yass_batch_a_${uuid().replace(/-/g, '')}`;
	const tableB = `yass_batch_b_${uuid().replace(/-/g, '')}`;

	const base = (table) => ({ types: t }) => ({
		table,
		schema: { id: t.idKey },
	});
	const plusTwo = (table) => ({ types: t }) => ({
		table,
		schema: { id: t.idKey, notice: t.string, noticeDetail: t.text },
	});

	before(function beforeBatchedAddSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableA}\``);
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableB}\``);
		await mysqlGeneralLog.disable(conn);
		await conn.end();
	});

	it('executes exactly ONE ALTER for two columns added to one table', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(base(tableA)));

		const conn = await dbh({ ignoreCachedConnections: true });
		const log = await mysqlGeneralLog.enable(conn);

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(tableA)));
		} finally {
			cap.restore();
		}

		// WITNESS 1 -- yass-orm's own executed-statement array. Always runs.
		const executed = cap.executedAltersFor(tableA);
		expect(
			executed,
			`expected ONE batched ALTER, got:\n${executed.join('\n')}`,
		).to.have.length(1);
		expect(executed[0]).to.include('notice');
		expect(executed[0]).to.include('noticeDetail');

		// WITNESS 2 -- the SERVER's own log. Independent failure mode.
		if (log.available) {
			const serverAlters = await mysqlGeneralLog.altersFor(conn, tableA);
			expect(
				serverAlters,
				`server logged:\n${serverAlters.join('\n')}`,
			).to.have.length(1);
		} else {
			console.warn(
				`SKIPPED the general-log witness: ${log.reason}. Witness 1 still asserted.`,
			);
		}
		await mysqlGeneralLog.disable(conn);
		await conn.end();
	});

	// AC7 end-to-end: the ledger the heal path replays is still per-column.
	it('records a SINGLE-COLUMN heal statement per added column', async () => {
		const dropped = `yass_batch_led_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(dropped)));

		const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
		const seen = [];
		const originalGenerate = MySQLDialect.prototype.generateAlterAddColumn;
		MySQLDialect.prototype.generateAlterAddColumn = function patched(
			table,
			fieldData,
		) {
			const out = originalGenerate.call(this, table, fieldData);
			if (table === dropped) {
				seen.push(out);
			}
			return out;
		};
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(dropped)));
		} finally {
			MySQLDialect.prototype.generateAlterAddColumn = originalGenerate;
		}

		// Two single-column statements were generated for the ledger even though
		// ONE batched statement was executed.
		expect(seen).to.have.length(2);
		seen.forEach((stmt) => {
			expect(stmt.match(/ADD /g)).to.have.length(1);
		});

		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${dropped}\``);
		await conn.end();
	});

	// AC4 -- batching is PER TABLE.
	it('keeps columns on different tables in separate statements', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(base(tableB)));

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(tableB)));
		} finally {
			cap.restore();
		}

		const forB = cap.executedAltersFor(tableB);
		expect(forB).to.have.length(1);
		// No statement may name both tables.
		expect(forB[0]).to.not.include(tableA);
	});

	// AC2 -- the resulting schema must be identical to the per-column path,
	// column ORDER included.
	it('produces a schema identical to the per-column path', async () => {
		const batched = `yass_batch_eq_b_${uuid().replace(/-/g, '')}`;
		const perCol = `yass_batch_eq_p_${uuid().replace(/-/g, '')}`;
		const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

		await syncSchemaToDb(YassORM.convertDefinition(base(batched)));
		await syncSchemaToDb(YassORM.convertDefinition(base(perCol)));

		// Batched run (normal behaviour).
		await syncSchemaToDb(YassORM.convertDefinition(plusTwo(batched)));

		// Per-column run: force the capability OFF for this one sync.
		const descriptor = Object.getOwnPropertyDescriptor(
			MySQLDialect.prototype,
			'supportsMultiClauseAlterAdd',
		);
		Object.defineProperty(
			MySQLDialect.prototype,
			'supportsMultiClauseAlterAdd',
			{ get: () => false, configurable: true },
		);
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(perCol)));
		} finally {
			Object.defineProperty(
				MySQLDialect.prototype,
				'supportsMultiClauseAlterAdd',
				descriptor,
			);
		}

		const conn = await dbh({ ignoreCachedConnections: true });
		const read = async (name) => {
			const rows = await conn.pquery(`SHOW CREATE TABLE \`${name}\``);
			const ddl = rows[0]['Create Table'] || rows[0].Table_Create || '';
			return ddl.replace(new RegExp(name, 'g'), 'T');
		};
		const ddlBatched = await read(batched);
		const ddlPerCol = await read(perCol);
		await conn.pquery(`DROP TABLE IF EXISTS \`${batched}\``);
		await conn.pquery(`DROP TABLE IF EXISTS \`${perCol}\``);
		await conn.end();

		expect(ddlBatched).to.equal(ddlPerCol);
	});
});
