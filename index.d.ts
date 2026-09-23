/**
 * TypeScript declarations for yass-orm.
 *
 * Goal: provide a correct, minimal, stable surface for library consumers.
 * Source of truth: lib/obj.js + lib/dbh.js + lib/finder.js.
 */

export type AnyRecord = Record<string, any>;

export type GlobalChangeHookPayload = {
	modelName: string;
	id: string | number;
	/** DB-level (deflated) values. ORM-managed keys (updatedAt, createdAt, nonce)
	 *  and the id field are stripped. Empty when the write was a no-op. */
	changedFields: Record<string, unknown>;
	wasCreated: boolean;
};

export declare function registerGlobalChangeHook(
	fn: (payload: GlobalChangeHookPayload) => void | Promise<void>,
): () => void;

export type JsonifyOptions = {
	includeLinked?: boolean;
	excludeLinked?: boolean;
	[key: string]: any;
};

export type FindOptions = {
	/** If true, allows returning an in-memory cached instance when available. */
	allowCached?: boolean;
	/** Debug/trace span object (opaque). */
	span?: any;
	/**
	 * Transaction handle from `dbh.transaction((tx) => ...)`. When supplied, the
	 * read runs on that pinned connection so it can see the transaction's own
	 * uncommitted writes, and the lost-connection retry wrapper is bypassed.
	 */
	tx?: DbHandle;
	[key: string]: any;
};

/**
 * Options carrying a transaction handle, accepted by the model-level write and
 * read methods (`create`, `patch`, `remove`, `search`, `searchOne`).
 *
 * Passing `tx` runs the operation - including linked-field inflation - on the
 * transaction's pinned connection, and disables the per-statement
 * lost-connection retry (retry belongs to `dbh.transaction({ maxRetries })`).
 */
export type TxOptions = {
	tx?: DbHandle;
};

/**
 * Options accepted by `search()` in place of the legacy boolean `limitOne`.
 * Any key outside this set throws at runtime, naming the key.
 * See also `Model.find()` — a Feathers-style `$limit`/`$skip`/`$sort` finder
 * that returns RAW ROWS rather than hydrated instances.
 */
export type SearchOptions = {
	limitOne?: boolean;
	limit?: number;
	offset?: number;
	orderBy?: string;
	orderDir?: 'ASC' | 'DESC' | 'asc' | 'desc';
};

export type PatchWithNonceRetryOptions = {
	logger?: { warn: (...args: any[]) => void; error: (...args: any[]) => void };
	verbose?: boolean;
	maxRetryTime?: number;
	shouldRetry?: (latestObj: any) => Promise<boolean>;
};

export type PromisePoolMapConfig = {
	concurrency?: number;
	debug?: boolean;
	logger?: any;
	throwErrors?: boolean;
	yieldEvery?: number;
	[key: string]: any;
};

/**
 * `searchOne()`'s second positional (BDL-2700).
 *
 * Deliberately has NO index signature, unlike `PromisePoolMapConfig`. That open
 * `[key: string]: any` is exactly why `searchOne(fields, { sort: {...} })`
 * type-checked clean for years while being a silent runtime no-op: an open
 * index signature admits every object, so excess-property checking can never
 * fire. Closing it here is what lets the compiler reject a mistyped option at
 * the call site instead of leaving it to a runtime throw.
 *
 * `limitOne` is intentionally absent — `searchOne` IS `limitOne: true`, and
 * setting it throws at runtime.
 *
 * `limit`/`offset` are absent for the same reason: they contradict the
 * single-row return shape (use `search()` for a bounded page).
 */
export type SearchOneOptions = Omit<
	SearchOptions,
	'limitOne' | 'limit' | 'offset'
> & {
	concurrency?: number;
	debug?: boolean;
	logger?: any;
	throwErrors?: boolean;
	yieldEvery?: number;
} & TxOptions;

export type SchemaField = {
	field: string;
	linkedModel?: any;
	isObject?: boolean;
	objectSchema?: AnyRecord;
	arraySchema?: AnyRecord;
	nativeType?: any;
	type?: string;
	default?: any;
	defaultValue?: any;
	options?: any[];
	[key: string]: any;
};

export interface SchemaDefinition {
	table: string;
	fieldMap: Record<string, SchemaField>;
	sortBy?: any;
	stringifyAs?: any;
	legacyExternalSchema?: boolean;
	disableAutoUpdatedAt?: boolean;
	objectIdPrefix?: string;
	/**
	 * Declared database triggers, reconciled by schema-sync against the
	 * catalog (MySQL: information_schema.TRIGGERS). See README for the
	 * shape and semantics -- the presence of this key on the def is the
	 * OPT-IN gate that lets schema-sync drop undeclared triggers on the
	 * same table.
	 */
	triggers?: Record<string, TriggerSpec>;
	[key: string]: any;
}

/**
 * Timing of a declared trigger. MySQL supports only `before` and `after`.
 * Postgres and SQLite have `instead of` too but yass-orm does not implement
 * their reconcilers yet (see lib/dialects/*.js `supportsDeclaredTriggers`).
 */
