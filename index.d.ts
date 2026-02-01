/**
 * TypeScript declarations for yass-orm.
 *
 * Goal: provide a correct, minimal, stable surface for library consumers.
 * Source of truth: lib/obj.js + lib/dbh.js + lib/finder.js.
 */

export type AnyRecord = Record<string, any>;

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
	[key: string]: any;
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
	[key: string]: any;
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
	search: (
		tableAndIdField: string,
		fields?: AnyRecord,
		limitOne?: boolean,
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
			idGenerator?: (() => string) | string;
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
		opts?: { allowBlankIdOnCreate?: boolean; idGenerator?: () => string },
	) => Promise<any>;
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
	patch(data?: AnyRecord): Promise<this>;

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
	remove(): Promise<this>;

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
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<Array<TInstance>>;

	search(
		fields: AnyRecord,
		limitOne: true,
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<TInstance | null>;

	/** Search for a single record matching query */
	searchOne(
		fields?: AnyRecord,
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<TInstance | null>;

	/** Get a record by ID */
	get(id: string, opts?: FindOptions): Promise<TInstance | null>;

	/** Create a new record */
	create(data: Partial<TSchema>): Promise<TInstance>;

	/** Find existing record or create new one */
	findOrCreate(
		fields: Partial<TSchema>,
		patchIf?: Partial<TSchema>,
		patchIfFalsey?: Partial<TSchema>,
		...extraArgs: any[]
	): Promise<TInstance>;

	/** Inflate raw data to typed instance */
	inflate(
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<TInstance | null>;

	inflateValues(
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
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
	patch(data?: AnyRecord): Promise<this>;

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
	remove(): Promise<this>;

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
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<Array<InstanceType<T>>>;

	static search<T extends typeof DatabaseObject>(
		this: T,
		fields: AnyRecord,
		limitOne: true,
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<InstanceType<T> | null>;

	static searchOne<T extends typeof DatabaseObject>(
		this: T,
		fields?: AnyRecord,
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<InstanceType<T> | null>;

	static get<T extends typeof DatabaseObject>(
		this: T,
		id: string,
		opts?: FindOptions,
	): Promise<InstanceType<T> | null>;

	static create<T extends typeof DatabaseObject>(
		this: T,
		data: AnyRecord,
	): Promise<InstanceType<T>>;

	static findOrCreate<T extends typeof DatabaseObject>(
		this: T,
		fields: AnyRecord,
		patchIf?: AnyRecord,
		patchIfFalsey?: AnyRecord,
		...extraArgs: any[]
	): Promise<InstanceType<T>>;

	static inflate<T extends typeof DatabaseObject>(
		this: T,
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
	): Promise<InstanceType<T> | null>;

	static inflateValues(
		data: AnyRecord,
		span?: any,
		promisePoolMapConfig?: PromisePoolMapConfig,
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

export declare function convertDefinition(definition: any): SchemaDefinition;

export declare function loadDefinition(
	definitionFile: string | (() => any),
): typeof DatabaseObject;

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
