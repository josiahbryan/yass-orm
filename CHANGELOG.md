# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.1] - 2026-08-08

### Fixed

- **FULLTEXT indexes over TEXT columns no longer drop and recreate on every single schema-sync.** The index-reconciliation pass records an implicit `(255)` prefix length for any TEXT column participating in an index — required for BTREE, since MySQL refuses to index a TEXT column without a prefix — but it applied that unconditionally, including to FULLTEXT. FULLTEXT indexes the *entire* column and never carries a prefix, so `SHOW INDEXES` reports `Sub_part: NULL`. Every sync therefore compared a desired signature of `{"fulltext":true,"unique":false,"columns":["body(255)"]}` against an existing signature of `{"fulltext":true,"unique":false,"columns":["body"]}` — never equal, so `diff` was always true and the index was dropped and rebuilt on every run, forever.
  - **Why it stayed invisible:** MySQL *accepts* `CREATE FULLTEXT INDEX ... (body(255))` and silently discards the prefix rather than erroring, so each rebuild succeeded, logged only the ordinary `(re)Creating index` line, and re-armed the identical mismatch for the next tick. No error, no failed sync, no signal.
  - **Impact:** a FULLTEXT rebuild holds a metadata lock for the duration and blocks every write to the table. Root-caused from a 120-second stall on `bc_agent_grid_transcript_turns` (421k rows / 1.1 GB), with inserts queued behind it at 119s/111s/110s — one stall per sync tick.
  - Fix: gate the prefix-length bookkeeping on `!isFullText` at the point where it is recorded, so both the desired signature *and* the generated `CREATE INDEX` DDL are corrected from one condition (the `textLengths` map feeds both `buildIndexSignature` and `MySQLDialect.generateCreateIndex`). BTREE indexes on TEXT columns are unaffected and still get `(255)`.
  - Also fixed, same root cause, same loop: an *explicitly* written prefix length on a FULLTEXT column (`{ fulltext: true, cols: ['notes(255)'] }`) took the "explicit length already present" branch and was passed straight through to both the signature and the DDL — MySQL discarded it just the same, so those indexes rebuilt on every sync too. Explicit `(N)` prefixes are now stripped for FULLTEXT specs.
  - Prefix lengths are a MySQL-only concept: `PostgresDialect`/`SQLiteDialect.generateCreateIndex` strip `col(N)` out of the DDL they emit, while the `(255)` was being injected into the desired signature for every dialect — the same permanent mismatch, so *any* index on a TEXT column rebuilt on every sync under Postgres. The injection is now gated on `dialect.name === 'mysql'`.
  - The errno-1170 pre-drop pass (drop prefix-less indexes before a `CHANGE COLUMN ... TEXT`) no longer drops FULLTEXT indexes. FULLTEXT is always prefix-less and never triggers 1170, so dropping it bought nothing and cost exactly the metadata-locked rebuild described above.
  - **No migration needed and no final rebuild:** existing FULLTEXT indexes in the database already have `Sub_part: NULL`, so the first sync after upgrading matches immediately and performs no DDL at all.
  - Tests in `test/schemaSync.fulltextIdempotency.test.js` cover all three index-spec spellings (`{ fulltext: true, cols: [...] }`, the legacy `['fulltext', 'col']` form, and an explicit `cols: ['notes(255)']`): one asserts the created indexes report `Index_type: FULLTEXT` with `Sub_part: null`, the other syncs the identical schema twice and asserts no index is recreated on the second pass. The second test is the red-green one — the first passes either way, because MySQL silently discards the bogus prefix (that silence is the whole reason the bug hid). Both include a BTREE-on-TEXT control that must still report `Sub_part: 255`, so the fix cannot regress the prefix behavior the `(255)` injection exists for. A third test covers the errno-1170 guard: it establishes a FULLTEXT index on a `varchar` column, flips the column to `longtext`, and asserts the guard did not drop the FULLTEXT index while the column change still succeeded (verified red — without the skip, the guard logs a drop of that index).
  - **Known limitation (Postgres, pre-existing and unfixed):** FULLTEXT indexes still drop/recreate on every sync under Postgres for a second, independent reason — `PostgresDialect.getTableIndexes` never populates `type`, so an existing index's signature always carries `fulltext: false` while the desired one carries `true`. Fixing that needs GIN/`to_tsvector` detection in the PG introspection query, which is outside this changeset and could not be verified here (no PG server available). The prefix half of the Postgres problem *is* fixed above, so ordinary BTREE indexes on TEXT columns no longer churn there.

