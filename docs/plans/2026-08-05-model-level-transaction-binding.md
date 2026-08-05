# Proposal: model-level transaction binding (`{ tx }`)

**Date:** 2026-08-05
**Status:** Proposal, awaiting approval
**Author:** written for Josiah Bryan at his request, out of a Business Coach design session
**Depends on:** the first-class transaction work of 2.0.21 (`docs/transactions.md`)

---

## 1. The problem

2.0.21 gave us real transactions. `dbh.transaction(cb, opts)` leases one connection and pins the full
dbh helper surface to it. That surface is **dbh-level**: `tx.create(table, data)`,
`tx.patch(table, id, data)`, `tx.get(table, id)`.

The model layer cannot reach it. `Model.create()` takes no handle
(`lib/obj.js:1343` — note the already-present `/* , params */` placeholder) and resolves its own:

```js
const createdRow = await this.retryIfConnectionLost((dbh) => dbh.create(...createArgs));
// :427 — retryIfConnectionLost(callback, { handleFactory: () => this.dbh() })
```

`withDbh` (`:1125`) passes the handle as a callback argument and stores it nowhere, and yass-orm uses no
`AsyncLocalStorage` or `async_hooks`, so there is no ambient context a nested `create()` could inherit.
The only transaction-aware model method today is `findOrCreate` (`:1207`), which takes
`{ useTransaction, transactionOptions }` and opens its **own** transaction rather than joining a caller's.

So a caller who wants several model writes to be atomic must drop to the dbh surface and hand-marshal
everything the model would have done:

```js
await BCTask.withDbh((dbh) => dbh.transaction(async (tx) => {
    await tx.create(
        BCTask.table(),
        BCTask.deflateValues({ ...data, createdAt: new Date() }, true),
        { allowBlankIdOnCreate: false, idGenerator: BCTask.generateObjectId },
    );
    // ...repeat for every model, forever
}));
```

That reimplements `create` (`:1343-1372`) at every call site. It loses id generation, deflation,
`afterCreateHook`, and the inflated return value, and it silently rots whenever `create` changes.

## 2. Proposed API

Add an options argument carrying a transaction handle. It occupies the `params` slot both signatures
already reserve, so this is additive and backward-compatible.

```js
await BCTask.withDbh((dbh) => dbh.transaction(async (tx) => {
    const task   = await BCTask.create({ title: 'Relay audit result' }, { tx });
    const work   = await BCTask.create({ title: 'Scope the email CLI' }, { tx });
    const link   = await BCTaskLink.create({ fromTask: work, toTask: task, linkType: 'blocks' }, { tx });
    await task.patch({ status: 'in_progress' }, { tx });
    return task;
}, { isolationLevel: 'serializable', maxRetries: 2 }));
```

**Scope — the minimum coherent set.** `create` alone is not usable; see §3.

| Method | Change |
|---|---|
| `static create(data, { tx })` | Use `tx` instead of `this.dbh()` |
| `instance.patch(data, { tx })` | Same |
| `static get(id, { tx })` | Same. Required to read your own writes |
| `static search(fields, limitOne, poolCfg, { tx })` | Same. Awkward arg position; see §6 |
| `static searchOne(fields, { tx })` | Same |
| `static findOrCreate(f, pi, pif, { tx })` | JOIN the caller's `tx` instead of opening its own |

## 3. Why `create` alone does not work — three findings

These are the reasons a naive one-line patch to `create` would look right and be wrong.

### 3.1 Reads must join, or you cannot see your own writes

An uncommitted row is invisible to every other connection. Without tx-aware `get`/`search`, a caller
who creates a row inside the transaction and then reads it back gets nothing, on a connection that is
not in the transaction. `docs/transactions.md` already makes this point for `tx.roQuery`, which
deliberately refuses to route to a read replica for exactly this reason. The model layer needs the same
property, or the transaction is write-only and unreadable.

### 3.2 `inflate` resolves linked fields via the database — this is the sharp edge

`create` returns `await this.inflate(createdRow, span)` (`:1397`). `inflate` calls `inflateValues`
(`:645`), which for any `linkedModel` field calls `_resolvedLinkedModel(...)` — **a database read**.

So `Model.create(data, { tx })` that threads `tx` into `dbh.create` but not into `inflate` will:

1. Insert the row inside the transaction, correctly.
2. Then resolve its linked fields on a **different pooled connection**, which cannot see any
   uncommitted row written earlier in the same transaction.
3. Return an instance whose linked fields are silently `null`.

Concretely: create task A, create task B, then create a link row `{fromTask: A, toTask: B}`. Inflating
that link row reads tasks A and B — both uncommitted — and resolves both to null. No error. The write
is correct in the database and the returned object is wrong, which is the worst possible failure shape
because nothing surfaces it until something downstream trusts the return value.

**Therefore `tx` must thread all the way through: `create` → `inflate` → `inflateValues` →
`_resolvedLinkedModel`.** Same for `search`/`get` and their inflation paths.

