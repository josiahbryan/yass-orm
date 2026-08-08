# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.4] - 2026-08-08

### Security

- **Patched the HIGH-severity `js-yaml` advisory [GHSA/CVE-2026-59870](https://github.com/advisories) — quadratic CPU consumption in `!!omap` resolution.** `resolveYamlOmap()` enforces key uniqueness with a linear `objectKeys.indexOf(...)` scan inside the per-element loop, so resolution degrades to O(n²). Present transitively at **4.1.0** via `mocha@9.2.2`, which pins js-yaml at an **exact** `4.1.0` rather than a range.
  - A blanket top-level override would have been wrong: the other js-yaml line in the tree is **3.14.1** (via `eslint@7.32.0` and `@eslint/eslintrc`), and js-yaml 4 removed `safeLoad`, so forcing 4.x there would break eslint at runtime. The overrides are therefore **scoped per parent**: `mocha` → `^4.3.1` (the patched 4.x), and `eslint`/`@eslint/eslintrc` → `^3.15.1` (the 3.x maintenance line, within their declared `^3.13.1` range).
  - Verified `npm audit` no longer reports js-yaml, and that both dependents still work under the overridden versions (`npm run eslint` clean, full mocha suite green).
  - Dev-dependency only — js-yaml is not reachable from any runtime code path in this package.

### Fixed

- **The Postgres text-search configuration is no longer hardcoded to `'english'`.** It selects the language's stemming and stopword rules, so it is a real schema decision. Set it per index (`{ fulltext: true, cols: [...], textSearchConfig: 'spanish' }`, or the `tsConfig` alias) or globally via `config.textSearchConfig`; it still defaults to `'english'`.
  - A **changed** config is now detected as a changed index. `getTableIndexes` reads the config back off the index definition, and the signature carries it — without that, switching languages left the old index silently in place, since the column list and flags were identical. Verified on a live server: create → 1 build, resync → 0, switch to spanish → rebuild, resync → 0, switch back → rebuild.
  - The value is validated as a plain identifier before being interpolated into DDL, so a config name from a schema file cannot smuggle SQL into a `CREATE INDEX`.
  - **MySQL/SQLite signatures are byte-identical to before.** The key is only set for full-text on a dialect that has the concept, and `JSON.stringify` omits `undefined` keys — so upgrading cannot trigger a mass index rebuild.
- **`t.object` and `t.array` now map to JSONB on Postgres instead of TEXT.** They convert to `{ type: 'longtext', isObject: true }` — the MySQL storage type — which landed in TEXT, throwing away JSONB's operators and indexing for the field type that most wants them. `t.json` already reached JSONB, so the two spellings disagreed about where the same data belongs. Verified end-to-end: an object and an array of strings round-trip through `create`/`get`/`patch` as real `jsonb` columns. This works because the inflate path already tolerates a non-string value (the `pg` driver hands back parsed objects for jsonb, not JSON text). An `ALTER` to JSONB emits an explicit `USING <col>::jsonb`, since Postgres will not cast text to jsonb implicitly.
- **Postgres JSON functional indexes were silently useless.** Schemas spell JSON paths MySQL-style (`meta->>'$.valence'`), but Postgres' `->>` takes a **key name**, not a JSONPath — so the emitted index was on a key literally named `$.valence`, which no row can have. It failed silently in the worst way: the DDL is valid Postgres, so the index built successfully and indexed NULL forever. And because `PostgresSqlTransformer` already strips the `$.` prefix on the **query** side, the planner could never match the index to a query even in principle. The index expression is now normalized identically to the query (`meta->>'valence'`), and double-quoted paths become single-quoted literals (a double-quoted token is an identifier in Postgres). A new `normalizePostgresIndexExpression` converts the introspected form (`((meta ->> 'valence'::text))`) back to the canonical schema shorthand so these indexes are idempotent too — confirmed 0 churn on a second sync.
  - **Known limitation:** a nested path (`$.a.b`) is treated as a single key named `a.b`, matching what the query transformer already does. Both sides agree, so the index is usable and consistent, but genuinely nested lookups need `#>>'{a,b}'` — a separate change spanning the transformer.
- **`dbh({ ignoreCachedConnections: true })` could still poison the shared connection cache** — "Cannot use a pool after calling end on the pool". 2.0.19 stopped a throwaway handle from *replacing* an existing cache entry, but deliberately still cached it when the cache was **empty** ("the first-create case"). So when the very first handle for a key was a throwaway — exactly what a script or test does when its first database touch is a setup/teardown handle — it became the shared handle, and `end()`ing it left every later plain `dbh()` resolving to a dead pool. A throwaway must never become the shared handle, cache empty or not. **Dialect-agnostic** (the regression test runs on SQLite); it surfaced while writing the Postgres model tests.

### Added

- **Model and transaction coverage against a live Postgres server** (`test/postgres.model.test.js`, 10 tests): create/get with object+array inflation, search, patch, `findOrCreate` (both branches), `remove()` soft-delete asserting a real boolean landed on disk, transaction commit, rollback, read-your-own-writes with the identity cache cleared so the read must actually join the transaction, a JSONB round-trip inside a transaction, and nested-transaction savepoint rollback keeping the outer work. All pass; nothing in the model or transaction layer needed changing beyond the `dbh` fix above.
- `npm run test:postgres` now runs both Postgres files. They skip unless the active dialect is postgres, so the normal MySQL run is unaffected (640 passing, 0 failing).
- 8 more `PostgresDialect` unit tests (text-search config: per-index, default, identifier validation, read-back; JSON path: `$.` stripping, quote conversion, query/index agreement, introspection normalization) plus the `t.object`/`t.array` → JSONB cases. Dialect unit suites: 244 passing.

### Known limitations (Postgres)

- Nested JSON paths, as above.
- `getTableIndexes` still parses partial-index definitions (`... WHERE (x IS NULL)`) with an outermost-parens heuristic. Dormant — nothing in schema-sync passes the `where` option, so this library never creates one.

## [2.1.3] - 2026-08-08

### Fixed

**The Postgres dialect now works end-to-end for the first time.** 2.1.2 fixed the Postgres FULLTEXT signature bug but could only verify it against canned `pg_get_indexdef()` strings, because no PostgreSQL server was reachable. With a real server (PostgreSQL 16.14, local Homebrew install) the canned strings turned out to match reality character-for-character — but running the sync end-to-end for the first time surfaced a stack of latent bugs that made `schema-sync` unusable against Postgres. Every one of them is now fixed and covered.

The verification story from 2.1.2 is closed: `npm run test:postgres` creates a table with three FULLTEXT indexes, syncs the identical schema a second time, and asserts **zero** DDL — no column ALTER, no index drop, no index create. Confirmed red first: reverting the 2.1.2 `type` fix makes that test fail with all three FULLTEXT indexes rebuilding, which is the exact production symptom.

- **`CREATE TABLE` failed outright for any schema using the standard commonFields.** `t.bool` converts to `{ type: 'int(1)', default: 0 }` — a JS **number** — which was interpolated bare as `DEFAULT 0`. Postgres rejects an integer default on a boolean column (`column "isDeleted" is of type boolean but default expression is of type integer`); MySQL accepts it, so this only ever failed here. Since `isDeleted` is in the default commonFields, essentially no table could be created. Boolean defaults are now rendered as real `true`/`false` literals, in both `generateFieldSpec` and `generateAlterModifyColumn` (the same bug existed at both sites).
- **No Postgres table ever got a working primary key.** `mapType()` fell back to `'TEXT'` for anything unrecognized, but schema-sync resolves primary keys through `getIntegerPrimaryKeyAttrs()`/`getUuidPrimaryKeyAttrs()` — which return the ALREADY-NATIVE `'SERIAL'`/`'UUID'` — and `generateFieldSpec` maps that resolved type a second time. `SERIAL` was not a key in the map, so `id SERIAL PRIMARY KEY` was emitted as **`id TEXT PRIMARY KEY`**. Native PG types now map to themselves, the same way `SQLiteDialect` already did ("Map SQL types to themselves").
- **Every `t.string` column silently became `TEXT` instead of `VARCHAR(255)`.** `t.string` converts to the bare type `varchar` (no length); MySQL normalizes that to `varchar(255)` in `generateFieldSpec`, and without the same normalization here it hit the TEXT fallback.
- **`ALTER COLUMN ... TYPE SERIAL` is invalid SQL** (`type "serial" does not exist`) — `SERIAL` is CREATE-time shorthand for an integer column plus a sequence, not a real type. New `alterableType()` maps `SERIAL`/`BIGSERIAL`/`SMALLSERIAL` to `INTEGER`/`BIGINT`/`SMALLINT` for ALTER statements.
- **`ALTER COLUMN ... DROP NOT NULL` was emitted for primary keys**, which Postgres refuses (a PK is implicitly NOT NULL). yass-orm's key attrs express that as `key: 'PRI'`, not `null: 0`, so the else-branch fired on every primary key.
- **Every column was reported CHANGED on every sync.** The root cause of the residual churn, and the Postgres analogue of the FULLTEXT signature bug: the column diff builds its comparison map from `col._raw` with lowercased keys, which is specifically a MySQL `SHOW COLUMNS` row (`Field`/`Type`/`Null` → `field`/`type`/`null`, exactly the schema's own field keys). Postgres' `_raw` is an `information_schema` row, so lowercasing yields `column_name`/`data_type`/`is_nullable` — names that exist on no schema field. Each one compared unequal against `undefined`, so every column produced a no-op `ALTER`, **and** the errno-1170 guard then dropped and recreated every prefix-less index on those columns. It also meant the Postgres type-normalization rules already present in the diff (`text` == `longtext`, `boolean` == `int(1)`, …) never fired at all, since `k` was never `'type'`. The `_raw` branch now requires the MySQL shape; other dialects use the normalized structure.
- **`getTableColumns` hardcoded `primaryKey: false`** ("Needs pg_constraint join for accuracy") and omitted declared lengths, so the diff could not recognize a primary key and could not match `character varying(255)`. Both fixed — primary-key membership resolved via `pg_index`/`pg_attribute`, and the reported type now carries its length as MySQL's does.
- **Remaining no-op ALTERs closed** with Postgres normalization rules in the diff: `integer` == `SERIAL`, a `nextval(...)` default against a schema that declares none, `auto_increment` extra on a serial column, a primary key's implicit NOT NULL, and boolean defaults spelled `false`/`true` vs MySQL-style `0`/`1` (via a new `booleanishEquals` helper — note `default: 0` reaches the comparison as `''`, since the diff coerces falsy values).

- `pg` moved from devDependencies to **dependencies**, matching how the other dialect drivers (`mariadb`, `better-sqlite3`) are declared. It remains lazy-loaded, so nothing is required at import time.
- New `.yass-orm.postgres.js` test config and `npm run test:postgres` script. The config deliberately carries the SAME commonFields as `.yass-orm.js`/`.yass-orm.sqlite.js`, so a Postgres run exercises the identical schema shape the other dialects do — which is what caught the boolean-default failure.
- 16 new tests: 12 unit tests in `lib/dialects/test/PostgresDialect.test.js` (native-type identity mapping, boolean DEFAULT coercion across `0`/`1`/`'0'`/`'1'`/`true`/`false`, resolved SERIAL/UUID keys, the four `generateAlterModifyColumn` fixes, and `getTableColumns` primary-key/length normalization) plus 4 end-to-end tests in `test/schemaSync.postgres.idempotency.test.js`. The end-to-end file skips unless the active dialect is Postgres, so it is inert in the normal MySQL run.
- Full MySQL suite: 627 passing, 0 failing — the `_raw` gating change leaves MySQL byte-identical, which is why it is gated on the MySQL row shape rather than on the dialect name.

### Known limitations (Postgres, unchanged by this release)

- The text-search configuration is hardcoded to `'english'` in `generateCreateIndex`. Any deployment needing another language cannot express it.
- `getTableIndexes` still parses partial-index definitions (`... WHERE (x IS NULL)`) with an outermost-parens heuristic that would capture the `WHERE` clause as columns. Nothing in schema-sync passes the `where` option, so this library never creates one.
- `t.object` maps to `TEXT` rather than `JSONB` (it converts to `longtext`, which maps to TEXT). Only `t.json` reaches `JSONB`. Left alone deliberately — changing it would rewrite existing columns.
- Only schema-sync was exercised end-to-end. Model CRUD, transactions, and the SQL transformer against a live Postgres server remain unverified.

## [2.1.2] - 2026-08-08

### Fixed

- **Postgres FULLTEXT indexes no longer drop and recreate on every schema-sync.** Completes the 2.1.1 fix, which closed the MySQL half of the loop and the cross-dialect prefix-length half but explicitly left this open. Postgres expresses a full-text index as a GIN index over `to_tsvector(...)`, and `PostgresDialect.getTableIndexes` never populated `type` — so *every* existing index compared as `fulltext: false` while the desired signature for a full-text index said `true`. Permanently unequal, so `diff` was always true: DROP + CREATE on every run, same infinite loop as the MySQL bug, same metadata-lock cost on a large table.
  - `getTableIndexes` now reports `type`, derived from the `USING <method>` clause: `FULLTEXT` when the method is GIN **and** the definition contains `to_tsvector(`, otherwise the actual method (`BTREE`, `GIN`, `GIST`, …). The `to_tsvector` requirement matters — a plain GIN index on a `jsonb` column is an ordinary index and must not be reported as full-text.
  - **Column parsing for GIN/tsvector indexes was also returning garbage.** The old parser took everything inside the outermost parens and split it on commas, which for `USING gin (to_tsvector('english'::regconfig, body))` yields `["to_tsvector('english'::regconfig", "body)"]` — so even had `fulltext` matched, the column list never could. Full-text definitions are now parsed by extracting the source column of each `to_tsvector()` call, in index order.
  - The parser handles what `pg_get_indexdef()` actually returns, which is a re-render of the parsed expression rather than an echo of the submitted DDL: the regconfig literal comes back as `'english'::regconfig`, a `varchar` argument picks up an explicit `(notes)::text` cast, lowercase identifiers are bare while camelCase ones stay double-quoted, and multi-column indexes concatenate one `to_tsvector()` call per column with `||`.
  - **Multi-column Postgres FULLTEXT DDL was a syntax error as emitted** — a latent bug found while fixing the above. Postgres' `index_elem` grammar accepts a bare column name or a bare function call, but any other expression must be parenthesized; a concatenation of tsvectors (`a || b`) is an operator expression, so `USING GIN (to_tsvector(...) || to_tsvector(...))` does not parse. The tsvector expression is now wrapped in one additional set of parens unconditionally (extra parens around a lone function call are always legal, so single-column indexes are unaffected).
  - 9 tests in `lib/dialects/test/PostgresDialect.test.js` cover the introspection (single column, the `(col)::text` cast, quoted camelCase, multi-column ordering, plain-GIN-is-not-full-text, `BTREE`/unique/multi-column regression, primary-key filtering) and the DDL parenthesization. All 9 verified red first — including the garbage-column failure, which reproduced exactly as `["to_tsvector('english'::regconfig", "bodyText\")"]`.
  - **Verification limit, stated plainly:** these are unit tests over canned `pg_get_indexdef()` strings written from the documented Postgres output format. **No PostgreSQL server was available in this environment, so the end-to-end round trip — create a full-text index, read it back, confirm a second sync emits no DDL — has not been run.** If the real `pg_get_indexdef()` output on your server differs in shape from the canned strings, the parser could still mismatch. Verifying this needs a reachable PG instance (see the `- (needs verification)` note in the README).
  - Not addressed, pre-existing and dormant: `getTableIndexes` still parses partial-index definitions (`... WHERE (x IS NULL)`) with the same outermost-parens heuristic, which would capture the `WHERE` clause instead of the column list. Nothing in schema-sync passes the `where` option to `generateCreateIndex` today, so no partial index is ever created by this library — but a hand-created one on a synced table could churn.

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
