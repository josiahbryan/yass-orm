exports.default = ({ types: t }) => ({
	table: 'yass_test1.id',
	schema: {
		name: t.string,
		date: t.date,
		jsonSample: t.object(),
	},
	indexes: { testJsonIndex: ['jsonSample->>"$.testValue"'] },
});
