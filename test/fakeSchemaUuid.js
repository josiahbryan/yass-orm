exports.default = ({ types: t }) => ({
	table: 'yass_test2',
	schema: {
		id: t.uuidKey,
		name: t.string,
		nonce: t.string,
	},

	indexes: {
		idx_name: ['name'],
		idx_nonce: ['nonce DESC'],
		idx_name_and_nonce: '(name, nonce(3))',
		idx_name_fulltext: ['fulltext', 'name'],
	},
});
