/* eslint-disable no-console */
/* global describe, it, before, after, beforeEach, afterEach */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');
const { isUniqueViolation, isConstraintError } = require('../lib/utils');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const tempFile = path.join('/tmp', `yass-idempotent-${process.pid}.sqlite`);

describe('createIgnore and upsert (atomic at-most-once / on-dup primitives)', () => {
	let conn;
	let cap;

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});
	});

	beforeEach(async () => {
		// Fresh table per test — kills inter-test ordering dependencies and
		// keeps `--grep` runs of a single test working.
		await conn.query('DROP TABLE IF EXISTS drop_log');
		await conn.query(`
			CREATE TABLE drop_log (
				id TEXT PRIMARY KEY,
				tenant TEXT NOT NULL,
				user TEXT NOT NULL,
				sourceKey TEXT NOT NULL,
				itemId TEXT NOT NULL,
				count INTEGER DEFAULT 1,
				UNIQUE (tenant, user, sourceKey, itemId),
				CHECK (count >= 0)
			)
		`);
		cap = captureConsoleError.install();
	});
	afterEach(() => {
		cap.restore();
	});

	after(async () => {
		await closeAllConnections();
		try {
			fs.unlinkSync(tempFile);
		} catch (err) {
			/* ignore */
		}
	});

	// ====================================================================
	// createIgnore
	// ====================================================================

	describe('conn.createIgnore', () => {
		it('Happy path: returns the row when no conflict exists', async () => {
			const row = await conn.createIgnore('drop_log', {
				id: 'log_001',
				tenant: 'acme',
				user: 'u1',
				sourceKey: 'milestone_a',
				itemId: 'item-a',
			});
			expect(row).to.exist;
			expect(row.id).to.equal('log_001');
			expect(row.itemId).to.equal('item-a');
			expect(cap.loudCount()).to.equal(0);
		});

		it('Sad path: returns null on UNIQUE conflict (no throw, no console noise)', async () => {
			// Seed THIS test's conflict — don't depend on a sibling test.
			await conn.createIgnore('drop_log', {
				id: 'log_seed',
				tenant: 'acme',
				user: 'u1',
				sourceKey: 'milestone_a',
				itemId: 'item-a',
			});

			const row = await conn.createIgnore('drop_log', {
				id: 'log_conflict',
				tenant: 'acme',
				user: 'u1',
				sourceKey: 'milestone_a',
				itemId: 'item-a', // conflicts on the composite UNIQUE
			});
			expect(row).to.equal(null);
			expect(cap.loudCount()).to.equal(0);
		});

		it('Happy path: re-firing same milestone for different user inserts cleanly', async () => {
			await conn.createIgnore('drop_log', {
				id: 'log_u1',
				tenant: 'acme',
				user: 'u1',
				sourceKey: 'milestone_a',
				itemId: 'item-a',
			});
			const row = await conn.createIgnore('drop_log', {
				id: 'log_u2',
				tenant: 'acme',
				user: 'u2', // different user
				sourceKey: 'milestone_a',
				itemId: 'item-a',
			});
			expect(row).to.exist;
			expect(row.id).to.equal('log_u2');
		});

		it('Sad path: real errors (table missing) still throw — only dup-key is swallowed', async () => {
			let thrown;
			try {
				await conn.createIgnore('nonexistent_table', { id: 'x' });
			} catch (err) {
				thrown = err;
			}
			expect(thrown).to.be.an.instanceof(Error);
			expect(thrown.cause).to.exist;
		});

		it('Sad path: CHECK violations still throw (not swallowed like INSERT IGNORE would do)', async () => {
			// The table has CHECK (count >= 0). A negative count should THROW,
			// not silently no-op — that's the regression vs. MySQL's INSERT IGNORE.
			let thrown;
			try {
				await conn.createIgnore('drop_log', {
					id: 'log_check',
					tenant: 'acme',
					user: 'u1',
					sourceKey: 'milestone_a',
					itemId: 'item-check',
					count: -1, // violates CHECK
				});
			} catch (err) {
				thrown = err;
			}
			expect(thrown, 'CHECK violation must throw').to.be.an.instanceof(Error);
			expect(isUniqueViolation(thrown)).to.equal(false);
			expect(isConstraintError(thrown)).to.equal(true);
		});

		it('Sad path: NOT NULL violations still throw', async () => {
			let thrown;
			try {
				// `tenant` is NOT NULL — omit it.
				await conn.createIgnore('drop_log', {
					id: 'log_nn',
					user: 'u1',
					sourceKey: 'milestone_a',
					itemId: 'item-nn',
				});
			} catch (err) {
				thrown = err;
			}
			expect(thrown, 'NOT NULL violation must throw').to.be.an.instanceof(Error);
			expect(isUniqueViolation(thrown)).to.equal(false);
		});
	});

	// ====================================================================
	// upsert
	// ====================================================================

	describe('conn.upsert', () => {
		it('Happy path: inserts when no conflict exists', async () => {
			const row = await conn.upsert(
				'drop_log',
				{
					id: 'log_100',
					tenant: 'acme',
					user: 'u3',
					sourceKey: 'milestone_b',
					itemId: 'item-b',
					count: 1,
				},
				{
					conflictColumns: ['tenant', 'user', 'sourceKey', 'itemId'],
					onDuplicate: { count: 'count + 1' },
				},
			);
			expect(row).to.exist;
			expect(row.id).to.equal('log_100');
			expect(row.count).to.equal(1);
			expect(cap.loudCount()).to.equal(0);
		});

		it('Happy path: updates existing row on conflict (raw-SQL form)', async () => {
			// Seed the row first.
			await conn.upsert(
				'drop_log',
				{
					id: 'log_seed_100',
					tenant: 'acme',
					user: 'u3',
					sourceKey: 'milestone_b',
					itemId: 'item-b',
					count: 1,
				},
				{
					conflictColumns: ['tenant', 'user', 'sourceKey', 'itemId'],
					onDuplicate: { count: 'count + 1' },
				},
			);

			const row = await conn.upsert(
				'drop_log',
				{
					id: 'log_bump',
					tenant: 'acme',
					user: 'u3',
					sourceKey: 'milestone_b',
					itemId: 'item-b',
					count: 1,
				},
				{
					conflictColumns: ['tenant', 'user', 'sourceKey', 'itemId'],
					onDuplicate: { count: 'count + 1' },
				},
			);
			expect(row.id).to.equal('log_seed_100'); // pre-existing row wins
			expect(row.count).to.equal(2);
			expect(cap.loudCount()).to.equal(0);
		});

		it('Happy path: updates existing row using the safe array form (copy-from-values)', async () => {
			await conn.upsert(
				'drop_log',
				{
					id: 'log_array_seed',
					tenant: 'acme',
					user: 'u4',
					sourceKey: 'milestone_c',
					itemId: 'item-c',
					count: 5,
				},
				{
					conflictColumns: ['tenant', 'user', 'sourceKey', 'itemId'],
					onDuplicate: ['count'],
				},
			);

			const row = await conn.upsert(
				'drop_log',
				{
					id: 'log_array_bump',
					tenant: 'acme',
					user: 'u4',
					sourceKey: 'milestone_c',
					itemId: 'item-c',
					count: 99, // copied to the row
				},
				{
					conflictColumns: ['tenant', 'user', 'sourceKey', 'itemId'],
					onDuplicate: ['count'],
				},
			);
			expect(row.count).to.equal(99);
		});

		it('Sad path: missing conflictColumns on dialects that require them throws clearly', async () => {
			let thrown;
			try {
				await conn.upsert(
					'drop_log',
					{
						id: 'log_no_conflict',
						tenant: 'acme',
						user: 'u9',
						sourceKey: 'x',
						itemId: 'y',
					},
					{ onDuplicate: { count: 'count + 1' } }, // no conflictColumns
				);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).to.be.an.instanceof(Error);
			expect(thrown.message).to.match(/conflictColumns/i);
		});

		it('Sad path: missing onDuplicate throws', async () => {
			let thrown;
			try {
				await conn.upsert(
					'drop_log',
					{
						id: 'log_no_od',
						tenant: 'acme',
						user: 'u',
						sourceKey: 'x',
						itemId: 'y',
					},
					{ conflictColumns: ['tenant', 'user', 'sourceKey', 'itemId'] },
				);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).to.be.an.instanceof(Error);
			expect(thrown.message).to.match(/onDuplicate/i);
		});
	});

	// ====================================================================
	// isUniqueViolation / isConstraintError helpers
	// ====================================================================

	describe('isUniqueViolation / isConstraintError', () => {
		it('Happy path: recognizes a UNIQUE-violation thrown by pquery via .cause', async () => {
			await conn.pquery(
				'INSERT INTO drop_log (id, tenant, user, sourceKey, itemId) VALUES (:id, :t, :u, :s, :i)',
				{ id: 'uv1', t: 'acme', u: 'u', s: 'x', i: 'y' },
			);

			let thrown;
			await captureConsoleError.during(async () => {
				try {
					await conn.pquery(
						'INSERT INTO drop_log (id, tenant, user, sourceKey, itemId) VALUES (:id, :t, :u, :s, :i)',
						{ id: 'uv2', t: 'acme', u: 'u', s: 'x', i: 'y' },
					);
				} catch (err) {
					thrown = err;
				}
			});
			expect(isUniqueViolation(thrown)).to.equal(true);
			expect(isConstraintError(thrown)).to.equal(true);
		});

		it('Sad path: returns false for non-DB errors', () => {
			expect(isUniqueViolation(new Error('plain'))).to.equal(false);
			expect(isUniqueViolation('not an error')).to.equal(false);
			expect(isUniqueViolation(null)).to.equal(false);
			expect(isUniqueViolation(undefined)).to.equal(false);
			expect(isConstraintError(new Error('plain'))).to.equal(false);
		});

		it('Sad path: returns false for a successful (no error) path', () => {
			// We never call these on success, but the contract is "boolean", so
			// passing non-error inputs must return false without throwing.
			expect(isUniqueViolation({})).to.equal(false);
			expect(isConstraintError({})).to.equal(false);
		});

		it('Recognizes synthetic MySQL/Postgres signatures by structured fields', () => {
			// MySQL/MariaDB
			expect(isUniqueViolation({ code: 'ER_DUP_ENTRY' })).to.equal(true);
			expect(isUniqueViolation({ errno: 1062 })).to.equal(true);
			expect(isUniqueViolation({ sqlState: '23000' })).to.equal(true);
			// Postgres
			expect(isUniqueViolation({ sqlState: '23505' })).to.equal(true);
			// Walks .cause
			expect(
				isUniqueViolation({ cause: { code: 'SQLITE_CONSTRAINT_UNIQUE' } }),
			).to.equal(true);
			// NOT a unique violation, but IS a constraint error (CHECK).
			expect(
				isUniqueViolation({ code: 'SQLITE_CONSTRAINT_CHECK' }),
			).to.equal(false);
			expect(
				isConstraintError({ code: 'SQLITE_CONSTRAINT_CHECK' }),
			).to.equal(true);
		});
	});
});
