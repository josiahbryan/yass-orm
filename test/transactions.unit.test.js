/* global describe, it */
const { expect } = require('chai');
const {
	isRetryableTransactionError,
	runTransaction,
} = require('../lib/transactions');

function createHarness(overrides = {}) {
	const events = [];
	const connection = {
		query: async (sql) => {
			events.push(`query:${sql}`);
			return [{ source: 'leased' }];
		},
	};
	const dialect = {
		normalizeTransactionOptions: (options) => options,
		acquireTransactionConnection: async () => {
			events.push('acquire');
			return {
				connection,
				release: async () => events.push('release'),
			};
		},
		beginTransaction: async () => events.push('begin'),
		commitTransaction: async () => events.push('commit'),
		rollbackTransaction: async () => events.push('rollback'),
		cleanupTransaction: async () => events.push('cleanup'),
		...overrides,
	};
	const parent = {
		dialect,
		query: async () => {
			throw new Error('parent query must not be used');
		},
		pquery(sql) {
			return this.query(sql);
		},
		roQuery: async () => {
			throw new Error('read replica must not be used');
		},
		transaction(callback, options) {
			return runTransaction(this, callback, options);
		},
	};

	return { connection, dialect, events, parent };
}

describe('transaction lifecycle unit coverage', () => {
	it('pins roQuery to the leased connection and runs lifecycle in order', async () => {
		const { events, parent } = createHarness();
		const result = await runTransaction(parent, async (tx) => {
			const rows = await tx.roQuery('SELECT uncommitted');
			expect(rows).to.deep.equal([{ source: 'leased' }]);
			return 42;
		});

		expect(result).to.equal(42);
		expect(events).to.deep.equal([
			'acquire',
			'begin',
			'query:SELECT uncommitted',
			'commit',
			'cleanup',
			'release',
		]);
	});

	it('rolls back callback errors, cleans up, releases, and preserves identity', async () => {
		const { events, parent } = createHarness();
		const expected = new Error('callback failed');
		let caught;
		try {
			await runTransaction(parent, async () => {
				throw expected;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(expected);
		expect(events).to.deep.equal([
			'acquire',
			'begin',
			'rollback',
			'cleanup',
			'release',
		]);
	});

	it('releases after BEGIN failure without issuing rollback', async () => {
		const expected = new Error('begin failed');
		const { events, parent } = createHarness({
			beginTransaction: async () => {
				events.push('begin');
				throw expected;
			},
		});

		let caught;
		try {
			await runTransaction(parent, async () => 'never called');
		} catch (err) {
			caught = err;
		}
		expect(caught).to.equal(expected);
		expect(events).to.deep.equal(['acquire', 'begin', 'cleanup', 'release']);
	});

	it('attempts rollback when COMMIT fails', async () => {
		const expected = new Error('commit failed');
		const { events, parent } = createHarness({
			commitTransaction: async () => {
				events.push('commit');
				throw expected;
			},
		});

		let caught;
		try {
			await runTransaction(parent, async () => 'done');
		} catch (err) {
			caught = err;
		}
		expect(caught).to.equal(expected);
		expect(events).to.deep.equal([
			'acquire',
			'begin',
			'commit',
			'rollback',
			'cleanup',
			'release',
		]);
	});

	it('attaches rollback and cleanup errors without masking callback failure', async () => {
		const primary = new Error('primary');
		const rollbackError = new Error('rollback');
		const cleanupError = new Error('cleanup');
		const { parent } = createHarness({
			rollbackTransaction: async () => {
				throw rollbackError;
			},
			cleanupTransaction: async () => {
				throw cleanupError;
			},
		});

		let caught;
		try {
			await runTransaction(parent, async () => {
				throw primary;
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).to.equal(primary);
		expect(caught.rollbackError).to.equal(rollbackError);
		expect(caught.cleanupError).to.equal(cleanupError);
	});

	it('validates callback, option object, and retry count before acquiring', async () => {
		const { events, parent } = createHarness();
		for (const invoke of [
			() => runTransaction(parent, null),
			() => runTransaction(parent, async () => {}, null),
			() => runTransaction(parent, async () => {}, { maxRetries: -1 }),
			() => runTransaction(parent, async () => {}, { maxRetries: 1.5 }),
		]) {
			let caught;
			try {
				await invoke();
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an.instanceof(TypeError);
		}
		expect(events).to.deep.equal([]);
	});

	it('recognizes retryable driver codes through wrapped causes', () => {
		expect(
			isRetryableTransactionError({ cause: { code: '40001' } }),
		).to.equal(true);
		expect(isRetryableTransactionError({ errno: 1213 })).to.equal(true);
		expect(isRetryableTransactionError({ code: 'SQLITE_BUSY_TIMEOUT' })).to
			.equal(true);
		expect(isRetryableTransactionError({ code: '23505' })).to.equal(false);
	});

	it('does not retry a callback after commit when release fails', async () => {
		const harness = createHarness();
		const releaseError = new Error('release failed after commit');
		releaseError.code = '40001';
		harness.dialect.acquireTransactionConnection = async () => {
			harness.events.push('acquire');
			return {
				connection: harness.connection,
				release: async () => {
					harness.events.push('release');
					throw releaseError;
				},
			};
		};
		let callbacks = 0;
		let caught;
		try {
			await runTransaction(
				harness.parent,
				async () => {
					callbacks += 1;
				},
				{ maxRetries: 2 },
			);
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(releaseError);
		expect(callbacks).to.equal(1);
		expect(harness.events.filter((event) => event === 'commit')).to.have.length(
			1,
		);
	});

	it('does not retry ordinary application errors', async () => {
		const { parent } = createHarness();
		let callbacks = 0;
		let caught;
		try {
			await runTransaction(
				parent,
				async () => {
					callbacks += 1;
					throw new Error('validation failed');
				},
				{ maxRetries: 3 },
			);
		} catch (err) {
			caught = err;
		}
		expect(caught.message).to.equal('validation failed');
		expect(callbacks).to.equal(1);
	});
});