## [2.1.0] - 2026-08-05

### Added

- **Model-level transaction binding (`{ tx }`).** 2.0.21 made transactions correct at the dbh layer, but the model layer could not reach them: `Model.create()` resolved its own handle, `withDbh` stored nothing, and there is no ambient context, so any caller wanting multi-model atomicity had to drop to `tx.create(table, Model.deflateValues(...), ...)` and reimplement `create` inline at every call site — losing id generation, deflation, `afterCreateHook`, and the inflated return value, and silently rotting whenever `create` changed. Model methods now accept the transaction handle directly. Spec: `docs/specs/2026-08-05-model-level-transaction-binding.spec.md`.
  - `{ tx }` is accepted by `Model.create(data, { tx })`, `instance.patch(data, { tx })`, `instance.remove({ tx })`, `Model.get(id, { tx })`, `Model.search(fields, limitOne, poolConfig, { tx })`, `Model.searchOne(fields, poolConfig, { tx })`, and `Model.findOrCreate(fields, patchIf, patchIfFalsey, { tx })`. Every change is additive and occupies an options slot that already existed or was reserved (`/* , params */`), so all existing calls behave identically.
  - `search`/`searchOne` also read `tx` off the `promisePoolMapConfig` object, so `searchOne(fields, { tx })` — the shape callers naturally write — works instead of silently landing in the pool-config slot. The explicit trailing options argument wins if both are given.
  - **Reads join the transaction.** An uncommitted row is invisible to every other connection, so without tx-aware `get`/`search` a transaction is write-only and unreadable. Same property `tx.roQuery` already enforces by refusing to route to a read replica.
  - **`tx` threads through the whole inflation chain** (`create`/`get`/`search` → `inflate` → `inflateValues` → `_resolvedLinkedModel` → `get`, and `patch` → `_updateProperties` → `inflateValues`). Linked-field resolution is a database read: had `tx` stopped at `dbh.create`, a row linking to rows created earlier in the same transaction would insert correctly and return an instance whose linked fields were silently `null` — no error, wrong return value. Explicitly covered by a test that clears the identity cache first so the read cannot be satisfied from memory.
  - **Per-statement retry is disabled when `tx` is supplied.** New `DatabaseObject._runOn(tx, callback)` calls the transaction handle directly with no `retryIfConnectionLost` wrapper. Retrying a single statement on a fresh connection after the pinned connection dropped would land that write *outside* the transaction — committed and unrollbackable — while the surrounding transaction rolled back, producing exactly the partial write the transaction existed to prevent. Retry granularity stays with `dbh.transaction({ maxRetries })`, which replays the entire callback.
  - **`findOrCreate(..., { tx })` JOINS the caller's transaction** instead of opening its own. `dbh.findOrCreate` already short-circuits when the handle is transactional, so no savepoint is created and a caller-level rollback undoes what it created. `tx` takes precedence over `useTransaction`/`transactionOptions`; passing both logs one warning.
  - TypeScript: new exported `TxOptions` type, `tx` on `FindOptions` and `FindOrCreateOptions`, updated static/instance declarations in `index.d.ts`, and the model-type generator (`lib/generate-types.js`) now emits `tx` on `create`/`get`/`getMultiple`/`search`/`searchOne`/`findOrCreate`/`inflate` so generated model declarations accept it too.
  - 9 red-green tests in `test/obj.transaction.test.js` cover rollback of model writes, read-your-own-writes, tx-aware `search`, linked-field resolution inside a transaction, tx-aware `patch`, retry-suppression under `tx`, the unchanged non-`tx` retry path, `findOrCreate` joining, and hook `tx` propagation. They run against live MySQL/MariaDB deliberately: SQLite queues ordinary parent-handle queries behind an active transaction, so a read that failed to join would hang rather than return the wrong answer, making the red phase uninformative.

