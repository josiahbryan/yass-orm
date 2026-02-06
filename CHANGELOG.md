# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
