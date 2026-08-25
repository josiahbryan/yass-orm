/* global describe, it, beforeEach */
const { expect } = require('chai');

const { getDialect } = require('../lib/dbh');
const {
	generateLinkCollationManifest,
	runLinkCollationMigration,
	createMemoryStateStore,
	CANONICAL_UUID_COLLATION,
	groupItemsByTable,
} = require('../lib/migrations/link-collation');

const dialect = getDialect('mysql');

/**
 * A mock db handle whose .query() returns canned information_schema rows.
 * NEVER touches a real database.
 */
function mockHandle(rows) {
	return {
		queries: [],
		async query(sql, params) {
			this.queries.push({ sql, params });
			return rows;
		},
	};
}

const SAMPLE_ROWS = [
	// small table, mismatched -> direct
	{
		tableName: 'bc_task_external_links',
		columnName: 'task',
		collationName: 'utf8mb4_0900_ai_ci',
		columnType: 'char(36)',
		isNullable: 'YES',
		tableRows: 5000,
		totalBytes: 2 * 1024 * 1024,
	},
	// big table, mismatched -> online
	{
		tableName: 'bc_tasks',
		columnName: 'parent',
		collationName: 'utf8mb4_general_ci',
		columnType: 'char(36)',
		isNullable: 'YES',
		tableRows: 5_000_000,
		totalBytes: 8 * 1024 * 1024 * 1024,
	},
];