- **Opt-in canonical link-column collation + resumable migration batch (default OFF, zero behavior change).** Root fix for the `char(36)` link-vs-uuid-PK collation mismatch that makes cross-table JOINs on linked/uuid columns non-sargable: link/uuid columns previously inherited the table-default collation (`utf8mb4_0900_ai_ci` / `_general_ci`) while the uuid PK is pinned to `utf8mb4_bin`, so a join between them can't use the index and falls back to a full scan.
  - New `lib/uuid-collation.js` holds `CANONICAL_UUID_COLLATION` (`utf8mb4_bin`) as the single source of truth; `MySQLDialect.getUuidPrimaryKeyAttrs` now reads it, so the PK and any opt-in link columns match by construction.
  - `def-to-schema`: `resolveLinkColumnCollation()` gives `char(36)` `t.linked`/`t.uuid` columns the canonical collation only when `config.linkColumnCollation` is enabled (`true` → `utf8mb4_bin`, or an explicit string). Off (the default) emits no collation, exactly as before. Non-`char(36)`/int links are never affected; SQLite/Postgres ignore collation entirely.
  - `sync-to-db`: an inverted guard (`shouldDeferCollationOnlyChange`) *reports* but does **not** auto-apply the bin-vs-inherited-default canonicalization on existing columns unless `config.migrateLinkCollation` is also set, so an ordinary `schema-sync` can never trigger a mass table rebuild by surprise.
  - Migration batch tooling (build + unit-tested only; not run against any real database in this repo): `lib/migrations/link-collation.js` provides a read-only GENERATOR that queries `information_schema` for mismatched `char(36)` columns and emits an ordered manifest of per-table `ALTER`s (DDL sourced from the dialect, not hand-authored), plus a resumable RUNNER that applies one table at a time with dry-run, disk precheck, verify-after, idempotency, `stopAfter` batching, rate-limiting, and gh-ost/pt-osc online-DDL support for large tables. `bin/migrate-link-collation` is the CLI entry point (read-only by default; `--run` to apply).
  - 28 new tests cover the flag OFF/ON paths, PK==link-column collation by construction, generator mismatch detection, and the runner's resumable/idempotent/dry-run/verify-halt/`stopAfter`/disk-check behavior. Existing suite (302 no-DB tests) remains green.
- **`columns` accepted as an alias for the `cols` index-spec key (additive, zero behavior change).** Schema-def index specs (`options.indexes.<name> = { cols: [...], fulltext, unique }`) previously only recognized the exact key `cols` — any other spelling (`columns`, `fields`) hit the "ignore empty indexes" branch meant for manually-created indexes and silently produced no index at all: no error, no DDL, no signal that the schema def had a typo. Root-caused as the underlying cause of two separate schema defs that used `columns:`/`fields:` and got no index, later patched at the symptom layer with a runtime `ALTER` instead of catching the source typo.
  - New `resolveIndexColumns()` (exported from `lib/sync-to-db.js`) centralizes the key resolution: `cols` remains canonical and wins if both keys are present on the same spec; `columns` is now read identically. `fields` is intentionally still not recognized — only `cols`/`columns` are accepted, everything else remains a silent no-op exactly as before.
  - 8 new tests (`test/index-column-key-alias.test.js`) prove both spellings resolve identically for the pure key-resolution function, and a real schema-sync end-to-end test confirms a `columns:`-spelled index spec now actually creates the index in the database (previously silently skipped).

### Changed

