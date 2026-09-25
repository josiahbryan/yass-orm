import { expectType, expectError } from 'tsd';
import { sqlHelpers, type DbHandle } from 'yass-orm';

declare const db: DbHandle;

expectType<string>(sqlHelpers.now(db));
expectType<string>(sqlHelpers.addInterval(db, sqlHelpers.now(db), ':m', 'minute'));
expectError(sqlHelpers.addInterval(db, 'x', 1, 'fortnight'));
expectType<{ sql: string; params: Record<string, any> }>(
	sqlHelpers.inList('ids', ['a', 'b']),
);
expectType<string>(sqlHelpers.forUpdate(db, { skipLocked: true }));
expectType<Promise<void>>(sqlHelpers.lockKey(db, 'k'));
expectType<Promise<void>>(sqlHelpers.ensureLockTable(db));
expectType<Promise<{ inserted: boolean; updated: boolean }>>(
	sqlHelpers.upsertWhere(db, 'attempts', {
		values: { key: 'k', failures: 1 },
		conflictColumns: ['key'],
		update: { failures: 'failures + 1' },
		where: 'lockedUntil IS NULL',
	}),
);
expectType<Promise<{ rows: { value: string }[]; affectedRows: number }>>(
	sqlHelpers.readBack<{ value: string }>(db, {
		readFirst: true,
		read: ['SELECT value FROM t WHERE id = :id', { id: 1 }],
		write: ['DELETE FROM t WHERE id = :id', { id: 1 }],
	}),
);
