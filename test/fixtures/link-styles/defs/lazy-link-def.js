/**
 * Fixture for test/generate-types.test.js: a definition with a lazy-reference
 * link. Codegen reads the definition, not the model, so it cannot see the
 * reference's type; the field is typed `unknown` instead of crashing.
 */
exports.default = ({ types: t }) => ({
	table: 'yass_link_lazy_def',
	schema: {
		id: t.idKey,
		// eslint-disable-next-line global-require
		author: t.linked(() => require('../author')),
	},
});
