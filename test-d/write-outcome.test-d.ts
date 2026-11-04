import { expectType } from 'tsd';
import {
	DatabaseObject,
	retryIfConnectionLost,
	WriteOutcomeUnknownError,
	WRITE_OUTCOME_UNKNOWN,
	type RetryOptions,
} from 'yass-orm';

// BDL-4470: a write whose outcome is unknown after a lost connection.
const err = new WriteOutcomeUnknownError(new Error('socket closed'));
expectType<'ERR_WRITE_OUTCOME_UNKNOWN'>(err.code);
expectType<unknown>(err.cause);
expectType<'ERR_WRITE_OUTCOME_UNKNOWN'>(WRITE_OUTCOME_UNKNOWN);

// Marking a call idempotent.
const options: RetryOptions = { idempotent: true };
expectType<Promise<number>>(
	retryIfConnectionLost(async () => 1, { idempotent: true }),
);
expectType<Promise<number>>(
	DatabaseObject.retryIfConnectionLost(async () => 1, options),
);
expectType<Promise<number>>(
	DatabaseObject.withDbh(async () => 1, {}, { idempotent: true }),
);
DatabaseObject.withDbh('UPDATE t SET a=1', {}, options);
