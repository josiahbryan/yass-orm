/* global describe, it */
const { expect } = require('chai');
const {
	formatSyncErrorSummary,
	reportSyncResults,
} = require('../lib/sync-error-summary');

// A trigger failure shaped the way bin/schema-sync sees it: the mariadb
// driver's error (errno 1419 refusing CREATE TRIGGER), wrapped by dbh's
// wrapQueryError, recorded by lib/sync-triggers.js.
function trigger1419Error() {
	const driverError = new Error(
		'(conn=42, no: 1419, SQLState: HY000) You do not have the SUPER privilege and binary logging is enabled (you *might* want to use the less safe log_bin_trust_function_creators variable)\nsql: CREATE TRIGGER ... - parameters:[]',
	);
	driverError.code = 'ER_BINLOG_CREATE_ROUTINE_NEED_SUPER';
	driverError.errno = 1419;
	driverError.sqlState = 'HY000';
	driverError.text =
		'You do not have the SUPER privilege and binary logging is enabled (you *might* want to use the less safe log_bin_trust_function_creators variable)';
	const wrapped = new Error(`Error in query: ${driverError.message}`);
	wrapped.cause = driverError;
	wrapped.code = driverError.code;
	wrapped.errno = driverError.errno;
	return wrapped;
}

const longTriggerSql = `CREATE TRIGGER \`before_insert_widgets_set_id\` BEFORE INSERT ON \`yass_test\`.\`widgets\` FOR EACH ROW BEGIN ${'IF NEW.id IS NULL THEN SET NEW.id = uuid(); END IF; '.repeat(
	20,
)}END`;

function failingResults() {
	const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:3306');
	connectionError.code = 'ECONNREFUSED';
	connectionError.errno = -111;
	// Errors can carry the connection config; none of it may be printed.
	connectionError.config = {
		host: '127.0.0.1',
		user: 'root',
		password: 'hunter2-secret',
	};

	return [
		{ table: 'clean_table', applied: 3, failed: 0, errors: [] },
		{
			table: 'widgets',
			applied: 1,
			failed: 2,
			errors: [
				{
					table: 'widgets',
					description: 'Error syncing field',
					sql: 'ALTER TABLE `widgets` ADD COLUMN `size` int',
					error: Object.assign(new Error("Unknown column 'x'"), {
						code: 'ER_BAD_FIELD_ERROR',
						errno: 1054,
						sqlMessage: "Unknown column 'x' in 'field list'",
					}),
				},
				{
					table: 'widgets',
					description: "Error creating trigger 'before_insert_widgets_set_id'",
					sql: longTriggerSql,
					error: trigger1419Error(),
				},
			],
		},
		{
			table: 'accounts',
			applied: 0,
			failed: 1,
			errors: [
				{
					table: 'accounts',
					description: 'Error reading existing triggers from database',
					sql: 'dialect.getTableTriggers(yass_test, accounts)',
					error: connectionError,
				},
			],
		},
	];
}

describe('#schemaSync error summary', () => {
	it('lists every counted error with table, description, sql and the db error', () => {
		const out = formatSyncErrorSummary(failingResults());

		expect(out).to.be.a('string');
		// Header + both failing tables, in table order.
		expect(out).to.match(/3 error\(s\)/);
		expect(out.indexOf('accounts')).to.be.lessThan(out.indexOf('widgets'));
		expect(out).not.to.include('clean_table');

		expect(out).to.include('Error syncing field');
		expect(out).to.include('ALTER TABLE `widgets` ADD COLUMN `size` int');
		expect(out).to.include('ER_BAD_FIELD_ERROR');
		expect(out).to.include('1054');
		expect(out).to.include("Unknown column 'x' in 'field list'");

		// The trigger failure: description, (truncated) SQL, errno 1419 and the
		// server's message, not the driver's appended SQL echo.
		expect(out).to.include(
			"Error creating trigger 'before_insert_widgets_set_id'",
		);
		expect(out).to.include(
			'CREATE TRIGGER `before_insert_widgets_set_id` BEFORE INSERT',
		);
		expect(out).not.to.include(longTriggerSql);
		expect(out).to.match(/truncated/);
		expect(out).to.include('ER_BINLOG_CREATE_ROUTINE_NEED_SUPER');
		expect(out).to.include('1419');
		expect(out).to.include('You do not have the SUPER privilege');

		expect(out).to.include('Error reading existing triggers from database');
		expect(out).to.include('ECONNREFUSED');
		expect(out).to.include('connect ECONNREFUSED 127.0.0.1:3306');
		expect(out).not.to.include('hunter2-secret');
	});

	it('returns null when nothing failed', () => {
		expect(
			formatSyncErrorSummary([
				{ table: 'a', applied: 1, failed: 0, errors: [] },
			]),
		).to.equal(null);
	});

	it('groups one result under its table even when its records name it differently', () => {
		const out = formatSyncErrorSummary([
			{
				table: 'widgets',
				applied: 0,
				failed: 2,
				errors: [
					{
						table: '`widgets`',
						description: 'Error syncing field',
						sql: 'ALTER TABLE `widgets` ADD COLUMN `size` int',
						error: new Error('column refused'),
					},
					{
						table: 'widgets',
						description: "Error creating trigger 'trg'",
						sql: 'CREATE TRIGGER trg ...',
						error: new Error('trigger refused'),
					},
				],
			},
		]);
		expect(out).to.include('2 error(s) in 1 table(s)');
		expect(out).to.include('[widgets] 2 error(s)');
		expect(out).not.to.include('[`widgets`]');
	});

	it('reportSyncResults prints the summary and the final line, returns the exit code', () => {
		const lines = [];
		const log = (...args) => lines.push(args.join(' '));

		const code = reportSyncResults(failingResults(), { log });
		const printed = lines.join('\n');

		expect(code).to.equal(1);
		expect(printed).to.include(
			"Error creating trigger 'before_insert_widgets_set_id'",
		);
		expect(printed).to.include('1419');
		expect(printed).to.include(
			'3 schema-sync error(s) across 3 table(s). Exiting non-zero.',
		);
		// The summary comes before the final line.
		expect(printed.indexOf('1419')).to.be.lessThan(
			printed.indexOf('Exiting non-zero'),
		);

		const cleanLines = [];
		expect(
			reportSyncResults([{ table: 'a', applied: 0, failed: 0, errors: [] }], {
				log: (...args) => cleanLines.push(args.join(' ')),
			}),
		).to.equal(0);
		expect(cleanLines).to.deep.equal([]);
	});
});
