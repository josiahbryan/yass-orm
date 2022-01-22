// Override here so we don't have to reply on it being set for scripts in prod
// TODO: Use config instead?
process.env.NODE_ENV = 'development';

module.exports = {
	development: {
		password: 'testsys1',
	},

	// Applies to all envs above
	shared: {
		schema: 'test',
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
