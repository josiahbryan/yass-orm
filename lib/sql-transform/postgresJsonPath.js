/**
 * Shared MySQL-JSONPath -> Postgres JSON accessor conversion.
 *
 * yass-orm schemas and queries spell JSON access the MySQL way:
 *
 *     meta->>'$.valence'      meta->>"$.a.b"
 *
 * Postgres has no JSONPath in `->>`. That operator takes a single KEY NAME, so a
 * path deeper than one level needs a DIFFERENT operator -- `#>>` with a `text[]`
 * path literal:
 *
 *     meta->>'valence'        meta#>>'{a,b}'
 *
 * Previously the `$.` prefix was merely stripped, which turned `$.a.b` into the
 * single key `'a.b'`. Nothing errored -- that is valid SQL -- it just always
 * returned NULL, because no row has a key literally named `a.b`.
 *
 * BOTH the query transformer and the index DDL generator go through this module.
 * That is deliberate: if the two ever disagreed, a functional JSON index would be
 * dead weight the planner could never match to a query.
 */

/**
 * Split a JSON path into its steps.
 *
 * Accepts `$.a.b`, `a.b`, and array subscripts (`$.items[0].name`), which become
 * ordinary path steps -- Postgres treats a numeric step in a `text[]` path as an
 * array index.
 *
 * @param {string} pathSpec e.g. `$.a.b` or `items[0].name`
 * @returns {string[]} path steps, e.g. ['a', 'b']
 */
function splitJsonPath(pathSpec) {
	return `${pathSpec || ''}`
		.replace(/^\$\.?/, '')
		.replace(/\[(\d+)\]/g, '.$1')
		.split('.')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/**
 * Resolve a MySQL-style JSON path to the Postgres operator and literal to use.
 *
 * @param {string} pathSpec the path, with or without the `$.` prefix
 * @param {string} [operator] the source operator, `->>` (text) or `->` (json)
 * @returns {{operator: string, literal: string, keys: string[]}} Postgres form
 */
function jsonPathToPostgres(pathSpec, operator = '->>') {
	const keys = splitJsonPath(pathSpec);
	const wantsText = `${operator}`.includes('>>');

	if (keys.length <= 1) {
		// Single key: the plain key operator, with the key as a string literal.
		return {
			operator: wantsText ? '->>' : '->',
			literal: `'${(keys[0] || '').replace(/'/g, "''")}'`,
			keys,
		};
	}

	// Nested: the path operator takes a text[] literal, e.g. '{a,b}'.
	return {
		operator: wantsText ? '#>>' : '#>',
		literal: `'{${keys.map((k) => k.replace(/'/g, "''")).join(',')}}'`,
		keys,
	};
}

/**
 * Rewrite every MySQL-style JSON accessor in a string into its Postgres form.
 *
 * Handles both quote styles, because both appear in real schemas -- and note a
 * double-quoted token in Postgres is an IDENTIFIER, not a string, so the
 * double-quoted spelling MUST be converted rather than passed through.
 *
 * @param {string} input SQL text or a schema column spec
 * @returns {string} the same text with accessors converted
 */
function convertJsonAccessorsToPostgres(input) {
	return `${input === undefined || input === null ? '' : input}`.replace(
		/(->>?)\s*(['"])([^'"]+)\2/g,
		(match, operator, quote, pathSpec) => {
			const { operator: pgOperator, literal } = jsonPathToPostgres(
				pathSpec,
				operator,
			);
			return `${pgOperator}${literal}`;
		},
	);
}

module.exports = {
	splitJsonPath,
	jsonPathToPostgres,
	convertJsonAccessorsToPostgres,
};
