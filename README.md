# yass-orm

Yet Another Super Simple ORM

Why? Mainly for my personal use in a variety of projects.

## Recent changes

---
- 2025-09-21
  - (perf) Core under‑the‑hood optimizations for faster hot paths with no API changes required
    - Cached schema metadata per class to cut repeated work:
      - `fields()` now memoizes to `Class._cachedFields`
      - `idField()` now memoizes to `Class._cachedIdField`
      - Instances reuse the cached fields during construction and updates
    - Replaced several `.forEach`/temporary allocations with tight `for` loops and early exits in hot code paths
    - Reduced repeated calls to `schema()`/`Object.values()` and avoided unnecessary key enumeration where possible
    - Stabilized and streamlined `jsonify` internals:
      - Backward‑compatible behavior preserved (defaults to `{ id, name }`)
      - `{ excludeLinked: true }` includes regular (non‑linked) fields only
      - `{ includeLinked: true }` includes linked models (recursively, respecting each model’s `jsonify`)
      - Lightweight promise guard prevents re‑entrancy/race conditions
    - Minor allocation reductions across `inflateValues`/`deflateValues`/update flows
    - Overall impact: fewer micro‑allocations, less schema re‑work, better steady‑state throughput

- 2025-09-18
  - (feat) **Exposed `updatePromiseMapDefaultConfig` function** - Added ability to customize global `promisePoolMap` defaults for your application.
    - **New export**: `updatePromiseMapDefaultConfig(newDefaults)` allows changing default concurrency, yieldEvery, and other settings globally
    - **Updated defaults**: Changed default `concurrency` from 5 to 4 and `yieldEvery` from 10 to 8 for better balance of performance and responsiveness
    - **Usage example**: `const { updatePromiseMapDefaultConfig } = require('yass-orm'); updatePromiseMapDefaultConfig({ concurrency: 2, yieldEvery: 5 });`
    - **Affects all operations**: Changes apply to `inflateValues`, `fromSql`, `search`, and all other database operations using `promisePoolMap`
    - **Per-operation override**: Individual operations can still override defaults by passing `promisePoolMapConfig` parameter

- 2025-09-17
  - (feat) **Enhanced event loop responsiveness** - Replaced `Promise.all` with `promisePoolMap` in database operations to prevent event loop blocking during large result set processing.
    - **`inflateValues` method**: Core object inflation now uses `promisePoolMap` instead of `Promise.all` when processing field transformations (dates, JSON, linked models, etc.), affecting ALL database loading operations
    - **`fromSql` method**: Now uses `promisePoolMap` when inflating database rows, yielding control to the event loop every N items (configurable via `yieldEvery`, default: 10)
    - **`search` method**: Similarly enhanced to yield during result processing, preventing UI freezes and allowing other async operations to proceed
    - **`.get()` method**: Benefits from `inflateValues` improvements, so even single record loading is more responsive
    - **`finder.js`**: Updated search result processing to use `promisePoolMap` for better responsiveness during large search operations
    - **Configurable yielding**: All methods accept `promisePoolMapConfig` parameter to customize concurrency and yield frequency based on your application's needs
    - **Backward compatible**: No breaking changes - existing code continues to work with improved performance characteristics
    - This prevents the notorious "blocking the event loop" issue when processing hundreds or thousands of database records, keeping your application responsive

