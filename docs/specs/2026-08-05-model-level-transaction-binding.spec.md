# Spec: model-level transaction binding (`{ tx }`)

**Date:** 2026-08-05
**Status:** Approved for implementation
**Design source:** `docs/plans/2026-08-05-model-level-transaction-binding.md`
**Depends on:** first-class transactions shipped in 2.0.21 (`docs/transactions.md`)
**Target release:** 2.1.0 (additive feature, no breaking change)

---

## 1. Goal

Let a caller run several **model-layer** writes inside one `dbh.transaction()` so they commit or
roll back together, without hand-marshalling `deflateValues` / id generation / hooks / inflation at
the call site.

```js
await BCTask.withDbh((dbh) =>
    dbh.transaction(async (tx) => {
        const task = await BCTask.create({ title: 'Relay audit result' }, { tx });
        const work = await BCTask.create({ title: 'Scope the email CLI' }, { tx });
        await BCTaskLink.create({ fromTask: work, toTask: task }, { tx });
        await task.patch({ status: 'in_progress' }, { tx });
        return task;
    }, { isolationLevel: 'serializable', maxRetries: 2 }),
);
```

`tx` is the transaction handle yielded by `dbh.transaction()`. It is passed **explicitly**; there is
no ambient/`AsyncLocalStorage` context (see §7.2).

## 2. Public API surface

Every change is additive and occupies an options slot that either already existed or was reserved.

| Method | Before | After |
|---|---|---|
| `static create(data)` | `create(data /* , params */)` | `create(data, { tx } = {})` |
| `instance.patch(data)` | `patch(data /* , params */)` | `patch(data, { tx } = {})` |
| `instance.remove()` | `remove(/* , params */)` | `remove({ tx } = {})` |
| `static get(id, opts)` | `{ allowCached, span }` | `{ allowCached, span, tx }` |
| `static search(f, limitOne, poolCfg)` | 3 positional | `search(f, limitOne, poolCfg, { tx } = {})` |
| `static searchOne(f, poolCfg)` | 2 positional | `searchOne(f, poolCfg, { tx } = {})` |
| `static findOrCreate(f, pi, pif, opts)` | `{ useTransaction, transactionOptions }` | `+ { tx }` |

### 2.1 `search` / `searchOne` argument ergonomics

`search`'s third parameter is already `promisePoolMapConfig`, so a fourth options object is
awkward and `searchOne(fields, { tx })` is the shape a caller would naturally reach for — and would
silently land in the pool-config slot.

**Decision:** accept `tx` from **either** position.

- Canonical: `search(fields, limitOne, poolConfig, { tx })`, `searchOne(fields, poolConfig, { tx })`
- Also honored: a `tx` key on the `promisePoolMapConfig` object, so `searchOne(fields, { tx })` and
  `search(fields, false, { tx })` work as written.

The explicit fourth-argument form wins if both are present. `tx` is stripped before the object
reaches `promisePoolMap`.

### 2.2 Hooks

`afterCreateHook` and `afterChangeHook` are invoked with `{ tx }` merged into their existing
argument (`afterChangeHook({ wasCreated, tx })` on the `findOrCreate` path). Existing hooks that
declare no parameters are unaffected.

**Behavioral note for the changelog:** a user hook that performs its own DB writes and does *not*
accept and forward `tx` will write **outside** the caller's transaction — those writes commit even
if the transaction rolls back. The signature is backward compatible; the meaning is not.

### 2.3 Global change hooks

`runGlobalChangeHooks` payloads gain a `tx` property (the handle, or `undefined` outside a
model-level transaction). Hooks still fire at the same points — i.e. **before commit** — so a
consumer that needs commit-only semantics can now detect the case and defer. Firing them at the
same point preserves existing behavior for every current consumer.

## 3. Correctness requirements

These are the three findings from the design doc. Each one is a silent-failure mode, so each gets a
positive, adversarial test in §5.

### 3.1 Reads must join the transaction

An uncommitted row is invisible to every other connection. `get`, `search`, and `searchOne` must
therefore accept `tx` and run on it, or a caller cannot read back what it just wrote. This mirrors
`tx.roQuery`'s existing refusal to route to a read replica.

### 3.2 `tx` must thread through inflation

`create` returns `await this.inflate(createdRow, span)`. `inflate` → `inflateValues` →
`_resolvedLinkedModel` → `ModelClass.get(...)`, which is **a database read**. If `tx` stops at
`dbh.create`, linked fields resolve on a different pooled connection that cannot see the
uncommitted rows, and the returned instance has silently `null` links while the database rows are
correct.

**Requirement:** `tx` threads `create`/`patch`/`get`/`search` → `inflate` → `inflateValues` →
`_resolvedLinkedModel` → `get`, and `patch` → `_updateProperties` → `inflateValues`.