export type TriggerTiming = 'before' | 'after';

/**
 * Event a declared trigger fires on. `truncate` is a Postgres-only concept
 * and is intentionally NOT accepted here for portability.
 */
export type TriggerEvent = 'insert' | 'update' | 'delete';

/**
 * The trigger BODY the schema author writes.
 *
 * `string` form means "the active dialect", which is convenient when a def
 * is only ever run against one database. `object` form is dialect-keyed
 * (`mysql`, `pg`/`postgres`, `sqlite`); a dialect without an entry is
 * SKIPPED STABLY -- the reconciler emits no DDL for it and the rest of the
 * table syncs as normal, mirroring how unsupported multi-valued indexes
 * behave under `supportsMultiValuedIndexes`.
 */
export type TriggerBody =
	| string
	| {
			mysql?: string;
			pg?: string;
			postgres?: string;
			sqlite?: string;
	  };

/**
 * A declared trigger, matching what `lib/sync-triggers.js validateTriggerSpec`
 * accepts at convert time. `timing`/`event` are structured because those are
 * the columns the catalog exposes for comparison; putting them in the body
 * would force the reconciler to parse a header out of a string. The engine
 * owns the CREATE TRIGGER framing and the ON clause, so the body is JUST the
 * body -- no `${table}` templating in the author's string.
 */
export interface TriggerSpec {
	timing: TriggerTiming;
	event: TriggerEvent;
	body: TriggerBody;
}

export type FinderResult<Row = AnyRecord> = {
	total: number;
	limit?: number;
	skip: number;
	data: Row[];
	extra: AnyRecord;
	/** Some mutateMeta hooks set this to avoid automatic COUNT(*). */
	totalSetManually?: boolean;
};

export type TransactionIsolationLevel =
	| 'read uncommitted'
	| 'read committed'
	| 'repeatable read'
	| 'serializable';

export type TransactionOptions = {
	isolationLevel?: TransactionIsolationLevel;
	/** SQLite-specific lock acquisition mode. */
	mode?: 'deferred' | 'immediate' | 'exclusive';
	readOnly?: boolean;
	/** Postgres only; requires serializable + readOnly. */
	deferrable?: boolean;
	/** Retry serialization, deadlock, busy, and lock failures. Defaults to 0. */
	maxRetries?: number;
};

export type FindOrCreateOptions = {
	allowBlankIdOnCreate?: boolean;
	/** Make the id with `idGenerator` when creating, even without `uuidLinkedIds`. */
	generateId?: boolean;
	idGenerator?: () => string;
	silenceErrors?: boolean;
	/** Defaults to true. Set false to retain the legacy non-transactional path. */
	useTransaction?: boolean;
	transactionOptions?: TransactionOptions;
	/**
	 * Join an existing transaction rather than opening one. Takes precedence over
	 * `useTransaction`/`transactionOptions`.
	 */
	tx?: DbHandle;
};

/**
 * DB handle (connection/pool) returned by `dbh()` and passed into retry/withDbh callbacks.
 * This is intentionally minimal and loosely typed.
 *
 * Generic type parameters on query methods allow type-safe results:
 * @example
 * ```typescript
 * const rows = await dbh.roQuery<{ count: number }>('SELECT COUNT(*) as count FROM users');
 * console.log(rows[0].count); // typed as number
 * ```
 */
