exports.default = ({ types: t }) => ({
	table: 'yass_test2.yass_test3',
	schema: {
		id: t.uuidKey,
		name: t.string,
		nonce: t.string,
	},
});