Rejected alternative: skipping link resolution when `tx` is present. Cheaper and has no silent-null
mode, but it makes the return-value *shape* depend on whether a transaction was passed, which is a
worse trap. Threading it properly is the chosen behavior.

### 3.3 Retry must be disabled when `tx` is supplied

`retryIfConnectionLost` is correct outside a transaction and dangerous inside one: if the pinned
connection drops, the transaction is dead, and retrying a single statement on a fresh connection
lands that write **outside** the transaction — committed, unrollbackable, while the surrounding
transaction rolls back.

**Requirement:** when `tx` is supplied, call it directly with no retry wrapper. Retry granularity
belongs to `dbh.transaction({ maxRetries })`, which replays the whole callback.

## 4. Implementation

One helper on `DatabaseObject`, used by every converted method:

```js
static _runOn(tx, callback) {
    // Inside a transaction: no retry wrapper. A dropped connection kills the whole
    // transaction; retrying one statement on a new connection would land it OUTSIDE
    // the transaction. dbh.transaction({ maxRetries }) retries at the right granularity.
    if (tx) return callback(tx);
    return this.retryIfConnectionLost(callback);
}

_runOn(tx, callback) {
    return this.constructor._runOn(tx, callback);
}
```

`findOrCreate` with a `tx` calls `tx.findOrCreate(...)` directly. `lib/dbh.js` already short-circuits
its internal transaction when `this._transactionContext` is set, so the work **joins** the caller's
transaction rather than opening a savepoint.

`tx` wins over `useTransaction` / `transactionOptions`. If a caller explicitly passes `tx` together
with an explicit `useTransaction` or `transactionOptions`, log one `console.warn` and use `tx`.

### 4.1 Out of scope

Unchanged in this pass, and documented as such: `find()`, `fromSql()`, `patchIf()`,
`patchWithNonceRetry()`, `queryCallback()`, `withDbh()`, `reallyDelete()`. Callers needing those
inside a transaction should use `withDbh`/raw `tx` helpers directly.

### 4.2 Known limitation: the identity cache

`inflate` populates the per-class instance cache keyed by id. Rows created inside a transaction that
later rolls back leave instances in that cache for ids that no longer exist. This is pre-existing
behavior for the already-transactional `findOrCreate` path and is **not** changed here. Callers that
roll back and then rely on cached reads should call `Model.clearCache()`. Documented in README.

## 5. Test plan (red/green)

Live MySQL, model-layer fixtures under `test/fixtures/`, in `test/obj.transaction.test.js`.

SQLite is deliberately **not** the substrate: it serializes non-transaction queries on the parent
handle behind an active transaction, so an un-threaded read would hang rather than return the wrong
answer — the red phase would time out instead of failing informatively.

| # | Test | Fails without |
|---|---|---|
| 1 | Rollback covers model writes — `create(_, {tx})` several rows, throw, assert all absent | `tx` in `create` |
| 2 | Read-your-own-writes — `create(_, {tx})` then `get(id, {tx})` returns it; `get(id)` outside returns null | `tx` in `get` |
| 3 | `search`/`searchOne` with `{tx}` see uncommitted rows; without `{tx}` they do not | `tx` in `search` |
| 4 | Linked-field resolution inside a transaction returns real objects, not `null` (§3.2) | `tx` in the inflate chain |
| 5 | `patch(_, {tx})` is visible to `get(_, {tx})` and rolled back with the transaction | `tx` in `patch` |
| 6 | No retry wrapper when `tx` is supplied — `retryIfConnectionLost` is not called | §3.3 branch in `_runOn` |
| 7 | Backward compatibility — no-`tx` calls still route through `retryIfConnectionLost` | `_runOn` fallback |
| 8 | `findOrCreate(..., {tx})` joins: creates on the caller's tx and a caller rollback undoes it | `tx` in `findOrCreate` |
| 9 | Hooks receive `tx` — `afterCreateHook` / `afterChangeHook` see the handle | §2.2 |

Test 4 must call `Model.clearCache()` before creating the linking row; otherwise the identity cache
satisfies `_resolvedLinkedModel` from memory and the test passes for the wrong reason.

## 6. Documentation

- `docs/transactions.md` — new "Model-level binding" section.
- `README.md` — `{ tx }` usage in the transaction area.
- `CHANGELOG.md` — feature entry plus the §2.2 hook behavior note.
- `index.d.ts` — options types for the six methods.

## 7. Deliberate non-goals

1. **Ambient transaction context.** An `AsyncLocalStorage` holding the active `tx` would make every
   model call transactional with no signature change, and would also let an unrelated call deep in a
   stack silently join a transaction it knows nothing about, and let hooks outliving the callback
   inherit a dead handle. Explicit `{ tx }` for this pass — a deliberate no, not an omission.
2. **A single-options-object overload for `search`.** Mitigated by §2.1 rather than solved by a
   larger signature change.
3. **Making global change hooks commit-aware.** Payload now carries `tx` so consumers can decide;
   yass-orm does not defer them.
