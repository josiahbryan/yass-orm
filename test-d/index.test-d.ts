import { expectType, expectError, expectAssignable } from 'tsd';
import {
	loadDefinition,
	DatabaseObject,
	type FinderResult,
	type TriggerSpec,
	type TriggerTiming,
	type TriggerEvent,
} from 'yass-orm';

class MyModel extends loadDefinition('./defs/my-model') {
	hello() {
		return 'world';
	}
}

// Static methods should be available and properly typed.
expectType<Promise<MyModel | null>>(MyModel.get('id_123'));
expectType<Promise<MyModel>>(MyModel.create({ id: 'id_123' }));
expectType<Promise<MyModel>>(MyModel.findOrCreate({ id: 'id_123' }));
expectType<Promise<MyModel>>(
	MyModel.findOrCreate(
		{ id: 'id_123' },
		{},
		{},
		{
			useTransaction: false,
			transactionOptions: { isolationLevel: 'serializable' },
		},
	),
);

// search(): array vs single row based on limitOne flag
expectType<Promise<MyModel[]>>(MyModel.search({ id: 'id_123' }));
expectType<Promise<MyModel | null>>(MyModel.search({ id: 'id_123' }, true));

// BDL-2646: options form returns an ARRAY of instances, never a bare instance.
expectType<Promise<MyModel[]>>(
	MyModel.search({ id: 'id_123' }, { limit: 20, orderBy: 'id', orderDir: 'DESC' }),
);
expectType<Promise<MyModel[]>>(MyModel.search({ id: 'id_123' }, { limit: 5 }));
expectType<Promise<MyModel[]>>(
	MyModel.search({ id: 'id_123' }, { limit: 5, offset: 10 }),
);

// An unsupported key must not type-check. `expectError` is the tsd
// negative control: if the overload were `Record<string, unknown>` this
// line would silently pass and the test would measure nothing.
expectError(MyModel.search({ id: 'id_123' }, { sortBy: ['-datetime'] }));
expectError(MyModel.search({ id: 'id_123' }, { sort: { score: -1 } }));
expectError(MyModel.search({ id: 'id_123' }, { orderDir: 'sideways' }));

// BDL-2700: `searchOne`'s SECOND positional is now a typed options bag, not an
// open `PromisePoolMapConfig`. It still resolves to a single instance or null.
expectType<Promise<MyModel | null>>(
	MyModel.searchOne({ id: 'id_123' }, { orderBy: 'id', orderDir: 'DESC' }),
);
expectType<Promise<MyModel | null>>(MyModel.searchOne({ id: 'id_123' }));
// Pool-config keys keep their old meaning in that slot.
expectType<Promise<MyModel | null>>(
	MyModel.searchOne({ id: 'id_123' }, { concurrency: 2 }),
);

// The negative control that could NOT fire before this ticket. These are the
// two live monorepo call sites; both type-checked clean against the old
// `PromisePoolMapConfig & TxOptions` slot purely because of its
// `[key: string]: any` index signature.
expectError(MyModel.searchOne({ id: 'id_123' }, { sort: { createdAt: -1 } }));
expectError(MyModel.searchOne({ id: 'id_123' }, { sortBy: ['-datetime'] }));
expectError(MyModel.searchOne({ id: 'id_123' }, { orderDir: 'sideways' }));
// `limitOne` is implied by searchOne and rejected at runtime — reject it here too.
expectError(MyModel.searchOne({ id: 'id_123' }, { limitOne: false }));
// `limit`/`offset` contradict the single-row shape.
expectError(MyModel.searchOne({ id: 'id_123' }, { limit: 5 }));

// BDL-2646 fix round 1: `limitOne: true` INSIDE the options object must
// discriminate to a single instance (or null) — matching Task 3's runtime,
// which returns a single row/null for exactly this shape. Getting this
// wrong is the unsafe direction: a caller would type-check `.map()`/`.length`
// on a green build and crash at runtime on a single object or null.
expectType<Promise<MyModel | null>>(
	MyModel.search({ id: 'id_123' }, { limitOne: true }),
);
expectType<Promise<MyModel | null>>(
	MyModel.search({ id: 'id_123' }, { limitOne: true, limit: 5 }),
);
// Negative control on the discrimination itself: WITHOUT `limitOne: true`,
// the exact same other keys must still type as an ARRAY, never a bare
// instance. If the discriminating overload were too greedy (e.g. matched on
// `limit` alone) this would silently narrow to `MyModel | null` and the
// test would measure nothing.
expectType<Promise<MyModel[]>>(MyModel.search({ id: 'id_123' }, { limit: 5 }));

