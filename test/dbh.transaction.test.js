/* global describe, it, before, after, beforeEach */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const {
	dbh,
	closeAllConnections,
	FIND_OR_CREATE_META,
} = require('../lib/dbh');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const tempFile = path.join('/tmp', `yass-transactions-${process.pid}.sqlite`);

describe('dbh transactions', () => {
	let conn;

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});
	});

	beforeEach(async () => {
		await conn.query('DROP TABLE IF EXISTS transaction_items');
		await conn.query(
			'CREATE TABLE transaction_items (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
		);
	});

	after(async () => {
		await closeAllConnections();
		try {
			fs.unlinkSync(tempFile);
		} catch (err) {
			/* ignore */
		}
	});

	it('commits and returns the callback value', async () => {
		const result = await conn.transaction(async (tx) => {
			await tx.pquery(
				'INSERT INTO transaction_items (id, value) VALUES (:id, :value)',
				{ id: 'committed', value: 'yes' },
			);
			const uncommittedRows = await tx.roQuery(
				'SELECT value FROM transaction_items WHERE id = :id',
				{ id: 'committed' },
			);
			expect(uncommittedRows).to.deep.equal([{ value: 'yes' }]);
			return { ok: true };
		});

		expect(result).to.deep.equal({ ok: true });
		const rows = await conn.pquery(
			'SELECT value FROM transaction_items WHERE id = :id',
			{ id: 'committed' },
		);
		expect(rows).to.deep.equal([{ value: 'yes' }]);
	});

	it('rolls back when the callback throws and rethrows the same error', async () => {
		const expected = new Error('abort this unit of work');
		let caught;

		try {
			await conn.transaction(async (tx) => {
				await tx.pquery(
					'INSERT INTO transaction_items (id, value) VALUES (:id, :value)',
					{ id: 'rolled-back', value: 'no' },
				);
				throw expected;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(expected);
		const rows = await conn.pquery(
			'SELECT * FROM transaction_items WHERE id = :id',
			{ id: 'rolled-back' },
		);
		expect(rows).to.deep.equal([]);
	});

	it('exposes the full dbh helper surface on the pinned transaction handle', async () => {
		await conn.transaction(async (tx) => {
			const created = await tx.create('transaction_items', {
				id: 'helper',
				value: 'created',
			});
			expect(created.value).to.equal('created');
			await tx.patch('transaction_items', 'helper', { value: 'patched' });
		});

		const row = await conn.get('transaction_items', 'helper');
		expect(row.value).to.equal('patched');
	});

	it('uses savepoints for nested transactions', async () => {
		await conn.transaction(async (tx) => {
			await tx.create('transaction_items', { id: 'outer', value: 'kept' });

			try {
				await tx.transaction(async (nestedTx) => {
					await nestedTx.create('transaction_items', {
						id: 'inner',
						value: 'discarded',
					});
					throw new Error('rollback savepoint only');
				});
			} catch (err) {
				expect(err.message).to.equal('rollback savepoint only');
			}

			await tx.create('transaction_items', { id: 'outer-2', value: 'kept' });
		});

		const rows = await conn.pquery(
			'SELECT id FROM transaction_items ORDER BY id',
		);
		expect(rows).to.deep.equal([{ id: 'outer' }, { id: 'outer-2' }]);
	});

	it('commits successful nested savepoints and returns their values', async () => {
		const nestedValue = await conn.transaction(async (tx) =>
			tx.transaction(async (nestedTx) => {
				await nestedTx.create('transaction_items', {
					id: 'nested-success',
					value: 'kept',
				});
				return 'nested-result';
			}),
		);

		expect(nestedValue).to.equal('nested-result');
		expect(await conn.get('transaction_items', 'nested-success')).to.include({
			value: 'kept',
		});
	});

	it('rejects nested isolation overrides without aborting caught outer work', async () => {
		await conn.transaction(async (tx) => {
			let nestedCalled = false;
			try {
				await tx.transaction(
					async () => {
						nestedCalled = true;
					},
					{ isolationLevel: 'serializable' },
				);
			} catch (err) {
				expect(err.message).to.include('inherited from the outer transaction');
			}
			expect(nestedCalled).to.equal(false);
			await tx.create('transaction_items', {
				id: 'outer-after-rejection',
				value: 'committed',
			});
		});

		expect(await conn.get('transaction_items', 'outer-after-rejection')).to
			.exist;
	});

	it('serializes concurrent transactions on SQLite single connections', async () => {
		const events = [];
		await Promise.all([
			conn.transaction(async (tx) => {
				events.push('first:start');
				await new Promise((resolve) => setImmediate(resolve));
				await tx.create('transaction_items', { id: 'first', value: 'one' });
				events.push('first:end');
			}),
			conn.transaction(async (tx) => {
				events.push('second:start');
				await tx.create('transaction_items', { id: 'second', value: 'two' });
				events.push('second:end');
			}),
		]);

		expect(events).to.deep.equal([
			'first:start',
			'first:end',
			'second:start',
			'second:end',
		]);
	});

	it('keeps concurrent non-transaction SQLite queries outside the active transaction', async () => {
		let outsideWrite;
		try {
			await conn.transaction(async (tx) => {
				await tx.create('transaction_items', {
					id: 'inside-rollback',
					value: 'discarded',
				});
				outsideWrite = conn.create('transaction_items', {
					id: 'outside-commit',
					value: 'kept',
				});
				await new Promise((resolve) => setImmediate(resolve));
				throw new Error('rollback only the pinned work');
			});
		} catch (err) {
			expect(err.message).to.equal('rollback only the pinned work');
		}

		await outsideWrite;
		const rows = await conn.pquery(
			'SELECT id FROM transaction_items ORDER BY id',
		);
		expect(rows).to.deep.equal([{ id: 'outside-commit' }]);
	});

	it('supports SQLite isolation options and restores connection state', async () => {
		const before = await conn.pquery('PRAGMA read_uncommitted');

		await conn.transaction(
			async (tx) => {
				const during = await tx.pquery('PRAGMA read_uncommitted');
				expect(during[0].read_uncommitted).to.equal(1);
			},
			{ isolationLevel: 'read uncommitted', mode: 'immediate' },
		);

		const after = await conn.pquery('PRAGMA read_uncommitted');
		expect(after).to.deep.equal(before);
	});

	it('enforces and restores SQLite read-only mode', async () => {
		const cap = captureConsoleError.install();
		let caught;
		try {
			await conn.transaction(
				(tx) =>
					tx.create('transaction_items', {
						id: 'read-only-rejected',
						value: 'no',
					}),
				{ readOnly: true },
			);
		} catch (err) {
			caught = err;
		} finally {
			cap.restore();
		}
		expect(caught).to.be.an.instanceof(Error);
		expect(await conn.get('transaction_items', 'read-only-rejected')).to.equal(
			null,
		);

		await conn.create('transaction_items', {
			id: 'write-after-read-only',
			value: 'works',
		});
		expect(await conn.get('transaction_items', 'write-after-read-only')).to
			.exist;
	});

	it('rejects unsupported isolation levels before invoking the callback', async () => {
		let called = false;
		let caught;
		try {
			await conn.transaction(
				async () => {
					called = true;
				},
				{ isolationLevel: 'repeatable read' },
			);
		} catch (err) {
			caught = err;
		}

		expect(called).to.equal(false);
		expect(caught.message).to.include('repeatable read');
		expect(caught.message).to.include('sqlite');
	});

	it('can retry retryable serialization/lock failures when explicitly requested', async () => {
		let attempts = 0;
		const value = await conn.transaction(
			async () => {
				attempts += 1;
				if (attempts === 1) {
					const err = new Error('database is busy');
					err.code = 'SQLITE_BUSY';
					throw err;
				}
				return 'retried';
			},
			{ maxRetries: 1 },
		);

		expect(value).to.equal('retried');
		expect(attempts).to.equal(2);
	});

	describe('findOrCreate transaction integration', () => {
		it('serializes concurrent callers and creates only one matching row', async () => {
			const [first, second] = await Promise.all([
				conn.findOrCreate('transaction_items', {
					id: 'same-row',
					value: 'same-value',
				}),
				conn.findOrCreate('transaction_items', {
					id: 'same-row',
					value: 'same-value',
				}),
			]);

			expect(first).to.deep.equal(second);
			const rows = await conn.pquery(
				'SELECT * FROM transaction_items WHERE id = :id',
				{ id: 'same-row' },
			);
			expect(rows).to.have.length(1);
		});

		it('runs atomically by default with safe dialect defaults', async () => {
			const originalTransaction = conn.transaction;
			let transactionOptions;
			conn.transaction = function instrumentedTransaction(callback, options) {
				transactionOptions = options;
				return originalTransaction.call(this, callback, options);
			};

			try {
				const row = await conn.findOrCreate('transaction_items', {
					id: 'automatic',
					value: 'transactional',
				});
				expect(row.value).to.equal('transactional');
				expect(transactionOptions).to.deep.equal({
					mode: 'immediate',
					maxRetries: 2,
				});
			} finally {
				conn.transaction = originalTransaction;
			}
		});

		it('passes caller transaction option overrides through unchanged', async () => {
			const originalTransaction = conn.transaction;
			let receivedOptions;
			conn.transaction = function instrumentedTransaction(callback, options) {
				receivedOptions = options;
				return originalTransaction.call(this, callback, options);
			};

			try {
				await conn.findOrCreate(
					'transaction_items',
					{ id: 'custom-options', value: 'custom' },
					{},
					{},
					{
						transactionOptions: {
							mode: 'exclusive',
							maxRetries: 0,
						},
					},
				);
				expect(receivedOptions).to.deep.equal({
					mode: 'exclusive',
					maxRetries: 0,
				});
			} finally {
				conn.transaction = originalTransaction;
			}
		});

		it('keeps patch metadata on the specific returned row', async () => {
			await conn.create('transaction_items', {
				id: 'metadata',
				value: 'before',
			});
			const row = await conn.findOrCreate(
				'transaction_items',
				{ id: 'metadata' },
				{ value: 'after' },
			);

			expect(row.value).to.equal('after');
			expect(row[FIND_OR_CREATE_META]).to.deep.equal({
				lastAction: 'patch',
				wasCreated: false,
				lastPatch: { value: 'after' },
			});
		});

		it('rolls back a newly-created row if a later patchIf step fails', async () => {
			const cap = captureConsoleError.install();
			let caught;
			try {
				await conn.findOrCreate(
					'transaction_items',
					{ id: 'atomic-failure', value: 'created-first' },
					{ missingColumn: 'patch-fails' },
					{},
					{ silenceErrors: true },
				);
			} catch (err) {
				caught = err;
			} finally {
				cap.restore();
			}

			expect(caught).to.be.an.instanceof(Error);
			const rows = await conn.pquery(
				'SELECT * FROM transaction_items WHERE id = :id',
				{ id: 'atomic-failure' },
			);
			expect(rows).to.deep.equal([]);
		});

		it('allows callers to opt out through the existing options object', async () => {
			const originalTransaction = conn.transaction;
			let transactionCalled = false;
			conn.transaction = function instrumentedTransaction(...args) {
				transactionCalled = true;
				return originalTransaction.apply(this, args);
			};

			try {
				const row = await conn.findOrCreate(
					'transaction_items',
					{ id: 'opt-out', value: 'legacy-path' },
					{},
					{},
					{ useTransaction: false },
				);
				expect(row.id).to.equal('opt-out');
				expect(transactionCalled).to.equal(false);
			} finally {
				conn.transaction = originalTransaction;
			}
		});
	});
});
