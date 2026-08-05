/* global describe, it, beforeEach */
const { expect } = require('chai');

const { getDialect } = require('../lib/dbh');
const {
	generateLinkCollationManifest,
	runLinkCollationMigration,
	createMemoryStateStore,
	CANONICAL_UUID_COLLATION,
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