// withDbh() overloads
expectType<Promise<number>>(
	MyModel.withDbh(async (dbh, table) => {
		expectType<string>(table);
		await dbh.pquery(`SELECT 1 FROM ${table} LIMIT 1`);
		expectType<Promise<number>>(
			dbh.transaction(async (tx) => {
				await tx.pquery('SELECT 1');
				return 1;
			}, { isolationLevel: 'repeatable read' }),
		);
		return 123;
	}),
);
expectType<Promise<any>>(MyModel.withDbh('SELECT 1', {}));

// Model-level transaction binding: `{ tx }` on the model write/read surface.
expectType<Promise<MyModel>>(
	MyModel.withDbh(async (dbh) =>
		dbh.transaction(async (tx) => {
			expectType<Promise<MyModel>>(MyModel.create({ id: 'id_123' }, { tx }));
			expectType<Promise<MyModel | null>>(MyModel.get('id_123', { tx }));
			expectType<Promise<MyModel[]>>(
				MyModel.search({ id: 'id_123' }, false, undefined, { tx }),
			);
			// `tx` is also accepted in the promisePoolMapConfig slot, so the shape
			// callers naturally reach for compiles too.
			expectType<Promise<MyModel | null>>(
				MyModel.searchOne({ id: 'x' }, { tx }),
			);
			expectType<Promise<MyModel>>(
				MyModel.findOrCreate({ id: 'id_123' }, {}, {}, { tx }),
			);

			const instance = await MyModel.create({ id: 'id_123' }, { tx });
			expectType<Promise<MyModel>>(instance.patch({ id: 'id_123' }, { tx }));
			expectType<Promise<MyModel>>(instance.remove({ tx }));
			return instance;
		}),
	),
);

// find() returns a packet (not instances)
expectType<Promise<FinderResult<Record<string, any>>>>(
	MyModel.find({ $limit: 10 }),
);

// Ensure DatabaseObject base is usable as a type.
expectType<DatabaseObject>({} as DatabaseObject);

// -----------------------------------------------------------------------
// Declared triggers (schema.triggers block)
// -----------------------------------------------------------------------

// String body form: shorthand for "the active dialect". Accepts every valid
// timing/event and rejects unknown ones at compile time.
expectAssignable<TriggerSpec>({
	timing: 'before',
	event: 'insert',
	body: 'BEGIN END',
});
expectAssignable<TriggerSpec>({
	timing: 'after',
	event: 'update',
	body: 'BEGIN END',
});

// Dialect-keyed body: at least one known key. A dialect without an entry
// gets skipped stably at runtime.
expectAssignable<TriggerSpec>({
	timing: 'before',
	event: 'insert',
	body: { mysql: 'BEGIN END', pg: 'BEGIN END', sqlite: 'BEGIN END' },
});
expectAssignable<TriggerSpec>({
	timing: 'before',
	event: 'insert',
	body: { mysql: 'BEGIN END' },
});

// Type-level rejections: the whole reason these are separate string-literal
// unions rather than plain `string` is that a typo has to fail at COMPILE
// time, not one deploy later as a silent no-op.
expectError<TriggerSpec>({
	timing: 'instead of', // MySQL only supports before/after
	event: 'insert',
	body: 'BEGIN END',
});
expectError<TriggerSpec>({
	timing: 'before',
	event: 'truncate', // Postgres-only, not portable
	body: 'BEGIN END',
});
// A body that is neither a string nor a dialect-keyed object. Uses a
// literal (not `as any`, which would defeat the compile-time check).
expectError<TriggerSpec>({
	timing: 'before',
	event: 'insert',
	body: 42,
});

// The literal-union types themselves.
expectAssignable<TriggerTiming>('before');
expectAssignable<TriggerTiming>('after');
expectError<TriggerTiming>('during');
expectAssignable<TriggerEvent>('insert');
expectAssignable<TriggerEvent>('update');
expectAssignable<TriggerEvent>('delete');
expectError<TriggerEvent>('select');
