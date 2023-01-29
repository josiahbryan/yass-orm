# yass-orm
Yet Another Super Simple ORM

Why? Mainly for my personal use in a variety of projects.

## Recent changes:
----
* 2023-01-28
	* Chore: Added tests around `debugSql`'s behavior to ensure it stays stable and performs as expected in future releases
	* Fix: Changed `debugSql` to use the same deflation done when writing data to the database (e.g. properly convert dates and booleans to their database values) and now properly quotes non-numeric strings with `'` instead of `"`.
	* Fix: Added `JSON.decycle` polyfill to decycle json objects before stringifying them when outputting error messages to the console.
	* Fix: Changed quoting in `finder.js` to use single quotes when outputting SQL for debugging
* 2022-11-29
	* Feat: Changed multi-schema format from 'x/y' to 'x.y'. This requires the (legacy) method of specifying ID field to always use a schema. So if you had schemas that said "user.userId" to load legacy data, you will need to update that to be "database.users.userId"
* 2022-11-24
	* Feat: Added support for linking schemas to alternate database schemas other than the `db` set in `.yass-orm.js` by specifying a `table` name in the schema like `"databaseSchema/tableName"` (which would be used in SQL as `select * from databaseSchema.tableId where id=123`)
	* Updated schema-sync to support the same special "slash" table names
* 2022-10-06
	* Feat: Added support for a `disableAutoUpdatedAt` on schema definitions to do as it says: Turn off the automatic setting of `updatedAt` fields in the `patch()` method on objects. It is on by default, but you can set `disableAutoUpdatedAt: true` in your schema definition to turn off that behavior now.
* 2022-09-16
	* Fix: Add better nonce failure messages
	* Fix: Regression in nonce failures with JSON.stringify
	* Fix: Added better error messages when it can't find linked models long with traces on where the call appeared to originate from
* 2022-08-11
	* Fix: Don't try to destructure failures in queries for nonces
* 2022-08-10
	* Added `verbose` flag to `patchWithNonceRetry` options and defaulted it to false to quiet some logs that were not strictly required.
* 2022-08-08
	* Bump version to `1.6.5` to reflect recent changes
	* Did `npm audit fix` so `npm audit` runs clean now
	* Updated `package-lock.json`'s `lockFileVersion`
	* Added `QueryLogger` interface as named export to allow users to consume a query log, get last 100 queries executed, and get notified on each new query (and when the query ends). Off by default, to use, first call `QueryLogger.enable()` then `QueryLog.attachListener(callback)`. Also `QueryLogger.getLines()` gets most recent 100 queries. In your `attachListener` callback, you can set an `onFinished` property on the first json argument you receive, and it will be called when the query ends.
	* Made handle creation deferred  - i.e. two simultaneous calls to something like `retryIfConnectionLost` will now use the same handle instead of creating a new handle each time. This should have worked in the past, and it does work if you call `retryIfConnectionLost` (or anything that creates a handle) some milliseconds apart. However, if the internal `handle` routine was called while the first `handle` was still connecting (since connections are async), there would be no cached handle (yet), so it would just create another new handle - which would also have to connect. In situations where multiple queries are being run by different parts of the program on cold start (e.g. a server stack booting), this could create hundreds of handles where it really should just have the one cached handle (as needed). This commit fixes that "cold-boot" scenario.
* 2022-08-07
	* Modified `patch` behavior to NOT set ALL the fields, but only the fields explicitly given to `patch` (as long as they are in the schema).
	* Added `patchWithNonceRetry` method (see jsdocs in the code) to help with retrying when nonce changes on disk
* 2022-07-30
	* Added support for pass-thru props from definitions into the JSON schema created for objects, including auto-population of any schema-provided 'options' object. This was added to support passing thru custom fields from the schema into domain code.
* 2022-07-10
	* Changed calls from `path.join` to `path.resolve` to support relative links and other use-cases
	* Changed UUID Primary Key definitions to be `char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin` in order to force case-sensitive matches
	* Updated sync-to-db to support a new schema prop, `collation` and properly sync that to MariaDB when changed
* 2022-05-27
	* Added support for a special `nonce` field - when `nonce` is present on a schema, it is enforced in the `DatabaseObject`'s `patch` method - the nonce given in the patch (or stored in memory) MUST equal the `nonce` stored on disk (explicit `SELECT` is done for the `nonce` before patching to compare). If not equal (`===`), then an `Error` is thrown with the `.code` prop on the error set to `ERR_NONCE`. The caller is expected to `get` a new copy from disk and apply the patch again, or verify with user, or any other domain-specific steps desired.