export type DbHandle = {
	/** Raw MySQL query method - use pquery for parameterized queries */
	query: <T = any>(sql: string, params?: any) => Promise<T>;
	/** Parameterized query - automatically escapes params */
	pquery: <T = any>(sql: string, params?: any, opts?: any) => Promise<T>;
	/** Read-only query - routes to read replicas if configured */
	roQuery: <T = any>(
		sql: string,
		params?: any,
		opts?: any,
		...args: any[]
	) => Promise<T[]>;
	/** Run work atomically on one physical connection; nested calls use savepoints. */
	transaction: <T>(
		callback: (tx: DbHandle) => Promise<T> | T,
		options?: TransactionOptions,
	) => Promise<T>;
	search: (
		tableAndIdField: string,
		fields?: AnyRecord,
		limitOne?: boolean | SearchOptions,
		options?: {
			silenceErrors?: boolean;
			silenceRetryableTransactionErrors?: boolean;
		},
	) => Promise<any>;
	find: (
		tableAndIdField: string,
		fields?: AnyRecord,
		limitOne?: boolean,
	) => Promise<any>;
	create: (
		tableAndIdField: string,
		fields: AnyRecord,
		opts?: {
			allowBlankIdOnCreate?: boolean;
			/** Make the id with `idGenerator` when `fields` has none, even without `uuidLinkedIds`. */
			generateId?: boolean;
			idGenerator?: (() => string) | string;
			silenceErrors?: boolean;
		},
	) => Promise<any>;
	patch: (
		tableAndIdField: string,
		id: string,
		fields: AnyRecord,
	) => Promise<any>;
	patchIf: (
		tableAndIdField: string,
		existing: AnyRecord,
		values: AnyRecord,
		ifFalsey: AnyRecord,
	) => Promise<any>;
	findOrCreate: (
		tableAndIdField: string,
		fields: AnyRecord,
		patchIf?: AnyRecord,
		patchIfFalsey?: AnyRecord,
		opts?: FindOrCreateOptions,
	) => Promise<any>;
	/**
	 * Atomic at-most-once insert. Uses dialect-specific `INSERT IGNORE`
	 * (MySQL) or `INSERT ... ON CONFLICT DO NOTHING` (SQLite/Postgres).
	 * Returns the inserted row, or `null` if a UNIQUE-key conflict
	 * caused the insert to be skipped. Other errors still throw.
	 */
	createIgnore: (
		tableAndIdField: string,
		fields: AnyRecord,
		opts?: {
			allowBlankIdOnCreate?: boolean;
			/** Make the id with `idGenerator` when `fields` has none, even without `uuidLinkedIds`. */
			generateId?: boolean;
			idGenerator?: (() => string) | string;
			conflictColumns?: string[];
			silenceErrors?: boolean;
		},
	) => Promise<AnyRecord | null>;
	/**
	 * Atomic insert-or-update. Uses `ON DUPLICATE KEY UPDATE` (MySQL) or
	 * `ON CONFLICT(...) DO UPDATE SET ...` (SQLite/Postgres).
	 *
	 * `onDuplicate` is either an object mapping `{ column: 'sql expression' }`
	 * (raw SQL on the right, e.g. `{ count: 'count + 1' }`) or an array of
	 * column names to copy from the insert values.
	 *
	 * `conflictColumns` is required for SQLite/Postgres (ignored for MySQL).
	 */
	upsert: (
		tableAndIdField: string,
		fields: AnyRecord,
		opts: {
			onDuplicate: Record<string, string> | string[];
			conflictColumns?: string[];
			allowBlankIdOnCreate?: boolean;
			/** Make the id with `idGenerator` when `fields` has none, even without `uuidLinkedIds`. */
			generateId?: boolean;
			idGenerator?: (() => string) | string;
			silenceErrors?: boolean;
		},
	) => Promise<AnyRecord | null>;
	get: (tableAndIdField: string, id: string) => Promise<any>;
	destroy: (tableAndIdField: string, id: string) => Promise<any>;
	[key: string]: any;
};

// ============================================================================
// INSTANCE INTERFACE - Base instance methods available on all DatabaseObject instances
// ============================================================================

/**
 * Instance methods available on all DatabaseObject instances.
 * Use DatabaseObjectInstance<TSchema> to get schema-typed instances.
 */
export interface DatabaseObjectInstanceMethods {
	/** Unique identifier */
	id: string;

	/** Optional name field (common pattern) */
	name?: string;

	/** Soft-delete flag */
	isDeleted?: boolean;

	/** Creation timestamp */
	createdAt?: Date;

	/** Last update timestamp */
	updatedAt?: Date;

	/** Optimistic concurrency control token */
	nonce?: string;

	/**
	 * Async JSONification.
	 * NOTE: This is NOT `toJSON()`.
	 */
	jsonify(opts?: JsonifyOptions): Promise<AnyRecord>;

	/**
	 * Patch fields in DB and refresh this instance.
	 */
	patch(data?: AnyRecord, options?: TxOptions): Promise<this>;

	/**
	 * Patch with nonce retry behavior (ERR_NONCE retry loop).
	 */
	patchWithNonceRetry(
		patch: AnyRecord,
		opts?: PatchWithNonceRetryOptions,
	): Promise<any>;

	/**
	 * Sets isDeleted=true (requires schema to have isDeleted field).
	 */
	remove(options?: TxOptions): Promise<this>;

	/**
	 * Actually DELETEs from DB (dangerous).
	 */
	reallyDelete(): Promise<any>;

	/**
	 * Deflates this instance (or passed object) into DB-ready primitives.
	 */
	deflate(data?: AnyRecord, noUndefined?: boolean): AnyRecord;

	getId(): any;

	idField(): string;

	debugSql(sql: string, args: AnyRecord): string;

	/** Underlying db handle (async). */
	dbh(): Promise<DbHandle>;

	retryIfConnectionLost<T>(fn: (dbh: DbHandle) => Promise<T>): Promise<T>;

	mutateQuery(query: AnyRecord, sqlData: any, ctx: any): Promise<void>;

	mutateSort(sort: any[], sqlData: any, ctx: any): Promise<any[]>;

	mutateResult(result: any[], query: AnyRecord, ctx: any): Promise<any[]>;

	mutateMeta(meta: any, sqlData: any, ctx: any): Promise<any>;

	afterCreateHook(...args: any[]): Promise<any>;

	afterChangeHook(...args: any[]): Promise<any>;