A cheaper alternative worth considering explicitly: when `tx` is present, **skip link resolution** and
return the instance with raw ids, since the caller is mid-transaction and the links are likely
uncommitted anyway. That is less code and has no silent-null failure mode, but it makes the return value
shape depend on whether a transaction was passed, which is its own trap. My recommendation is to thread
it properly; the alternative is noted so the choice is deliberate.

### 3.3 Retry MUST be disabled when `tx` is supplied

`create` currently wraps its write in `retryIfConnectionLost` (`:427`). That is correct outside a
transaction and **actively dangerous inside one**: if the pinned connection drops mid-transaction, the
transaction is dead, and retrying that single statement on a fresh connection writes it **outside the
transaction**, committed and unrollbackable, while the surrounding transaction rolls back. You get a
partial write that the transaction was specifically there to prevent, and no error.

When `tx` is supplied, call `tx` directly with no retry wrapper, and let `dbh.transaction`'s own
`maxRetries` handle retry at the correct granularity — the whole callback, replayed from the start.

## 4. Implementation sketch

One helper, used by every converted method:

```js
// lib/obj.js
static _runOn(tx, callback) {
    // Inside a transaction: no retry wrapper. A dropped connection kills the whole
    // transaction; retrying one statement on a new connection would land it OUTSIDE
    // the transaction. dbh.transaction({maxRetries}) retries at the right granularity.
    if (tx) return callback(tx);
    return this.retryIfConnectionLost(callback);
}
```

Then, in `create`:

```js
static async create(data, { tx } = {}) {
    // ...unchanged id/schema logic...
    const createdRow = await this._runOn(tx, (dbh) => dbh.create(...createArgs));
    // ...unchanged validation...
    const instance = await this.inflate(createdRow, span, undefined, { tx });
    await instance.afterCreateHook({ tx });
    return instance;
}
```

`inflate`/`inflateValues`/`_resolvedLinkedModel` gain an optional `{ tx }` threaded through unchanged
otherwise.

**`afterCreateHook` (`:1026`).** User-defined hooks may perform their own DB work. Pass `tx` so a hook
can join. Existing hooks ignoring the argument are unaffected. Worth calling out in the changelog: a
hook that writes without accepting `tx` will write outside the transaction, which is a behavior change
in meaning even though the signature is compatible.

## 5. Testing

The failure modes here are all silent, so assertions must be positive and adversarial:

1. **Rollback covers model writes.** `Model.create(_, {tx})` several rows, throw, assert every row is
   absent afterward. Without `{tx}` threading this fails — the rows commit.
2. **Read-your-own-writes.** `Model.create(_, {tx})` then `Model.get(id, {tx})` returns it, while a
   concurrent handle outside the transaction does **not** see it.
3. **Linked-field resolution inside a transaction (§3.2).** Create A, create B, create a link row
   referencing both, assert the returned instance's linked fields are the real objects and not null.
   This is the test that fails if `tx` stops at `dbh.create`.
4. **No retry inside a transaction (§3.3).** Force a connection-lost error on a `{tx}` write and assert
   it propagates rather than being retried onto another connection.
5. **Backward compatibility.** Every existing call with no second argument behaves identically,
   including the retry wrapper.
6. **`findOrCreate` joins rather than nesting.** With a caller `tx`, assert no inner transaction is
   opened and that a caller-level rollback undoes what `findOrCreate` created. (Nested transactions use
   savepoints, so the wrong behavior here is subtle rather than fatal — it would commit at the savepoint
   and look fine until the outer rollback.)

## 6. Open questions

1. **`search`'s argument position.** `search(fields, limitOne, promisePoolMapConfig)` already has three
   positional parameters; `{tx}` as a fourth is ugly. Options: accept it as a property on the existing
   `promisePoolMapConfig` object, or add an overload that takes a single options object. Prefer the
   latter, but it is a larger change.
2. **Should `withDbh` set an ambient context instead?** An `AsyncLocalStorage` holding the active `tx`
   would make every model call transactional automatically with no signature changes at all. It is more
   elegant and considerably more dangerous: an unrelated call deep in a stack silently joins a
   transaction it knows nothing about, and hooks or event handlers that outlive the callback would
   inherit a dead handle. Recommend explicit `{tx}` for this pass. Worth a deliberate no rather than
   an omission.
3. **Should passing `{tx}` to `findOrCreate` conflict with `useTransaction: true`?** Suggest `tx` wins
   and `useTransaction` is ignored, with a warning logged if both are set explicitly.

## 7. Why this is worth doing

Without it, every caller that needs multi-model atomicity reimplements `create` inline, and each
reimplementation is a copy that will drift from the real one. The first such call site is the Business
Coach commitment ledger (`managed-apps/business-coach/docs/specs/2026-08-05-commitment-ledger-and-agent-sweep.spec.md`,
§5.2), where four rows across four models must land together or not at all — a half-written commitment
is a dropped follow-up, which is the exact failure that spec exists to eliminate.

More generally: 2.0.21 made transactions correct at the dbh layer. Every consumer of this library works
at the model layer. Right now the two do not meet, so the safe path is also the inconvenient one, and
people will take the convenient one.
