// PostgreSQL test configuration for yass-orm
// Used to run the suite against Postgres instead of MySQL:
//   YASS_CONFIG=$PWD/.yass-orm.postgres.js npx mocha --exit <files>
//
// Expects a local server with a `yass` role and a `test` database. To set one up
// from scratch on macOS:
//   brew install postgresql@16 && brew services start postgresql@16
//   psql -d postgres -c "CREATE ROLE yass LOGIN PASSWORD 'testsys1' SUPERUSER"
//   createdb -O yass test

// Override here so we don't have to rely on it being set for scripts in prod
process.env.NODE_ENV = 'development';

module.exports = {
	development: {
		dialect: 'postgres',
		host: 'localhost',
		port: 5432,
		user: 'yass',
		password: 'testsys1',
	},

	// Applies to all envs above
	shared: {
		// Postgres' default schema is `public`; yass-orm uses `schema` as the
		// database name for connection purposes.
		schema: 'test',

		// Same commonFields as .yass-orm.js / .yass-orm.sqlite.js, so a Postgres run
		// exercises the identical schema shape the other dialects do.
		commonFields: (t) => {
			return {
				isDeleted: t.bool,

				createdBy: t.linked('user', { inverse: null }),
				createdAt: t.datetime,

				updatedBy: t.linked('user', { inverse: null }),
				updatedAt: t.datetime,
			};
		},
	},
};
