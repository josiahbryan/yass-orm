# yass-orm
Yet Another Super Simple ORM

Why? Mainly for my personal use in a variety of projects.
## Latest changes:

* Support for UUID primary keys (in the 'id' field)
	* To use, define an 'id' field in your schema using the `t.uuidKey` type. Triggers will automatically be added to that table to set a UUID using the MySQL `uuid()` function.
* `dbh()` accessors on classes are now **async** which means you MUST `await` them to get the handle.
* Uses `mariadb` (https://www.npmjs.com/package/mariadb) instead of `mariasql` internally now because `mariasql` failed to build on > Node 10, and I needed Node 12 for some projects
* Updated test suite internally add more coverage
