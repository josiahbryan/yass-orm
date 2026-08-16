# yass-orm

Yet Another Super Simple ORM

Why? Mainly for my personal use in a variety of projects.

## Transactions

Database handles support callback-based transactions across MySQL, MariaDB,
PostgreSQL, and SQLite:

```javascript
await Model.withDbh((dbh) =>
  dbh.transaction(
    async (tx) => {
      await tx.pquery('UPDATE accounts SET balance = balance - :amount WHERE id = :id', {
        id: fromAccountId,
        amount,
      });

      // roQuery stays on the same transaction connection; it never uses a replica.
      const rows = await tx.roQuery('SELECT balance FROM accounts WHERE id = :id', {
        id: fromAccountId,
      });
      return rows[0];
    },
    { isolationLevel: 'serializable', maxRetries: 2 },
  ),
);
```

The callback result is returned on commit. Thrown errors roll back and are
re-thrown. Nested transactions use savepoints. Supported options include
portable isolation levels, `readOnly`, PostgreSQL `deferrable`, SQLite
`mode`, and opt-in conflict retries with `maxRetries`.

`findOrCreate()` is transactional by default, using serializable isolation on
MySQL/MariaDB and PostgreSQL and immediate mode on SQLite. Pass
`{ useTransaction: false }` in its existing options position to opt out.

### Model-level binding (`{ tx }`)

Model methods accept the transaction handle directly, so several model writes
can land atomically without dropping to the raw dbh surface:

```javascript
await BCTask.withDbh((dbh) =>
  dbh.transaction(
    async (tx) => {
      const task = await BCTask.create({ title: 'Relay audit result' }, { tx });
      const work = await BCTask.create({ title: 'Scope the email CLI' }, { tx });
      await BCTaskLink.create({ fromTask: work, toTask: task }, { tx });
      await task.patch({ status: 'in_progress' }, { tx });

      // Reads must join too, or they cannot see the writes above.
      return BCTask.get(task.id, { tx });
    },
    { isolationLevel: 'serializable', maxRetries: 2 },
  ),
);
```

`{ tx }` is accepted by `create`, `patch`, `remove`, `get`, `search`,
`searchOne`, and `findOrCreate`. `search`/`searchOne` also accept `tx` in their
`promisePoolMapConfig` slot, so `searchOne(fields, { tx })` works as written.

Three things this does that a naive pass-through would not:

- **Reads join the transaction.** An uncommitted row is invisible to any other
  connection, so `get`/`search` must run on `tx` to read your own writes.
- **`tx` threads through inflation.** Linked-field resolution is a database
  read; without threading, links to rows created earlier in the same
  transaction resolve to `null` while the database rows are correct.
- **Per-statement retry is disabled.** Retrying one statement on a fresh
  connection would land the write *outside* the transaction. Use
  `dbh.transaction({ maxRetries })`, which replays the whole callback.

`findOrCreate(fields, patchIf, patchIfFalsey, { tx })` **joins** the caller's
transaction rather than opening its own; `tx` takes precedence over
`useTransaction` / `transactionOptions`.

Model hooks (`afterCreateHook`, `afterChangeHook`) and global change hooks now
receive `tx`. A hook that performs its own DB writes and does not forward `tx`
will write outside the transaction — those writes commit even if the
transaction rolls back.

One known limitation: `inflate` populates the per-class identity cache, so rows
created inside a transaction that later rolls back leave cached instances for
ids that no longer exist. Call `Model.clearCache()` after a rollback if you
rely on cached reads.

See [docs/transactions.md](docs/transactions.md) for complete dialect
semantics, retry guidance, `findOrCreate` signatures, and the API audit.

## MySQL string-literal normalization (`ANSI_QUOTES`)

As of 2026-08, yass-orm rewrites double-quoted **string literals** to single-quoted
ones on the MySQL path, so the same SQL means the same thing whether or not the
server runs with `ANSI_QUOTES`.

### Why

Under default `sql_mode`, `"upm%"` is a string. Under `ANSI_QUOTES` it is an
**identifier**. So a query written like this:

```javascript
await Model.fromSql('linkedTransactionId LIKE "upm%"');
```

succeeds against a primary and fails against an `ANSI_QUOTES` read replica with
`ERROR 1054 unknown column 'upm%'` — routing-dependent, intermittent, and with an
error message that points you at the schema rather than at your quoting.

The normalization runs at the dialect chokepoint (`MySQLDialect.transformSql`),
so it covers both `dbh.pquery` and `dbh.roQuery` — and therefore `Model.fromSql`,
`Model.search`, and raw handle queries.

### What it does and does not touch

The rewrite **splices the original SQL source**, replacing only the double-quoted
runs. It does not parse and reserialize, so your whitespace, keyword case, and
comments come back byte-for-byte.

| Input | Result |
| --- | --- |
| `... LIKE "upm%"` | rewritten to `... LIKE 'upm%'` |
| `-- note "quoted prose"` | left alone — a quote inside a comment is prose |
| `'say "hi"'` | left alone — content of a single-quoted string |
| `` `we"ird` `` | left alone — content of a backticked identifier |
| `CREATE INDEX ... meta->>"valence" ...` | left alone — DDL is never rewritten |
| unterminated string or `/*` | left alone — input returned untouched |

Escaping is handled by decoding out of the double-quote context and re-encoding
into the single-quote one, so `"O'Brien"`, `"say ""hi"""`, `"back\\slash"` and
`LIKE "%50\% off%"` all survive with their values intact. A naive
search-and-replace corrupts every one of those.

DDL is excluded for a text-matching reason rather than a semantic one:
`meta->>'valence'` means the same thing as `meta->>"valence"`, but it no longer
matches the index definition MySQL reports back, which would make `schemaSync`
drop and recreate the index on every run.

### Caveat

Do **not** feed this SQL that was authored *for* `ANSI_QUOTES`. There, `"col"` is
meant as an identifier, and it is indistinguishable from a string literal here —
it would be rewritten to the constant `'col'`. Under default `sql_mode` that is
already how MySQL reads it, so this is a no-op for SQL written against a
default-mode primary.

