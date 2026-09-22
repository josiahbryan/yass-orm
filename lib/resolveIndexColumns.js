/**
 * Resolves the column list for a schema-def index spec.
 *
 * `cols` is the canonical/current key and is what schema-sync has always
 * read. `columns` is an accepted ALIAS for `cols` with identical behavior --
 * closes a silent-no-op footgun where a schema def spelled the key `columns`
 * (or `fields`) instead of `cols` and the index was quietly never created
 * (no error, no DDL -- the mismatch surfaced later, if at all, as a missing
 * index rather than a schema-def bug). `fields` is intentionally NOT accepted
 * here; only `cols`/`columns` are recognized index-spec keys.
 *
 * The shorthand forms (a bare string or array, e.g. `['email']` or
 * `'email'`) are returned as-is, unchanged from existing behavior. When the
 * spec is an object, `cols` wins if both `cols` and `columns` are present.
 *
 * ONE DEFINITION, TWO CONSUMERS. `lib/sync-to-db.js` reads it to emit DDL and
 * `lib/obj.js` reads it to derive `conflictColumns` for `createIgnore`. Those
 * two must agree on which key names count as an index's column list: a second
 * copy that accepted a key schema-sync ignores would derive a conflict target
 * for an index that was never physically created. Never re-inline it.
 *
 * @param {string|Array|Object} indexSpec
 * @returns {string|Array|undefined}
 */
function resolveIndexColumns(indexSpec) {
	if (typeof indexSpec === 'string' || Array.isArray(indexSpec)) {
		return indexSpec;
	}
	if (indexSpec && typeof indexSpec === 'object') {
		if (indexSpec.cols !== undefined) {
			return indexSpec.cols;
		}
		return indexSpec.columns;
	}
	return undefined;
}

/**
 * Is this index spec a UNIQUE index?
 *
 * 🔴 SHARED ON PURPOSE, AND THE REASON IS A MEASURED NEAR-MISS. `sync-to-db`
 * tested `!!indexSpec.unique` (truthy) while `obj.js`'s conflict-target
 * deriver tested `spec.unique === true` (strict). A def spelled `unique: 1`
 * therefore got a REAL UNIQUE INDEX emitted in DDL and was invisible to the
 * deriver, which then threw "declares no unique:true index" on a model whose
 * constraint plainly existed. That is the same drift class extracting
 * `resolveIndexColumns` was meant to prevent, one line over — so the predicate
 * is shared too. Truthy wins, because the DDL emitter is the thing that
 * decides what physically exists.
 *
 * A bare string/array shorthand cannot carry the flag, which is what keeps the
 * `isDeleted` index schema-sync injects into every table from ever qualifying.
 *
 * @param {string|Array|Object} indexSpec
 * @returns {boolean}
 */
function isUniqueIndexSpec(indexSpec) {
	return !!(
		indexSpec &&
		typeof indexSpec === 'object' &&
		!Array.isArray(indexSpec) &&
		indexSpec.unique
	);
}

module.exports = { resolveIndexColumns, isUniqueIndexSpec };
