# yass-orm
Yet Another Super Simple ORM

Why? Mainly for my personal use in a variety of projects.

## Recent changes:
----
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

----
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
	* `create table yass_test1 (id int primary key auto_increment, name varchar(255), isDeleted int default 0);`
	* `create table yass_test2 (id varchar(255), name varchar(255), isDeleted int default 0);`