- 2025-06-22
  - (feat) Added comprehensive load balancing system for database read operations in [lib/load-balancing/](lib/load-balancing/) folder.
    -  The system supports multiple strategies including Round Robin (default) and Random selection, plus the ability to add custom load balancers. 
    -  The architecture uses target-based routing with a 3-level configuration hierarchy (global → per-target → per-query) for maximum flexibility. 
    -  To set a custom strategy, use the `LoadBalancerManager` class or extend [the `LoadBalancer` base class](lib/load-balancing/LoadBalancer.js). 
    -  See [lib/load-balancing/README.md](lib/load-balancing/README.md) for comprehensive documentation and usage examples, and check [lib/load-balancing/LoadBalancer.js](lib/load-balancing/LoadBalancer.js) for extensive JSDoc documentation on the interface and implementation patterns.
    -  Note: `LoadBalancer` and the `loadBalancerManager` instance used internally are both exported for creating/setting custom strategies or changing the strategy externally.
  -  (fix) Fixed an assumption in `DatabaseObject` method `withDbh` - previously, if you passed a string as the first arg, it would only execute that as SQL if you ALSO passed a truthy value for the 2nd arg - which for some queries didn't make sense, since not all queries require props. It has been adjusted now so that if the first prop is a string. it will execute the query regardless. (The usual function-style callback as the first arg is still supported, that was not changed.)
  -  (feat) Added pass-thru of any other options passed to the `handle` method internally. This allows requesting a database handle at runtime with different server props/schema props than what is configured.

- 2025-04-12
  - (feat) Added caching of the model classes loaded by _resolvedLinkedModel(), which is called internally when you define a related field using `t.linked('model-class-name')`. This reduces the disk hits considerably, which can significantly increase performance under heavy production loads.

- 2025-05-27
  - (feat) Added detection of JSON index support when syncing schema, and automatically doesn't try to create indexes containing JSON.
  - (fix) Added better error capturing when executing SQL to sync the tables so as to not crash the entire sync for a single problem table, logs errors at end of each table if present.
  - (chore) Documentation update: You can set YASS_ALLOW_DROP=1 in your environment to allow dropping columns when syncing. By default, the sync process DOES NOT drop columns that you remove from your schema to preserve data in case you accidentally removed them.

- 2024-12-26
  - (feat) Added support for fulltext index specifications, extending the index methods below with two ways to specify full-text indexes:

	1. Make an index "fulltext" by setting the first column to "FULLTEXT", for example:

		```javascript
		{
			indexes: {
				idx_ex_ft: ['FULLTEXT', 'name'],
			}
		}
		```

		YASS will use that 'FULLTEXT' string as a "hint" and modify it's accordingly. Instead of generating:
		
		```sql
		 create index idx_ex_ft on example_table (name);
		 ```

		 We will generate:
		 ```sql
		 create fulltext index on example_table (name);
		 ```

		 (Note how the `fulltext` modifier must come before the `index` keyword)

	2. Instead of using the first column, you can provide an index spec as an object with (currently) two props supported, `fulltext` and `cols`. The `cols` property supports all the same formats described below and is parsed identically as described below, no change to current functionality. The `fulltext` sibling prop is used to enable the same SQL transformation as described above (e.g. `create fulltext index` vs `create index`).

		Example of this style:

		```javascript
		{
			indexes: {
				idx_ex_ft: { fulltext: true, cols: ['name'] }
			}
		}
		```

		

