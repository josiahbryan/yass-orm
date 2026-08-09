/* eslint-disable no-console */
/* global describe, it */
const { expect } = require('chai');
const {
	resolvePhysicalIndexName,
	fitIdentifierToLimit,
} = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { PostgresDialect } = require('../lib/dialects/PostgresDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');

// MySQL scopes index names to their table: `users.idx_status` and
// `orders.idx_status` coexist happily. Postgres does NOT -- an index is a relation
// in pg_class, unique per schema -- so the second table to declare `idx_status`
// fails outright with `relation "idx_status" already exists`. Since names like
// `idx_status` / `idx_email` are exactly the ones people reuse across tables, a
// schema that is fine on MySQL breaks on Postgres.
//
// So on Postgres the declared name is prefixed with the table name,
// deterministically. This extends the convention yass-orm already used for its
// automatic `isDeleted` index.
describe('#schemaSync index-name scoping', () => {
	const mysql = new MySQLDialect();
	const postgres = new PostgresDialect();
	const sqlite = new SQLiteDialect();

	describe('dialect capability', () => {
		it('prefixes on Postgres only', () => {
			expect(postgres.prefixIndexNamesWithTable).to.equal(true);
			// MySQL index names are already table-scoped -- prefixing would be noise.
			expect(mysql.prefixIndexNamesWithTable).to.equal(false);
			// SQLite names ARE database-global, but prefixing them would rename the
			// indexes of every existing SQLite database for a collision that has not
			// been reported there. Postgres has no such installed base.
			expect(sqlite.prefixIndexNamesWithTable).to.equal(false);
		});

		it('reports the identifier length limit where the server truncates', () => {
			// Postgres truncates past NAMEDATALEN-1 with only a NOTICE.
			expect(postgres.maxIdentifierLength).to.equal(63);
			expect(mysql.maxIdentifierLength).to.equal(64);
		});
	});

	describe('resolvePhysicalIndexName()', () => {
		it('prefixes the table name on Postgres', () => {
			expect(
				resolvePhysicalIndexName('idx_status', 'users', postgres),
			).to.equal('users_idx_status');
		});

		it('is deterministic -- the same inputs always give the same name', () => {
			const first = resolvePhysicalIndexName('idx_status', 'users', postgres);
			const second = resolvePhysicalIndexName('idx_status', 'users', postgres);
			expect(first).to.equal(second);
		});

		it('gives DIFFERENT names to the same index name on different tables', () => {
			// The whole point: this is the collision that used to fail.
			expect(
				resolvePhysicalIndexName('idx_status', 'users', postgres),
			).to.not.equal(
				resolvePhysicalIndexName('idx_status', 'orders', postgres),
			);
		});

		it('leaves MySQL and SQLite names untouched', () => {
			expect(resolvePhysicalIndexName('idx_status', 'users', mysql)).to.equal(
				'idx_status',
			);
			expect(resolvePhysicalIndexName('idx_status', 'users', sqlite)).to.equal(
				'idx_status',
			);
		});

		it('does not double-prefix an already-scoped name (idempotent)', () => {
			// Matters because the automatic isDeleted index is already declared as
			// `<table>_isDeleted`, and because applying this twice must be a no-op.
			expect(
				resolvePhysicalIndexName('users_isDeleted', 'users', postgres),
			).to.equal('users_isDeleted');
			const once = resolvePhysicalIndexName('idx_status', 'users', postgres);
			expect(resolvePhysicalIndexName(once, 'users', postgres)).to.equal(once);
		});

		it('tolerates a missing dialect', () => {
			expect(
				resolvePhysicalIndexName('idx_status', 'users', undefined),
			).to.equal('idx_status');
		});

		// Postgres SILENTLY truncates an identifier past 63 characters -- it emits a
		// NOTICE, not an error. That is a churn trap: schema-sync would ask for the
		// long name, the catalog would report the truncated one, the lookup would miss,
		// and the index would be recreated on every single sync.
		describe('length limit', () => {
			const longTable = `t_${'x'.repeat(50)}`; // 52 chars

			it('keeps the result within the limit', () => {
				const name = resolvePhysicalIndexName(
					'idx_a_rather_long_index_name',
					longTable,
					postgres,
				);
				expect(name.length).to.be.at.most(63);
			});

			it('is still deterministic when truncated', () => {
				const a = resolvePhysicalIndexName(
					'idx_long_name_here',
					longTable,
					postgres,
				);
				const b = resolvePhysicalIndexName(
					'idx_long_name_here',
					longTable,
					postgres,
				);
				expect(a).to.equal(b);
			});

			it('keeps two long names distinct despite a shared prefix', () => {
				// Plain truncation would collapse these into one name, and the second
				// CREATE INDEX would fail as a duplicate.
				const a = resolvePhysicalIndexName(
					'idx_identical_prefix_but_ending_one',
					longTable,
					postgres,
				);
				const b = resolvePhysicalIndexName(
					'idx_identical_prefix_but_ending_two',
					longTable,
					postgres,
				);
				expect(a).to.not.equal(b);
				expect(a.length).to.be.at.most(63);
				expect(b.length).to.be.at.most(63);
			});
		});
	});

	describe('fitIdentifierToLimit()', () => {
		it('leaves a short identifier alone', () => {
			expect(fitIdentifierToLimit('short_name', 63)).to.equal('short_name');
		});

		it('leaves anything alone when there is no limit', () => {
			const long = 'x'.repeat(200);
			expect(fitIdentifierToLimit(long, undefined)).to.equal(long);
		});

		it('truncates to exactly the limit', () => {
			expect(fitIdentifierToLimit('y'.repeat(100), 63)).to.have.lengthOf(63);
		});

		it('derives the suffix from the FULL name, so near-identical names differ', () => {
			const a = fitIdentifierToLimit(`${'z'.repeat(80)}_alpha`, 63);
			const b = fitIdentifierToLimit(`${'z'.repeat(80)}_beta`, 63);
			expect(a).to.not.equal(b);
		});
	});
});