	/**
	 * Called when the save that `set()` schedules fails (nothing awaits it).
	 * Override to route the error; the default logs it. A throw is logged.
	 */
	onAutoSaveError(error: unknown): void | Promise<void>;
}

/**
 * Schema-typed instance. Combines your schema fields with base instance methods.
 */
export type DatabaseObjectInstance<TSchema = AnyRecord> = TSchema &
	DatabaseObjectInstanceMethods;

// ============================================================================
// STATIC INTERFACE - Static methods available on all DatabaseObject classes
// ============================================================================

/**
 * Static methods available on DatabaseObject classes.
 *
 * @typeParam TSchema - The schema fields interface (e.g., PallasSessionInstance)
 * @typeParam TInstance - The full instance type returned by static methods.
 *   Defaults to DatabaseObjectInstance<TSchema>. Frameworks can override this
 *   to add additional instance methods (e.g., Rubber's BaseInstanceMethods).
 *
 * @example
 * ```typescript
 * import type { DatabaseObjectStatic } from 'yass-orm';
 *
 * function doSomething<T>(Model: DatabaseObjectStatic<T>) {
 *   return Model.searchOne({ isDeleted: false });
 * }
 * ```
 *
 * @example Extending with custom instance type
 * ```typescript
 * interface MyInstanceMethods { customMethod(): void; }
 * type MyInstance<T> = DatabaseObjectInstance<T> & MyInstanceMethods;
 *
 * interface MyModelStatic<T> extends DatabaseObjectStatic<T, MyInstance<T>> {
 *   // Add custom static methods here
 * }
 * ```
 */
export interface DatabaseObjectStatic<
	TSchema = AnyRecord,
	TInstance = DatabaseObjectInstance<TSchema>,
> {
	/** Constructor - creates a new instance */
	new (): TInstance;

	/** Get the schema definition */
	schema(): SchemaDefinition;

	/** Feathers-like search packet; returns raw rows (not instances). */
	find(
		query: AnyRecord,
		opts?: { promisePoolMapConfig?: PromisePoolMapConfig; [key: string]: any },
	): Promise<FinderResult<AnyRecord>>;

	allowedFindParams(): string[] | null;

	/** Get the database table name */
	table(): string;

	/** Get field definitions */
	fields(): SchemaField[];

	idField(): string;

	debugSql(sql: string, args: AnyRecord): string;

	dbh(): Promise<DbHandle>;

	retryIfConnectionLost<T>(fn: (dbh: DbHandle) => Promise<T>): Promise<T>;

	/**
	 * Access raw db handle.
	 * Overloads:
	 * - withDbh((dbh, table) => ...) -> runs callback under retryIfConnectionLost
	 * - withDbh('UPDATE ...', { ... }) -> runs dbh.pquery(sql, props)
	 */
	withDbh<T>(
		fn: (dbh: DbHandle, tableName: string) => Promise<T> | T,
	): Promise<T>;
	withDbh(sql: string, props?: AnyRecord): Promise<any>;

	/** Execute raw SQL and return typed instances */
	fromSql(
		whereClause?: string,
		args?: AnyRecord & { promisePoolMapConfig?: PromisePoolMapConfig },
	): Promise<Array<TInstance>>;

	/** Search for multiple records matching query */
	search(
		fields?: AnyRecord,
		limitOne?: false,
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		options?: TxOptions,
	): Promise<Array<TInstance>>;

	/**
	 * Search with explicit bounds AND `limitOne: true` in the same options
	 * object — resolves to a SINGLE instance (or null), not an array.
	 * Must come before the general `SearchOptions` overload below so the
	 * `limitOne: true` literal discriminates correctly.
	 */
	search(
		fields: AnyRecord,
		options: SearchOptions & { limitOne: true },
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		txOptions?: TxOptions,
	): Promise<TInstance | null>;

	/** Search with explicit bounds — always resolves to an ARRAY. */
	search(
		fields: AnyRecord,
		options: SearchOptions,
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		txOptions?: TxOptions,
	): Promise<Array<TInstance>>;

	search(
		fields: AnyRecord,
		limitOne: true,
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		options?: TxOptions,
	): Promise<TInstance | null>;

	/**
	 * Search for a single record matching query.
	 *
	 * The second positional accepts `orderBy`/`orderDir` (validated against this
	 * model's schema), pool-config keys, and `tx` — anything else throws naming
	 * the key (BDL-2700).
	 */
	searchOne(
		fields?: AnyRecord,
		options?: SearchOneOptions,
		txOptions?: TxOptions,
	): Promise<TInstance | null>;

	/** Get a record by ID */
	get(id: string, opts?: FindOptions): Promise<TInstance | null>;

	/** Create a new record */
	create(data: Partial<TSchema>, options?: TxOptions): Promise<TInstance>;

	/** Find existing record or create new one */
	findOrCreate(
		fields: Partial<TSchema>,
		patchIf?: Partial<TSchema>,
		patchIfFalsey?: Partial<TSchema>,
		options?: Pick<
			FindOrCreateOptions,
			'useTransaction' | 'transactionOptions' | 'tx'
		>,
	): Promise<TInstance>;

	/** Inflate raw data to typed instance */
	inflate(
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
		options?: TxOptions,
	): Promise<TInstance | null>;

	inflateValues(
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
		options?: TxOptions,
	): Promise<AnyRecord>;

	deflateValues(object?: AnyRecord, noUndefined?: boolean): AnyRecord;

	/** Get cached instance by ID */
	getCachedId(id: string, ...args: any[]): Promise<TInstance | undefined>;

	/** Cache an instance */
	setCachedId(
		id: string,
		freshData: TInstance,
		...args: any[]
	): Promise<TInstance>;

	/** Remove an instance from cache */
	removeCachedId(id: string): boolean;

	/** Clear entire cache for this model */
	clearCache(): void;

	/** Generate a new object ID */
	generateObjectId(): string;
}

