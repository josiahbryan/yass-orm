const crypto = require('crypto');

/**
 * Hex characters of the SHA-1 digest a fitted identifier ends with. A `_` goes
 * before it, so fitting reserves `IDENTIFIER_DIGEST_LENGTH + 1` characters.
 */
const IDENTIFIER_DIGEST_LENGTH = 8;

/**
 * Fit an identifier inside a dialect's length limit, deterministically.
 *
 * A name within the limit is returned unchanged. A longer one becomes a
 * truncated prefix, `_`, and a short hash of the FULL name, exactly the limit
 * long: stable across runs (so schema-sync finds it again in the catalog) and
 * distinct for two names that share a long prefix.
 *
 * Postgres silently TRUNCATES an identifier longer than 63 bytes (it emits only a
 * NOTICE), which would make schema-sync ask for a name the catalog never reports
 * back and recreate the object on every sync; MySQL refuses one over 64
 * characters outright ("Identifier name ... is too long").
 *
 * @param {string} name the desired identifier
 * @param {number} [limit] max length in characters, or falsy for no limit
 * @returns {string} an identifier within the limit
 */
function fitIdentifierToLimit(name, limit) {
	const value = `${name}`;
	if (!limit || value.length <= limit) {
		return value;
	}
	const digest = crypto
		.createHash('sha1')
		.update(value)
		.digest('hex')
		.slice(0, IDENTIFIER_DIGEST_LENGTH);
	return `${value.slice(0, limit - IDENTIFIER_DIGEST_LENGTH - 1)}_${digest}`;
}

/**
 * The name of the built-in id trigger (`SET NEW.id = uuid()` BEFORE INSERT) on
 * a `t.uuidKey` table: `before_insert_<table>_set_id`, fitted to the dialect's
 * identifier limit. Every place that names or looks up that trigger uses this,
 * so a fitted name is still recognised as the id trigger.
 *
 * The framing is 21 characters, so on MySQL (64) the name is unchanged for any
 * table of up to 43 characters; a longer table gets a prefix plus a hash.
 *
 * @param {string} tableName the table, without a database prefix
 * @param {number} [limit] the dialect's `maxIdentifierLength`
 * @returns {string} the trigger name
 */
function idTriggerName(tableName, limit) {
	return fitIdentifierToLimit(`before_insert_${tableName}_set_id`, limit);
}

module.exports = {
	IDENTIFIER_DIGEST_LENGTH,
	fitIdentifierToLimit,
	idTriggerName,
};
