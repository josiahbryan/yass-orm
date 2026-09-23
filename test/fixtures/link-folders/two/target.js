/**
 * Fixture for test/obj.link-resolution.test.js: link-folders/one and
 * link-folders/two each hold a `target` model, and each folder's `owner` links
 * to it by the same relative name.
 */
const YassORM = require('../../../../lib');

const Target = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_link_target_two',
	schema: {
		id: t.uuidKey,
		name: t.string,
	},
}));

module.exports = Target;
module.exports.default = Target;
