exports.default = ({ types: t }) => ({
	table: 'yass_test_created_at.id',
	schema: {
		name: t.string,
		createdAt: t.datetime,
	},
});
