import { expectType } from 'tsd';
import {
	TransactionCancelledError,
	TRANSACTION_CANCELLED,
	type DbHandle,
	type TransactionHandle,
} from 'yass-orm';

declare const db: DbHandle;

// The callback's handle can cancel and report doom; it is still a DbHandle.
db.transaction(async (tx) => {
	expectType<TransactionHandle>(tx);
	expectType<boolean>(tx.cancel(new Error('deadline')));
	expectType<boolean>(tx.cancel());
	expectType<boolean>(tx.isDoomed());
	const asDbHandle: DbHandle = tx;
	await tx.transaction(async (nested) => {
		expectType<boolean>(nested.cancel('from nested'));
	});
	return asDbHandle;
});

const err = new TransactionCancelledError(new Error('deadline'));
expectType<'YASS_TRANSACTION_CANCELLED'>(err.code);
expectType<unknown>(err.reason);
expectType<'YASS_TRANSACTION_CANCELLED'>(TRANSACTION_CANCELLED);
