/**
 * Change hooks. Two kinds, their lists on globalThis (lib/globals.js), so two
 * copies of yass share them:
 *   - global change hooks: called after every successful create() or patch()
 *     (and so remove(), a soft-delete patch); inside a transaction, before it
 *     commits;
 *   - committed change hooks: the same changes, plus reallyDelete(), once they
 *     are committed: at once outside a transaction, after COMMIT inside one,
 *     never after a rollback.
 */
const {
	globalChangeHooks: GLOBAL_CHANGE_HOOKS,
	committedChangeHooks: COMMITTED_CHANGE_HOOKS,
} = require('../globals');
const { onTransactionEnd, transactionLocal } = require('../transactions');

// transactionLocal key: a transaction's committed changes, in order.
const COMMITTED_BATCH_KEY = Symbol('yass-orm committed changes');

/**
 * Keys that yass-orm manages automatically.  They must never appear in the
 * `changedFields` payload emitted to hooks because consumers shouldn't treat
 * them as user-driven field changes.
 */
const MANAGED_KEYS = new Set(['updatedAt', 'createdAt', 'nonce']);

/**
 * Return a copy of `obj` with ORM-managed keys and the model's own id field
 * removed.  `obj` must already be deflated (DB-level scalars).
 * @param {Object} obj  Deflated field map
 * @param {string} idField  Name of the primary-key field for this model
 * @returns {Object}
 */
function stripManagedKeys(obj, idField) {
	return Object.keys(obj || {}).reduce((out, k) => {
		if (!MANAGED_KEYS.has(k) && k !== idField) {
			// eslint-disable-next-line no-param-reassign
			out[k] = obj[k];
		}
		return out;
	}, {});
}

function addHook(hooks, fn) {
	hooks.push(fn);
	return function unregister() {
		const i = hooks.indexOf(fn);
		if (i >= 0) hooks.splice(i, 1);
	};
}

/**
 * Register a function that will be called after every successful `create()`
 * or `patch()` (and therefore `remove()`, which is a soft-delete patch).
 *
 * The hook receives:
 *   { modelName: string, id: string|number, changedFields: Object, wasCreated: boolean, tx }
 *
 * - Inside a transaction it runs BEFORE the commit (the write may still roll
 *   back), with the write's `tx`; see registerCommittedChangeHook for after.
 * - `modelName` is the table name returned by `Model.table()`.
 * - `changedFields` contains DB-level (deflated) values; ORM-managed keys
 *   (`updatedAt`, `createdAt`, `nonce`) and the id field are stripped out.
 * - On create, `changedFields` covers the full created entity (including
 *   default-valued fields), not just the props passed to `create()`.
 *
 * @param {Function} fn  Hook function (may be async)
 * @returns {Function}   Call to unregister the hook
 */
function registerGlobalChangeHook(fn) {
	return addHook(GLOBAL_CHANGE_HOOKS, fn);
}

/**
 * Register a function called once a change is committed: at once for a write
 * outside a transaction, after COMMIT for one inside a transaction (in the
 * order the transaction made them), never after a rollback. The changes are
 * those of `registerGlobalChangeHook`, plus `reallyDelete()` (a hard delete):
 *   { modelName, id, changedFields, wasCreated, wasDeleted }
 * `wasDeleted` is true (with empty `changedFields`) only for `reallyDelete()`;
 * a soft delete (`remove()`) is a change. No `tx` is passed: it has ended.
 * A change inside a savepoint that rolled back is still reported at COMMIT.
 *
 * @param {Function} fn  Hook function (may be async)
 * @returns {Function}   Call to unregister the hook
 */
function registerCommittedChangeHook(fn) {
	return addHook(COMMITTED_CHANGE_HOOKS, fn);
}

/** `fn(item)` for each item, each awaited before the next. */
const inTurn = (items, fn) =>
	items.reduce((chain, item) => chain.then(() => fn(item)), Promise.resolve());

/**
 * Call `hooks` in turn with `payload`, each awaited before the next. A
 * throwing hook is logged but never allowed to propagate: the write already
 * succeeded.
 */
function runHooks(hooks, payload, label) {
	// A snapshot, so a hook that unregisters itself doesn't skip the next one.
	return inTurn(hooks.slice(), async (fn) => {
		try {
			await fn(payload);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error(`[yass-orm] ${label} change hook threw:`, err);
		}
	});
}

/**
 * Skip no-op payloads (e.g. a patch whose only fields were managed keys like
 * updatedAt/createdAt: after stripManagedKeys there is nothing user-meaningful
 * to report). This also prevents double-fire on findOrCreate: the internal
 * `instance.patch({ createdAt: new Date() })` becomes an empty-changedFields
 * call and is suppressed; the real wasCreated:true hook fires once, correctly.
 */
const isEmptyChange = ({ changedFields }) =>
	!changedFields || Object.keys(changedFields).length === 0;

/**
 * Fire all registered global change hooks sequentially.
 * @param {Object} payload
 */
async function runGlobalChangeHooks(payload) {
	if (GLOBAL_CHANGE_HOOKS.length === 0 || isEmptyChange(payload)) return;
	await runHooks(GLOBAL_CHANGE_HOOKS, payload, 'global');
}

/**
 * Hand a change to the committed change hooks: now when `tx` is not a
 * transaction handle (the write has committed), otherwise once `tx`'s root
 * transaction commits. By then the transaction's instances are in the shared
 * cache: a model write registers its txInstanceCache listener (which
 * publishes them) before this one, and listeners run in order.
 * @param {Object} payload  As for the global hooks (its `tx` is not passed on)
 */
async function runCommittedChangeHooks({ tx, ...payload }) {
	if (COMMITTED_CHANGE_HOOKS.length === 0) return;
	const change = { wasDeleted: false, ...payload };
	if (!change.wasDeleted && isEmptyChange(change)) return;
	const batch = transactionLocal(tx, COMMITTED_BATCH_KEY, () => {
		const changes = [];
		onTransactionEnd(tx, {
			commit: () =>
				inTurn(changes, (committed) =>
					runHooks(COMMITTED_CHANGE_HOOKS, committed, 'committed'),
				),
		});
		return changes;
	});
	if (batch) {
		batch.push(change);
	} else {
		await runHooks(COMMITTED_CHANGE_HOOKS, change, 'committed');
	}
}

/**
 * A write succeeded: the global change hooks now, the committed ones once it
 * is committed.
 * @param {Object} payload  { modelName, id, changedFields, wasCreated, tx }
 */
async function emitChange(payload) {
	await runGlobalChangeHooks(payload);
	await runCommittedChangeHooks(payload);
}

module.exports = {
	MANAGED_KEYS,
	stripManagedKeys,
	registerGlobalChangeHook,
	registerCommittedChangeHook,
	runCommittedChangeHooks,
	emitChange,
};
