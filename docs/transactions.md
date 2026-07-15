# First-class transactions

Implemented 2026-07-15 for MySQL, MariaDB, PostgreSQL, and SQLite.

## Summary

yass-orm database handles now expose a callback-based transaction API:

```javascript
const result = await Model.withDbh((dbh) =>
	dbh.transaction(
		async (tx) => {
			const account = await tx.get('accounts', accountId);
			await tx.patch('accounts', accountId, {
				balance: account.balance - amount,
			});
			await tx.create('ledger_entries', {
				accountId,
				amount: -amount,
			});
			return accountId;
		},
		{ isolationLevel: 'serializable', maxRetries: 2 },
	),
);
```

The callback's return value becomes the transaction promise's return value. A
fulfilled callback commits; a thrown error or rejected promise rolls back and
the original error is rethrown. If rollback, cleanup, or connection release
also fails, that secondary failure is attached to the original error rather
than replacing it.

## Connection pinning

MySQL/MariaDB leases one connection from the MariaDB pool. PostgreSQL leases
one `pg.Pool` client. SQLite uses its single database connection and queues
concurrent top-level transactions on that connection. The callback
receives a transaction-scoped handle which inherits the complete dbh helper
surface, while its `query` method is pinned to that lease.

Both `tx.pquery()` and `tx.roQuery()` execute on the transaction connection.
`tx.roQuery()` intentionally does not use a read replica: a replica cannot see
the transaction's uncommitted writes and would violate transaction semantics.

## Options and dialect behavior

```typescript
type TransactionOptions = {
	isolationLevel?:
		| 'read uncommitted'
		| 'read committed'
		| 'repeatable read'
		| 'serializable';
	mode?: 'deferred' | 'immediate' | 'exclusive'; // SQLite only
	readOnly?: boolean;
	deferrable?: boolean; // PostgreSQL only
	maxRetries?: number;
};
```

Isolation names are case-insensitive and accept spaces, underscores, or
hyphens. Invalid or unsupported values fail before the callback runs.

| Dialect | Isolation levels | Access/options | Connection behavior |
|---|---|---|---|
| MySQL / MariaDB | read uncommitted, read committed, repeatable read, serializable | `readOnly` | `SET TRANSACTION ISOLATION LEVEL ...`, then a transaction on one leased pool connection |
| PostgreSQL | read uncommitted, read committed, repeatable read, serializable | `readOnly`, `deferrable` | One `BEGIN ...` statement on one leased pool client; deferrable requires serializable + read-only |
| SQLite | read uncommitted, serializable | `readOnly`, `mode` | `PRAGMA read_uncommitted`, `PRAGMA query_only`, and `BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE` on the single connection; PRAGMA state is restored afterward |

When `isolationLevel` is omitted, the database's configured/default isolation
is retained. SQLite defaults to `BEGIN DEFERRED` for direct transaction calls.
PostgreSQL accepts `READ UNCOMMITTED` but, per PostgreSQL semantics, provides
`READ COMMITTED` behavior. SQLite dirty reads additionally require connections
sharing a cache; yass-orm exposes the supported pragma but does not enable
shared-cache mode automatically.

While a SQLite transaction is active, ordinary queries submitted through the
same parent handle are queued until it finishes. This prevents unrelated async
work from accidentally becoming part of the active transaction merely because
SQLite uses one connection.

## Retries

`maxRetries` defaults to zero. When greater than zero, yass-orm reruns the
entire callback for recognized transaction conflicts:

- PostgreSQL serialization failures and deadlocks (`40001`, `40P01`)
- MySQL/MariaDB deadlocks and lock wait timeouts
- SQLite busy and locked errors

Retries necessarily re-execute the callback. A retryable callback should keep
irreversible external side effects (emails, HTTP calls, queue publication)
outside the transaction or make them idempotent.

## Nested transactions

Calling `tx.transaction()` inside an active transaction creates a savepoint.
Successful nested work releases it; failed nested work rolls back to it, so an
outer callback may catch that error and continue. Nested transactions inherit
the outer isolation/access mode and therefore reject their own options.

## `findOrCreate()` integration

`dbh.findOrCreate()` and `Model.findOrCreate()` now use transactions by
default. This closes the previous gap where a later `patchIf` failure could
leave the newly inserted row committed and gives each dialect a safe default:

| Dialect | `findOrCreate` default |
|---|---|
| MySQL / MariaDB | serializable, up to 2 transaction-conflict retries |
| PostgreSQL | serializable, up to 2 transaction-conflict retries |
| SQLite | immediate, up to 2 busy/locked retries |

Expected retryable conflicts are not printed as query failures during this
automatic path. If all attempts fail, or an error is not retryable, the error
still propagates normally; explicit `silenceErrors` behavior is unchanged.

Raw-handle opt-out (the options object was already the fifth argument):

```javascript
await dbh.findOrCreate(table, fields, patchIf, patchIfFalsey, {
	useTransaction: false,
});
```

Model opt-out:

```javascript
await User.findOrCreate(fields, patchIf, patchIfFalsey, {
	useTransaction: false,
});
```

Callers may replace the defaults with `transactionOptions`. A
`findOrCreate()` invoked inside an existing transaction joins that transaction
instead of creating an unnecessary savepoint.

Per-call action/patch metadata used by model hooks is attached non-enumerably to
each returned row. Legacy `dbh.findOrCreate.lastAction` properties remain for
compatibility, but concurrent model calls no longer read shared mutable
metadata from another operation.

Transactions do not manufacture a uniqueness rule. For cross-process
find-or-create correctness, the identifying columns should still have a
database `UNIQUE` constraint. Prefer `createIgnore()` or `upsert()` when the
desired behavior maps directly to a known conflict key.

## API audit

The other multi-step dbh methods were reviewed for default transaction use:

- `create`, `patch`, `createIgnore`, and `upsert` perform one atomic database
  write followed by a read-back used to return the resulting row. Wrapping
  every call would add pool leasing and transaction round trips without making
  the write more atomic, so they remain unchanged. They automatically remain
  on the pinned connection when called through `tx`.
- `destroy`, `search`, `find`, and `get` are single-statement operations.
- Schema synchronization includes dialect-specific DDL, much of which is not
  transactionally portable (notably MySQL implicit commits), so it was not
  given a misleading all-or-nothing wrapper.

`findOrCreate` is the default-wrapped method because its result and side
effects depend on a read-then-conditional-write sequence and it can also apply
a third `patchIf` step.

## Implementation and verification

- `lib/transactions.js` owns callback lifecycle, pinning, savepoints, cleanup,
  and retry classification.
- Each dialect owns connection leasing, begin/commit/rollback behavior, option
  support, and `findOrCreate` defaults.
- `lib/dbh.js` supplies the inherited helper surface and automatic
  `findOrCreate` integration.
- `index.d.ts` and generated model declarations expose the new options.
- Red-green coverage lives in `test/dbh.transaction.test.js`, lifecycle unit
  tests, live MySQL/MariaDB integration tests, and dialect tests. PostgreSQL's
  leased-client behavior is tested against a `pg`-compatible client wrapper;
  no PostgreSQL service is configured in this repository's test environment.