- **Model hooks now receive `{ tx }`.** `afterCreateHook` and `afterChangeHook` are called with `{ tx }` (and `{ wasCreated, tx }` on the `findOrCreate` path), and `runGlobalChangeHooks` payloads carry `tx`. Hooks still fire at the same points, i.e. before commit. Signature-compatible — existing hooks that declare no parameters are unaffected — but **the meaning changes**: a user hook that performs its own database writes and does not accept and forward `tx` will write **outside** the caller's transaction, and those writes commit even if the transaction rolls back.

### Known limitations

- `inflate` populates the per-class identity cache by id, so rows created inside a transaction that later rolls back leave cached instances for ids that no longer exist. This is pre-existing behavior on the already-transactional `findOrCreate` path and is unchanged here; call `Model.clearCache()` after a rollback if you rely on cached reads.
- Model-level `{ tx }` is not accepted by `find()`, `fromSql()`, `patchIf()`, `patchWithNonceRetry()`, `queryCallback()`, `withDbh()`, or `reallyDelete()` — by design. Use `withDbh` or the raw `tx` helpers for those inside a transaction.
- No ambient (`AsyncLocalStorage`) transaction context — a deliberate no, not an omission. It would make every model call transactional with no signature change, and would also let an unrelated call deep in a stack silently join a transaction it knows nothing about, and let hooks outliving the callback inherit a dead handle.

### Security

