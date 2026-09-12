/* eslint-disable no-console */
/* global describe, it */
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
