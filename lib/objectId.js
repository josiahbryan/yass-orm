const { randomInt } = require('crypto');

/**
 * Prefixed, time-ordered object ids, e.g. `chat_0mfq3k2z1x8c4v7b2n9m5k1j3`.
 *
 * The id is `<prefix>_<9 time chars><16 random chars>`, all lowercase base 36:
 *
 *  - The time part is the creation time in ms, zero-padded to a FIXED width, so
 *    ids sort by creation time as plain strings and new rows land at the end of
 *    the primary-key index instead of scattering through it (random ids do). Nine
 *    base-36 chars run past the year 5000.
 *  - The random part is 16 chars (~82 bits) from the CSPRNG, so ids generated in
 *    the same millisecond, on any number of processes, do not collide.
 *  - With a prefix of up to 10 chars the whole id fits 36 chars: a MySQL CHAR(36)
 *    `t.uuidKey` column holds it too.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const TIME_CHARS = 9;
const RANDOM_CHARS = 16;
const MAX_PREFIX_LENGTH = 10;
const PREFIX_RE = /^[a-z][a-z0-9]*$/;

/**
 * @param {number} [now] creation time in ms (defaults to Date.now())
 * @returns {string} 25 chars, lowercase base 36, sortable by `now`
 */
function timeOrderedId(now = Date.now()) {
	let id = Math.floor(now).toString(36).padStart(TIME_CHARS, '0');
	for (let i = 0; i < RANDOM_CHARS; i += 1) {
		id += ALPHABET[randomInt(ALPHABET.length)];
	}
	return id;
}

/**
 * @param {string} prefix the model's `objectIdPrefix` (1-10 lowercase alphanumerics, leading letter)
 * @param {number} [now] creation time in ms
 * @returns {string} `<prefix>_<timeOrderedId>`, at most 36 chars
 */
function prefixedId(prefix, now) {
	if (
		typeof prefix !== 'string' ||
		prefix.length > MAX_PREFIX_LENGTH ||
		!PREFIX_RE.test(prefix)
	) {
		throw new Error(
			`Invalid objectIdPrefix '${prefix}': use 1-${MAX_PREFIX_LENGTH} lowercase letters/digits starting with a letter (the id must fit 36 chars)`,
		);
	}
	return `${prefix}_${timeOrderedId(now)}`;
}

module.exports = { timeOrderedId, prefixedId, MAX_PREFIX_LENGTH };