- **Patched the HIGH-severity `brace-expansion` ReDoS/DoS advisory [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) (CVE-2026-13149)** — exponential-time expansion of consecutive non-expanding `{}` groups. `brace-expansion` was pulled in transitively at **1.1.12** by `minimatch@3.1.2` (via `eslint-plugin-import`) and `minimatch@4.2.1` (via `mocha`), both of which declare `brace-expansion: ^1.1.7`. An npm `overrides` entry pins it to **^1.1.16** (the maintainer's `maintenance-v1` backport and the exact version GitHub names as patched), which resolves to **1.1.16** — in range for both parents, so no parent bump was needed. This also clears the MEDIUM [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v) (patched in 1.1.13).
  - Dev-dependency-only: `brace-expansion` is not reachable from any runtime code path in this package.
  - **Known residual:** [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (HIGH, unbounded-expansion OOM) affects `<= 5.0.7` and is patched **only in 5.0.8** — there is no 1.x backport, so `npm audit` still reports it. Taking it would require overriding to `brace-expansion@5`, which is not viable here: 5.x is a tshy ESM/CJS build whose CommonJS entry exports a *named* `expand` (`exports.expand = expand`) rather than `module.exports = expand`, so `minimatch@3/4`'s `require('brace-expansion')(...)` would throw at runtime. It also raises the engine floor to `node 20 || >=22`. The alternative — `npm audit fix --force` — performs a breaking major bump to `mocha@11`. Neither is warranted for a dev-only dependency; revisit when `minimatch` (or `mocha`) ships a release on a patched `brace-expansion` line.

## [2.0.21] - 2026-07-15

### Added

- **First-class transactions for MySQL/MariaDB, PostgreSQL, and SQLite.** `dbh.transaction(callback, options?)` pins the full dbh helper surface—including `pquery` and `roQuery`—to one physical connection, commits successful callbacks, rolls back failures, returns callback values, and uses savepoints for nested transactions.
- Portable isolation-level validation, read-only transactions, PostgreSQL deferrable transactions, SQLite deferred/immediate/exclusive modes with connection-state restoration, and opt-in retries for recognized serialization, deadlock, busy, and lock failures.

### Changed

- **`findOrCreate()` is transactional by default.** MySQL/MariaDB and PostgreSQL use serializable isolation; SQLite uses immediate mode. Each path retries recognized transaction conflicts up to twice. Callers can opt out with `{ useTransaction: false }` or supply `transactionOptions`.
- SQLite queues concurrent transactions and ordinary parent-handle queries around its single connection so unrelated async work cannot accidentally join an active transaction.

### Fixed

- A failed `patchIf` step in `findOrCreate()` now rolls back a row created earlier in the same operation.
- Concurrent `findOrCreate()` calls now retain per-result action and patch metadata for model hooks instead of relying solely on shared mutable function properties.

## [2.0.20] - 2026-07-03

### Fixed

- **`null` as an enum default-marker no longer generates the bogus `'null'` string-literal type.** A model can make `NULL` the default of an enum column by listing `null` first in the values: `t.enum([null, 'claude', 'codex'], { defaultValue: null })` (yass-orm uses the first value as the column default; here that's a genuine SQL `NULL`, verified end-to-end). But the type/Zod generators interpolated that `null` naively (`` `'${v}'` ``), emitting the STRING-LITERAL member `'null'` — so the `.d.ts` typed the column as `'null' | 'claude' | 'codex' | null` and the `.zod.ts` as `z.enum(['null', 'claude', 'codex']).nullable()`. The spurious `'null'` member broke every consumer that assigns `entry.col` into a real-value union (observed: ~10 TS2322/TS2345 errors across a downstream app) and would let the Zod schema validate the literal string `"null"` as a legal value.
  - Fix: a shared `enumLiteralMembers()` helper filters `null`/`undefined` out of the option list before quoting, applied at all three enum sites (inline `.d.ts` union, top-level multi-line `.d.ts` union, and `.zod.ts` `z.enum`). Every generated enum type already appends `| null` / `.nullable()`, so a `null` option was redundant there anyway — the union now stays the clean set of real values (+ the existing nullability). Runtime behavior is unchanged (the default was already a real NULL); this only corrects the generated types.
  - Regression tests: `test/generate-types.test.js` covers `enumLiteralMembers()` (drops null/undefined anywhere, applies the format wrapper) plus `mapFieldToTsType()` / `mapFieldToZodSchema()` for both scalar and array-of-enum fields with a leading `null` marker, asserting no `'null'` member survives.

## [2.0.18] - 2026-06-10

### Fixed

- **errno 1170 on changing an indexed column to a TEXT/BLOB type** ("BLOB/TEXT column used in key specification without a key length"). When a column starts as an indexed `VARCHAR` (a prefix-less index, legal for varchar) and a later schema revision turns it into `t.text`/`t.object` (longtext), schema-sync emitted the `CHANGE COLUMN ... longtext` in the column-diff pass, which runs **before** index reconciliation — so the old prefix-less index was still attached when the column flipped to TEXT, and MySQL/Vitess rejected it. Root-caused on the CI bastion's PlanetScale sub-sync against `ai_dataset_items.sourceUrl` and `messages.channelMessageId` (hard-failed `schema-sync` with code 1 every tick).
  - Fix: before applying the column alters, a pre-pass drops any **prefix-less** index that references a column being changed to a TEXT/BLOB type. The index pass then recreates any the schema still declares, now with the implicit `(255)` prefix length. Only triggers on the exact drift case (a column changing to text while a prefix-less index exists), so it is dormant on already-correct databases.
  - Regression test: `test/schemaSync.textColumnReindex.test.js` establishes the indexed-varchar state, flips the column to `t.text`, and asserts zero sync errors + a prefixed index survives.
- **Silent ADD/CHANGE-column drops now fail loud.** schema-sync's per-statement apply could resolve without error yet leave a column absent — observed on the CI bastion, where an `ADD COLUMN` "succeeded" (the parallel sync worker's connection never committed it under connection pressure) and schema-sync reported "completed successfully," only to surface one stage later as a confusing `Unknown column` precommit failure.
  - Fix: after applying its column alters, `mysqlSchemaUpdate` re-reads the table and records a sync error for any column it just ADD/CHANGEd that is not actually present (`findMissingSchemaColumns`, now exported). Scoped to this run's changes so it never false-positives on pre-existing columns.
  - Regression test: `test/schemaSync.missingColumnVerification.test.js` deterministically simulates the silent drop (a sabotaged `ADD` that runs a valid no-op) and asserts the missing column is reported as an error.

## [2.0.17] - 2026-06-10

### Fixed

- **Orphaned connection-pool leak in `MySQLDialect.createPool` when post-create setup fails.** `createPool` creates the mariadb pool and then, for PlanetScale `ONLY_FULL_GROUP_BY` mode (`disableFullGroupByPerSession`), runs `SET sql_mode=...`. That query leases a connection, so on a slow/contended server it can fail (e.g. `"retrieve connection from pool timeout after 20000ms"`) — and the error was thrown **without closing the pool that had just been created**. The pool's connections were never returned to the caller, never cached (`getDbh` only populates `connCache` at the very end, after this point), and never closed, so they lingered server-side until idle-timeout. Under load + `retryIfConnectionLost` retries this stacked up duplicate pools for the **same** key and exhausted the server's `max_connections` (root-caused on a CI bastion: a `SET`-query timeout on the first metrics write orphaned a ~140-connection pool, the retry created a second one → 281 live connections for one key, two `~connectionLimit`-sized pools crossing the 300 cap).
  - Fix: wrap the post-create `SET sql_mode` in try/catch and `pool.end()` the pool before re-throwing. Safe because the pool is not yet returned/cached/shared — closing it has no in-flight-caller risk.
  - This is the true root cause of the orphan that 2.0.16's `closeReplacedPool` only partially mitigated; the orphaned pool was created on the `createPool` setup-failure path, not the `ignoreCachedConnections` replacement path.
- Regression test (`test/MySQLDialect.createPool-cleanup.test.js`) injects a failing setup query and asserts the pool is closed.

## [2.0.16] - 2026-06-09

### Fixed

- **Orphaned connection-pool leak on the `retryIfConnectionLost` recovery path.** When a pooled connection died (`"socket has unexpectedly been closed"` / `"connection closed"`), `retryIfConnectionLost` recovered by requesting a fresh pool via `dbh({ ignoreCachedConnections: true })`, which overwrote `connCache[key]` and **silently abandoned the previous pool without closing it**. The old pool's open connections lingered server-side (`Sleep`/idle) until idle-timeout (~10 min), or indefinitely. Under load this stacked up multiple ~`connectionLimit`-sized pools for the *same* key and exhausted the server's `max_connections` (observed in CI: two ~160-connection pools for one key crossing a 300-connection MySQL cap → `ERROR 1040: Too many connections`, which then starved every later query).
  - Fix is **opt-in** via a new `closeReplacedPool: true` option on `dbh()`: when set and an existing cached pool is being replaced, the old pool is closed (`.end()`, best-effort/guarded) once the new pool is wired up. `retryIfConnectionLost` now passes this flag on its recovery retry — the only path that knows the old pool is abandoned.
  - Plain `dbh({ ignoreCachedConnections: true })` is **unchanged**: it still hands out a fresh handle WITHOUT closing the previous pool, because that form is also used to obtain an additional handle while existing references stay live (schema-sync, test setup). Closing there would yank the pool out from under live callers.
- Added a regression test (`test/dbh.ignore-cached-closes-old.test.js`) covering both the opt-in close and the preserved no-close-by-default reuse contract.

## [2.0.13] - 2026-05-15

### Fixed

- **`dbh.create`, `dbh.createIgnore`, and `dbh.upsert` default `idGenerator` is now a function reference.** The previous default `idGenerator = uuid()` evaluated the *result* of calling `uuid()` (a fresh UUID string) at each call, so any caller that hit the `fields[idField] = idGenerator()` auto-id path without passing a function got `TypeError: idGenerator is not a function`. `Model.create` always passed its own `idGenerator`, so this latent bug never bit through that path — surfaced when business-coach started calling `dbh.createIgnore` directly via `Model.withDbh`. Default is now `idGenerator = uuid` (the function from `require('uuid').v4`).
- Added a regression test that toggles `config.uuidLinkedIds = true` and calls `dbh.createIgnore` with no `id` and no `idGenerator` to lock in the fix.

## [2.0.12] - 2026-05-15

### Added

- **Atomic at-most-once / upsert primitives.** New `conn.createIgnore(tableAndIdField, fields, opts?)` and `conn.upsert(tableAndIdField, fields, { onDuplicate, conflictColumns, ... })` methods on the dbh, with matching dialect support for MySQL/MariaDB, SQLite, and Postgres.
  - `createIgnore` returns the inserted row on success or `null` on UNIQUE/PK conflict — no race window, no try/catch, no console noise.
  - `upsert` returns the final row whether inserted or updated. `onDuplicate` accepts an array of column names to copy from insert values (safe, parameterized) or an object `{ col: 'sql expression' }` for in-place SQL like `{ count: 'count + 1' }` (raw — not escaped).
  - MySQL uses `INSERT ... ON DUPLICATE KEY UPDATE <col>=<col>` (not `INSERT IGNORE`, which would also swallow CHECK / NOT NULL / FK violations). SQLite and Postgres use `ON CONFLICT DO NOTHING` / `ON CONFLICT (...) DO UPDATE SET ...`. Non-conflict errors still throw on every dialect.
  - `conflictColumns` is required by SQLite and Postgres; MySQL ignores it (infers from matched UNIQUE index).
- **Structured error fields preserved on wrapped query errors.** Errors thrown by `pquery` now expose `.cause` (the original driver error), `.code`, `.errno`, and `.sqlState` so consumers can recognize dup-key / constraint / connection-closed violations without regex-matching the message. The original stack is on `.originalStack`.
- **`silenceErrors` opt threaded through high-level methods.** `conn.search`, `conn.create`, `conn.findOrCreate`, `conn.createIgnore`, and `conn.upsert` accept `{ silenceErrors }` in their opts bag and forward to pquery. Suppresses the `=== Error processing query ===` banner without otherwise altering throw behavior. `createIgnore` and `upsert` default to `silenceErrors: true`.
- **`isUniqueViolation(err)` and `isConstraintError(err)`** exported from the package root. Recognizes wrapped errors (walks `.cause`) across all four supported dialects via structured fields, with message-regex fallback for drivers that strip codes.

### Changed

- The wrapped-error message no longer concatenates the stack trace into `.message`. The stack is now on `.originalStack`. Message still starts with `"Error in query: "` for backward compatibility, so existing string matchers on the prefix continue to work. Matchers on `, original stack:` or the previously-doubled `"Error in query: Error:"` form will break — consumers should switch to the new structured fields.
- Consolidated insert SQL generation into a shared `conn._buildInsertParts(table, fields)` helper so `create` / `createIgnore` / `upsert` share one column/value list construction path.

### Fixed

- `wrapQueryError` now extracts the driver error's `.message` instead of stringifying the whole error, eliminating the duplicate `"Error: "` prefix the old wrapping produced.

## [2.0.11] - 2026-05-10

### Changed (potentially breaking)

- **`bin/schema-sync` now exits non-zero when any ALTER fails.** Previously, per-statement errors were caught, pushed to an internal `sqlErrors` array, logged to stderr, and the bin still exited 0 regardless. CI consumers that check only the exit code (the standard shell convention) silently treated failed syncs as successful — including cases like `ALTER TABLE ... ADD COLUMN` being rejected by lock timeouts, insufficient privileges, or the NOT NULL preflight. The bin now aggregates per-table results and exits `1` if any errors occurred across any table, while still continuing past individual failures so one bad table doesn't hide errors in the rest. If you have CI that depends on schema-sync never failing the build, you'll need to address the underlying errors (or wrap the call) before upgrading.
- **`syncSchemaToDb` now returns a result object** (`{ table, applied, failed, errors }`) instead of `undefined`. Callers can inspect `result.failed > 0` to drive their own policy. The existing side-effect logging is preserved.

### Fixed

- Fix typo in the schema-sync error summary line: "Enountered" → "Encountered". External log-greppers keyed on the old spelling will need to update.
- `dialect.getTableColumns` failures during schema-sync are now recorded in the returned `errors` array instead of being silently warned-and-ignored.

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