- 2024-12-15
  - (feat) Added better support for JSON field indexes by not recreating them every time - we now properly match them to the on-disk explain output and properly detect if they already exist.
  - (feat) Added support for three new ways to specify indexes: Raw SQL (`(name, age DESC)`), array with inline arguments (`['name(255)', 'age DESC', 'isDeleted']`) or 100% manual (`idx_whatever: true`)

	**Documentation on Methods of indexing (Old and New)**

	As a refresher, indexes are specified in your schema like this:

	```javascript
	{
		table: 'example_table',
		schema: {
			id: t.uuidKey,
			name: t.string,
			nonce: t.string,
			props: t.object(),
		},

		indexes: {
			// Different ways to specify an index (see docs below)
			idx_name: ['name'], // (a) "Column-only"
			idx_prop_date: ['props->>"$.date"'], // (b) "JSON"
			idx_nonce: ['nonce DESC'], // (c) "Column + arguments"
			idx_name_and_nonce: '(name, nonce(3))', // (d) "SQL String for Columns"
			idx_manual_whatever: true, // (e) "Full Manual Control"
		},
	}
	```

	Ways to specify an index:

	1. *Column-Only*
		- Example: `idx_foobar: ['foo', 'bar', 'baz']` - self explanatory
		- Columns are each checked to ensure they exist in the schema and any of them do not exist, errors are logged and the index will not be created.
   	1. *JSON*
		- Example: `idx_foobar: ['foo->>'$.bar', 'baz']` - indexes the field 'bar' inside a JSON string stored in column 'foo', and regular column 'baz'
		- This method of indexing previously existed in the codebase, but was enhanced by this update to properly detect the JSON column in the index and not re-create the index every time we run the sync
	2. Column + "arguments"
		- Arguments could be anything valid SQL, like `(255)` or `DESC`
		- Example: `idx_foobar: ['foo(255)', 'bar DESC', 'baz']`
		- This allows you more full-grained control over the index spec while still keeping the schema-verification guarantees that the sync script does (e.g. it still checks your schema to make sure that `foo`, `bar`, and `baz` are valid columns defined in your schema)
    3. SQL String for Columns
		- Example: `idx_foobar: "(foo, bar DESC, baz)"` 
		- The **string MUST start with '(' and end with ')'** - This is just extra validation to ensure you really did mean to give us SQL and didn't just accidentally give us some other string. If you don't wrap it in parenthesis, we will ignore your index completely. The sync process will log an error to the console, but won't stop the sync for the other indexes/
		- We assume you know your SQL well enough that you properly escaped any column names
		- We do NOT parse the string and we do not verify that the columns exist - that's up to you
		- We just give the string to the database like 'create index idx_foobar on whatever_table ${yourStringHere}`
		- **IMPORTANT** Since we don't parse the string, we can't tell if the index on disk in the database has been changed, we just know if the index itself exists (`idx_foobar`) - so if you change the string in your schema, you **MUST** change the index name to force the sync to re-create it, e.g. change it from `idx_foobar` to `idx_foobar_v2` or something - then the sync WILL drop the old `idx_foobar` after creating `idx_foobar_v2`
	4. Full Manual Control
		- Example: `idx_foobar: true`
		- There's nothing else for you to do in the schema besides giving the index name and some truthy value - this just keeps the sync from deleting the index on disk when the sync runs.
		- The rest is up to you to create it however you want, usually by going to the CLI or Workbench and doing some variant of "create index X on TableY as (...)" or "alter table TableY add index Foobar" etc
		- This gives you full control over the index creation, and we don't bother your index at all as long as you tell us the name here.
		- Obviously, it goes without saying, we don't check the column names or anything like that either.

- 2024-11-03

  - (fix) Added explicit warning if you pass more than 3 args to 'findOrCreate' because that would be useless to do anyway.

- 2024-05-02

  - (feat) Added `setOnConnectRetryFailed` to catch retry failure and customize how the library responds. By default, we now call `process.exit(1)` on the assumption that the app will restart.

- 2024-04-11

  - (feat) Added support for functional indices (Requires mysql 8.0.13 or newer.) Using the MySQL JSON operator (`->>`) is now supported when specifying indexes. For example, if you include a key like this in your `indexes` array in a schema:

  ```json
  stripeData_customer: ['stripeData->>"$.customer"'],
  ```

  ... it will be transformed into DDL like the following:

  ```sql
  alter table user_payment_methods add index stripeData_stripeCustomer ((cast(stripeData->>'$.customer' as char(255)) COLLATE utf8mb4_bin));
  ```

  PlanetScale has a wonderful writeup on this and other JSON tips in SQL: <https://planetscale.com/blog/indexing-json-in-mysql#functional-indexes>

  - (feat) Added new config option, `connectTimeout` (units: milliseconds), which defaults to `3000` milliseconds if not specified. Added to support more reliable connections for intercontinental connections (e.g. India>SF)

- 2023-09-11
  - (fix) Updated `debugSql` to properly quote dates in it's string output, making it easier to copy/paste SQL for testing
  - (chore) Added es6 string template syntax helpers internally to the codebase in some spots
  - (feat) Added the ability to override `readonlyNodes`, `disableFullGroupByPerSession`, and `disableTimezone` when calling the `dbh(...)` factory directly - useful for connecting to a specific server instead of a configured cluster, e.g. for reporting, etc
