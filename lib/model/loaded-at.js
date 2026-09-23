/**
 * LOADED_AT: when the data an instance holds was read, on this process's
 * monotonic clock (`performance.now()`), so a cache can refuse data older than
 * an invalidation it received (the bus design, 7.3). A hidden property: not
 * enumerable, so it stays out of Object.keys, spreads and JSON.
 *
 * - A read: when its query was issued; inside a transaction, when the
 *   transaction started (its snapshot can be that old).
 * - A write: when it completed; inside a transaction, when it committed.
 *
 * `Symbol.for`, so every copy of yass in a process uses the same symbol.
 */
const { performance } = require('node:perf_hooks');
const { transactionStartedAt } = require('../transactions');

const LOADED_AT = Symbol.for('yass-orm.loadedAt');

/** The stamp for a read issued now, on `tx` (any value) or outside one. */
const readIssuedAt = (tx) => transactionStartedAt(tx) ?? performance.now();

const stampLoadedAt = (instance, loadedAt = performance.now()) => {
	Object.defineProperty(instance, LOADED_AT, {
		value: loadedAt,
		writable: true,
		configurable: true,
		enumerable: false,
	});
};

module.exports = { LOADED_AT, readIssuedAt, stampLoadedAt };
