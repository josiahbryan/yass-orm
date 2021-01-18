# yass-orm
Yet Another Super Simple ORM

Why? Mainly for my personal use in a variety of projects.
## Recent changes:
----
* 2021-01-17
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