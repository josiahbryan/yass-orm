/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { buildColumnAlterPlan, syncSchemaToDb } = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { PostgresDialect } = require('../lib/dialects/PostgresDialect');
const { captureAlterStatements } = require('./helpers/captureAlterStatements');
const { mysqlGeneralLog } = require('./helpers/mysqlGeneralLog');

/**
 * One ALTER per table. A type change (varchar -> longtext) cannot be done
 * online on MySQL: each ALTER is a full table-copy rebuild that blocks writes.
 * Nine CHANGEs and one ADD on one hot table were ten rebuilds; as one
 * `ALTER TABLE t CHANGE ..., CHANGE ..., ADD ...` they are one.
 */
describe('#schemaSync buildColumnAlterPlan', () => {
	const mysql = new MySQLDialect();
	const postgres = new PostgresDialect();
	const changes = [
		{ field: 'body', type: 'longtext' },
		{ field: 'summary', type: 'longtext' },
	];
	const adds = [{ field: 'notice', type: 'varchar(255)' }];

	it('combines CHANGEs and ADDs into exactly ONE statement on an opted-in dialect', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: changes,
			addFieldList: adds,
		});
		expect(plan.statements).to.deep.equal([
			'ALTER TABLE `widgets` CHANGE `body` `body` longtext, ' +
				'CHANGE `summary` `summary` longtext, ADD `notice` varchar(255)',
		]);
	});

	it('includes DROPs in the same statement', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: [changes[0]],
			dropColumnList: ['legacy'],
		});
		expect(plan.statements).to.deep.equal([
			'ALTER TABLE `widgets` CHANGE `body` `body` longtext, DROP `legacy`',
		]);
		expect(plan.ledger.map((e) => [e.col, e.type])).to.deep.equal([
			['body', 'CHANGE'],
			['legacy', 'DROP'],
		]);
	});

	it('carries the per-statement path as the fallback for a combined ALTER', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: changes,
			addFieldList: adds,
		});
		expect(plan.fallbackStatements).to.deep.equal([
			mysql.generateAlterModifyColumn('widgets', changes[0]),
			mysql.generateAlterModifyColumn('widgets', changes[1]),
			mysql.generateAlterAddColumn('widgets', adds[0]),
		]);
	});

	// verifyAndHealColumns replays entry.sql PER COLUMN, so the combined
	// string must never reach the ledger (see buildAddColumnPlan).
	it('keeps the ledger SINGLE-COLUMN, CHANGEs then ADDs', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: changes,
			addFieldList: adds,
		});
		expect(plan.ledger).to.deep.equal([
			{
				col: 'body',
				type: 'CHANGE',
				textLike: true,
				sql: 'ALTER TABLE `widgets` CHANGE `body` `body` longtext',
			},
			{
				col: 'summary',
				type: 'CHANGE',
				textLike: true,
				sql: 'ALTER TABLE `widgets` CHANGE `summary` `summary` longtext',
			},
			{
				col: 'notice',
				type: 'ADD',
				sql: 'ALTER TABLE `widgets` ADD `notice` varchar(255)',
			},
		]);
	});

	// The errno 1170 guard's index drops go in the same ALTER as the change
	// they make room for, so a change that cannot get its lock leaves the
	// index in place (dropped on its own first, nothing would recreate it).
	it('puts index drops in the combined ALTER, and first in the fallback', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: [changes[0]],
			dropIndexList: ['body'],
		});
		expect(plan.statements).to.deep.equal([
			'ALTER TABLE `widgets` DROP INDEX `body`, CHANGE `body` `body` longtext',
		]);
		expect(plan.fallbackStatements).to.deep.equal([
			mysql.generateDropIndex('widgets', 'body'),
			mysql.generateAlterModifyColumn('widgets', changes[0]),
		]);
		expect(plan.ledger.map((e) => [e.col, e.type])).to.deep.equal([
			['body', 'CHANGE'],
		]);
	});

	it('marks only TEXT/BLOB changes textLike (the errno 1170 index guard reads it)', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: [{ field: 'count', type: 'int(11)' }],
		});
		expect(plan.ledger[0].textLike).to.equal(false);
	});

	it('a single change is byte-identical to the single-column generator, with no fallback', () => {
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			changeFieldList: [changes[0]],
		});
		expect(plan.statements).to.deep.equal([
			mysql.generateAlterModifyColumn('widgets', changes[0]),
		]);
		expect(plan.fallbackStatements).to.equal(null);
	});

	it('ADDs alone are the existing batched ADD, with no fallback', () => {
		const twoAdds = [...adds, { field: 'noticeDetail', type: 'text' }];
		const plan = buildColumnAlterPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoAdds,
		});
		expect(plan.statements).to.deep.equal([
			mysql.generateAlterAddColumns('widgets', twoAdds),
		]);
		expect(plan.fallbackStatements).to.equal(null);
	});

	it('nothing to do emits NOTHING', () => {
		const plan = buildColumnAlterPlan({ dialect: mysql, tableName: 'widgets' });
		expect(plan).to.deep.equal({
			statements: [],
			fallbackStatements: null,
			ledger: [],
		});
	});

	it('a dialect with multi-clause ADDs turned off gets no combined ALTER either', () => {
		const noMultiClause = Object.create(mysql, {
			supportsMultiClauseAlterAdd: { get: () => false },
		});
		const plan = buildColumnAlterPlan({
			dialect: noMultiClause,
			tableName: 'widgets',
			changeFieldList: changes,
			addFieldList: adds,
		});
		expect(plan.statements).to.have.length(3);
		expect(plan.fallbackStatements).to.equal(null);
	});

	// not opted in: it keeps one statement per CHANGE plus its batched ADD.
	it('a dialect that has not opted in keeps one statement per CHANGE', () => {
		const twoAdds = [...adds, { field: 'noticeDetail', type: 'text' }];
		const plan = buildColumnAlterPlan({
			dialect: postgres,
			tableName: 'widgets',
			changeFieldList: changes,
			addFieldList: twoAdds,
			dropColumnList: ['legacy'],
		});
		expect(plan.statements).to.deep.equal([
			postgres.generateAlterModifyColumn('widgets', changes[0]),
			postgres.generateAlterModifyColumn('widgets', changes[1]),
			postgres.generateAlterAddColumns('widgets', twoAdds),
			postgres.generateAlterDropColumn('widgets', 'legacy'),
		]);
		expect(plan.fallbackStatements).to.equal(null);
	});
});

