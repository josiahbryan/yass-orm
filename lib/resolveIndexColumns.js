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

module.exports = { resolveIndexColumns };
