/**
 * Canonical option vocabulary for `Model.search()` / `dbh.search()`.
 *
 * Historically the second positional of `search` was a boolean `limitOne`, so
 * `search(fields, { limit: 20 })` passed a truthy OBJECT into a boolean slot:
 * SQL got `limit 1`, no ORDER BY, and the caller got a single object instead of
 * an array — silently. This module is the single place that decides what an
 * options object may contain, so the two layers cannot drift apart.
 */

const SUPPORTED_SEARCH_OPTION_KEYS = [
	'limitOne',
	'limit',
	'offset',
	'orderBy',
	'orderDir',
];

const SUPPORTED_LIST = SUPPORTED_SEARCH_OPTION_KEYS.join(', ');

function fail(message) {
	throw new Error(`yass-orm search(): ${message}`);
}

function assertNonNegativeInteger(name, value) {
	if (!Number.isInteger(value) || value < 0) {
		fail(
			`option '${name}' must be a non-negative integer, got ${JSON.stringify(
				value,
			)}. Supported: ${SUPPORTED_LIST}.`,
		);
	}
}

/**
 * Normalize the `boolean | object` second positional into a canonical shape.
 *
 * @param {boolean|object} [arg] `true`/`false` (legacy) or an options object.
 * @param {object} [context]
 * @param {string[]} [context.validColumns] Schema column names. When supplied,
 *   `orderBy` must be one of them. Omitted at the `dbh` layer, which has no schema.
 * @returns {{limitOne: boolean, limit: number|undefined, offset: number|undefined,
 *   orderBy: string|undefined, orderDir: 'ASC'|'DESC'|undefined}}
 */
function normalizeSearchOptions(arg, { validColumns } = {}) {
	// Legacy boolean path — must stay byte-identical in behaviour.
	if (arg === undefined || arg === null || typeof arg === 'boolean') {
		return {
			limitOne: arg === true,
			limit: undefined,
			offset: undefined,
			orderBy: undefined,
			orderDir: undefined,
		};
	}

	if (typeof arg !== 'object' || Array.isArray(arg)) {
		fail(
			`second argument must be a boolean or an options object, got ${typeof arg}. Supported: ${SUPPORTED_LIST}.`,
		);
	}

	Object.keys(arg).forEach((key) => {
		if (arg[key] === undefined) return; // present-but-undefined is treated as absent (idempotency)
		if (!SUPPORTED_SEARCH_OPTION_KEYS.includes(key)) {
			fail(`unknown option '${key}'. Supported: ${SUPPORTED_LIST}.`);
		}
	});

	const { limitOne = false, limit, offset, orderBy, orderDir } = arg;

	if (typeof limitOne !== 'boolean') {
		fail(`option 'limitOne' must be a boolean. Supported: ${SUPPORTED_LIST}.`);
	}

	if (limit !== undefined) {
		assertNonNegativeInteger('limit', limit);
	}
	if (offset !== undefined) {
		assertNonNegativeInteger('offset', offset);
		// MySQL and SQLite both reject OFFSET without LIMIT.
		if (limit === undefined) {
			fail(
				`option 'offset' requires 'limit' — SQL cannot express an offset without a limit.`,
			);
		}
	}

	if (limitOne && limit !== undefined) {
		fail(
			`option 'limitOne' cannot be combined with 'limit' — they mean different return shapes (single object vs array).`,
		);
	}

	let normalizedDir;
	if (orderDir !== undefined) {
		if (orderBy === undefined) {
			fail(`option 'orderDir' requires 'orderBy'.`);
		}
		if (typeof orderDir !== 'string') {
			fail(
				`option 'orderDir' must be 'ASC' or 'DESC', got ${typeof orderDir}.`,
			);
		}
		normalizedDir = orderDir.toUpperCase();
		if (normalizedDir !== 'ASC' && normalizedDir !== 'DESC') {
			fail(`option 'orderDir' must be 'ASC' or 'DESC', got '${orderDir}'.`);
		}
	}

	if (orderBy !== undefined) {
		if (typeof orderBy !== 'string' || !orderBy.length) {
			fail(`option 'orderBy' must be a non-empty column name.`);
		}
		if (validColumns && !validColumns.includes(orderBy)) {
			fail(
				`option 'orderBy' names '${orderBy}', which is not a column on this model. Known columns: ${validColumns.join(
					', ',
				)}.`,
			);
		}
		// Default direction so the emitted SQL is always explicit.
		normalizedDir = normalizedDir || 'ASC';
	}

	return {
		limitOne,
		limit,
		offset,
		orderBy,
		orderDir: orderBy === undefined ? undefined : normalizedDir,
	};
}

module.exports = { normalizeSearchOptions, SUPPORTED_SEARCH_OPTION_KEYS };