// ============================================================================
// DATABASE OBJECT CLASS - Runtime class (kept for backwards compatibility)
// ============================================================================

/**
 * Base class for all database models.
 *
 * For typed models, use DatabaseObjectStatic<TSchema> interface instead of
 * extending this class directly, or use createBaseClass from your framework.
 */
export declare class DatabaseObject {
	// Common instance props (schema-dependent, so keep loose)
	id: string;

	name?: any;

	isDeleted?: boolean;

	createdAt?: Date;

	updatedAt?: Date;

	nonce?: string;

	/**
	 * Async JSONification.
	 * NOTE: This is NOT `toJSON()`.
	 */
	jsonify(opts?: JsonifyOptions): Promise<AnyRecord>;

	/**
	 * Patch fields in DB and refresh this instance.
	 */
	patch(data?: AnyRecord, options?: TxOptions): Promise<this>;

	/**
	 * Patch with nonce retry behavior (ERR_NONCE retry loop).
	 */
	patchWithNonceRetry(
		patch: AnyRecord,
		opts?: PatchWithNonceRetryOptions,
	): Promise<any>;

	/**
	 * Sets isDeleted=true (requires schema to have isDeleted field).
	 */
	remove(options?: TxOptions): Promise<this>;

	/**
	 * Actually DELETEs from DB (dangerous).
	 */
	reallyDelete(): Promise<any>;

	/**
	 * Deflates this instance (or passed object) into DB-ready primitives.
	 */
	deflate(data?: AnyRecord, noUndefined?: boolean): AnyRecord;

	getId(): any;

	idField(): string;

	debugSql(sql: string, args: AnyRecord): string;

	/** Underlying db handle (async). */
	dbh(): Promise<DbHandle>;

	retryIfConnectionLost<T>(fn: (dbh: DbHandle) => Promise<T>): Promise<T>;

	mutateQuery(query: AnyRecord, sqlData: any, ctx: any): Promise<void>;

	mutateSort(sort: any[], sqlData: any, ctx: any): Promise<any[]>;

	mutateResult(result: any[], query: AnyRecord, ctx: any): Promise<any[]>;

	mutateMeta(meta: any, sqlData: any, ctx: any): Promise<any>;

	afterCreateHook(...args: any[]): Promise<any>;

	afterChangeHook(...args: any[]): Promise<any>;

	/**
	 * Called when the save that `set()` schedules fails (nothing awaits it).
	 * Override to route the error; the default logs it. A throw is logged.
	 */
	onAutoSaveError(error: unknown): void | Promise<void>;

	// ==== Static API (polymorphic on subclasses) ====
	static schema(): SchemaDefinition;

	/** Feathers-like search packet; returns raw rows (not instances). */
	static find(
		query: AnyRecord,
		opts?: { promisePoolMapConfig?: PromisePoolMapConfig; [key: string]: any },
	): Promise<FinderResult<AnyRecord>>;

	static allowedFindParams(): string[] | null;

	static table(): string;

	static fields(): SchemaField[];

	static idField(): string;

	static debugSql(sql: string, args: AnyRecord): string;

	static dbh(): Promise<DbHandle>;

	static retryIfConnectionLost<T>(
		fn: (dbh: DbHandle) => Promise<T>,
	): Promise<T>;

	/**
	 * Access raw db handle.
	 * Overloads:
	 * - withDbh((dbh, table) => ...) -> runs callback under retryIfConnectionLost
	 * - withDbh('UPDATE ...', { ... }) -> runs dbh.pquery(sql, props)
	 */
	static withDbh<T>(
		fn: (dbh: DbHandle, tableName: string) => Promise<T> | T,
	): Promise<T>;

	static withDbh(sql: string, props?: AnyRecord): Promise<any>;

	static fromSql<T extends typeof DatabaseObject>(
		this: T,
		whereClause?: string,
		args?: AnyRecord & { promisePoolMapConfig?: PromisePoolMapConfig },
	): Promise<Array<InstanceType<T>>>;

