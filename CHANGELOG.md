# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.10] - 2026-05-05

### Fixed

- **Schema-sync NOT NULL backfill diagnostics** - Schema sync now preflights ALTERs that make an existing nullable column `NOT NULL` and reports the required data backfill instead of surfacing MySQL's opaque "Invalid use of NULL value" error
  - Counts existing rows where the target column is `NULL` before running the unsafe ALTER
  - Skips the ALTER when NULL rows are present, preserving the previous nullable column until data is backfilled
  - Prints an actionable `UPDATE ... WHERE ... IS NULL` suggestion when the schema has a default value
  - Adds regression coverage for both the diagnostic formatter and end-to-end schema-sync behavior

## [2.0.9] - 2026-03-05

### Added

- **PostgreSQL Dialect Support** - yass-orm now supports PostgreSQL as a first-class dialect alongside MySQL/MariaDB and SQLite
  - New `dialect: 'postgres'` config option (also accepts `'postgresql'` or `'pg'`)
  - New `PostgresDialect` class extending `BaseDialect` with full type mapping, DDL generation, and schema introspection
  - New `PostgresSqlTransformer` with AST-first + scanner fallback for MySQL-to-PostgreSQL SQL translation
  - Automatic SQL syntax translation: `:name` → `$N` positional placeholders, backticks → double quotes, `IFNULL` → `COALESCE`, `CURDATE()` → `CURRENT_DATE`, JSON `$.path` → simple key, `LIMIT offset,count` → `LIMIT count OFFSET offset`
  - Full PostgreSQL type mapping: `SERIAL`, `UUID`, `JSONB`, `BYTEA`, `BOOLEAN`, `DOUBLE PRECISION`, `TIMESTAMP`, etc.
  - Schema-sync support with PostgreSQL type normalization via `information_schema` and `pg_index`/`pg_class` introspection
  - GIN indexes for fulltext search, expression indexes for JSON columns
  - `ALTER COLUMN` generates separate `TYPE`/`NOT NULL`/`DEFAULT` statements per PostgreSQL requirements
  - Auto-appends `RETURNING *` to `INSERT` statements for generated ID retrieval
  - Connection pooling via `pg.Pool` and read replica support
  - `pg` added as a direct dependency
  - Comprehensive test coverage: 24 transformer tests + 58 dialect tests

### Changed

- `dbh.js` updated to handle object return type from `transformSql` (for positional placeholder support)
- `sync-to-db.js` updated with PostgreSQL port defaults, index naming conventions, and 9 type normalizations
- `config.js` updated to document PostgreSQL dialect options

### Fixed

- Updated internal jsonSafeStringify utility to detect running under Bun and proactively de-cycle JSON before stringifying


## [2.0.8] - 2026-02-06

### Fixed

- **Quieter logging for connection-closed errors (08S01)** – When a query fails with "socket has unexpectedly been closed" (SQLState 08S01), the ORM now logs a single line ("Database connection closed, retrying...") instead of the full "Error processing query" block (Raw SQL, Interpolated SQL, stack trace). Retry behavior is unchanged: `retryIfConnectionLost` still runs and retries with a fresh connection. This reduces noisy stderr output in CLIs and logs when the pool occasionally returns a stale connection under concurrent load.

## [2.0.7] - 2026-02-05

### Fixed

- Fixed bug where initial `default` values on chainable types (like `t.bool` with `default: 0`) were lost during type creation
  - The `.default()` chainable method was overwriting the initial `default` value before it could be preserved
  - Types like `t.bool` now correctly generate SQL with `DEFAULT '0'` instead of missing the DEFAULT clause
  - This caused `isDeleted` columns to be created without `DEFAULT 0`, leading to SQL insert errors: "Field 'isDeleted' doesn't have a default value"
  - Fix: Preserve initial default in `__defaultValue` before attaching the `.default()` method

## [2.0.6] - 2026-02-01

### Fixed

- Fixed crash when `inflateValues()` or `_updateProperties()` receive `undefined` or `null` data
  - This can occur during race conditions when a record is deleted while an async operation (like a debounced update) tries to patch it
  - `inflateValues()` now returns `undefined` early instead of throwing "Cannot read properties of undefined"
  - `_updateProperties()` now returns the instance unchanged instead of crashing
  - Added regression tests to prevent future breakage

## [2.0.5] - 2026-01-27

### Fixed

- Fixed type generator singularization for English words ending in `-es` (e.g., `chat_inboxes` now correctly generates `ChatInboxInstance` instead of `ChatInboxeInstance`)

### Added

- Added `singularize()` helper function in `lib/generate-types.js` that properly handles English pluralization rules:
  - Words ending in `-xes`, `-sses`, `-ches`, `-shes`, `-zes` → drop `-es`
  - Words ending in `-ies` → change to `-y`
  - Default → drop `-s`
- Added test coverage for singularization in `test/generate-types.test.js`
- Exported `singularize` function from module

## [2.0.4] - Previous

- See git history for earlier changes