- 2023-04-26
  - Added `utf8mb4_general_ci` to the set of default collations so as to not have to alter entire schemas
- 2023-03-27
  - Added new config field, `enableAlternateSchemaInTableName`, off by default. If true, then you can override default schema in schema definition files with dot notation, such as "schema.tableName". This has the knock-on effect of requiring you to update any tables where you use dot notation to specify the ID field, like "foobar.foobarId" to also include the schema name if you enable this field. So that example would become: "foobarSchema.foobar.foobarId". Note that in previous releases the functionality added by `enableAlternateSchemaInTableName` was ON automatically, so if you ARE using alternate schemas in table names, you must enable this flag to retain the same functionality. This functionality was moved behind this flag to stop breaking older legacy code that relied on embedding the ID field in the table name.
- 2023-02-23
  - Fixed deflating sub-objects with schemas with `undefined` values - previously, if a sub-object had a declared SQL field type but the value was `undefined`, the SQL execution would throw an error about an undefined placeholder. This fix stops adding `undefined` sub-object fields to the deflated values to prevent those SQL errors.
- 2023-02-21
  - Added support for config prop `disableFullGroupByPerSession`. When set to a truthy value, YASS will execute `SET sql_mode=(SELECT REPLACE(@@sql_mode,'ONLY_FULL_GROUP_BY',''));` once on every connection at initial connection time.
- 2023-02-12
  - Added support for literal 'date' types in MySQL, stored as 'YYYY-MM-DD' on disk and cast to a String in javascript
- 2023-02-07:
  - fix: Added explicit throw-on-null-handle modes to better spot where errors come from inside `retryIfConnectionLost`
- 2023-02-02:
  - Feat: Made `retryIfConnectionLost` a static (and instance) method on `DatabaseObject` to allow for subclasses to override and customize the handle used by their class instances
  - Feat: Added support for `disableFunctions` config option to disable uploading the `match_ration` function and the ID triggers for hosts that don't support functions/triggers (e.g. PlanetScale)
  - Feat: Added support for overriding the config file used for a process by setting a file path in the `YASS_CONFIG` environment variable before starting the process. If set, we will use that file specified and ignore any `.yass-orm.js` or related files.
- 2023-01-30
  - Feat: Added support for config option `disableTimezone` to disable setting the timezone option on the MariaDB connector. Timezone option must not be set when connecting to PlanetScale databases, so set `disableTimezone: true` if you use PlanetScale as your DB host.
- 2023-01-28
  - Chore: Added tests around `debugSql`'s behavior to ensure it stays stable and performs as expected in future releases
  - Fix: Changed `debugSql` to use the same deflation done when writing data to the database (e.g. properly convert dates and booleans to their database values) and now properly quotes non-numeric strings with `'` instead of `"`.
  - Fix: Added `JSON.decycle` polyfill to decycle json objects before stringifying them when outputting error messages to the console.
  - Fix: Changed quoting in `finder.js` to use single quotes when outputting SQL for debugging
- 2022-11-29
  - Feat: Changed multi-schema format from 'x/y' to 'x.y'. This requires the (legacy) method of specifying ID field to always use a schema. So if you had schemas that said "user.userId" to load legacy data, you will need to update that to be "database.users.userId"
- 2022-11-24
  - Feat: Added support for linking schemas to alternate database schemas other than the `db` set in `.yass-orm.js` by specifying a `table` name in the schema like `"databaseSchema/tableName"` (which would be used in SQL as `select * from databaseSchema.tableId where id=123`)
  - Updated schema-sync to support the same special "slash" table names
- 2022-10-06
  - Feat: Added support for a `disableAutoUpdatedAt` on schema definitions to do as it says: Turn off the automatic setting of `updatedAt` fields in the `patch()` method on objects. It is on by default, but you can set `disableAutoUpdatedAt: true` in your schema definition to turn off that behavior now.
