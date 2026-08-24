/**
 * Loud-failure guard for CALLER-SUPPLIED objects passed into the public
 * entry points that route through `deflateValues()` (`search`, `searchOne`,
 * `findOrCreate`, `create`, `patch`, `patchIf`).
 *
 * `deflateValues()` itself walks the SCHEMA's field list, not the input
 * object's keys, so a key with no matching column is silently invisible to
 * it — never read, never reported (see obj.js's `deflateValues`). This
 * module is the single place that decides whether that silence is
 * acceptable, mirroring the `search-options.js` `fail()` pattern used for
 * `normalizeSearchOptions()`.
 *
 * Deliberately NOT wired into `deflateValues()` itself — three INTERNAL
 * call sites pass a full model INSTANCE (not caller input) into
 * `deflateValues`/`deflate`, and a live instance can carry non-schema
 * own-properties (e.g. `_patchDeferTid`, set by `set()`/`_deferPatch()`).
 * Callers of this helper must call it at their own public entry point,
 * before the object reaches `deflateValues`, and must never call it with
 * `this`/an instance. See BDL-2697.
 */

function assertKnownFields(
	object,
	fieldMap,
	{ className, methodName, argName },
) {
	if (!object || typeof object !== 'object') {
		return;
	}

	const unknown = Object.keys(object).filter((key) => !fieldMap[key]);
	if (!unknown.length) {
		return;
	}

	const label = unknown.length > 1 ? 'fields' : 'field';
	const quoted = unknown.map((key) => `'${key}'`).join(', ');
	throw new Error(
		`yass-orm ${className}.${methodName}(): unknown ${label} ${quoted} in '${argName}' — not present in the '${className}' schema. Known fields: ${Object.keys(
			fieldMap,
		).join(', ')}.`,
	);
}

module.exports = { assertKnownFields };