* 2022-04-24
	* Fixed bug in `search(fields)` where `fields` would be modified with deflated values after returning (e.g. if `fields` was `{ flag: true }`, after `search()`, the outer scope's copy of `fields` would be incorrectly changed to `{ flag: 1 }`). This was caused by incorrect `Object.assign` usage internally, which has been rectified in this commit.
	* Version bump to `1.4.6`
* 2022-04-09
	* Added support for `staging` as a valid value for `NODE_ENV`
* 2022-02-16
	* Set `process.env.TZ='UTC'` to ensure consistent Date handling
* 2022-02-06
	* Fixed race condition around cached handles in `dbh.js`
	* Added code timing helper and optimized inflating already inflated values
* 2022-02-04
	* Fixed compatibility with `int(11)` primary keys for schema syncs
* 2022-02-02
   * Added `onHandleAccessDebug` as an external hook to debug handle creation/access. To use, `import { libUtils } from 'yass-orm'` then set `libUtils.handle.onHandleAccessDebug = (dbh, { cacheMiss }) => { ... }` to execute your custom code.
* 2022-01-21
	* Merged support for Read Only nodes to support MySQL clusters
	* Added support for a static `generateObjectId` method that child classes can override to change how IDs are generated
	* Added quotes ('`') around column names in the generated 'create index' SQL
	* Added checking for invalid column names in index definitions and better error messages if invalid column names are found
* 2022-01-13
	* Added `allowPublicKeyRetrieval` to handle options to support newer versions of MySQL
* 2021-12-06
	* Added support for custom `baseClass` in `config.js`
	* Added support for a promise guard in `DatabaseObject.jsonify` to prevent odd recursion errors where sometimes the object would not be properly jsonified if multiple instances running at once
	* Added support for subclasses overriding the caching implementation
	* Updated the caching implementation to properly freshen the cache when mutating the object via patches, etc
	* Added basic `stringify()` function to `DatabaseObject` base class
* 2021-10-30
	* Added support for `mutateJoins` to `finder.js` to inject custom joined tables when searching
* 2021-06-12
	* Added timezone config to mariadb connector to disable the underlying mariadb library from attempting to translate date/time string timezones since we take care to ensure date/time strings are loaded/stored as UTC
* 2021-05-30
	* Updated lodash and hosted-git-info deps due to upstream requirements
	* Added notes on testing and fixed linting errors in test.js
* 2021-04-14
	* Added additional error string to allowed retry errors
* 2021-04-13
	* Updated string/column quotations in generated SQL from the finder methods to support newer SQL constraints
* 2021-04-10
	* Updated generated DML format and matcher logic to support DigitalOcean's managed-MySQL instances
* 2021-04-07
	* Fixed bugs in the .find() routines that handle plain-text matching so it works with the new MariaDB modules
* 2021-03-07
	* Fixed bug in creating new tables with auto-inc IDs
	* Fixed bug in debug_sql with no args
* 2021-01-18
	* Fixed bug creating rows when `uuidLinkedIds` config enabled but the ID key was auto increment
	* Added config option `deflateToStrings` to force stringification of values before submitting to DB. This can work around some weird ForeignKey constraint errors if you encounter them.
	* Fixed ES6 import support for linked models
	* Added `bin/export-schema` to export the schema from the configured database to a set of `defs` and `models`
	* Updated handling of external schemas with primary key columns named something other than 'id' by honoring the convention of "table.field" when specifying the table name in schemas and including the 'legacyExternalSchema' attribute on schemas.
	* Added test suite to precommit hooks
* 2021-01-11
	* Rewrote the `schema-sync` utility from Perl to Javascript, thereby removing any use of Perl in this project.

----
* Fixed Date stringification on insert
* Added auto retry if SQL connection goes away
* Misc bug and linter fixes

----

* Support for UUID primary keys (in the 'id' field)
	* To use, define an 'id' field in your schema using the `t.uuidKey` type. Triggers will automatically be added to that table to set a UUID using the MySQL `uuid()` function.
* `dbh()` accessors on classes are now **async** which means you MUST `await` them to get the handle.
* Uses `mariadb` (https://www.npmjs.com/package/mariadb) instead of `mariasql` internally now because `mariasql` failed to build on > Node 10, and I needed Node 12 for some projects
* Updated test suite internally add more coverage
* Removed various service wrappers/emulators that were unused/uneeded (e.g. Feathers/etc)
* Added linting to clean up code quality

# Testing

For tests to run successfully, you will need to do the following steps:

* Copy `sample.yass-orm.js` to `.yass-orm.js`
* Modify `.yass-orm.js` to suit the user/pass for your local DB
* Ensure database `test` exists
* Create two test tables:
	* `create table yass_test1 (id int primary key auto_increment, name varchar(255), isDeleted int default 0, nonce varchar(255));`
	* `create table yass_test2 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));`
* Add another database: `yass_test2`
	* `create table yass_test3 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));`