describe('#Link Collation Migration Tooling', () => {
	describe('generateLinkCollationManifest (read-only generator)', () => {
		it('identifies mismatched char(36) columns and builds a manifest', async () => {
			const handle = mockHandle(SAMPLE_ROWS);
			const manifest = await generateLinkCollationManifest({
				handle,
				database: 'testdb',
				dialect,
			});

			expect(manifest.summary.columns).to.equal(2);
			expect(manifest.summary.tables).to.equal(2);
			expect(manifest.targetCollation).to.equal(CANONICAL_UUID_COLLATION);

			// The query must be scoped to the schema and exclude the target collation.
			const { sql, params } = handle.queries[0];
			expect(sql).to.match(/information_schema\.COLUMNS/i);
			expect(sql).to.match(/CHARACTER_MAXIMUM_LENGTH = 36/);
			expect(params).to.deep.equal(['testdb', CANONICAL_UUID_COLLATION]);
		});

		it('classifies big tables as online DDL, small as direct', async () => {
			const handle = mockHandle(SAMPLE_ROWS);
			const manifest = await generateLinkCollationManifest({
				handle,
				database: 'testdb',
				dialect,
			});
			const byTable = Object.fromEntries(
				manifest.items.map((i) => [i.table, i]),
			);
			expect(byTable.bc_task_external_links.strategy).to.equal('direct');
			expect(byTable.bc_tasks.strategy).to.equal('online');
			expect(manifest.summary.bigTables).to.equal(1);
		});

		it('generates ALTER SQL via the dialect (schema-sync DDL path)', async () => {
			const handle = mockHandle(SAMPLE_ROWS);
			const manifest = await generateLinkCollationManifest({
				handle,
				database: 'testdb',
				dialect,
			});
			const direct = manifest.items.find(
				(i) => i.table === 'bc_task_external_links',
			);
			// Full CHANGE statement targeting the canonical collation.
			expect(direct.alterSql).to.match(/ALTER TABLE `bc_task_external_links`/);
			expect(direct.alterSql).to.match(/CHANGE `task`/);
			expect(direct.alterSql).to.include(`COLLATE ${CANONICAL_UUID_COLLATION}`);
			// Online command present for the big table.
			const big = manifest.items.find((i) => i.table === 'bc_tasks');
			expect(big.onlineCommand).to.match(/gh-ost/);
			expect(big.onlineCommand).to.include('utf8mb4_bin');
		});

		it('honors a custom big-table row threshold', async () => {
			const handle = mockHandle(SAMPLE_ROWS);
			const manifest = await generateLinkCollationManifest({
				handle,
				database: 'testdb',
				dialect,
				bigTableRowThreshold: 100, // everything is "big" now
			});
			expect(manifest.items.every((i) => i.strategy === 'online')).to.equal(
				true,
			);
		});
	});

	describe('runLinkCollationMigration (runner)', () => {
		let manifest;
		beforeEach(async () => {
			manifest = await generateLinkCollationManifest({
				handle: mockHandle(SAMPLE_ROWS),
				database: 'testdb',
				dialect,
			});
		});

		it('dry-run makes NO changes and populates a plan', async () => {
			const executed = [];
			const store = createMemoryStateStore();
			const report = await runLinkCollationMigration({
				manifest,
				stateStore: store,
				dryRun: true,
				execute: async ({ item }) => executed.push(item),
				verify: async () => 'utf8mb4_0900_ai_ci',
			});
			expect(executed).to.have.length(0);
			expect(report.plan).to.have.length(2);
			expect(store.load().completed).to.have.length(0);
		});

		it('applies all items live (mocked) and records state', async () => {
			const executed = [];
			const store = createMemoryStateStore();
			const report = await runLinkCollationMigration({
				manifest,
				stateStore: store,
				execute: async ({ item }) => executed.push(`direct:${item.table}`),
				executeOnline: async ({ item }) =>
					executed.push(`online:${item.table}`),
				// verify: mismatched before, canonical after
				verify: (() => {
					const applied = new Set();
					return async ({ item }) => {
						const k = `${item.table}.${item.column}`;
						if (applied.has(k)) return CANONICAL_UUID_COLLATION;
						applied.add(k);
						return 'utf8mb4_0900_ai_ci';
					};
				})(),
			});
			expect(report.applied).to.have.length(2);
			expect(report.errors).to.have.length(0);
			expect(executed).to.include('direct:bc_task_external_links');
			expect(executed).to.include('online:bc_tasks');
			expect(store.load().completed).to.have.length(2);
		});

		it('is RESUMABLE: a second run skips already-completed items', async () => {
			const store = createMemoryStateStore({
				completed: ['bc_task_external_links.task'],
				startedAt: 'x',
			});
			const executed = [];
			const report = await runLinkCollationMigration({
				manifest,
				stateStore: store,
				execute: async ({ item }) => executed.push(item.table),
				executeOnline: async ({ item }) => executed.push(item.table),
				verify: (() => {
					let n = 0;
					return async () => {
						n += 1;
						return n === 1 ? 'utf8mb4_general_ci' : CANONICAL_UUID_COLLATION;
					};
				})(),
			});
			// Only bc_tasks should be touched; the pre-completed one is skipped.
			expect(executed).to.deep.equal(['bc_tasks']);
			expect(
				report.skipped.some((s) => s.reason === 'already-completed'),
			).to.equal(true);
		});

		it('is IDEMPOTENT: a column already at target is skipped without executing', async () => {
			const executed = [];
			const store = createMemoryStateStore();
			const report = await runLinkCollationMigration({
				manifest,
				stateStore: store,
				execute: async ({ item }) => executed.push(item.table),
				executeOnline: async ({ item }) => executed.push(item.table),
				// Everything already canonical -> nothing to do.
				verify: async () => CANONICAL_UUID_COLLATION,
			});
			expect(executed).to.have.length(0);
			expect(
				report.skipped.every((s) => s.reason === 'already-canonical'),
			).to.equal(true);
			expect(store.load().completed).to.have.length(2);
		});

		it('HALTS on verify-after mismatch (no silent success)', async () => {
			const store = createMemoryStateStore();
			const report = await runLinkCollationMigration({
				manifest,
				stateStore: store,
				execute: async () => {},
				executeOnline: async () => {},
				// Never becomes canonical -> apply "fails" verification.
				verify: async () => 'utf8mb4_0900_ai_ci',
			});
			expect(report.applied).to.have.length(0);
			expect(report.errors).to.have.length(1);
			expect(report.stoppedEarly).to.equal(true);
		});

		it('respects stopAfter (batching for overnight runs)', async () => {
			const store = createMemoryStateStore();
			const report = await runLinkCollationMigration({
				manifest,
				stateStore: store,
				stopAfter: 1,
				execute: async () => {},
				executeOnline: async () => {},
				verify: (() => {
					const applied = new Set();
					return async ({ item }) => {
						const k = `${item.table}.${item.column}`;
						if (applied.has(k)) return CANONICAL_UUID_COLLATION;
						applied.add(k);
						return 'utf8mb4_0900_ai_ci';
					};
				})(),
			});
			expect(report.applied).to.have.length(1);
			expect(report.remaining).to.equal(1);
			expect(report.stoppedEarly).to.equal(true);
		});

		it('disk precheck refuses when free space < largest table', async () => {
			const store = createMemoryStateStore();
			let threw = null;
			try {
				await runLinkCollationMigration({
					manifest,
					stateStore: store,
					execute: async () => {},
					verify: async () => 'utf8mb4_0900_ai_ci',
					checkDiskSpace: async () => 1024, // 1 KiB free, big table is 8 GiB
				});
			} catch (ex) {
				threw = ex;
			}
			expect(threw).to.not.equal(null);
			expect(threw.message).to.match(/Insufficient disk/);
		});
	});
});