- 2022-09-16
  - Fix: Add better nonce failure messages
  - Fix: Regression in nonce failures with JSON.stringify
  - Fix: Added better error messages when it can't find linked models long with traces on where the call appeared to originate from
- 2022-08-11
  - Fix: Don't try to destructure failures in queries for nonces
- 2022-08-10
  - Added `verbose` flag to `patchWithNonceRetry` options and defaulted it to false to quiet some logs that were not strictly required.
- 2022-08-08
  - Bump version to `1.6.5` to reflect recent changes
  - Did `npm audit fix` so `npm audit` runs clean now
  - Updated `package-lock.json`'s `lockFileVersion`
  - Added `QueryLogger` interface as named export to allow users to consume a query log, get last 100 queries executed, and get notified on each new query (and when the query ends). Off by default, to use, first call `QueryLogger.enable()` then `QueryLog.attachListener(callback)`. Also `QueryLogger.getLines()` gets most recent 100 queries. In your `attachListener` callback, you can set an `onFinished` property on the first json argument you receive, and it will be called when the query ends.
  - Made handle creation deferred - i.e. two simultaneous calls to something like `retryIfConnectionLost` will now use the same handle instead of creating a new handle each time. This should have worked in the past, and it does work if you call `retryIfConnectionLost` (or anything that creates a handle) some milliseconds apart. However, if the internal `handle` routine was called while the first `handle` was still connecting (since connections are async), there would be no cached handle (yet), so it would just create another new handle - which would also have to connect. In situations where multiple queries are being run by different parts of the program on cold start (e.g. a server stack booting), this could create hundreds of handles where it really should just have the one cached handle (as needed). This commit fixes that "cold-boot" scenario.
- 2022-08-07
  - Modified `patch` behavior to NOT set ALL the fields, but only the fields explicitly given to `patch` (as long as they are in the schema).
  - Added `patchWithNonceRetry` method (see jsdocs in the code) to help with retrying when nonce changes on disk
- 2022-07-30
  - Added support for pass-thru props from definitions into the JSON schema created for objects, including auto-population of any schema-provided 'options' object. This was added to support passing thru custom fields from the schema into domain code.
- 2022-07-10
  - Changed calls from `path.join` to `path.resolve` to support relative links and other use-cases
  - Changed UUID Primary Key definitions to be `char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` in order to force case-sensitive matches
  - Updated sync-to-db to support a new schema prop, `collation` and properly sync that to MariaDB when changed
- 2022-05-27
  - Added support for a special `nonce` field - when `nonce` is present on a schema, it is enforced in the `DatabaseObject`'s `patch` method - the nonce given in the patch (or stored in memory) MUST equal the `nonce` stored on disk (explicit `SELECT` is done for the `nonce` before patching to compare). If not equal (`===`), then an `Error` is thrown with the `.code` prop on the error set to `ERR_NONCE`. The caller is expected to `get` a new copy from disk and apply the patch again, or verify with user, or any other domain-specific steps desired.
