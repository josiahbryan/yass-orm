const { schema2 } = require('./helpers/schema2');

exports.default = ({ types: t }) => ({
	table: `${schema2()}.yass_test3`,
	schema: {
		id: t.uuidKey,
		name: t.string,
		nonce: t.string,
	},
});
