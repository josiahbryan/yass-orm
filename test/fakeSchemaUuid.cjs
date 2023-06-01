exports.default = ({ types: t }) => ({
	table: 'yass_test2',
	schema: {
		id: t.uuidKey,
		name: t.string,
		nonce: t.string,
		linkTest: t.linked('fakeSchema'),
	},
});
