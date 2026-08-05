/**
 * Canonical collation for UUID-style char(36) columns (primary keys AND the
 * char(36) foreign-key / "linked" columns that reference them).
 *
 * WHY THIS EXISTS (single source of truth):
 *   The uuid PRIMARY KEY is pinned to `utf8mb4_bin` (see
 *   MySQLDialect.getUuidPrimaryKeyAttrs) to avoid MySQL warning 1287. But a
 *   char(36) `t.linked()` / `t.uuid` column carries NO explicit collation, so it
 *   inherits the table default (utf8mb4_0900_ai_ci on MySQL 8, utf8mb4_general_ci
 *   on MariaDB/5.7). A JOIN across two columns with DIFFERENT collations cannot
 *   use the index -> full scan.
 *
 *   To guarantee "id column collation === link column collation BY CONSTRUCTION",
 *   BOTH the primary-key attrs and the opt-in link-column collation resolve to
 *   THIS one constant. Change it in exactly one place and both stay in lock-step.
 *
 * This is a MySQL/MariaDB concept; SQLite and Postgres field-spec generators
 * ignore the `collation` attribute, so emitting it is harmless for them.
 */
const CANONICAL_UUID_COLLATION = 'utf8mb4_bin';

/**
 * DB-side collations that are the KNOWN mismatch against CANONICAL_UUID_COLLATION
 * for an inherited-default char(36) column. Used to scope the schema-sync deferral
 * guard so it only ever suppresses the exact link-canonicalization case and never
 * a deliberate, unrelated collation change.
 */
const INHERITED_DEFAULT_COLLATIONS = [
	'utf8mb4_0900_ai_ci',
	'utf8mb4_general_ci',
];

module.exports = {
	CANONICAL_UUID_COLLATION,
	INHERITED_DEFAULT_COLLATIONS,
};