describe('#schemaSync one ALTER per table (db-backed)', function combinedAlterSuite() {
	this.timeout(120000);

	const tables = [];
	const newTable = (prefix) => {
		const table = `${prefix}_${uuid().replace(/-/g, '')}`;
		tables.push(table);
		return table;
	};
	const sync = (def) => syncSchemaToDb(YassORM.convertDefinition(def));
	const columnTypes = async (table) => {
		const rows = await (await dbh()).pquery(`SHOW COLUMNS FROM \`${table}\``);
		return Object.fromEntries(rows.map((r) => [r.Field, r.Type]));
	};

	before(function beforeCombinedAlterSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh();
		// eslint-disable-next-line no-restricted-syntax
		for (const table of tables) {
			// eslint-disable-next-line no-await-in-loop
			await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
		}
	});

	it('executes exactly ONE ALTER for two type changes and an added column', async () => {
		const table = newTable('yass_combined_a');
		await sync(({ types: t }) => ({
			table,
			schema: { id: t.idKey, body: t.string, summary: t.string },
		}));
		const after = ({ types: t }) => ({
			table,
			schema: { id: t.idKey, body: t.text, summary: t.text, notice: t.string },
		});

		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const log = await mysqlGeneralLog.enable(conn);
			const cap = captureAlterStatements.install();
			let result;
			try {
				result = await sync(after);
			} finally {
				cap.restore();
			}
			expect(result.errors).to.deep.equal([]);

			// WITNESS 1 -- yass-orm's own executed-statement log.
			const executed = cap.executedAltersFor(table);
			expect(
				executed,
				`expected ONE combined ALTER, got:\n${executed.join('\n')}`,
			).to.have.length(1);
			expect(executed[0]).to.match(
				/CHANGE `body` `body` longtext.*, CHANGE `summary` `summary` longtext.*, ADD `notice` /,
			);

			// WITNESS 2 -- the server's own log.
			if (log.available) {
				const serverAlters = await mysqlGeneralLog.altersFor(conn, table);
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
			await mysqlGeneralLog.disable(conn);
			await conn.end();
		}

		expect(await columnTypes(table)).to.include({
			body: 'longtext',
			summary: 'longtext',
			notice: 'varchar(255)',
		});
		expect((await sync(after)).applied).to.equal(0);
	});

	// One bad clause fails the whole combined ALTER (it is atomic). It must
	// not take the table's good columns down with it: the sync falls back to
	// one statement per column, where only the bad column fails.
	it('falls back to per-statement when the combined ALTER fails, so one bad column does not block the rest', async () => {
		const table = newTable('yass_combined_fb');
		await sync(({ types: t }) => ({
			table,
			schema: { id: t.idKey, amount: t.string, body: t.string },
		}));
		// 'abc' cannot become an integer under strict sql_mode: CHANGE amount fails.
		await (
			await dbh()
		).pquery(`INSERT INTO \`${table}\` (amount, body) VALUES ('abc', 'x')`);

		const cap = captureAlterStatements.install();
		const originalError = console.error;
		const originalWarn = console.warn;
		const warned = [];
		console.error = () => {};
		console.warn = (...args) => warned.push(args.map((a) => `${a}`).join(' '));
		let result;
		try {
			result = await sync(({ types: t }) => ({
				table,
				schema: {
					id: t.idKey,
					amount: t.int.nullable(),
					body: t.text,
					notice: t.string,
				},
			}));
		} finally {
			cap.restore();
			console.error = originalError;
			console.warn = originalWarn;
		}

		expect(
			result.errors.map((e) => e.sql),
			'only the bad column is reported',
		).to.have.length(1);
		expect(result.errors[0].sql).to.match(/^ALTER TABLE \S+ CHANGE `amount` /);
		expect(result.errors[0].sql).to.not.include('body');

		expect(warned.join('\n')).to.match(
			/combined ALTER .* failed.*falling back/is,
		);

		// The combined attempt, then the per-statement path: all of it logged.
		const executed = cap.executedAltersFor(table);
		expect(executed[0]).to.match(
			/CHANGE `amount`.*CHANGE `body`.*ADD `notice`/,
		);
		expect(executed.slice(1)).to.have.length(3);

		expect(await columnTypes(table)).to.include({
			amount: 'varchar(255)',
			body: 'longtext',
			notice: 'varchar(255)',
		});
	});

	// A NOT NULL change blocked by existing NULL rows is reported, as before,
	// and is left out of the combined ALTER so the rest still go as one.
	it('leaves a preflight-blocked NOT NULL change out of the combined ALTER', async () => {
		const table = newTable('yass_combined_nn');
		await sync(({ types: t }) => ({
			table,
			schema: {
				id: t.idKey,
				confidence: t.float.nullable(),
				body: t.string,
				summary: t.string,
			},
		}));
		await (
			await dbh()
		).pquery(`INSERT INTO \`${table}\` (confidence) VALUES (NULL)`);

		const cap = captureAlterStatements.install();
		const originalError = console.error;
		console.error = () => {};
		let result;
		try {
			result = await sync(({ types: t }) => ({
				table,
				schema: {
					id: t.idKey,
					confidence: t.float.default(0.5),
					body: t.text,
					summary: t.text,
				},
			}));
		} finally {
			cap.restore();
			console.error = originalError;
		}

		expect(result.errors.map((e) => e.description)).to.deep.equal([
			'Unsafe NOT NULL alter blocked by existing NULL values',
		]);
		const executed = cap.executedAltersFor(table);
		expect(executed, executed.join('\n')).to.have.length(1);
		expect(executed[0]).to.match(/CHANGE `body`.*CHANGE `summary`/);
		expect(executed[0]).to.not.include('confidence');
		expect(await columnTypes(table)).to.include({
			body: 'longtext',
			summary: 'longtext',
		});
	});
});