- 2022-04-24
  - Fixed bug in `search(fields)` where `fields` would be modified with deflated values after returning (e.g. if `fields` was `{ flag: true }`, after `search()`, the outer scope's copy of `fields` would be incorrectly changed to `{ flag: 1 }`). This was caused by incorrect `Object.assign` usage internally, which has been rectified in this commit.
  - Version bump to `1.4.6`
- 2022-04-09
  - Added support for `staging` as a valid value for `NODE_ENV`
- 2022-02-16
  - Set `process.env.TZ='UTC'` to ensure consistent Date handling
- 2022-02-06
  - Fixed race condition around cached handles in `dbh.js`
  - Added code timing helper and optimized inflating already inflated values
- 2022-02-04
  - Fixed compatibility with `int(11)` primary keys for schema syncs
- 2022-02-02
  - Added `onHandleAccessDebug` as an external hook to debug handle creation/access. To use, `import { libUtils } from 'yass-orm'` then set `libUtils.handle.onHandleAccessDebug = (dbh, { cacheMiss }) => { ... }` to execute your custom code.
- 2022-01-21
  - Merged support for Read Only nodes to support MySQL clusters
  - Added support for a static `generateObjectId` method that child classes can override to change how IDs are generated
  - Added quotes ('`') around column names in the generated 'create index' SQL
  - Added checking for invalid column names in index definitions and better error messages if invalid column names are found
- 2022-01-13
  - Added `allowPublicKeyRetrieval` to handle options to support newer versions of MySQL
- 2021-12-06
  - Added support for custom `baseClass` in `config.js`
  - Added support for a promise guard in `DatabaseObject.jsonify` to prevent odd recursion errors where sometimes the object would not be properly jsonified if multiple instances running at once
  - Added support for subclasses overriding the caching implementation
  - Updated the caching implementation to properly freshen the cache when mutating the object via patches, etc
  - Added basic `stringify()` function to `DatabaseObject` base class
- 2021-10-30
  - Added support for `mutateJoins` to `finder.js` to inject custom joined tables when searching
- 2021-06-12
  - Added timezone config to mariadb connector to disable the underlying mariadb library from attempting to translate date/time string timezones since we take care to ensure date/time strings are loaded/stored as UTC
- 2021-05-30
  - Updated lodash and hosted-git-info deps due to upstream requirements
  - Added notes on testing and fixed linting errors in test.js
- 2021-04-14
  - Added additional error string to allowed retry errors
- 2021-04-13
  - Updated string/column quotations in generated SQL from the finder methods to support newer SQL constraints
- 2021-04-10
  - Updated generated DML format and matcher logic to support DigitalOcean's managed-MySQL instances
- 2021-04-07
  - Fixed bugs in the .find() routines that handle plain-text matching so it works with the new MariaDB modules
- 2021-03-07
  - Fixed bug in creating new tables with auto-inc IDs
  - Fixed bug in debug_sql with no args
- 2021-01-18
  - Fixed bug creating rows when `uuidLinkedIds` config enabled but the ID key was auto increment
  - Added config option `deflateToStrings` to force stringification of values before submitting to DB. This can work around some weird ForeignKey constraint errors if you encounter them.
  - Fixed ES6 import support for linked models
  - Added `bin/export-schema` to export the schema from the configured database to a set of `defs` and `models`
  - Updated handling of external schemas with primary key columns named something other than 'id' by honoring the convention of "table.field" when specifying the table name in schemas and including the 'legacyExternalSchema' attribute on schemas.
  - Added test suite to precommit hooks
- 2021-01-11
  - Rewrote the `schema-sync` utility from Perl to Javascript, thereby removing any use of Perl in this project.

---

- Fixed Date stringification on insert
- Added auto retry if SQL connection goes away
- Misc bug and linter fixes

---

- Support for UUID primary keys (in the 'id' field)
  - To use, define an 'id' field in your schema using the `t.uuidKey` type. Triggers will automatically be added to that table to set a UUID using the MySQL `uuid()` function.
- `dbh()` accessors on classes are now **async** which means you MUST `await` them to get the handle.
- Uses `mariadb` (<https://www.npmjs.com/package/mariadb>) instead of `mariasql` internally now because `mariasql` failed to build on > Node 10, and I needed Node 12 for some projects
- Updated test suite internally add more coverage
- Removed various service wrappers/emulators that were unused/uneeded (e.g. Feathers/etc)
- Added linting to clean up code quality

## Testing

For tests to run successfully, you will need to do the following steps:

- Copy `sample.yass-orm.js` to `.yass-orm.js`
- Modify `.yass-orm.js` to suit the user/pass for your local DB
- Ensure database `test` exists
- Create two test tables:
  - `create table yass_test1 (id int primary key auto_increment, name varchar(255), isDeleted int default 0, nonce varchar(255));`
  - `create table yass_test2 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));`
- Add another database: `yass_test2`
  - `create table yass_test3 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));`
