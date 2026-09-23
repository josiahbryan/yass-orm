import { expectType, expectError } from 'tsd';
import {
	registerGlobalChangeHook,
	registerCommittedChangeHook,
	onTransactionEnd,
	transactionLocal,
	LOADED_AT,
	DatabaseObject,
	type GlobalChangeHookPayload,
	type CommittedChangeHookPayload,
	type DbHandle,
} from 'yass-orm';

// The global hook's payload carries the write's tx (it runs before COMMIT).
registerGlobalChangeHook((payload) => {
	expectType<GlobalChangeHookPayload>(payload);
	expectType<unknown>(payload.tx);
	expectType<boolean>(payload.wasCreated);
});

// The committed hook's payload has wasDeleted and no tx.
const unregister = registerCommittedChangeHook(async (payload) => {
	expectType<CommittedChangeHookPayload>(payload);
	expectType<boolean>(payload.wasDeleted);
	expectType<string | number>(payload.id);
	expectError(payload.tx);
});
expectType<() => void>(unregister);

declare const tx: DbHandle;
expectType<boolean>(
	onTransactionEnd(tx, {
		commit: () => {},
		rollback: async () => {},
		savepointRollback: () => {},
	}),
);
expectType<boolean>(onTransactionEnd(undefined, {}));
expectType<Set<string> | null>(
	transactionLocal(tx, 'k', () => new Set<string>()),
);

expectType<typeof LOADED_AT>(LOADED_AT);
declare const instance: DatabaseObject;
expectType<number | undefined>(instance[LOADED_AT]);