	static search<T extends typeof DatabaseObject>(
		this: T,
		fields?: AnyRecord,
		limitOne?: false,
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		options?: TxOptions,
	): Promise<Array<InstanceType<T>>>;

	/**
	 * Search with explicit bounds AND `limitOne: true` in the same options
	 * object — resolves to a SINGLE instance (or null), not an array.
	 * Must come before the general `SearchOptions` overload below so the
	 * `limitOne: true` literal discriminates correctly.
	 */
	static search<T extends typeof DatabaseObject>(
		this: T,
		fields: AnyRecord,
		options: SearchOptions & { limitOne: true },
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		txOptions?: TxOptions,
	): Promise<InstanceType<T> | null>;

	/** Search with explicit bounds — always resolves to an ARRAY. */
	static search<T extends typeof DatabaseObject>(
		this: T,
		fields: AnyRecord,
		options: SearchOptions,
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		txOptions?: TxOptions,
	): Promise<Array<InstanceType<T>>>;

	static search<T extends typeof DatabaseObject>(
		this: T,
		fields: AnyRecord,
		limitOne: true,
		promisePoolMapConfig?: PromisePoolMapConfig & TxOptions,
		options?: TxOptions,
	): Promise<InstanceType<T> | null>;

	/**
	 * The second positional accepts `orderBy`/`orderDir`, pool-config keys, and
	 * `tx`; anything else throws naming the key (BDL-2700).
	 */
	static searchOne<T extends typeof DatabaseObject>(
		this: T,
		fields?: AnyRecord,
		options?: SearchOneOptions,
		txOptions?: TxOptions,
	): Promise<InstanceType<T> | null>;

	static get<T extends typeof DatabaseObject>(
		this: T,
		id: string,
		opts?: FindOptions,
	): Promise<InstanceType<T> | null>;

	static create<T extends typeof DatabaseObject>(
		this: T,
		data: AnyRecord,
		options?: TxOptions,
	): Promise<InstanceType<T>>;

	static findOrCreate<T extends typeof DatabaseObject>(
		this: T,
		fields: AnyRecord,
		patchIf?: AnyRecord,
		patchIfFalsey?: AnyRecord,
		...extraArgs: any[]
	): Promise<InstanceType<T>>;

	/**
	 * Atomic at-most-once insert (`INSERT ... ON CONFLICT DO NOTHING` and
	 * dialect equivalents). Resolves to the created instance, or `null` when a
	 * UNIQUE/PK conflict caused the insert to be SKIPPED. The `| null` is the
	 * whole point of the return type: it forces the caller to decide what to
	 * do about the occupant, which `findOrCreate` hides behind a race.
	 *
	 * `conflictColumns` is derived from the def's single `unique: true` index
	 * when omitted; pass `uniqueIndex` to choose among several, or
	 * `conflictColumns` to override entirely. An ambiguous or absent target
	 * throws rather than silently resolving to `undefined`.
	 */
	static createIgnore<T extends typeof DatabaseObject>(
		this: T,
		data: AnyRecord,
		options?: TxOptions & {
			conflictColumns?: string[];
			uniqueIndex?: string;
			allowBlankIdOnCreate?: boolean;
			silenceErrors?: boolean;
		},
	): Promise<InstanceType<T> | null>;

	static inflate<T extends typeof DatabaseObject>(
		this: T,
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
		options?: TxOptions,
	): Promise<InstanceType<T> | null>;

	static inflateValues(
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
		options?: TxOptions,
	): Promise<AnyRecord>;

	static deflateValues(object?: AnyRecord, noUndefined?: boolean): AnyRecord;

	static getCachedId<T extends typeof DatabaseObject>(
		this: T,
		id: string,
		...args: any[]
	): Promise<InstanceType<T> | undefined>;

	static setCachedId<T extends typeof DatabaseObject>(
		this: T,
		id: string,
		freshData: InstanceType<T>,
		...args: any[]
	): Promise<InstanceType<T>>;

	static removeCachedId(id: string): boolean;

	static clearCache(): void;

	static generateObjectId(): string;
}

// ============================================================================
// UTILITY FUNCTIONS AND EXPORTS
// ============================================================================

// ============================================================================
// LINKS AND THE MODEL REGISTRY
// ============================================================================

/** A model class: DatabaseObject or a subclass (what loadDefinition returns). */
export type ModelClass = typeof DatabaseObject;

/**
 * The names `t.linked('name')` resolves through the model registry. Empty
 * here; a consumer lists its models by declaration merging, and then those
 * names autocomplete and `getRegisteredModel(name)` returns the right type:
 *
 * ```ts
 * declare module 'yass-orm' {
 *   interface ModelRegistry { user: typeof User }
 * }
 * registerModels({ user: User });
 * ```
 */
export interface ModelRegistry {}

/** A name listed in {@link ModelRegistry}. */
export type RegisteredModelName = Extract<keyof ModelRegistry, string>;