The portable habit is still the best one: **use single quotes for strings.** See
[Best Practice for Portable SQL](#best-practice-for-portable-sql).

## SQLite Support

As of 2026-02, yass-orm supports SQLite as an alternative to MySQL/MariaDB. This enables local development, testing, and lightweight deployments without a MySQL server.

### Configuration

To use SQLite, update your `.yass-orm.js` config:

```javascript
module.exports = {
  development: {
    dialect: 'sqlite',        // or 'sqlite3'
    filename: '/path/to/db.sqlite',  // Use ':memory:' for in-memory database
  },
  shared: {
    schema: 'main',           // SQLite uses 'main' as the default schema
    // ... your commonFields, etc.
  },
};
```

`better-sqlite3` is included as a direct dependency of `yass-orm`, so no separate install is required in consumer projects.
Note: `better-sqlite3` is a native module and may require platform build tooling in some environments.

### What's Automatically Translated

The SQLite dialect automatically transforms common MySQL syntax in your raw SQL queries:

Implementation note: transformations use a parser-first SQL rewrite pass with a quote/comment-safe scanner fallback so literals and comments are not rewritten accidentally.

| MySQL Syntax | SQLite Equivalent | Auto-Translated |
|--------------|-------------------|-----------------|
| `:name` params | `$name` | Yes |
| `` `identifier` `` (backticks) | `"identifier"` | Yes |
| `col->>"$.path"` (JSON) | `json_extract(col, '$.path')` | Yes |
| `col->"$.path"` (JSON) | `json_extract(col, '$.path')` | Yes |
| `CONCAT(a, b, c)` | `(a \|\| b \|\| c)` | Yes |
| `NOW()` | `datetime('now')` | Yes |
| `LIMIT 10, 5` | `LIMIT 5 OFFSET 10` | Yes |

### ORM Methods Work Transparently

All high-level ORM methods work without changes:
- `.search({ field: value })`
- `.searchOne({ field: value })`
- `.fromSql('field = :value', { value })`
- `.get(id)`
- `.create({ ... })`
- `.patch({ ... })`
- `.remove()`
- Schema sync (`syncSchemaToDb`)

### What Consumers Need to Handle

If you write raw SQL via `pquery`/`roQuery`, be aware of these differences:

| MySQL Syntax | Issue | Solution |
|--------------|-------|----------|
| `"string"` (double quotes) | SQLite uses `"` for identifiers | Use `'string'` single quotes |
| `SHOW TABLES/COLUMNS/INDEXES` | MySQL-only commands | Use dialect introspection or avoid |
| `schema.table` | Cross-database semantics differ from MySQL | Avoid assuming MySQL-style cross-database behavior |
| `FULLTEXT` indexes | Not available in SQLite | Use FTS5 or alternative approach |
| `ALTER TABLE ... MODIFY COLUMN` | Not supported directly | yass-orm attempts a safe table rebuild migration; some complex cases may still need manual migration |

### Best Practice for Portable SQL

To write SQL that works on both MySQL and SQLite:

```javascript
// Good - single quotes for strings (SQL standard)
await Model.fromSql("name LIKE '%test%'");

// Avoid - double quotes for strings (MySQL-specific)
await Model.fromSql('name LIKE "%test%"');

// Good - use ORM methods when possible
const results = await Model.search({ name: 'test' });
```

### SQLite Limitations

- **No UUID triggers**: SQLite doesn't have MySQL's `uuid()` function. UUIDs are generated in JavaScript instead.
- **No connection pooling**: SQLite uses a single synchronous connection (handled automatically).
- **No read replicas**: The `readonlyNodes` config is ignored for SQLite.
- **Schema changes**: `ADD COLUMN` is supported; `DROP COLUMN` requires modern SQLite (3.35+) and can still be limited by schema constraints; modifying existing columns uses yass-orm table rebuild migration.

### Running Tests with SQLite

```bash
# Run tests with SQLite dialect
YASS_CONFIG=/path/to/.yass-orm.sqlite.js npm test

# Run specific test file
YASS_CONFIG=/path/to/.yass-orm.sqlite.js npx mocha --exit test/test.js
```

Some tests are intentionally skipped under SQLite where behavior is MySQL-specific (for example, certain cross-database and MySQL-only index inspection cases).

---

## PostgreSQL Support

As of 2026-03, yass-orm supports PostgreSQL as a first-class dialect alongside MySQL/MariaDB and SQLite. This enables production deployments on PostgreSQL with full ORM functionality.

### Configuration

To use PostgreSQL, update your `.yass-orm.js` config:

```javascript
module.exports = {
  development: {
    dialect: 'postgres',        // or 'postgresql', 'pg'
    host: 'localhost',
    port: 5432,
    user: 'myuser',
    password: 'mypassword',
    database: 'mydb',
  },
  shared: {
    schema: 'mydb',
    // ... your commonFields, etc.
  },
};
```

`pg` is included as a direct dependency of `yass-orm`, so no separate install is required in consumer projects.

### What's Automatically Translated

The PostgreSQL dialect automatically transforms common MySQL syntax in your raw SQL queries:

Implementation note: transformations use a parser-first SQL rewrite pass with a quote/comment-safe scanner fallback so literals and comments are not rewritten accidentally.

| MySQL Syntax | PostgreSQL Equivalent | Auto-Translated |
|--------------|----------------------|-----------------|
| `:name` params | `$1, $2, ...` (positional) | Yes |
| `` `identifier` `` (backticks) | `"identifier"` | Yes |
| `col->>"$.path"` (JSON) | `col->>'path'` | Yes |
| `IFNULL(a, b)` | `COALESCE(a, b)` | Yes |
| `CURDATE()` | `CURRENT_DATE` | Yes |
| `LIMIT 10, 5` | `LIMIT 5 OFFSET 10` | Yes |

### ORM Methods Work Transparently

All high-level ORM methods work without changes:
- `.search({ field: value })`
- `.searchOne({ field: value })`
- `.fromSql('field = :value', { value })`
- `.get(id)`
- `.create({ ... })`
- `.patch({ ... })`
- Schema sync (`syncSchemaToDb`)

### What Consumers Need to Handle

If you write raw SQL via `pquery`/`roQuery`, be aware of these differences:

| MySQL Syntax | Issue | Solution |
|--------------|-------|----------|
| `"string"` (double quotes) | PostgreSQL uses `"` for identifiers | Use `'string'` single quotes |
| `SHOW TABLES/COLUMNS/INDEXES` | MySQL-only commands | Use dialect introspection or avoid |
| Stored functions / triggers | Not yet supported in PG dialect | Avoid or use raw PG SQL |
| `AUTO_INCREMENT` | PG uses `SERIAL`/`BIGSERIAL` | Handled automatically by dialect |

### Best Practice for Portable SQL

To write SQL that works across MySQL, SQLite, and PostgreSQL:

```javascript
// Good - single quotes for strings (SQL standard)
await Model.fromSql("name LIKE '%test%'");

// Avoid - double quotes for strings (MySQL-specific)
await Model.fromSql('name LIKE "%test%"');

// Good - use ORM methods when possible
const results = await Model.search({ name: 'test' });
```

### PostgreSQL Type Mapping

| yass-orm Type | PostgreSQL Type |
|---------------|-----------------|
| `t.idKey` | `SERIAL PRIMARY KEY` |
| `t.uuidKey` | `UUID PRIMARY KEY` |
| `t.varchar(N)` | `VARCHAR(N)` |
| `t.text` | `TEXT` |
| `t.int` | `INTEGER` |
| `t.bigint` | `BIGINT` |
| `t.float` / `t.double` | `DOUBLE PRECISION` |
| `t.bool` | `BOOLEAN` |
| `t.json` | `JSONB` |
| `t.blob` | `BYTEA` |
| `t.date` | `DATE` |
| `t.datetime` | `TIMESTAMP` |

### PostgreSQL Limitations

- **No stored functions/triggers**: The PG dialect does not yet support automatic creation of MySQL-style stored functions or triggers.
- **INSERT RETURNING**: The dialect automatically appends `RETURNING *` to INSERT statements to retrieve generated IDs.
- **Connection pooling**: Fully supported via `pg.Pool`.
- **Read replicas**: Supported via `readonlyNodes` config.

---

## Recent changes

---
- 2026-08-09 (2.3.1)
  - (fix) **Seven churn bugs from a code review of the 2.1.1–2.3.0 Postgres work** — six raised by the review, one found while verifying its fixes. All the same shape as the bug that started this work: DDL emitted on an unchanged schema, which on a large table means a metadata lock and stalled writes. Each now has a test (the review applied fixes without adding any).
    - **Partial FULLTEXT indexes rebuilt every sync**: the `fulltext` branch of `generateCreateIndex` returned *before* appending `WHERE`, so the desired signature carried a predicate the DDL never emitted — permanently unequal, a full GIN rebuild each run.
    - **Every MySQL FULLTEXT index carrying `textSearchConfig` rebuilt every sync** — the key was gated on `isFullText` alone, not on the dialect having the concept, so it entered the desired signature on MySQL where introspection can never report one. **Verified red/green on live MySQL (1 rebuild → 0).** This one hit the primary dialect.
    - **Partial indexes with a JSON accessor in the predicate rebuilt every sync** (my find, not the review's): schemas spell `meta->>'$.x'`, the transformer resolves it to a bare key in the DDL, so Postgres reports `meta ->> 'x'` while the desired side kept `'$.x'`. The predicate canonicalizer now uses the same shared JSON converter as the column path, nested paths included.
    - **Hand-scoped index names over 63 chars rebuilt every sync** — an already-prefixed name skipped the length fitting, so Postgres truncated it silently and the lookup never matched.
    - **Partial indexes with a JSON predicate over ordinary columns rebuilt every sync** — the JSON branch tested the whole definition for `->>`, reporting `(status, priority)` as one pseudo-column.
    - **Every `t.uuid` column reported CHANGED forever** — Postgres spells `CHAR(36)` back as `character(36)` with no diff normalization, costing a no-op ALTER plus errno-1170 index churn each sync. Affects `char(36)` link columns under `uuidLinkedIds` too.
    - **`where` on a raw-SQL index spec was silently dropped** — no predicate, no warning. Now emitted where supported, warned where not.

---
- 2026-08-09 (2.3.0)
  - (change) **Postgres index names are now table-scoped, deterministically.** MySQL scopes index names to their table, so `users.idx_status` and `orders.idx_status` coexist; Postgres does not (an index is a relation in `pg_class`, unique per schema), so the second table to declare `idx_status` failed with `relation "idx_status" already exists` — and those are exactly the names people reuse. On Postgres the declared name is now prefixed with the table name (`users_idx_status`), extending the convention already used for the automatic `isDeleted` index. Deterministic, and idempotent: a name already starting with `<table>_` is left alone, so nothing is double-prefixed.
    - **Postgres only.** MySQL needs no prefixing. SQLite is also database-global but deliberately excluded — prefixing would rename the indexes of every existing SQLite database for a collision nobody has reported, while Postgres has no installed base (the dialect only started working in 2.1.3). New `dialect.prefixIndexNamesWithTable`, false by default.
    - **63-char limit handled.** Postgres silently truncates longer identifiers (only a `NOTICE`), and prefixing lengthens names — so an over-long name would be asked for, stored truncated, never found, and recreated every sync. Truncation now appends an 8-char digest of the *full* intended name: stable across runs, and two names sharing a long prefix stay distinct. New `dialect.maxIdentifierLength`.
    - **The stale-index sweep had to be taught the difference** — it drops any index not declared in the schema, and comparing raw schema keys against prefixed physical names would have dropped every index the same sync just created (an endless loop). It now compares physical names.
    - **Migrating an existing Postgres database takes one pass:** the bare-named index is dropped by the sweep while the prefixed one is created, then it goes quiet. Covered by a live test including the "then settles" half. Messages still show the name you wrote; only DDL and lookups use the physical name.
  - (test) Filled the coverage gaps in the earlier Postgres work, found by auditing what was actually asserted: index-name scoping (15 unit + 3 live), **live** text-search-config switching english→spanish→english (3 tests — 2.1.4 shipped that verified only by hand), `mapType('varchar')` (the bare varchar `t.string` produces — fixed in 2.1.3 but only the live column type had been asserted), and SQLite partial-index predicate introspection (added in 2.2.0 with no test at all).

---
- 2026-08-08 (2.2.1)
  - (fix) **Partial-index predicates are compared via a real SQL AST, restoring the fidelity 2.2.0 traded away.** 2.2.0 normalized predicate *text* and, unable to tell whose parentheses were whose, had to drop them all — which meant `a AND (b OR c)` and `(a AND b) OR c` compared equal, so a pure re-grouping went undetected. `node-sql-parser` was already a dependency (the Postgres transformer uses it), so the new `lib/sql-transform/indexPredicate.js` parses the predicate and canonicalizes from the tree: grouping lives in the tree's **shape**, so redundant parens vanish for free while real structure survives. Both groupings are now distinguished; `a AND b` still equals `((a) AND (b))`.
  - (fix) **AND/OR precedence is repaired.** `node-sql-parser` chains booleans strictly left-to-right and ignores precedence — it reads `a OR b AND c` as `(a OR b) AND c`, which is not what SQL means. Postgres reports predicates correctly parenthesized, so uncorrected this meant an unparenthesized mixed predicate could never match the catalog and rebuilt on every sync.
  - (fix) Two silent failures found while building it: a top-level parenthesized predicate recursed infinitely (stack overflow swallowed by the `catch`, degrading quietly to the lossy path), and the cast stripper allowed spaces in type names (needed for `character varying`) so `::text ~~ ` ate the operator after it. Multi-word types are now enumerated explicitly.
  - (verified) Live PostgreSQL 16, 15 predicate spellings including nested grouping and unparenthesized mixed AND/OR: create → 17 built, resync twice → **0** DDL, change one predicate → exactly **1** rebuild. The LIKE family churned on the first live run despite passing canned unit strings — a `varchar` column reports as `((email)::text ~~ 'a%'::text)`, not `(email ~~ …)` — which is what exposed the greedy-cast bug. 17 new unit tests; the 2.2.0 test that asserted grouping-blindness is inverted to assert the distinction.

---
- 2026-08-08 (2.2.0)
  - (feat) **Partial (filtered) indexes** via `where` on an index spec: `idx_live: { cols: ['status'], where: '"isDeleted" = false' }`. `where` is **raw dialect SQL** — deliberately not parsed or rewritten — so on Postgres a camelCase column must be quoted by the author (`"isDeleted"`), since Postgres folds unquoted identifiers to lowercase.
    - **MySQL/MariaDB cannot do partial indexes at all** (verified on MySQL 8.4.2: `CREATE INDEX ... WHERE` is a syntax error). Postgres and SQLite can. New `dialect.supportsPartialIndexes` capability.
    - On MySQL the behavior splits on `unique`, and it is a correctness distinction: a **non-unique** partial index degrades to a FULL index with a warning (superset of rows → results still correct, just a larger index; dropping it would be the worse regression), while a **unique** one is **skipped** with a loud error — `unique: true` + `where: 'isDeleted = 0'` is the "unique among live rows" pattern, and as a full UNIQUE index it would *reject* rows the predicate excluded (a second soft-deleted row with the same email). Silent data rejection is never an acceptable degradation.
  - (feat) **Nested JSON paths now work** — `meta->>'$.a.b'`. Previously `$.` was merely stripped, leaving the single key `'a.b'` that no row has: valid SQL, so it silently returned NULL forever on both the query and index sides. Postgres needs the **different operator** `#>>` with a `text[]` path for depth > 1. New `lib/sql-transform/postgresJsonPath.js` is shared by the query transformer *and* the index DDL generator — if those two disagreed the index would be dead weight the planner can never match, so tests assert they emit the same accessor. Array subscripts (`$.items[0].name`) become path steps. Verified end-to-end against a live server.
  - (fix) **The dormant partial-index introspection gap.** Postgres column lists were parsed with a greedy `/\((.+)\)$/`, so a partial index's `WHERE` clause was swallowed into the column list (`status) WHERE ("isDeleted" = false`) — meaning any hand-created partial index churned on every sync. Now uses balanced-paren extraction, which also fixes nested parens in expression indexes.
  - (fix) **Predicates compare semantically, not textually** — the hard part. Postgres re-renders predicates: it parenthesizes the whole thing *and* each conjunct, quotes identifiers, casts literals, rewrites `IN (...)` as `= ANY (ARRAY[...])`, and reports LIKE/NOT LIKE/ILIKE/`!=` as the operators `~~`/`!~~`/`~~*`/`<>`. Every one of those would mean a rebuild-forever loop. `normalizeIndexPredicate()` folds them all; verified live across 12 spellings — resync twice = **0** DDL, change one predicate = exactly **1** rebuild. Tradeoff (tested and documented): parens are dropped entirely, so the comparison is blind to *re-grouping* (`a AND (b OR c)` vs `(a AND b) OR c`); that is the safe direction to fail, since the alternative was a metadata-locked rebuild on every sync. Non-partial signatures stay byte-identical, so upgrading rebuilds nothing.
  - (note) **Postgres index names are unique per SCHEMA, not per table** (unlike MySQL). Two tables each declaring `idx_status` collide — the second fails with `relation "idx_status" already exists`. yass-orm already scopes its automatic `isDeleted` index this way on non-MySQL dialects, but user-declared names pass through as written. Not changed here (auto-prefixing would rename indexes in existing SQLite deployments) — just worth knowing when naming Postgres indexes.

---
- 2026-08-08 (2.1.4)
  - (security) **Patched HIGH `js-yaml` CVE-2026-59870** (quadratic CPU in `!!omap` resolution — `resolveYamlOmap()` does a linear `indexOf` scan inside its per-element loop). Present transitively at `4.1.0` via `mocha@9.2.2`, which pins js-yaml at an **exact** version. A blanket override would have broken eslint, whose line is js-yaml `3.x` (js-yaml 4 removed `safeLoad`), so the overrides are **scoped per parent**: `mocha` → `^4.3.1`, `eslint`/`@eslint/eslintrc` → `^3.15.1` (in range for their declared `^3.13.1`). `npm audit` no longer reports js-yaml; both dependents verified working. Dev-dependency only.
  - (fix) **Postgres text-search config is configurable.** Per index (`{ fulltext: true, cols: [...], textSearchConfig: 'spanish' }` or `tsConfig`) or globally via `config.textSearchConfig`; still defaults to `'english'`. A **changed** config now rebuilds the index — previously switching languages left the old index silently in place, since columns and flags were unchanged. Validated as a plain identifier so a schema file can't smuggle SQL into DDL. MySQL/SQLite signatures are byte-identical, so upgrading triggers no rebuild.
  - (fix) **`t.object`/`t.array` map to JSONB on Postgres**, not TEXT — they carry MySQL's `longtext` storage type, and `t.json` already reached JSONB, so the two spellings disagreed. Round-trips verified end-to-end; works because inflate already tolerates non-strings (`pg` returns parsed objects for jsonb). ALTERs emit an explicit `USING <col>::jsonb`.
  - (fix) **Postgres JSON functional indexes were silently useless.** Schemas use MySQL JSONPath (`meta->>'$.valence'`), but PG's `->>` takes a **key name** — so the index was on a key literally named `$.valence`, which no row can have. Valid DDL, so it built fine and indexed NULL forever; and the query transformer already strips `$.`, so the planner could never match it. Index expressions are now normalized identically to queries, double-quoted paths become single-quoted literals, and the introspected form is canonicalized so these indexes are idempotent (0 churn confirmed). Nested paths (`$.a.b`) are still treated as one key named `a.b`, matching the transformer — consistent and usable, but true nesting needs `#>>'{a,b}'`.
  - (fix) **`dbh({ ignoreCachedConnections: true })` could still poison the shared pool** ("Cannot use a pool after calling end on the pool"). 2.0.19 stopped a throwaway from *replacing* a cache entry but still cached it when the cache was **empty**, so a script whose first database touch is a throwaway handle poisoned every later `dbh()` when it called `end()`. Dialect-agnostic; regression test runs on SQLite.
  - (test) **Model + transaction layer now covered against live Postgres** (10 tests): CRUD, object/array JSONB inflation, `findOrCreate`, `remove()` soft-delete verified on disk, transaction commit/rollback, read-your-own-writes with the identity cache cleared, JSONB inside a transaction, and savepoint rollback. All pass — nothing in the model/transaction layer needed changing beyond the `dbh` fix. `npm run test:postgres` runs both Postgres files; they skip on MySQL runs (640 passing, 0 failing).

---
- 2026-08-08 (2.1.3)
  - (fix) **The Postgres dialect now works end-to-end for the first time.** 2.1.2's FULLTEXT fix could only be verified against canned `pg_get_indexdef()` strings; with a real server (PG 16.14) those strings proved correct character-for-character, but running the sync for real surfaced a stack of latent bugs that made `schema-sync` unusable against Postgres. `npm run test:postgres` now creates a table with three FULLTEXT indexes, syncs the identical schema again, and asserts **zero** DDL. Verified red first: reverting the 2.1.2 `type` fix makes it fail with all three FULLTEXT indexes rebuilding.
  - (fix) **`CREATE TABLE` failed for any schema with the standard commonFields.** `t.bool` carries `default: 0` (a JS number) → `DEFAULT 0`, which Postgres rejects on a boolean column. Since `isDeleted` is a default commonField, essentially no table could be created. Boolean defaults now render as real `true`/`false`, in both `generateFieldSpec` and `generateAlterModifyColumn`.
  - (fix) **No Postgres table ever had a working primary key.** `mapType()`'s `|| 'TEXT'` fallback caught the already-resolved `SERIAL`/`UUID` returned by the key-attr helpers, so `id SERIAL PRIMARY KEY` was emitted as `id TEXT PRIMARY KEY`. Native PG types now map to themselves (as `SQLiteDialect` already did).
  - (fix) **Every `t.string` became `TEXT`** instead of `VARCHAR(255)` — `t.string` converts to a bare `varchar`, which MySQL normalizes and Postgres didn't.
  - (fix) **`ALTER COLUMN TYPE SERIAL` is invalid SQL** (`type "serial" does not exist`); new `alterableType()` maps SERIAL/BIGSERIAL → INTEGER/BIGINT for ALTERs. Also stops emitting `DROP NOT NULL` on primary keys, which Postgres refuses.
  - (fix) **Every column was reported CHANGED on every sync** — the Postgres analogue of the FULLTEXT signature bug. The column diff read Postgres' `information_schema` row as though it were a MySQL `SHOW COLUMNS` row, so its keys (`column_name`, `data_type`, …) matched nothing on the schema field and each compared unequal against `undefined`: a no-op `ALTER` per column, plus the errno-1170 guard dropping and recreating every prefix-less index on them. It also meant the Postgres normalization rules already in the diff never fired, since `k` was never `'type'`. Also fixes `getTableColumns` hardcoding `primaryKey: false` and omitting column lengths, and adds normalization for `integer`==`SERIAL`, `nextval()` defaults, serial `auto_increment`, PK implicit NOT NULL, and `false`/`true` vs `0`/`1` defaults.
  - (chore) `pg` moved to **dependencies**, matching `mariadb`/`better-sqlite3`; still lazy-loaded. New `.yass-orm.postgres.js` config + `npm run test:postgres`. The config carries the SAME commonFields as the other configs on purpose — that is what caught the boolean-default failure.
  - (test) 16 new tests (12 unit + 4 end-to-end). The end-to-end file skips unless the dialect is Postgres, so the MySQL run is unaffected: 627 passing, 0 failing.
  - (known limits) `'english'` is still hardcoded as the text-search config; partial-index (`WHERE`) introspection is still unparsed (dormant — schema-sync never creates one); `t.object` maps to TEXT rather than JSONB; and only schema-sync was exercised — model CRUD/transactions against a live Postgres server remain unverified.

---
- 2026-08-08 (2.1.2)
  - (fix) **Postgres FULLTEXT indexes no longer drop/recreate on every schema-sync** — the Postgres half of the 2.1.1 bug, which that release documented as a known limitation. Postgres expresses full-text as a GIN index over `to_tsvector(...)`, but `PostgresDialect.getTableIndexes` never populated `type`, so every existing index compared as `fulltext: false` against a desired `true` — permanently unequal, so DROP + CREATE ran on every sync, exactly as on MySQL. `type` is now derived from the `USING <method>` clause and reported as `FULLTEXT` only when the method is GIN **and** the definition contains `to_tsvector(` (a plain GIN index on `jsonb` is an ordinary index and must not be flagged).
  - (fix) **GIN/tsvector column parsing returned garbage.** The old parser split the outermost parens on commas, so `USING gin (to_tsvector('english'::regconfig, body))` produced `["to_tsvector('english'::regconfig", "body)"]` — the column list could never match even if `fulltext` did. Full-text definitions now parse by extracting each `to_tsvector()` call's source column, in index order, handling what `pg_get_indexdef()` really emits: `'english'::regconfig`, the `(notes)::text` cast Postgres adds for `varchar`, bare lowercase vs. quoted camelCase identifiers, and `||`-concatenated multi-column expressions.
  - (fix) **Multi-column Postgres FULLTEXT DDL was a syntax error** (latent, found while fixing the above). Postgres' `index_elem` grammar accepts a bare column or a bare function call; any other expression must be parenthesized, and `to_tsvector(...) || to_tsvector(...)` is an operator expression. The tsvector expression is now always wrapped in one extra set of parens — legal for the single-column case too, so no branching.
  - (test) 9 tests in `lib/dialects/test/PostgresDialect.test.js`, all verified red first, covering the introspection cases (single column, `(col)::text` cast, quoted camelCase, multi-column ordering, plain-GIN-is-not-full-text, BTREE/unique regression, PK filtering) and the DDL parenthesization.
  - (needs verification) These are **unit tests over canned `pg_get_indexdef()` strings** — no PostgreSQL server was reachable in this environment, so the end-to-end round trip (create a full-text index, read it back, confirm a second sync emits no DDL) has **not** been run. If real `pg_get_indexdef()` output differs in shape from the canned strings, the parser could still mismatch. See CHANGELOG.

---
- 2026-08-08 (2.1.1)
  - (fix) **FULLTEXT indexes on TEXT columns no longer drop/recreate on every schema-sync.** Schema-sync appends MySQL's implicit `(255)` prefix length for TEXT columns in an index (required for BTREE), but was doing so for FULLTEXT too — and FULLTEXT indexes the whole column, reporting `Sub_part: NULL`. So the desired signature `{"fulltext":true,...,"columns":["body(255)"]}` could never equal the DB's `{"fulltext":true,...,"columns":["body"]}`, and every sync dropped and rebuilt the index. MySQL *accepts* `CREATE FULLTEXT INDEX ... (body(255))` and silently discards the prefix, so each rebuild succeeded and re-armed the mismatch — no error ever surfaced. Each rebuild holds a metadata lock that blocks every write to the table (root-caused from a 120s stall on a 421k-row / 1.1 GB table, with inserts queued behind at 119s/111s/110s). Fixed by gating the prefix bookkeeping on `!isFullText`, which corrects both the signature comparison and the generated DDL at once. BTREE indexes on TEXT columns still get `(255)`. No migration or final rebuild needed — existing FULLTEXT indexes already report `Sub_part: NULL`, so the first sync after upgrading matches and emits no DDL.
  - (fix) Same loop, three more paths closed: an **explicit** prefix on a FULLTEXT column (`cols: ['notes(255)']`) took the "explicit length already present" branch and rebuilt every sync too (explicit `(N)` is now stripped for FULLTEXT); the `(255)` was injected into the signature for **every dialect** even though Postgres/SQLite strip prefixes out of the DDL they emit, so any index on a TEXT column rebuilt on every sync under Postgres (injection now gated to `dialect.name === 'mysql'`); and the errno-1170 pre-drop pass no longer drops FULLTEXT indexes before a `CHANGE COLUMN ... TEXT` — FULLTEXT is always prefix-less and never triggers 1170, so that drop bought nothing and cost the same metadata-locked rebuild.
  - (test) `test/schemaSync.fulltextIdempotency.test.js` covers all three index-spec spellings (`{ fulltext: true, cols: [...] }`, legacy `['fulltext', 'col']`, and explicit `cols: ['notes(255)']`): asserts the created indexes are `FULLTEXT` with `Sub_part: null`, and that a second sync of the identical schema recreates nothing — with a BTREE-on-TEXT control that must still report `Sub_part: 255`. The second assertion is the red-green one; the first passes either way because MySQL silently discards the bogus prefix. A third test flips a FULLTEXT-indexed `varchar` column to `longtext` and asserts the errno-1170 guard leaves the index alone.
  - (note) Under **Postgres**, FULLTEXT indexes still rebuild on every sync for a separate, pre-existing reason: `PostgresDialect.getTableIndexes` does not report index type, so an existing index always compares as `fulltext: false`. Needs GIN/`to_tsvector` detection in PG introspection; out of scope here and unverifiable without a PG server. See CHANGELOG.

---
- 2026-07-27 (unreleased)
  - (security) **Patched HIGH `brace-expansion` advisory [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) / CVE-2026-13149** (DoS via exponential-time expansion of consecutive non-expanding `{}` groups). The package was present transitively at `1.1.12` under `minimatch@3.1.2` (from `eslint-plugin-import`) and `minimatch@4.2.1` (from `mocha`); an npm `overrides` pin of `brace-expansion: ^1.1.16` lifts it to `1.1.16`, which satisfies both parents' declared `^1.1.7` range — no parent upgrade required. Dev-dependency only, not reachable from runtime code. Also clears MEDIUM [GHSA-f886-m6hf-6m8v](https://github.com/advisories/GHSA-f886-m6hf-6m8v).
  - (note) `npm audit` still flags [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (HIGH) on `brace-expansion`: it affects `<= 5.0.7` and is fixed **only** in `5.0.8`, with no 1.x backport. Overriding to `brace-expansion@5` would break `minimatch@3/4`, whose `require('brace-expansion')(...)` call is incompatible with 5.x's named-`expand` CommonJS export (and 5.x requires node `20 || >=22`). See CHANGELOG for the full rationale.

---
- 2026-07-15 (2.0.21)
  - (feat) **First-class transactions for MySQL/MariaDB, PostgreSQL, and SQLite.** `dbh.transaction(callback, options?)` pins the full dbh helper surface to one physical connection, commits callback success, rolls back callback failure, returns the callback value, and uses savepoints for nested transactions. `tx.roQuery` is pinned to the transaction and never routes to a read replica.
  - (feat) Portable isolation options with strict per-dialect validation, read-only transactions, PostgreSQL deferrable transactions, SQLite deferred/immediate/exclusive modes with connection-state restoration, and opt-in retry of recognized serialization/deadlock/busy failures.
  - (fix) **`findOrCreate()` is transactional by default** with safe dialect defaults and two conflict retries. Its existing raw-handle options object and new model-level fourth options argument accept `{ useTransaction: false }`; callers can override defaults with `transactionOptions`. A failed `patchIf` now rolls back a row created earlier in the operation.
  - (docs/test) Added `docs/transactions.md`, TypeScript declarations/generator coverage, dialect lifecycle tests, and SQLite integration coverage for commit, rollback, pinned `roQuery`, isolation restoration, savepoints, retries, and `findOrCreate` atomicity/opt-out.

---
- 2026-07-03 (2.0.20)
  - (fix) **`null` as an enum default-marker no longer generates a `'null'` string-literal type.** A model can make `NULL` the default of an enum column by listing `null` first: `t.enum([null, 'claude', 'codex'], { defaultValue: null })` (yass-orm uses the first value as the column default — here a real SQL `NULL`). The type/Zod generators interpolated that `null` naively into `` `'${v}'` ``, emitting the bogus member `'null'` (`.d.ts`: `'null' | 'claude' | 'codex' | null`; `.zod.ts`: `z.enum(['null', 'claude', 'codex']).nullable()`) — which broke every consumer assigning the column into a real-value union and would let Zod validate the literal string `"null"`. A shared `enumLiteralMembers()` helper now filters `null`/`undefined` out before quoting at all three enum sites; every enum type already appends `| null` / `.nullable()`, so the null option was redundant there. Runtime is unchanged (the default was already a real NULL) — only the generated types are corrected.
  - (test) `test/generate-types.test.js` covers `enumLiteralMembers()` plus `mapFieldToTsType()` / `mapFieldToZodSchema()` for scalar and array-of-enum fields with a leading `null` marker (asserts no `'null'` member survives).

---
- 2026-06-20 (2.0.19)
  - (fix) **Schema-sync silent ADD/CHANGE column drop now self-heals on a fresh connection.** Under CI-bastion connection-pool churn an `ALTER ... ADD COLUMN` could resolve with no error yet never persist; the old post-sync guard re-read on the SAME (churning) connection, so it could pass on a stale view and the drop surfaced one stage later as a confusing "Unknown column" failure (the `ai_agent_memories.userEncodingSnapshot` incident, 2026-06-20: 51 dependent tests failed). `mysqlSchemaUpdate` now records each ADD/CHANGE's exact ALTER `sql` and, after applying, calls `verifyAndHealColumns` (exported) which re-reads on a FRESH connection, re-issues the ALTER for any column that did not persist, re-verifies, and records a loud, retryable error ONLY if it still will not land.
    - Falls back to the shared sync handle when a fresh connection cannot be opened — pool exhaustion is the very condition this guards against, so silently skipping there would disable the check when it is needed most.
    - Degrades to "could not verify" (no error) when a table cannot be re-read, so it never manufactures a false-positive schema-sync failure; the downstream check remains the backstop.
  - (fix) **`dbh({ ignoreCachedConnections: true })` no longer poisons the shared connection cache.** Plain `ignoreCachedConnections` is documented to hand out an EXTRA throwaway handle *without* invalidating existing references, but the handle was still written into `connCache[key]` — so `end()`-ing it left every subsequent `dbh()` resolving to a closed pool ("pool is closed"). The cache is now only (re)written for normal calls, explicit `closeReplacedPool` replacements, and the first-create case — never for a plain extra-handle request. (`closeReplacedPool` behavior is unchanged.)
  - (test) New regression coverage: `verifyAndHealColumns` heal-success / fail-loud / no-op in `test/schemaSync.missingColumnVerification.test.js`, and the cache-poisoning guard in `test/dbh.ignore-cached-closes-old.test.js`.

---
- 2026-05-15 (2.0.13)
  - (fix) **`dbh.create` / `dbh.createIgnore` / `dbh.upsert` default `idGenerator` is now a callable function.** Was `idGenerator = uuid()` (the *result* of calling uuid, i.e. a string) — should always have been `idGenerator = uuid` (the function reference). Latent bug never surfaced through `Model.create` because that path always passed its own generator; the new `dbh.createIgnore` used directly via `Model.withDbh` exposed it as `TypeError: idGenerator is not a function`. Includes a regression test.

---
- 2026-05-15
  - (feat) **Atomic at-most-once / upsert primitives** — `conn.createIgnore(table, fields, opts?)` and `conn.upsert(table, fields, { onDuplicate, conflictColumns, ... })` on the dbh, with matching dialect support for MySQL/MariaDB, SQLite, and Postgres. Replaces the SELECT-then-INSERT-with-catch pattern with a single race-free statement.
    - MySQL uses `INSERT ... ON DUPLICATE KEY UPDATE <col>=<col>` for the ignore path (NOT `INSERT IGNORE`, which would also swallow CHECK / NOT NULL / FK violations); SQLite and Postgres use `ON CONFLICT DO NOTHING` / `ON CONFLICT (...) DO UPDATE SET ...`. CHECK / NOT NULL / FK errors still throw on every dialect.
    - `onDuplicate` accepts an array of column names (safe, parameterized copy from insert values) or an object `{ col: 'sql expression' }` for raw in-place expressions like `{ count: 'count + 1' }`. Array form is preferred — RHS of object form is interpolated, not escaped.
    - `conflictColumns` is required by SQLite and Postgres (SQL standard); MySQL infers the matched UNIQUE index and ignores it.
  - (feat) **Structured error fields preserved on wrapped query errors** — `pquery` now wraps driver errors while keeping `.cause`, `.code`, `.errno`, and `.sqlState` on the thrown Error. The original stack lives on `.originalStack` (no longer concatenated into `.message`, which used to bloat structured logs and break regex matchers). Message still starts with `"Error in query: "` for backward compatibility.
  - (feat) **`silenceErrors` opt threaded through high-level methods** — `conn.search`, `conn.create`, `conn.findOrCreate`, `conn.createIgnore`, and `conn.upsert` accept `{ silenceErrors }` in their opts bag and forward to pquery, suppressing the `=== Error processing query ===` banner. `createIgnore` and `upsert` default `silenceErrors: true` since idempotency operations should not log on expected conflicts.
  - (feat) **`isUniqueViolation(err)` and `isConstraintError(err)` exported** from `yass-orm`. Recognizes wrapped errors (walks `.cause`), checks structured fields first (`.code`/`.errno`/`.sqlState`), and falls back to message regex only when the driver stripped codes. Consumers no longer need to hand-roll dup-key detection in every catch block.
  - (refactor) Consolidated insert SQL generation into a shared `conn._buildInsertParts(table, fields)` helper so `create`/`createIgnore`/`upsert` no longer drift on column/value list construction.
  - (test) New mocha test files cover happy + sad paths for all four areas (24 tests): `test/dbh.error-wrapping.test.js`, `test/dbh.idempotent-insert.test.js`, `test/dbh.silence-errors.test.js`, plus a shared `test/helpers/captureConsoleError.js`.

---
- 2026-05-05
  - (fix) **Schema-sync NOT NULL backfill diagnostics** - Schema sync now preflights ALTERs that make an existing nullable column `NOT NULL` and reports the required data backfill instead of surfacing MySQL's opaque "Invalid use of NULL value" error.
    - Counts existing rows where the target column is `NULL` before running the unsafe ALTER
    - Skips the ALTER when NULL rows are present, preserving the previous nullable column until data is backfilled
    - Prints an actionable `UPDATE ... WHERE ... IS NULL` suggestion when the schema has a default value
    - Adds regression coverage for both the diagnostic formatter and end-to-end schema-sync behavior

---
- 2026-03-05
  - (feat) **PostgreSQL Dialect Support** - yass-orm now supports PostgreSQL as a first-class dialect
    - New `dialect: 'postgres'` config option (also accepts `'postgresql'` or `'pg'`)
    - Automatic SQL syntax translation (`:name` to `$N` positional, backticks to double quotes, JSON operators, IFNULL to COALESCE, CURDATE to CURRENT_DATE, LIMIT)
    - Full type mapping (SERIAL, UUID, JSONB, BYTEA, BOOLEAN, DOUBLE PRECISION, etc.)
    - Schema-sync with PostgreSQL type normalization and `information_schema` introspection
    - GIN indexes for fulltext search, expression indexes for JSON columns
    - ALTER COLUMN generates separate TYPE/NULL/DEFAULT statements per PostgreSQL requirements
    - Auto-appends `RETURNING *` to INSERT statements for generated ID retrieval
    - Connection pooling via `pg.Pool` and read replica support
    - Comprehensive dialect unit test coverage (58+ tests)
  - (fix) Updated internal jsonSafeStringify utility to detect running under Bun and proactively de-cycle JSON before stringifying

---
- 2026-02-15
  - (feat) **SQLite Dialect Support** - yass-orm is now polymorphic and supports SQLite as an alternative to MySQL/MariaDB
    - New `dialect: 'sqlite'` config option with `filename` for database path
    - Automatic SQL syntax translation (`:name` → `$name`, backticks → double quotes, JSON operators, CONCAT, NOW(), LIMIT)
    - SQLite schema-sync with automatic table rebuild when existing column definitions must change
    - All ORM methods work transparently (`.search()`, `.fromSql()`, `.create()`, `.patch()`, etc.)
    - Comprehensive dialect unit/integration coverage for both SQLite and MySQL dialect behavior
    - See "SQLite Support" section above for full documentation
  - (feat) **Dialect Abstraction Layer** - New `lib/dialects/` module with `BaseDialect`, `MySQLDialect`, and `SQLiteDialect`
    - `getDialect(config)` factory function returns appropriate dialect instance
    - Each dialect handles SQL transformation, parameter formatting, type mapping, DDL generation
    - Schema introspection methods for tables, columns, and indexes
  - (deps) Added `better-sqlite3` as a direct dependency for SQLite support
  - (fix) **Schema-sync index diff stability for MySQL** - Prevent repeated drop/recreate churn when indexes are already correct
    - Preserves MySQL index prefix lengths from introspection (for example, `metric(230)`)
    - Preserves descending index direction from introspection (for example, `nonce DESC`)
    - Normalizes JSON functional index path forms so `->>"valence"` and `->>"$.valence"` compare equivalently
    - Adds regression tests to lock in these behaviors and prevent future reintroduction
  - (fix) **Schema-sync idempotency for shorthand text indexes** - Aligns index signature comparison with generated MySQL DDL so shorthand text indexes (for example, `action`) compare as `action(255)` and stop re-creating on every sync run
    - Adds explicit schema-sync idempotency regression coverage that runs sync twice and verifies those indexes are not recreated on the second pass
  - (fix) **Schema-sync JSON index quote normalization** - Normalizes single-quoted and double-quoted JSON accessor paths (for example, `->>'$.count'` vs `->>"$.count"`) to a canonical form so they compare equivalently
    - Prevents repeated index recreation when schema uses single quotes but MySQL introspection normalizes to double quotes

---
- 2026-02-06
  - (fix) **Quieter logging for connection-closed errors (08S01)** – When a query fails with "socket has unexpectedly been closed" (SQLState 08S01), the ORM now logs a single line ("Database connection closed, retrying...") instead of the full "Error processing query" block (Raw SQL, Interpolated SQL, stack trace). Retry behavior is unchanged: `retryIfConnectionLost` still runs and retries with a fresh connection. This reduces noisy stderr output in CLIs and logs when the pool occasionally returns a stale connection under concurrent load.

---
- 2026-01-31
  - (feat) **Bundled Executable Support** - Added comprehensive support for bundled executables (e.g., `bun build --compile`) that cannot use filesystem-based module resolution.
  
  - (feat) **Build-Time Definition Path Map** - Set `globalThis.__YASS_DEF_PATH_MAP__` to inject a name-to-path mapping at build time:
    - `getCachedDefinition` checks this object before attempting filesystem resolution
    - Keys are definition names (filename without extension), values are full filesystem paths
    - Enables Bun's `define` option to inject: `define: { 'globalThis.__YASS_DEF_PATH_MAP__': JSON.stringify(map) }`
    - Example usage in build script:
      ```javascript
      await Bun.build({
        entrypoints: ['./src/cli.ts'],
        compile: true,
        define: {
          'globalThis.__YASS_DEF_PATH_MAP__': JSON.stringify({
            'user': '/path/to/defs/user.js',
            'post': '/path/to/defs/post.js',
          }),
        },
      });
      ```
  
  - (feat) **Path Resolver for Bundled Executables** - Set `globalThis.__YASS_ORM_PATH_RESOLVER__` to translate virtual filesystem paths:
    - Both `getCachedDefinition` and `_resolveModelClass` use this resolver as a fallback
    - Translates `/$bunfs/root/...` paths to real filesystem paths (e.g., `/opt/rubber/backend/...`)
    - Enables bundled executables to load definitions and models from disk without pre-registration
    - Example usage:
      ```javascript
      // Early in your entrypoint, before any model imports:
      globalThis.__YASS_ORM_PATH_RESOLVER__ = (path) => {
        if (path.startsWith('/$bunfs/')) {
          return path.replace(/^\/\$bunfs\/root\//, '/opt/rubber/backend/');
        }
        return path;
      };
      ```
  
  - (feat) **External Model Path Index** - Pre-register model classes via `globalThis.__YASS_ORM_MODEL_PATH_INDEX__`:
    - `_resolveModelClass` checks this Map before attempting filesystem-based resolution
    - Paths are normalized by extracting suffix from `/defs/` or `/models/` for consistent lookups
    - Consumer code populates the index via `indexModelClass({ MyModel })` at module load time
    - Zero impact on existing workflows - falls back to normal filesystem resolution if model not in index
  
  - (feat) **External Definition Index** - Pre-register definition functions via `globalThis.__YASS_ORM_DEFINITION_INDEX__`:
    - `getCachedDefinition` checks this Map before attempting `require()` calls
    - New export: `registerDefinition(name, defFn)` - registers a definition function for later lookup
    - Paths are normalized by extracting suffix from `/defs/` for consistent lookups
  
  - (feat) **Debug Logging** - Added `YASS_DEBUG_PATH_RESOLVER` env var to enable verbose logging of path resolution:
    - Logs inputs to `getCachedDefinition` and `loadDefinition`
    - Logs path map lookups and resolutions
    - Useful for debugging bundled executable issues
  
  - (docs) **Why this matters**: Bundlers like Bun embed source files in a virtual filesystem (`/$bunfs/`) but `require()`, `fs.existsSync`, and dynamic `import()` cannot resolve these virtual paths at runtime. The path map and resolver mechanisms translate these paths to real filesystem locations where the source files still exist

---
- 2026-02-05
  - (fix) **Preserve initial `default` value in chainable types** - Fixed a bug where chainable types defined with an initial `default` value (like `t.bool` with `default: 0`) would lose that value when the `.default()` chainable method was attached. This caused `isDeleted` columns (which use `t.bool`) to be created WITHOUT `DEFAULT 0` in the SQL, leading to "Field 'isDeleted' doesn't have a default value" errors on INSERT. The fix preserves the initial default value in `__defaultValue` before the `.default()` method can overwrite it.

---
- 2026-01-28
  - (fix) **`.default()` on types with data `default`** - Chainable types that already had a data property `default` (e.g. `t.bool` with `default: 0`) now get the `.default()` method, so `t.bool.default(false)` works; previously this threw `t.bool.default is not a function`.

---
- 2026-01-14
  - (feat) **🎉 Fluent Schema API** - New chainable, expressive API for schema definitions inspired by Zod and Yup!
    - Chain methods on any type: `t.string.description('...').minLength(1).maxLength(100)`
    - **Universal methods** (all types): `.description()`, `.default()`, `.example()`, `.nullable()`
    - **String methods**: `.minLength()`, `.maxLength()`, `.pattern()`, `.email()`, `.url()`
    - **Number methods**: `.min()`, `.max()`, `.positive()`, `.negative()`, `.nonnegative()`
    - **Array methods**: `.minItems()`, `.maxItems()` (or `.min()`, `.max()` for Zod compatibility)
    - Works with function types too: `t.datetime.description('...')`, `t.enum([...]).default('...')`, `t.linked('user').description('...')`
    - **100% backward compatible** - existing schemas work without modification
    - See [FluentSchemaAPI.md](FluentSchemaAPI.md) for full documentation and examples
  - (feat) **Metadata flows to generated code**:
    - `.description()` → TypeScript JSDoc comments, Zod `.describe()`, MySQL `COMMENT` clauses
    - `.example()` → TypeScript `@example` JSDoc tags
    - Validation methods → Zod validation chains (`.min()`, `.max()`, `.regex()`, `.email()`, etc.)
  - (feat) **Enhanced Zod generation** - Generated `.zod.ts` files now include:
    - `.describe()` calls from schema descriptions
    - Validation methods: `.min()`, `.max()`, `.regex()`, `.email()`, `.url()`, `.positive()`, etc.
  - (feat) **MySQL schema comments** - `_description` metadata now generates `COMMENT` clauses on columns

---
- 2026-01-02
  - (fix) **Runtime honoring of `noExpand` for nested objects** - Fixed `_processObjectSchema` to respect the `noExpand` flag at runtime
    - Previously, even when `noExpand=true` was set during schema definition (preventing SQL column creation), the runtime deflate code would still try to write to those non-existent columns
    - Now `_processObjectSchema` checks `row.noExpand` before expanding subfields to separate columns
    - The `noExpand` flag is now propagated from `def-to-schema.js` through to the runtime schema
    - This fixes "Unknown column 'metadata_fieldName'" errors when using direct `t.object({ ... })` format with nested field definitions

---
- 2026-01-01
  - (fix) **Properly Typed ID Fields and Parameters** - Changed `id: any` to `id: string` throughout type definitions
    - `DatabaseObjectInstanceMethods.id` and `.name` are now `string` instead of `any`
    - All ID parameters in static methods (`get`, `getCachedId`, `setCachedId`, `removeCachedId`) now typed as `string`
    - `DbHandle` methods (`patch`, `get`, `destroy`) now accept `id: string` instead of `id: any`
    - **Why this matters**: When `TSchema & DatabaseObjectInstanceMethods` was computed, `id: string & any` resolved to `any`
    - This prevented TypeScript from catching bugs like passing `session.id` (string) where `session` (object) was expected
    - Now properly typed to preserve type safety in downstream intersection types

---
- 2025-12-30
  - (feat) **Smart Default for Object Schema Expansion** - Direct schema format now defaults to NO SQL column expansion
    - **Direct format** (new): `t.object({ name: t.string, ... })` → defaults to `noExpand=true` (types only, no SQL columns)
    - **Legacy format**: `t.object({ schema: {...} })` → defaults to `noExpand=false` (expands to SQL columns for backwards compat)
    - Override with explicit `noExpand: true/false` if needed
    - Example - **Types only, no SQL columns** (new default for direct format):
      ```javascript
      provenance: t.object({
        sourceType: t.enum(['direct', 'inferred']),
        confidence: t.real,
      })
      // Just creates `provenance` as longtext JSON
      // TypeScript/Zod still know the full shape!
      ```
    - Example - **Expand to SQL columns** (legacy format):
      ```javascript
      provenance: t.object({
        schema: {
          sourceType: t.enum(['direct', 'inferred']),
          confidence: t.real,
        },
      })
      // Creates `provenance_sourceType` and `provenance_confidence` columns
      ```
    - Example - **Force no expansion on legacy format**:
      ```javascript
      provenance: t.object({ schema: {...}, noExpand: true })
      ```
  - (fix) **Improved Zod Output Formatting** - Generated `.zod.ts` files now produce cleaner output
    - Multi-line formatting for `z.input`, `z.output`, and `z.infer` type declarations
    - Enum values stay single-line (prettier will reformat as needed per project)
  - (feat) **Zod Schema Generation** - New `--zod` flag generates runtime validation schemas alongside TypeScript types
    - Generates `.zod.ts` files in the `defs/` folder for each model definition
    - Produces fully-typed Zod schemas that match your database schema exactly
    - Named sub-schemas for nested objects (e.g., `PallasMemorySemanticProvenanceSchema`)
    - Named sub-schemas for array items (e.g., `PallasMemorySemanticRevisionHistoryItemSchema`)
    - Exports inferred types: `PallasMemorySemanticInput`, `PallasMemorySemanticOutput`
    - Exports partial schema for updates: `PallasMemorySemanticPartialSchema`
    - Usage: `generate-types --zod path/to/defs/*.js` (generates both `.d.ts` and `.zod.ts`)
    - Usage: `generate-types --zod-only path/to/defs/*.js` (generates only `.zod.ts`)
  - (feat) **Type Mappings for Zod** - Comprehensive SQL-to-Zod type mapping:
    - `t.uuidKey` / `t.uuid` → `z.string().uuid()`
    - `t.string` / `t.text` → `z.string()`
    - `t.int` → `z.number().int()`
    - `t.float` / `t.real` / `t.number` → `z.number()`
    - `t.boolean` → `z.boolean()`
    - `t.datetime` → `z.coerce.date().nullable()`
    - `t.enum([...])` → `z.enum([...]).nullable()`
    - `t.object({...})` → `z.object({...}).nullable()`
    - `t.array(t.X)` → `z.array(z.X())`
    - `t.linked('model')` → `z.string()` (just the foreign key ID)
    - `t.any` → `z.unknown()`

---
- 2025-12-29
  - (feat) **Nested Object Type Generation** - Type generator now produces proper TypeScript types for complex nested object schemas
    - Direct schema fields in `t.object()` - Use `t.object({ name: t.string, ... })` instead of requiring `t.object({ schema: {...} })`
    - Arrays of objects - `t.array(t.object({...}))` now generates proper `Array<{ field: type; ... }>` types
    - Enums inside nested objects - Generates proper union types like `'option1' | 'option2' | null`
    - Deeply nested structures - Recursive object and array nesting is fully supported
  - (feat) **Named Sub-Types for Complex Fields** - Complex nested objects are extracted as separate exported interfaces
    - Object fields generate interfaces like `PallasMemorySemanticProvenance`
    - Array item types generate interfaces like `PallasMemorySemanticRevisionHistoryItem`
    - Sub-types reference each other properly (e.g., `reasoningChain?: ProvenanceReasoningChainItem[]`)
    - Main instance interface uses named types instead of inline types for cleaner, reusable code
  - (feat) **New Type Definitions** - Added missing type definitions commonly used in schemas
    - `t.bigint` - For large integers, stored in native BIGINT-compatible columns and exposed as `string` in TS for JS number safety
    - `t.uuid` - For UUID fields that aren't primary keys (char(36), generates `string` in TS)
    - `t.any` - For generic/unknown values (longtext, generates `unknown` in TS)
    - `t.number` - Alias for `t.real`/`t.float` (double, generates `number` in TS)
    - `t.array()` without arguments now works (generates `unknown[]` in TS)
  - (fix) **Improved `toPascalCase`** - Now correctly handles camelCase input
    - `reasoningChain` → `ReasoningChain` (was incorrectly `Reasoningchain`)
    - Kebab-case and snake_case continue to work as before
  - (fix) **Filtered Expanded Sub-Fields** - SQL column expansions (like `provenance_sourceType`) are now excluded from TypeScript interfaces
    - Only the main object field appears in the interface
    - Cleaner, more accurate TypeScript types that match how you actually use the data

---
- 2025-12-25
  - (feat) **Linked Model Type Generation** - Type generator now produces proper typed imports for linked models instead of `string`
    - TypeScript model links (`.ts`) import the class type directly, preserving custom methods and ORM methods
    - JavaScript model links (`.js`) import the generated `Instance` interface from the `.d.ts` file
    - Bare module names (e.g., `t.linked('account')`) are automatically resolved using yass-orm's resolution logic
    - Handles both standard pattern (`models/defs/`) and sibling pattern (`db/defs/` + `db/models/`)
  - (feat) **Workspace-Relative Import Paths** - New `--workspace-roots` CLI option for cleaner imports
    - Usage: `generate-types --workspace-roots "backend,shared" path/to/defs/*.js`
    - When linked models cross workspace roots, imports use clean paths (e.g., `'backend/src/db/models/user'`)
    - Avoids ugly deeply-nested relative paths (e.g., `'../../../../../backend/src/db/models/user'`)
  - (feat) **Instance Interface Extends ORM Methods** - Generated `*Instance` interfaces now extend `DatabaseObjectInstanceMethods`
    - Automatically includes ORM instance methods like `jsonify`, `patch`, `remove`, etc.
    - No need to manually add these to your custom interfaces
  - (fix) **Improved Model Resolution for defs/ Directories** - Fixed bare module name resolution for type generation
    - Standard pattern: `defs/` as child of `models/` → looks in parent `models/` folder
    - Sibling pattern: `defs/` as sibling of `models/` → looks in sibling `models/` folder
    - Ensures linked model imports point to model files, not definition files

---
- 2025-12-24
  - (feat) **Generic Instance Type Parameter for DatabaseObjectStatic** - Added second generic parameter `TInstance` to `DatabaseObjectStatic` interface
    - Allows frameworks to specify custom instance return types for all static methods
    - Default: `DatabaseObjectInstance<TSchema>` for backwards compatibility
    - Enables extending without re-declaring all methods - just specify your instance type:
      ```typescript
      interface MyModelStatic<T> extends DatabaseObjectStatic<T, MyInstanceType<T>> {
        // Only add your custom methods here
      }
      ```
    - All static methods (`search`, `get`, `create`, etc.) now use `TInstance` for return types
  - (feat) **New Exported Types** - Added clean separation of instance and static interfaces
    - `DatabaseObjectInstanceMethods` - Base instance methods (patch, remove, jsonify, etc.)
    - `DatabaseObjectInstance<TSchema>` - Schema fields + base instance methods
    - `DatabaseObjectStatic<TSchema, TInstance>` - Full static interface with configurable instance type
  - (feat) **Smart Output Path for Type Generation** - Improved `.d.ts` output location logic to handle multiple directory patterns
    - **Standard pattern (`models/defs/`)**: Output goes to parent `models/` folder for JS models, stays in `defs/` for TS models
    - **Sibling pattern (`db/defs/` alongside `db/models/`)**: Output goes to sibling `models/` folder for JS models
    - TypeScript models always have types generated in `defs/` to avoid `.ts`/`.d.ts` conflicts
    - JavaScript models have types generated next to the model file for TypeScript auto-discovery
  - (feat) **Automatic Cleanup of Old Type Files** - Generator now removes `.d.ts` files in alternate locations
    - When generating to `models/`, removes stale files in `defs/` and vice versa
    - Prevents duplicate type definitions that could cause TypeScript confusion
    - Cleanup respects `--dry-run` flag for safe previewing
  - (feat) **Custom Header Comment Injection** - New `--header-comment` CLI option for adding regeneration instructions
    - Usage: `generate-types --header-comment "To regenerate: npm run generate-model-types" path/to/defs/*.js`
    - Comments appear in the generated `.d.ts` file header
    - Helps future engineers understand how to regenerate types
  - (feat) **Generic Type Parameters for DbHandle Query Methods** - Added TypeScript generics to `query`, `pquery`, and `roQuery` methods
    - All three methods now accept an optional type parameter for type-safe query results
    - Example: `dbh.roQuery<{ count: number }>('SELECT COUNT(*) as count FROM users')`
    - Backwards compatible - defaults to `any` if no type parameter provided
    - Eliminates need for local `DbHandle` interface definitions in consuming code

---
- 2025-12-23
  - (feat) **Enum Type Support** - Added native `t.enum()` type to schema definitions
    - Usage: `t.enum(['option1', 'option2'], { default: 'option1' })`
    - Stored as varchar in database, generates TypeScript union types
    - Supports `options` array for validation and type generation
  - (feat) **Improved Array Type Generation** - Array fields now generate proper TypeScript array types
    - `t.array()` fields now generate `string[]`, `number[]`, `boolean[]`, or `any[]` instead of `Record<string, unknown>`
    - Type generator detects item types when using `t.array(t.string)`, `t.array(t.int)`, etc.
    - Backwards compatible - runtime behavior unchanged, only type generation improved
  - (fix) **TypeScript Model File Support** - Added support for `.ts` model files in linked model resolution
    - `_resolveModelClass` now checks for `.js`, `.ts`, `.cjs`, and `.mjs` extensions in order of preference
    - Enables converting model files from JavaScript to TypeScript without breaking linked model relationships
    - Configurable via `MODEL_EXTENSIONS` static property on `DatabaseObject`

---
- 2025-12-18
  - (feat) **TypeScript Type Generation** - Added automatic `.d.ts` generation from model definitions
    - New CLI tool: `bin/generate-types` - generates TypeScript declaration files from yass-orm model definitions
    - Supports all field types including enums (generates union types), linked models, objects, and common fields
    - Smart output placement: generates `.d.ts` next to `.ts` model files, or in `defs/` folder for `.js` models
    - Generated types include both instance interfaces (schema fields) and static model types (ORM methods)
    - Includes `withDbh` overloads for both SQL string and callback patterns
    - Usage: `npx yass-orm-generate-types path/to/defs/*.js` or integrate with your build process

---
- 2025-12-14
  - (chore) **TypeScript typings + tooling hardening**
    - Added full `index.d.ts` surface for `DatabaseObject`, including `withDbh` overloads and typed helper exports.
    - Added `tsd` type tests (`npm run test:types`) and wired them into `test`/precommit.
    - Added `tsconfig` path mapping for self-imports and a `test-d/tsconfig.json` for editor/TS server correctness.
    - Improved ESLint config for TypeScript/overloads and added TS import resolver.
    - Typecheck-only configs (`noEmit`) to keep `allowImportingTsExtensions` valid.

---
- 2025-12-09
  - (fix) **Invalid Date Guard in `deflateValue`** - Added protection against invalid Date objects that would throw `RangeError: Invalid time value` when calling `toISOString()`
    - Before calling `toISOString()`, we now check if the Date is valid using `Number.isNaN(date.getTime())`
    - Invalid dates are converted to `null` instead of crashing the query
    - Also wrapped `toISOString()` in try-catch for custom objects with broken implementations
    - This prevents circuit breaker trips in load balancers caused by application bugs being mistaken for database errors
  - (fix) **Safe JSON Handling** - Replaced all direct `JSON.parse()`/`JSON.stringify()` calls with safe wrappers to prevent crashes
    - Added `lib/jsonSafeStringify.js` - Handles circular references gracefully using `JSON.decycle` polyfill, never throws
    - Added `lib/jsonSafeParse.js` - Returns `undefined` on parse failure instead of throwing
    - Updated `dbh.js`, `obj.js`, `finder.js`, `config.js`, `sync-to-db.js`, and `LoadBalancer.js` to use safe wrappers
    - Prevents crashes from circular references or malformed JSON in database operations and error logging
    - All 155 tests pass with the new implementation

---
- 2025-12-05
  - (feat) **ESM Compatibility** - Added support for consuming yass-orm from ES modules
    - yass-orm can now be imported using ESM syntax: `import YassORM from 'yass-orm'`
    - Model files can use ESM-style exports (`module.exports = { default: Model }`) and will be correctly unwrapped
    - `loadDefinition()` now handles `file://` URLs from `parentModule()` when called from ESM contexts
    - Added `fileUrlToPath` helper to convert file URLs to filesystem paths
    - Dynamic `import()` used in `_resolveModelClass` for loading linked model files, ensuring ESM module cache is used for correct `instanceof` checks
    - Global caches (`__YASS_ORM_OBJECT_CACHE__`, `__YASS_ORM_MODEL_CLASS_CACHE__`, etc.) now use `globalThis` to survive ESM module duplication when the same module is loaded via symlink and real path
    - Added comprehensive ESM compatibility test suite (`test/esm-compatibility.test.mjs`)

---
- 2025-11-29
  - (feat) **Graceful Shutdown Support** - Added `closeAllConnections()` function for properly closing all cached database connection pools
    - New export: `closeAllConnections()` - Closes all cached connection pools and clears the cache
    - Returns `{ closed, failed }` object indicating how many pools were successfully closed
    - Prevents connection exhaustion when running CLI scripts that don't properly exit
    - Essential for graceful shutdown in scripts and serverless functions
    - Usage example:
      ```javascript
      const { closeAllConnections } = require('yass-orm');
      
      // In your shutdown handler:
      process.on('SIGTERM', async () => {
        await closeAllConnections();
        process.exit(0);
      });
      ```
    - Also available via `dbhUtils.closeAllConnections()` for existing codebases using that import style

---
- 2025-10-08
  - (chore) **Security Updates** - Ran npm audit and fixed vulnerabilities
    - Fixed all critical and high severity vulnerabilities (reduced from 12 to 3 vulnerabilities)
    - Upgraded `nodemon` from `^2.0.15` to `^3.1.10` to fix semver ReDoS vulnerabilities
    - Remaining 3 moderate severity vulnerabilities are in dev dependency `mocha` and require breaking changes to fix
    - All production dependencies are now secure

---
- 2025-10-06
  - (feat) **Configurable Connection Pool Limit** - Added `connectionLimit` configuration option for connection pools
    - New config option: `connectionLimit` (default: 10) - allows increasing pool size for high-concurrency applications
    - Applied to both primary and read-only connection pools
    - Helps prevent "retrieve connection from pool timeout" errors in applications with high concurrency or long-running queries
    - Especially useful for applications processing large objects that hold connections for extended periods
    - Configure in your `.yass-orm.js` config file under development/staging/production sections
  - (fix) **Silenced Timezone Warnings** - Added `skipSetTimezone: true` option to MariaDB connection pool configurations
    - Eliminates repetitive "setting timezone 'Etc/GMT+0' fails on server" warnings from the MariaDB connector
    - Applied to both primary and read-only connection pools
    - Timezone handling still functions correctly on the client side, just without server-side timezone setting attempts
    - No functional changes to how dates/times are handled - all processing remains UTC-based as before

---
- 2025-10-02
  - (feat) **Database Connection Pool Implementation** - Replaced `createConnection` with `createPool` for improved connection lifecycle management
    - Added connection pooling with `connectionLimit: 10` for both primary and read-only connections
    - Added `idleTimeout: 600` (10 minutes) to automatically close idle connections and prevent "socket has unexpectedly been closed" errors
    - Eliminated manual `USE database` statements as pools automatically handle database selection
    - Applied pooling to both primary write connections and read-only replica connections
    - Improved connection reliability and resource management for high-traffic applications

---
- 2025-09-21
  - (perf) Core under‑the‑hood optimizations for faster hot paths with no API changes required
    - Cached schema metadata per class to cut repeated work:
      - `fields()` now memoizes results using private symbols
      - `idField()` now memoizes results using private symbols
      - Instances reuse the cached fields during construction and updates
    - Replaced several `.forEach`/temporary allocations with tight `for` loops and early exits in hot code paths
    - Reduced repeated calls to `schema()`/`Object.values()` and avoided unnecessary key enumeration where possible
    - Stabilized and streamlined `jsonify` internals:
      - Backward‑compatible behavior preserved (defaults to `{ id, name }`)
      - `{ excludeLinked: true }` includes regular (non‑linked) fields only
      - `{ includeLinked: true }` includes linked models (recursively, respecting each model’s `jsonify`)
      - Lightweight promise guard prevents re‑entrancy/race conditions
    - Minor allocation reductions across `inflateValues`/`deflateValues`/update flows
    - Global `PATH_CACHE` for linked model resolution:
      - Caches resolved file paths to avoid repeated `path.resolve()` calls
      - Speeds up linked model loading when same models are referenced multiple times
    - Overall impact: fewer micro‑allocations, less schema re‑work, better steady‑state throughput

- 2025-09-18
  - (feat) **Exposed `updatePromiseMapDefaultConfig` function** - Added ability to customize global `promisePoolMap` defaults for your application.
    - **New export**: `updatePromiseMapDefaultConfig(newDefaults)` allows changing default concurrency, yieldEvery, and other settings globally
    - **Updated defaults**: Changed default `concurrency` from 5 to 4 and `yieldEvery` from 10 to 8 for better balance of performance and responsiveness
    - **Usage example**: `const { updatePromiseMapDefaultConfig } = require('yass-orm'); updatePromiseMapDefaultConfig({ concurrency: 2, yieldEvery: 5 });`
    - **Affects all operations**: Changes apply to `inflateValues`, `fromSql`, `search`, and all other database operations using `promisePoolMap`
    - **Per-operation override**: Individual operations can still override defaults by passing `promisePoolMapConfig` parameter

- 2025-09-17
  - (feat) **Enhanced event loop responsiveness** - Replaced `Promise.all` with `promisePoolMap` in database operations to prevent event loop blocking during large result set processing.
    - **`inflateValues` method**: Core object inflation now uses `promisePoolMap` instead of `Promise.all` when processing field transformations (dates, JSON, linked models, etc.), affecting ALL database loading operations
    - **`fromSql` method**: Now uses `promisePoolMap` when inflating database rows, yielding control to the event loop every N items (configurable via `yieldEvery`, default: 10)
    - **`search` method**: Similarly enhanced to yield during result processing, preventing UI freezes and allowing other async operations to proceed
    - **`.get()` method**: Benefits from `inflateValues` improvements, so even single record loading is more responsive
    - **`finder.js`**: Updated search result processing to use `promisePoolMap` for better responsiveness during large search operations
    - **Configurable yielding**: All methods accept `promisePoolMapConfig` parameter to customize concurrency and yield frequency based on your application's needs
    - **Backward compatible**: No breaking changes - existing code continues to work with improved performance characteristics
    - This prevents the notorious "blocking the event loop" issue when processing hundreds or thousands of database records, keeping your application responsive

- 2025-06-22
  - (feat) Added comprehensive load balancing system for database read operations in [lib/load-balancing/](lib/load-balancing/) folder.
    -  The system supports multiple strategies including Round Robin (default) and Random selection, plus the ability to add custom load balancers. 
    -  The architecture uses target-based routing with a 3-level configuration hierarchy (global → per-target → per-query) for maximum flexibility. 
    -  To set a custom strategy, use the `LoadBalancerManager` class or extend [the `LoadBalancer` base class](lib/load-balancing/LoadBalancer.js). 
    -  See [lib/load-balancing/README.md](lib/load-balancing/README.md) for comprehensive documentation and usage examples, and check [lib/load-balancing/LoadBalancer.js](lib/load-balancing/LoadBalancer.js) for extensive JSDoc documentation on the interface and implementation patterns.
    -  Note: `LoadBalancer` and the `loadBalancerManager` instance used internally are both exported for creating/setting custom strategies or changing the strategy externally.
  -  (fix) Fixed an assumption in `DatabaseObject` method `withDbh` - previously, if you passed a string as the first arg, it would only execute that as SQL if you ALSO passed a truthy value for the 2nd arg - which for some queries didn't make sense, since not all queries require props. It has been adjusted now so that if the first prop is a string. it will execute the query regardless. (The usual function-style callback as the first arg is still supported, that was not changed.)
  -  (feat) Added pass-thru of any other options passed to the `handle` method internally. This allows requesting a database handle at runtime with different server props/schema props than what is configured.

- 2025-04-12
  - (feat) Added caching of the model classes loaded by _resolvedLinkedModel(), which is called internally when you define a related field using `t.linked('model-class-name')`. This reduces the disk hits considerably, which can significantly increase performance under heavy production loads.

- 2025-05-27
  - (feat) Added detection of JSON index support when syncing schema, and automatically doesn't try to create indexes containing JSON.
  - (fix) Added better error capturing when executing SQL to sync the tables so as to not crash the entire sync for a single problem table, logs errors at end of each table if present.
  - (chore) Documentation update: You can set YASS_ALLOW_DROP=1 in your environment to allow dropping columns when syncing. By default, the sync process DOES NOT drop columns that you remove from your schema to preserve data in case you accidentally removed them.

- 2024-12-26
  - (feat) Added support for fulltext index specifications, extending the index methods below with two ways to specify full-text indexes:

	1. Make an index "fulltext" by setting the first column to "FULLTEXT", for example:

		```javascript
		{
			indexes: {
				idx_ex_ft: ['FULLTEXT', 'name'],
			}
		}
		```

		YASS will use that 'FULLTEXT' string as a "hint" and modify it's accordingly. Instead of generating:
		
		```sql
		 create index idx_ex_ft on example_table (name);
		 ```

		 We will generate:
		 ```sql
		 create fulltext index on example_table (name);
		 ```

		 (Note how the `fulltext` modifier must come before the `index` keyword)

	2. Instead of using the first column, you can provide an index spec as an object with `cols`, `fulltext`, and `unique` props. The `cols` property supports all the same formats described below and is parsed identically as described below, no change to current functionality. The `fulltext` sibling prop is used to enable the same SQL transformation as described above (e.g. `create fulltext index` vs `create index`). The `unique` sibling prop is used to generate a portable unique index (e.g. `create unique index` vs `create index`).

		`columns` is also accepted as an alias for `cols` (identical behavior) -- `cols` remains the canonical/current key; `columns` exists purely so a schema def spelled either way behaves the same instead of silently creating no index. If both `cols` and `columns` are present on the same spec, `cols` wins. Other spellings (e.g. `fields`) are still not recognized and will silently produce no index, exactly as before -- only `cols`/`columns` are accepted keys.

		Example of this style:

		```javascript
		{
			indexes: {
				idx_ex_ft: { fulltext: true, cols: ['name'] },
				idx_ex_unique_email: { unique: true, cols: ['email'] }
			}
		}
		```

		Do not combine `fulltext: true` and `unique: true` on the same index. Full-text indexes and unique indexes are different index types, and a unique full-text index is not portable across supported dialects. Schema sync will skip indexes that request both.

		

- 2024-12-15
  - (feat) Added better support for JSON field indexes by not recreating them every time - we now properly match them to the on-disk explain output and properly detect if they already exist.
  - (feat) Added support for three new ways to specify indexes: Raw SQL (`(name, age DESC)`), array with inline arguments (`['name(255)', 'age DESC', 'isDeleted']`) or 100% manual (`idx_whatever: true`)

	**Documentation on Methods of indexing (Old and New)**

	As a refresher, indexes are specified in your schema like this:

	```javascript
	{
		table: 'example_table',
		schema: {
			id: t.uuidKey,
			name: t.string,
			nonce: t.string,
			props: t.object(),
		},

		indexes: {
			// Different ways to specify an index (see docs below)
			idx_name: ['name'], // (a) "Column-only"
			idx_prop_date: ['props->>"$.date"'], // (b) "JSON"
			idx_nonce: ['nonce DESC'], // (c) "Column + arguments"
			idx_name_and_nonce: '(name, nonce(3))', // (d) "SQL String for Columns"
			idx_manual_whatever: true, // (e) "Full Manual Control"
		},
	}
	```

	Ways to specify an index:

	1. *Column-Only*
		- Example: `idx_foobar: ['foo', 'bar', 'baz']` - self explanatory
		- Columns are each checked to ensure they exist in the schema and any of them do not exist, errors are logged and the index will not be created.
   	1. *JSON*
		- Example: `idx_foobar: ['foo->>'$.bar', 'baz']` - indexes the field 'bar' inside a JSON string stored in column 'foo', and regular column 'baz'
		- This method of indexing previously existed in the codebase, but was enhanced by this update to properly detect the JSON column in the index and not re-create the index every time we run the sync
	2. Column + "arguments"
		- Arguments could be anything valid SQL, like `(255)` or `DESC`
		- Example: `idx_foobar: ['foo(255)', 'bar DESC', 'baz']`
		- This allows you more full-grained control over the index spec while still keeping the schema-verification guarantees that the sync script does (e.g. it still checks your schema to make sure that `foo`, `bar`, and `baz` are valid columns defined in your schema)
    3. SQL String for Columns
		- Example: `idx_foobar: "(foo, bar DESC, baz)"` 
		- The **string MUST start with '(' and end with ')'** - This is just extra validation to ensure you really did mean to give us SQL and didn't just accidentally give us some other string. If you don't wrap it in parenthesis, we will ignore your index completely. The sync process will log an error to the console, but won't stop the sync for the other indexes/
		- We assume you know your SQL well enough that you properly escaped any column names
		- We do NOT parse the string and we do not verify that the columns exist - that's up to you
		- We just give the string to the database like 'create index idx_foobar on whatever_table ${yourStringHere}`
		- **IMPORTANT** Since we don't parse the string, we can't tell if the index on disk in the database has been changed, we just know if the index itself exists (`idx_foobar`) - so if you change the string in your schema, you **MUST** change the index name to force the sync to re-create it, e.g. change it from `idx_foobar` to `idx_foobar_v2` or something - then the sync WILL drop the old `idx_foobar` after creating `idx_foobar_v2`
	4. Full Manual Control
		- Example: `idx_foobar: true`
		- There's nothing else for you to do in the schema besides giving the index name and some truthy value - this just keeps the sync from deleting the index on disk when the sync runs.
		- The rest is up to you to create it however you want, usually by going to the CLI or Workbench and doing some variant of "create index X on TableY as (...)" or "alter table TableY add index Foobar" etc
		- This gives you full control over the index creation, and we don't bother your index at all as long as you tell us the name here.
		- Obviously, it goes without saying, we don't check the column names or anything like that either.

- 2024-11-03

  - (fix) Added explicit warning if you pass more than 3 args to 'findOrCreate' because that would be useless to do anyway.

- 2024-05-02

  - (feat) Added `setOnConnectRetryFailed` to catch retry failure and customize how the library responds. By default, we now call `process.exit(1)` on the assumption that the app will restart.

- 2024-04-11

  - (feat) Added support for functional indices (Requires mysql 8.0.13 or newer.) Using the MySQL JSON operator (`->>`) is now supported when specifying indexes. For example, if you include a key like this in your `indexes` array in a schema:

  ```json
  stripeData_customer: ['stripeData->>"$.customer"'],
  ```

  ... it will be transformed into DDL like the following:

  ```sql
  alter table user_payment_methods add index stripeData_stripeCustomer ((cast(stripeData->>'$.customer' as char(255)) COLLATE utf8mb4_bin));
  ```

  PlanetScale has a wonderful writeup on this and other JSON tips in SQL: <https://planetscale.com/blog/indexing-json-in-mysql#functional-indexes>

  - (feat) Added new config option, `connectTimeout` (units: milliseconds), which defaults to `3000` milliseconds if not specified. Added to support more reliable connections for intercontinental connections (e.g. India>SF)

- 2023-09-11
  - (fix) Updated `debugSql` to properly quote dates in it's string output, making it easier to copy/paste SQL for testing
  - (chore) Added es6 string template syntax helpers internally to the codebase in some spots
  - (feat) Added the ability to override `readonlyNodes`, `disableFullGroupByPerSession`, and `disableTimezone` when calling the `dbh(...)` factory directly - useful for connecting to a specific server instead of a configured cluster, e.g. for reporting, etc
- 2023-04-26
  - Added `utf8mb4_general_ci` to the set of default collations so as to not have to alter entire schemas
- 2023-03-27
  - Added new config field, `enableAlternateSchemaInTableName`, off by default. If true, then you can override default schema in schema definition files with dot notation, such as "schema.tableName". This has the knock-on effect of requiring you to update any tables where you use dot notation to specify the ID field, like "foobar.foobarId" to also include the schema name if you enable this field. So that example would become: "foobarSchema.foobar.foobarId". Note that in previous releases the functionality added by `enableAlternateSchemaInTableName` was ON automatically, so if you ARE using alternate schemas in table names, you must enable this flag to retain the same functionality. This functionality was moved behind this flag to stop breaking older legacy code that relied on embedding the ID field in the table name.
- 2023-02-23
  - Fixed deflating sub-objects with schemas with `undefined` values - previously, if a sub-object had a declared SQL field type but the value was `undefined`, the SQL execution would throw an error about an undefined placeholder. This fix stops adding `undefined` sub-object fields to the deflated values to prevent those SQL errors.
- 2023-02-21
  - Added support for config prop `disableFullGroupByPerSession`. When set to a truthy value, YASS will execute `SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));` once on every connection at initial connection time.
- 2023-02-12
  - Added support for literal 'date' types in MySQL, stored as 'YYYY-MM-DD' on disk and cast to a String in javascript
- 2023-02-07:
  - fix: Added explicit throw-on-null-handle modes to better spot where errors come from inside `retryIfConnectionLost`
- 2023-02-02:
  - Feat: Made `retryIfConnectionLost` a static (and instance) method on `DatabaseObject` to allow for subclasses to override and customize the handle used by their class instances
  - Feat: Added support for `disableFunctions` config option to disable uploading the `match_ration` function and the ID triggers for hosts that don't support functions/triggers (e.g. PlanetScale)
  - Feat: Added support for overriding the config file used for a process by setting a file path in the `YASS_CONFIG` environment variable before starting the process. If set, we will use that file specified and ignore any `.yass-orm.js` or related files.
- 2023-01-30
  - Feat: Added support for config option `disableTimezone` to disable setting the timezone option on the MariaDB connector. Timezone option must not be set when connecting to PlanetScale databases, so set `disableTimezone: true` if you use PlanetScale as your DB host.
- 2023-01-28
  - Chore: Added tests around `debugSql`'s behavior to ensure it stays stable and performs as expected in future releases
  - Fix: Changed `debugSql` to use the same deflation done when writing data to the database (e.g. properly convert dates and booleans to their database values) and now properly quotes non-numeric strings with `'` instead of `"`.
  - Fix: Added `JSON.decycle` polyfill to decycle json objects before stringifying them when outputting error messages to the console.
  - Fix: Changed quoting in `finder.js` to use single quotes when outputting SQL for debugging
- 2022-11-29
  - Feat: Changed multi-schema format from 'x/y' to 'x.y'. This requires the (legacy) method of specifying ID field to always use a schema. So if you had schemas that said "user.userId" to load legacy data, you will need to update that to be "database.users.userId"
- 2022-11-24
  - Feat: Added support for linking schemas to alternate database schemas other than the `db` set in `.yass-orm.js` by specifying a `table` name in the schema like `"databaseSchema/tableName"` (which would be used in SQL as `select * from databaseSchema.tableId where id=123`)
  - Updated schema-sync to support the same special "slash" table names
- 2022-10-06
  - Feat: Added support for a `disableAutoUpdatedAt` on schema definitions to do as it says: Turn off the automatic setting of `updatedAt` fields in the `patch()` method on objects. It is on by default, but you can set `disableAutoUpdatedAt: true` in your schema definition to turn off that behavior now.
- 2022-09-16
  - Fix: Add better nonce failure messages
  - Fix: Regression in nonce failures with JSON.stringify
  - Fix: Added better error messages when it can't find linked models long with traces on where the call appeared to originate from
- 2022-08-11
  - Fix: Don't try to destructure failures in queries for nonces
- 2022-08-10
  - Added `verbose` flag to `patchWithNonceRetry` options and defaulted it to false to quiet some logs that were not strictly required.
- 2022-08-08
  - Bump version to `1.6.5` to reflect recent changes
  - Did `npm audit fix` so `npm audit` runs clean now
  - Updated `package-lock.json`'s `lockFileVersion`
  - Added `QueryLogger` interface as named export to allow users to consume a query log, get last 100 queries executed, and get notified on each new query (and when the query ends). Off by default, to use, first call `QueryLogger.enable()` then `QueryLog.attachListener(callback)`. Also `QueryLogger.getLines()` gets most recent 100 queries. In your `attachListener` callback, you can set an `onFinished` property on the first json argument you receive, and it will be called when the query ends.
  - Made handle creation deferred - i.e. two simultaneous calls to something like `retryIfConnectionLost` will now use the same handle instead of creating a new handle each time. This should have worked in the past, and it does work if you call `retryIfConnectionLost` (or anything that creates a handle) some milliseconds apart. However, if the internal `handle` routine was called while the first `handle` was still connecting (since connections are async), there would be no cached handle (yet), so it would just create another new handle - which would also have to connect. In situations where multiple queries are being run by different parts of the program on cold start (e.g. a server stack booting), this could create hundreds of handles where it really should just have the one cached handle (as needed). This commit fixes that "cold-boot" scenario.
- 2022-08-07
  - Modified `patch` behavior to NOT set ALL the fields, but only the fields explicitly given to `patch` (as long as they are in the schema).
  - Added `patchWithNonceRetry` method (see jsdocs in the code) to help with retrying when nonce changes on disk
- 2022-07-30
  - Added support for pass-thru props from definitions into the JSON schema created for objects, including auto-population of any schema-provided 'options' object. This was added to support passing thru custom fields from the schema into domain code.
- 2022-07-10
  - Changed calls from `path.join` to `path.resolve` to support relative links and other use-cases
  - Changed UUID Primary Key definitions to be `char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` in order to force case-sensitive matches
  - Updated sync-to-db to support a new schema prop, `collation` and properly sync that to MariaDB when changed
- 2022-05-27
  - Added support for a special `nonce` field - when `nonce` is present on a schema, it is enforced in the `DatabaseObject`'s `patch` method - the nonce given in the patch (or stored in memory) MUST equal the `nonce` stored on disk (explicit `SELECT` is done for the `nonce` before patching to compare). If not equal (`===`), then an `Error` is thrown with the `.code` prop on the error set to `ERR_NONCE`. The caller is expected to `get` a new copy from disk and apply the patch again, or verify with user, or any other domain-specific steps desired.
- 2022-04-24
  - Fixed bug in `search(fields)` where `fields` would be modified with deflated values after returning (e.g. if `fields` was `{ flag: true }`, after `search()`, the outer scope's copy of `fields` would be incorrectly changed to `{ flag: 1 }`). This was caused by incorrect `Object.assign` usage internally, which has been rectified in this commit.
  - Version bump to `1.4.6`
- 2022-04-09
  - Added support for `staging` as a valid value for `NODE_ENV`
- 2022-02-16
  - Set `process.env.TZ='UTC'` to ensure consistent Date handling
- 2022-02-06
  - Fixed race condition around cached handles in `dbh.js`
  - Added code timing helper and optimized inflating already inflated values
- 2022-02-04
  - Fixed compatibility with `int(11)` primary keys for schema syncs
- 2022-02-02
  - Added `onHandleAccessDebug` as an external hook to debug handle creation/access. To use, `import { libUtils } from 'yass-orm'` then set `libUtils.handle.onHandleAccessDebug = (dbh, { cacheMiss }) => { ... }` to execute your custom code.
- 2022-01-21
  - Merged support for Read Only nodes to support MySQL clusters
  - Added support for a static `generateObjectId` method that child classes can override to change how IDs are generated
  - Added quotes ('`') around column names in the generated 'create index' SQL
  - Added checking for invalid column names in index definitions and better error messages if invalid column names are found
- 2022-01-13
  - Added `allowPublicKeyRetrieval` to handle options to support newer versions of MySQL
- 2021-12-06
  - Added support for custom `baseClass` in `config.js`
  - Added support for a promise guard in `DatabaseObject.jsonify` to prevent odd recursion errors where sometimes the object would not be properly jsonified if multiple instances running at once
  - Added support for subclasses overriding the caching implementation
  - Updated the caching implementation to properly freshen the cache when mutating the object via patches, etc
  - Added basic `stringify()` function to `DatabaseObject` base class
- 2021-10-30
  - Added support for `mutateJoins` to `finder.js` to inject custom joined tables when searching
- 2021-06-12
  - Added timezone config to mariadb connector to disable the underlying mariadb library from attempting to translate date/time string timezones since we take care to ensure date/time strings are loaded/stored as UTC
- 2021-05-30
  - Updated lodash and hosted-git-info deps due to upstream requirements
  - Added notes on testing and fixed linting errors in test.js
- 2021-04-14
  - Added additional error string to allowed retry errors
- 2021-04-13
  - Updated string/column quotations in generated SQL from the finder methods to support newer SQL constraints
- 2021-04-10
  - Updated generated DML format and matcher logic to support DigitalOcean's managed-MySQL instances
- 2021-04-07
  - Fixed bugs in the .find() routines that handle plain-text matching so it works with the new MariaDB modules
- 2021-03-07
  - Fixed bug in creating new tables with auto-inc IDs
  - Fixed bug in debug_sql with no args
- 2021-01-18
  - Fixed bug creating rows when `uuidLinkedIds` config enabled but the ID key was auto increment
  - Added config option `deflateToStrings` to force stringification of values before submitting to DB. This can work around some weird ForeignKey constraint errors if you encounter them.
  - Fixed ES6 import support for linked models
  - Added `bin/export-schema` to export the schema from the configured database to a set of `defs` and `models`
  - Updated handling of external schemas with primary key columns named something other than 'id' by honoring the convention of "table.field" when specifying the table name in schemas and including the 'legacyExternalSchema' attribute on schemas.
  - Added test suite to precommit hooks
- 2021-01-11
  - Rewrote the `schema-sync` utility from Perl to Javascript, thereby removing any use of Perl in this project.

---

- Fixed Date stringification on insert
- Added auto retry if SQL connection goes away
- Misc bug and linter fixes

---

- Support for UUID primary keys (in the 'id' field)
  - To use, define an 'id' field in your schema using the `t.uuidKey` type. Triggers will automatically be added to that table to set a UUID using the MySQL `uuid()` function.
- `dbh()` accessors on classes are now **async** which means you MUST `await` them to get the handle.
- Uses `mariadb` (<https://www.npmjs.com/package/mariadb>) instead of `mariasql` internally now because `mariasql` failed to build on > Node 10, and I needed Node 12 for some projects
- Updated test suite internally add more coverage
- Removed various service wrappers/emulators that were unused/uneeded (e.g. Feathers/etc)
- Added linting to clean up code quality

## Testing

For tests to run successfully, you will need to do the following steps:

- Copy `sample.yass-orm.js` to `.yass-orm.js`
- Modify `.yass-orm.js` to suit the user/pass for your local DB
- Ensure database `test` exists
- Create two test tables:
  - `create table yass_test1 (id int primary key auto_increment, name varchar(255), isDeleted int default 0, nonce varchar(255));`
  - `create table yass_test2 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));`
- Add another database: `yass_test2`
  - `create table yass_test3 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));`
