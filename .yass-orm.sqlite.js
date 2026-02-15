// SQLite test configuration for yass-orm
// This config file is used for running tests against SQLite instead of MySQL

// Override here so we don't have to rely on it being set for scripts in prod
process.env.NODE_ENV = 'development';

module.exports = {
	development: {
		dialect: 'sqlite',
		filename: '/tmp/yass-orm-test.sqlite', // Use temp file for tests
	},

	// Applies to all envs above
	shared: {
		schema: 'main', // SQLite uses 'main' as the default schema
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
