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

function fail(message, method = 'search') {
	throw new Error(`yass-orm ${method}(): ${message}`);
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
		// An unknown key throws regardless of its value — including `undefined`,
		// which is the common `{ ...opts, sortBy: cond ? x : undefined }` spread
		// footgun. "undefined is absent" applies only to VALUE VALIDATION of the
		// five canonical keys below, never to key membership.
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

/**
 * Vocabulary of `promisePoolMap`'s config object — the OTHER thing that may
 * legitimately appear in `searchOne`'s second positional. Kept in lockstep
 * with the destructuring in `lib/promiseMap.js` `promisePoolMap()`.
 *
 * This list and `SUPPORTED_SEARCH_OPTION_KEYS` are deliberately DISJOINT; that
 * is what makes the second positional partitionable rather than ambiguous.
 */
const SUPPORTED_POOL_CONFIG_KEYS = [
	'concurrency',
	'debug',
	'logger',
	'throwErrors',
	'yieldEvery',
];

/**
 * The `search()` options that are meaningful for a SINGLE row.
 *
 * `limitOne` is implied by the method. `limit`/`offset` contradict the
 * single-row return shape, so they are rejected explicitly (below) rather than
 * forwarded — forwarding them yields an error naming `limitOne`, which the
 * caller never typed.
 */
const SEARCH_ONE_SEARCH_KEYS = ['orderBy', 'orderDir'];

/** Valid on `search()`, deliberately refused on `searchOne()`. */
const SEARCH_ONE_REJECTED_SEARCH_KEYS = ['limitOne', 'limit', 'offset'];

/**
 * `searchOne`'s OWN supported list. Reusing `search()`'s `SUPPORTED_LIST` here
 * advertised `limitOne, limit, offset` as supported in a position that rejects
 * all three, so following the advice produced a second, contradictory throw.
 */
const SEARCH_ONE_SUPPORTED_HELP = `Supported: ${SEARCH_ONE_SEARCH_KEYS.join(
	', ',
)} (ordering), ${SUPPORTED_POOL_CONFIG_KEYS.join(', ')} (pool config), tx.`;

/**
 * Split `searchOne`'s second positional into its two legitimate vocabularies.
 *
 * Historically this slot was documented as `promisePoolMapConfig` alone, and
 * `searchOne` forwarded it into `search`'s THIRD positional. That slot really
 * IS the pool-config slot (`search` lifts `tx` off it and uses the remainder as
 * the pool config), so the forwarding was not itself wrong — but `searchOne`
 * hardcoded `true` into the SECOND positional, the only one that carries the
 * option vocabulary. A caller writing the shape that works on `search`
 * (`{ orderBy, orderDir }`) therefore got a SILENT NO-OP: no ORDER BY, no
 * throw, an arbitrary row (BDL-2700).
 *
 * And a genuine pool config in that slot is INERT BY CONSTRUCTION on this path
 * regardless: `search` returns inside its `limitOne` branch before
 * `promisePoolMap` is ever reached, and `searchOne` always sets `limitOne`.
 *
 * The slot is therefore partitioned, not replaced: pool keys keep their old
 * meaning, `tx` keeps routing a transaction, search-option keys are handed on
 * to `search()` for real validation against the model schema, and ANY other key
 * throws naming itself instead of vanishing.
 *
 * This function only PARTITIONS. Validating the search options (including
 * whether `orderBy` names a real column) is `search()`'s job, since it is the
 * layer that owns the schema — doing it here too would be two places to drift.
 *
 * @param {object|null|undefined} arg The second positional as written by the caller.
 * @returns {{searchOptions: object, poolConfig: object|undefined, tx: any}}
 *   `poolConfig` is `undefined` when the caller supplied no pool keys, so
 *   `search()`'s own default parameter applies.
 */
function splitSearchOneOptions(arg) {
	if (arg === undefined || arg === null) {
		return { searchOptions: {}, poolConfig: undefined, tx: undefined };
	}

	if (typeof arg !== 'object' || Array.isArray(arg)) {
		fail(
			`second argument must be an options object, got ${typeof arg}. ${SEARCH_ONE_SUPPORTED_HELP}`,
			'searchOne',
		);
	}

	const searchOptions = {};
	const poolConfig = {};
	let tx;
	let sawPoolKey = false;

	Object.keys(arg).forEach((key) => {
		if (key === 'tx') {
			tx = arg[key];
			return;
		}
		if (SEARCH_ONE_REJECTED_SEARCH_KEYS.includes(key)) {
			// These ARE valid `search()` options, so they must be rejected HERE,
			// naming the key the caller actually typed. Forwarding them to
			// `normalizeSearchOptions` produces a message about `limitOne` — a key
			// the caller never wrote and cannot remove.
			fail(
				`option '${key}' is not available on searchOne(), which always returns a single row. ` +
					`Use search() for a bounded page. ${SEARCH_ONE_SUPPORTED_HELP}`,
				'searchOne',
			);
		}
		if (SEARCH_ONE_SEARCH_KEYS.includes(key)) {
			searchOptions[key] = arg[key];
			return;
		}
		if (SUPPORTED_POOL_CONFIG_KEYS.includes(key)) {
			poolConfig[key] = arg[key];
			sawPoolKey = true;
			return;
		}
		fail(`unknown option '${key}'. ${SEARCH_ONE_SUPPORTED_HELP}`, 'searchOne');
	});

	return {
		searchOptions,
		poolConfig: sawPoolKey ? poolConfig : undefined,
		tx,
	};
}

module.exports = {
	normalizeSearchOptions,
	splitSearchOneOptions,
	SUPPORTED_SEARCH_OPTION_KEYS,
	SUPPORTED_POOL_CONFIG_KEYS,
	SEARCH_ONE_SEARCH_KEYS,
};