describe('#Link Collation — per-TABLE grouping (BDL-3125)', () => {
	// Two tables: one with THREE qualifying columns, one with a single column.
	// The 3-column table is the whole point — per-column it is rebuilt 3 times.
	const row = (
		tableName,
		columnName,
		isNullable,
		totalBytes,
		collationName,
	) => ({
		tableName,
		columnName,
		collationName: collationName || 'utf8mb4_0900_ai_ci',
		columnType: 'char(36)',
		isNullable,
		tableRows: 10,
		totalBytes,
	});
	// Ordered as the generator's SQL returns them: `ORDER BY totalBytes ASC`,
	// i.e. SMALLEST TABLE FIRST, so the batch racks up quick wins and the
	// operator reaches the big/online-DDL tables last, knowingly. Grouping must
	// PRESERVE that order — asserted below.
	const multiRows = [
		row('solo', 'z', 'YES', 500),
		row('multi', 'a', 'YES', 1000),
		row('multi', 'b', 'NO', 1000),
		row('multi', 'c', 'YES', 1000, 'utf8mb4_general_ci'),
	];
	const gen = (opts) =>
		generateLinkCollationManifest({
			handle: mockHandle(multiRows),
			database: 'testdb',
			dialect,
			...opts,
		});

	it('collapses N columns of a table into ONE rebuild', async () => {
		const grouped = await gen({ groupByTable: true });
		expect(grouped.items.length).to.equal(2); // 2 tables, not 4 columns
		expect(grouped.summary.columns).to.equal(4); // still reports all 4 columns
		expect(grouped.summary.rebuilds).to.equal(2);
		const multi = grouped.items.find((i) => i.table === 'multi');
		expect(multi.columns).to.deep.equal(['a', 'b', 'c']);
		expect(multi.columnCount).to.equal(3);
	});

	it('RED ARM: ungrouped really does emit one rebuild PER COLUMN', async () => {
		// Without this arm the test above cannot distinguish "grouping works"
		// from "there was only ever one item per table".
		const flat = await gen({ groupByTable: false });
		expect(flat.items.length).to.equal(4);
		expect(flat.summary.rebuilds).to.equal(4);
		expect(flat.items.filter((i) => i.table === 'multi').length).to.equal(3);
	});

	it('emits ONE ALTER carrying every column, each with the target collation', async () => {
		const grouped = await gen({ groupByTable: true });
		const multi = grouped.items.find((i) => i.table === 'multi');
		expect(multi.alterSql).to.match(/^ALTER TABLE `multi` MODIFY /);
		// exactly three MODIFY clauses in one statement
		expect(multi.alterSql.match(/MODIFY/g).length).to.equal(3);
		['a', 'b', 'c'].forEach((col) => {
			expect(multi.alterSql).to.include(col);
		});
		expect(
			multi.alterSql.match(new RegExp(CANONICAL_UUID_COLLATION, 'g')).length,
		).to.equal(3);
		// nullability is preserved per column, not flattened
		expect(multi.alterSql).to.include('NOT NULL');
	});

	it('totalBytes counts each TABLE ONCE — the 7.2x inflation bug', async () => {
		// multi=1000 bytes (3 cols), solo=500. Correct total is 1500.
		// Summing per column would give 3*1000 + 500 = 3500.
		const [grouped, flat] = await Promise.all([
			gen({ groupByTable: true }),
			gen({ groupByTable: false }),
		]);
		[grouped, flat].forEach((m) => {
			expect(m.summary.totalBytes).to.equal(1500);
			// summing per column would give 3*1000 + 500 = 3500
			expect(m.summary.totalBytes).to.not.equal(3500);
		});
	});

	it('grouped state keys are stable regardless of column order (resumability)', async () => {
		const a = groupItemsByTable({
			items: [
				{
					table: 't',
					column: 'x',
					currentCollation: 'utf8mb4_0900_ai_ci',
					isNullable: true,
					estRows: 1,
					estDataBytes: 1,
					big: false,
				},
				{
					table: 't',
					column: 'y',
					currentCollation: 'utf8mb4_0900_ai_ci',
					isNullable: true,
					estRows: 1,
					estDataBytes: 1,
					big: false,
				},
			],
			dialect,
			targetCollation: CANONICAL_UUID_COLLATION,
			database: 'd',
			onlineTool: 'pt-osc',
		});
		expect(a[0].columns).to.deep.equal(['x', 'y']);
	});

	it('a grouped run marks the whole table complete once, and RESUMES past it', async () => {
		const manifest = await gen({ groupByTable: true });
		const store = createMemoryStateStore();
		const applied = [];
		const report = await runLinkCollationMigration({
			manifest,
			stateStore: store,
			execute: async ({ item }) => applied.push(item.table),
			verify: async ({ item }) =>
				applied.includes(item.table)
					? CANONICAL_UUID_COLLATION
					: 'utf8mb4_0900_ai_ci',
		});
		expect(report.applied.length).to.equal(2);
		// Grouping must not reshuffle: smallest-table-first survives it.
		expect(applied).to.deep.equal(['solo', 'multi']);
		// second run: everything already done, nothing re-applied
		const rerun = await runLinkCollationMigration({
			manifest,
			stateStore: store,
			execute: async () => {
				throw new Error('must not re-apply');
			},
			verify: async () => CANONICAL_UUID_COLLATION,
		});
		expect(rerun.applied.length).to.equal(0);
		expect(rerun.skipped.length).to.equal(2);
	});

	it('pt-osc command passes --preserve-triggers and a VALID alter clause', async () => {
		const grouped = await gen({ groupByTable: true, onlineTool: 'pt-osc' });
		const multi = grouped.items.find((i) => i.table === 'multi');
		// yass-orm puts a before-insert trigger on EVERY table it manages, and
		// pt-osc refuses outright on a table with triggers without this flag.
		expect(multi.onlineCommand).to.include('--preserve-triggers');
		// --alter takes the CLAUSE INCLUDING its keyword. Stripping "MODIFY "
		// produced `ALTER TABLE t col char(36)...` -> a SQL syntax error,
		// verified against pt-osc 3.7.1 on 2026-08-25.
		expect(multi.onlineCommand).to.match(/--alter="MODIFY /);
	});
});

describe('#Link Collation — allowlist (production safety, BDL-3125)', () => {
	const rows = [
		{
			tableName: 'keep_me',
			columnName: 'a',
			collationName: 'utf8mb4_0900_ai_ci',
			columnType: 'char(36)',
			isNullable: 'YES',
			tableRows: 5,
			totalBytes: 100,
		},
		{
			tableName: 'huge_log',
			columnName: 'b',
			collationName: 'utf8mb4_0900_ai_ci',
			columnType: 'char(36)',
			isNullable: 'YES',
			tableRows: 9e9,
			totalBytes: 9e12,
		},
	];
	const gen = (onlyTables) =>
		generateLinkCollationManifest({
			handle: mockHandle(rows),
			database: 'testdb',
			dialect,
			onlyTables,
		});

	it('narrows the plan to the listed tables', async () => {
		const m = await gen(['keep_me']);
		expect(m.items.map((i) => i.table)).to.deep.equal(['keep_me']);
		expect(m.summary.columns).to.equal(1);
	});

	it('RED ARM: without the allowlist the huge table IS included', async () => {
		// Without this the test above cannot tell "narrowing works" from
		// "the huge table was never in the set".
		const m = await gen(null);
		expect(m.items.map((i) => i.table).sort()).to.deep.equal([
			'huge_log',
			'keep_me',
		]);
	});

	it('CANNOT WIDEN: a name not in the schema matches nothing', async () => {
		const m = await gen(['keep_me', 'table_that_does_not_exist']);
		expect(m.items.map((i) => i.table)).to.deep.equal(['keep_me']);
	});

	it('an EMPTY allowlist migrates NOTHING — never "no filter"', async () => {
		const m = await gen([]);
		expect(m.items.length).to.equal(0);
	});
});
