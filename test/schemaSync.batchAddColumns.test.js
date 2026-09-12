/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { buildAddColumnPlan, syncSchemaToDb } = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');
const { captureAlterStatements } = require('./helpers/captureAlterStatements');
const { mysqlGeneralLog } = require('./helpers/mysqlGeneralLog');

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
		expect(second.type).to.equal('ADD');
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

	it('UNDEFINED addFieldList is treated the same as N=0, not a throw', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
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

describe('#schemaSync batched ADD COLUMN (db-backed)', function batchedAddSuite() {
	this.timeout(60000);

	const tableA = `yass_batch_a_${uuid().replace(/-/g, '')}`;

	const base =
		(table) =>
		({ types: t }) => ({
			table,
			schema: { id: t.idKey },
		});
	const plusTwo =
		(table) =>
		({ types: t }) => ({
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
		await conn.end();
	});

	it('executes exactly ONE ALTER for two columns added to one table', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(base(tableA)));

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
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
			// `notice` is a literal substring of `noticeDetail`, so asserting it
			// separately would be redundant with this check.
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
		} finally {
			// F6: disable + end run even if an assertion above throws, so this
			// test can never leak GLOBAL general_log=ON or a connection.
			await mysqlGeneralLog.disable(conn);
			await conn.end();
		}
	});

	// AC7 end-to-end: prove the heal path itself re-issues a SINGLE-COLUMN
	// statement, by actually driving it -- not by counting generator calls
	// (that instrument passes on the unfixed tree and would still pass if the
	// batched string leaked into the heal ledger; see the RED-probe evidence
	// in task-3-report.md).
	//
	// Mechanism: patch the EXECUTION-ONLY generator (`generateAlterAddColumns`,
	// plural) so the batched ALTER it returns omits `noticeDetail` -- as if a
	// partial apply had happened. The heal ledger is built from
	// `generateAlterAddColumn` (singular), which we do NOT patch, so it still
	// carries the real single-column SQL. `syncSchemaToDb`'s post-sync
	// verifyAndHealColumns pass must then find `noticeDetail` missing and
	// re-issue exactly that column's ledger entry.
	it('heals a column missing from the executed batch with a single-column re-issue', async () => {
		const table = `yass_batch_heal_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(table)));

		const originalGenerateMany = MySQLDialect.prototype.generateAlterAddColumns;
		MySQLDialect.prototype.generateAlterAddColumns = function patched(
			tableName,
			fieldDataList,
		) {
			if (tableName === table) {
				const filtered = (fieldDataList || []).filter(
					(f) => f.field !== 'noticeDetail',
				);
				return originalGenerateMany.call(this, tableName, filtered);
			}
			return originalGenerateMany.call(this, tableName, fieldDataList);
		};

		const warnLines = [];
		// eslint-disable-next-line no-console
		const originalWarn = console.warn;
		// eslint-disable-next-line no-console
		console.warn = (...args) => {
			warnLines.push(args.map((a) => `${a}`).join(' '));
		};

		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(table)));
		} finally {
			// eslint-disable-next-line no-console
			console.warn = originalWarn;
			MySQLDialect.prototype.generateAlterAddColumns = originalGenerateMany;
		}

		const reissueLines = warnLines.filter((line) =>
			line.includes('re-issuing:'),
		);
		expect(
			reissueLines,
			`expected exactly one re-issue warning, got:\n${warnLines.join('\n')}`,
		).to.have.length(1);
		expect(reissueLines[0]).to.include('noticeDetail');
		expect(reissueLines[0].match(/ADD /g)).to.have.length(1);
		// The re-issued SQL must be SINGLE-COLUMN. Check the quoted identifier
		// `` `notice` `` rather than the bare substring "notice" -- "notice" is
		// a literal substring of "noticeDetail" and a bare search would always
		// match.
		expect(reissueLines[0]).to.not.include('`notice`');

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const cols = await conn.pquery(`SHOW COLUMNS FROM \`${table}\``);
			const names = cols.map((c) => c.Field);
			expect(names).to.include('notice');
			expect(names).to.include('noticeDetail');
		} finally {
			await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
			await conn.end();
		}
	});

	// AC4 -- batching is PER TABLE: two tables, each getting the same two
	// columns, inside ONE capture window. Each table's ADD alters must be
	// length 1, and no captured statement may name both tables -- a genuine
	// cross-table leak this test can actually detect, since both tables are
	// altered inside the same install/restore window.
	it('keeps columns on different tables in separate statements', async () => {
		const tableX = `yass_batch_x_${uuid().replace(/-/g, '')}`;
		const tableY = `yass_batch_y_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(tableX)));
		await syncSchemaToDb(YassORM.convertDefinition(base(tableY)));

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(tableX)));
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(tableY)));
		} finally {
			cap.restore();
		}

		try {
			const forX = cap.executedAltersFor(tableX);
			const forY = cap.executedAltersFor(tableY);
			expect(forX, `table X statements:\n${forX.join('\n')}`).to.have.length(1);
			expect(forY, `table Y statements:\n${forY.join('\n')}`).to.have.length(1);

			// No captured statement may name BOTH tables.
			cap.executedAlterStatements().forEach((stmt) => {
				if (stmt.includes(tableX)) {
					expect(stmt, `statement named both tables:\n${stmt}`).to.not.include(
						tableY,
					);
				}
				if (stmt.includes(tableY)) {
					expect(stmt, `statement named both tables:\n${stmt}`).to.not.include(
						tableX,
					);
				}
			});
		} finally {
			const conn = await dbh({ ignoreCachedConnections: true });
			try {
				await conn.pquery(`DROP TABLE IF EXISTS \`${tableX}\``);
				await conn.pquery(`DROP TABLE IF EXISTS \`${tableY}\``);
			} finally {
				await conn.end();
			}
		}
	});

	// AC2 -- the resulting schema must be identical to the per-column path,
	// column ORDER included -- AND the per-column arm must be PROVEN to have
	// actually executed per-column (more than one ADD alter), not merely
	// assumed from the capability override taking effect.
	it('produces a schema identical to the per-column path', async () => {
		const batched = `yass_batch_eq_b_${uuid().replace(/-/g, '')}`;
		const perCol = `yass_batch_eq_p_${uuid().replace(/-/g, '')}`;

		await syncSchemaToDb(YassORM.convertDefinition(base(batched)));
		await syncSchemaToDb(YassORM.convertDefinition(base(perCol)));

		// Batched run (normal behaviour).
		const batchedCap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(batched)));
		} finally {
			batchedCap.restore();
		}
		const batchedAdds = batchedCap
			.executedAltersFor(batched)
			.filter((s) => /\bADD\b/.test(s));
		expect(
			batchedAdds,
			`expected exactly 1 batched ADD alter, got:\n${batchedAdds.join('\n')}`,
		).to.have.length(1);

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
		const perColCap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(perCol)));
		} finally {
			perColCap.restore();
			// Guard: only re-define if a descriptor was actually captured --
			// `defineProperty` with an `undefined` descriptor throws.
			if (descriptor) {
				Object.defineProperty(
					MySQLDialect.prototype,
					'supportsMultiClauseAlterAdd',
					descriptor,
				);
			} else {
				delete MySQLDialect.prototype.supportsMultiClauseAlterAdd;
			}
		}
		// CONTROL: prove the override actually took effect. yass-orm may
		// auto-inject additional columns (e.g. isDeleted) alongside
		// notice/noticeDetail, so the true count is "more than one", not a
		// hardcoded 2 -- Task 4 measured 3 ADD alters on a raw table.
		const perColAdds = perColCap
			.executedAltersFor(perCol)
			.filter((s) => /\bADD\b/.test(s));
		expect(
			perColAdds.length,
			`expected MORE THAN 1 separate per-column ADD alter, got:\n${perColAdds.join(
				'\n',
			)}`,
		).to.be.greaterThan(1);

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const read = async (name) => {
				const rows = await conn.pquery(`SHOW CREATE TABLE \`${name}\``);
				const ddl = rows[0]['Create Table'] || rows[0].Table_Create || '';
				return ddl.replace(new RegExp(name, 'g'), 'T');
			};
			const ddlBatched = await read(batched);
			const ddlPerCol = await read(perCol);
			expect(ddlBatched).to.equal(ddlPerCol);
		} finally {
			await conn.pquery(`DROP TABLE IF EXISTS \`${batched}\``);
			await conn.pquery(`DROP TABLE IF EXISTS \`${perCol}\``);
			await conn.end();
		}
	});

	it('logs the table size before adding columns', async () => {
		const sized = `yass_batch_size_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(sized)));

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(sized)));
		} finally {
			cap.restore();
		}

		const sizeLines = cap.captured.filter(
			(l) => l.includes(sized) && l.includes('column(s) to'),
		);
		expect(
			sizeLines,
			`expected a pre-ALTER size line, captured:\n${cap.captured.join('\n')}`,
		).to.have.length.greaterThan(0);
		expect(sizeLines[0]).to.match(/rows/);

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(`DROP TABLE IF EXISTS \`${sized}\``);
		} finally {
			await conn.end();
		}
	});

	// The important half of AC8: a failed size lookup must NEVER block a
	// schema change.
	it('still applies the ALTER when the size lookup throws', async () => {
		const broken = `yass_batch_brk_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(broken)));

		const original = MySQLDialect.prototype.generateTableSizeQuery;
		MySQLDialect.prototype.generateTableSizeQuery = function boom() {
			throw new Error('size lookup exploded on purpose');
		};
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(broken)));
		} finally {
			MySQLDialect.prototype.generateTableSizeQuery = original;
		}

		const conn = await dbh({ ignoreCachedConnections: true });
		let names;
		try {
			const cols = await conn.pquery(`SHOW COLUMNS FROM \`${broken}\``);
			names = cols.map((c) => c.Field);
			await conn.pquery(`DROP TABLE IF EXISTS \`${broken}\``);
		} finally {
			await conn.end();
		}

		expect(names).to.include('notice');
		expect(names).to.include('noticeDetail');
	});
});