/**
 * A lazy reference to a model: `() => User`. Called when the link is first
 * resolved, not when the definition loads, so models may import each other.
 * May return the module (`{ default: User }`) or a promise of either, so
 * `() => import('./user.js')` works too.
 */
export type LazyModelReference<M extends ModelClass = ModelClass> = () =>
	| M
	| { default: M }
	| Promise<M | { default: M }>;

/**
 * What `t.linked(x)` takes: a lazy reference (or the model class itself), a
 * registered name, or a path string (resolved as it always has been).
 */
export type LinkTarget =
	| ModelClass
	| LazyModelReference
	| RegisteredModelName
	// Any other string: a path. `string & {}` keeps registered names autocompleting.
	| (string & {});

type UnwrapModelModule<R> = R extends ModelClass
	? R
	: R extends { default: infer D }
	? D extends ModelClass
		? D
		: never
	: never;

/** The model class a link target names. */
export type LinkedModelOf<T> = T extends ModelClass
	? T
	: T extends () => infer R
	? UnwrapModelModule<Awaited<R>>
	: T extends RegisteredModelName
	? ModelRegistry[T]
	: ModelClass;

/** `t.linked(...)`'s field type. `__linkedModel` only carries the type. */
export interface LinkedFieldType<M = ModelClass> {
	(options?: AnyRecord): LinkedFieldType<M>;
	readonly type: string;
	readonly linkedModel: LinkTarget;
	/** Type-level only: the linked model. Never set at runtime. */
	readonly __linkedModel?: M;
	description(text: string): LinkedFieldType<M>;
	[key: string]: any;
}

/** `t.linked`'s options. Only `array` does anything today. */
export type LinkOptions = {
	array?: boolean;
	inverse?: string | null;
	[key: string]: unknown;
};

/**
 * The `types` (`t`) a definition function receives. `linked` and `parent`
 * are typed; the other field types are loose for now.
 */
export interface SchemaTypes {
	linked<T extends LinkTarget>(
		target: T,
		options?: LinkOptions,
	): LinkedFieldType<LinkedModelOf<T>>;
	parent<T extends LinkTarget>(target: T): LinkedFieldType<LinkedModelOf<T>>;
	[type: string]: any;
}

/** A definition: `({ types: t }) => ({ table, schema: { ... } })`. */
export type DefinitionFunction = (context: {
	types: SchemaTypes;
	[key: string]: any;
}) => AnyRecord;

/** The model a registry name takes: its declared type, or any model. */
type ModelForName<K> = K extends RegisteredModelName
	? ModelRegistry[K]
	: ModelClass;

/**
 * Registers a model under `name`, for `t.linked(name)`. The same model again
 * is a no-op; a different model under a taken name throws, and so does a name
 * that looks like a path (a `/` or `\`, a leading `.`, or a `.js`/`.ts`/
 * `.cjs`/`.mjs` ending): a path link always resolves by path.
 * @returns A function that unregisters it
 */
export declare function registerModel<K extends string>(
	name: K,
	model: ModelForName<K>,
): () => void;

/**
 * Registers each model under its key (checking them all first).
 * @returns A function that unregisters them
 */
export declare function registerModels<
	M extends { [K in keyof M]: ModelForName<K> },
>(models: M): () => void;

/** The model registered under `name`, or undefined. */
export declare function getRegisteredModel<K extends string>(
	name: K,
): ModelForName<K> | undefined;

/** One link checkLinks() couldn't resolve. */
export type LinkProblem = {
	/** The linking model's class name */
	model: string;
	table: string;
	field: string;
	/** The link as written: a name, a path, or a reference's source */
	link: string;
	message: string;
};

export type LinkCheckReport = {
	ok: boolean;
	/** How many links were resolved */
	checked: number;
	problems: LinkProblem[];
};

/**
 * Resolves every link of the given models (default: the registered ones) and
 * reports every one that doesn't resolve, at once. Opt-in: call it at boot.
 * With `throwIfBroken`, rejects with one error listing them all (its
 * `problems` property holds the list).
 */
export declare function checkLinks(options?: {
	models?: ModelClass[] | Record<string, ModelClass>;
	throwIfBroken?: boolean;
}): Promise<LinkCheckReport>;

export declare function convertDefinition(definition: any): SchemaDefinition;

export declare function loadDefinition(
	definitionFile: string | DefinitionFunction | (() => any),
): typeof DatabaseObject;

/**
 * A 25-char, lowercase base-36 id whose first 9 chars are the creation time, so
 * ids sort by creation time as plain strings. See lib/objectId.js.
 */
export declare function timeOrderedId(now?: number): string;

/**
 * `<prefix>_<timeOrderedId>`, at most 36 chars. The prefix must be 1-10 lowercase
 * letters/digits starting with a letter. This is what a def that declares
 * `objectIdPrefix` gets from generateObjectId().
 */
export declare function prefixedId(prefix: string, now?: number): string;

