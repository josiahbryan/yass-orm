/**
 * Global change hooks: functions called after every successful create() or
 * patch() (and so remove(), a soft-delete patch). The hook list is on
 * globalThis (lib/globals.js), so two copies of yass share it.
 */
const { globalChangeHooks: GLOBAL_CHANGE_HOOKS } = require('../globals');

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

/**
 * Register a function that will be called after every successful `create()`
 * or `patch()` (and therefore `remove()`, which is a soft-delete patch).
 *
 * The hook receives:
 *   { modelName: string, id: string|number, changedFields: Object, wasCreated: boolean }
 *
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
	GLOBAL_CHANGE_HOOKS.push(fn);
	return function unregister() {
		const i = GLOBAL_CHANGE_HOOKS.indexOf(fn);
		if (i >= 0) GLOBAL_CHANGE_HOOKS.splice(i, 1);
	};
}

/**
 * Fire all registered global change hooks sequentially.  A throwing hook is
 * logged but never allowed to propagate — the write already succeeded.
 * @param {Object} payload
 */
async function runGlobalChangeHooks(payload) {
	if (GLOBAL_CHANGE_HOOKS.length === 0) return;
	// Skip no-op payloads (e.g. a patch whose only fields were managed keys like
	// updatedAt/createdAt — after stripManagedKeys there is nothing user-meaningful
	// to report).  This also prevents double-fire on findOrCreate: the internal
	// `instance.patch({ createdAt: new Date() })` becomes an empty-changedFields
	// call and is suppressed; the real wasCreated:true hook fires once, correctly.
	if (!payload.changedFields || Object.keys(payload.changedFields).length === 0)
		return;
	// Run hooks sequentially so each one is awaited before the next fires.
	// We use reduce over an array of hooks (snapshot to avoid mutation hazards).
	await GLOBAL_CHANGE_HOOKS.slice().reduce(
		(chain, fn) =>
			chain.then(() => {
				let result;
				try {
					result = fn(payload);
				} catch (err) {
					// eslint-disable-next-line no-console
					console.error('[yass-orm] global change hook threw:', err);
					return undefined;
				}
				return Promise.resolve(result).catch((err) => {
					// eslint-disable-next-line no-console
					console.error('[yass-orm] global change hook threw:', err);
				});
			}),
		Promise.resolve(),
	);
}

module.exports = {
	MANAGED_KEYS,
	stripManagedKeys,
	registerGlobalChangeHook,
	runGlobalChangeHooks,
};