/**
 * Register a definition function for bundled executable support.
 * This enables bundled executables (e.g., bun build --compile) to pre-register
 * definition functions that loadDefinition can use without filesystem access.
 *
 * @param name - The definition name/path (e.g., 'webhook-log' or 'defs/webhook-log')
 * @param defFn - The definition function that returns the schema
 */
export declare function registerDefinition(
	name: string,
	defFn: (ctx: { types: any }) => any,
): void;

export declare function retryIfConnectionLost<T>(
	fn: (dbh: DbHandle) => Promise<T>,
): Promise<T>;

// Exposed deep utilities (intentionally loose)
export declare const libUtils: any;
export declare const dbhUtils: any;

export declare const config: {
	baseClass?: typeof DatabaseObject;
	[key: string]: any;
};

export declare const loadBalancerManager: any;
export declare const LoadBalancer: any;

export declare function updatePromiseMapDefaultConfig(cfg: AnyRecord): void;

export declare function closeAllConnections(): Promise<{
	closed: number;
	failed?: number;
}>;

export declare const QueryTiming: any;
export declare const QueryLogger: any;

/**
 * Recognize a UNIQUE/PRIMARY KEY violation across MySQL/MariaDB/Postgres/SQLite,
 * including errors wrapped by yass-orm's internal `wrapQueryError`. Checks
 * `.code` / `.errno` / `.sqlState` on both the wrapped error and its `.cause`,
 * with a message-regex fallback for drivers that strip codes.
 */
export declare function isUniqueViolation(err: unknown): boolean;

/**
 * Recognize any integrity-constraint violation — UNIQUE/PK, CHECK, NOT NULL, FK —
 * across all supported dialects. Broader than `isUniqueViolation`.
 */
export declare function isConstraintError(err: unknown): boolean;

/** A dialect (lib/dialects/*): what the SQL helpers need of one. */
export interface SqlDialect {
	readonly name: string;
	quoteIdentifier(name: string): string;
}

/** What the SQL helpers take: a handle, a transaction, or a dialect. */
export type SqlTarget = DbHandle | SqlDialect | { dialect: SqlDialect };

/** `[sql, params]` for readBack(). */
export type SqlStatement = [sql: string, params?: AnyRecord];

export type IntervalUnit =
	| 'second'
	| 'minute'
	| 'hour'
	| 'day'
	| 'week'
	| 'month'
	| 'year'
	| 'seconds'
	| 'minutes'
	| 'hours'
	| 'days'
	| 'weeks'
	| 'months'
	| 'years';

/**
 * SQL helpers (`lib/sql-helpers.js`): the patterns raw SQL repeats that MySQL
 * and Postgres spell differently. Fragments return SQL to put in a query;
 * runners run the statements. See the README's "SQL helpers".
 */
export interface SqlHelpers {
	/** `IN (:name_0, ...)` and its params; an empty list matches nothing. */
	inList(
		name: string,
		values: Iterable<unknown>,
	): { sql: string; params: AnyRecord };
	/** The database clock, in UTC. */
	now(db: SqlTarget): string;
	/** `expr` plus `amount` (SQL: a number or a `:param`) `unit`s. */
	addInterval(
		db: SqlTarget,
		expr: string,
		amount: string | number,
		unit: IntervalUnit,
	): string;
	/** `expr` minus `amount` `unit`s. */
	subtractInterval(
		db: SqlTarget,
		expr: string,
		amount: string | number,
		unit: IntervalUnit,
	): string;
	/** `a = b` where NULL equals NULL. */
	nullSafeEqual(db: SqlTarget, a: string, b: string): string;
	/** `a <> b` where NULL differs from any value. */
	nullSafeNotEqual(db: SqlTarget, a: string, b: string): string;
	/** An ORDER BY term that puts NULLs last. */
	nullsLast(
		db: SqlTarget,
		expr: string,
		direction?: 'ASC' | 'DESC' | 'asc' | 'desc',
	): string;
	/** COUNT(expr) that reads back as a JS number. */
	count(db: SqlTarget, expr?: string): string;
	/** The row-lock clause for a SELECT ('' on SQLite). */
	forUpdate(
		db: SqlTarget,
		opts?: { skipLocked?: boolean; noWait?: boolean },
	): string;
	/** Locks `key` until the transaction ends (the advisory-lock replacement). */
	lockKey(tx: DbHandle, key: string): Promise<void>;
	/** Insert, or update where `where` holds. */
	upsertWhere(
		db: DbHandle,
		table: string,
		args: {
			values: AnyRecord;
			conflictColumns: string[];
			update: string[] | Record<string, string>;
			where?: string;
			params?: AnyRecord;
		},
	): Promise<{ inserted: boolean; updated: boolean }>;
	/** A write and a read in one transaction (the RETURNING replacement). */
	readBack<Row = AnyRecord>(
		db: DbHandle,
		args: { write: SqlStatement; read: SqlStatement; readFirst?: boolean },
	): Promise<{ rows: Row[]; affectedRows: number }>;
}

export declare const sqlHelpers: SqlHelpers;
