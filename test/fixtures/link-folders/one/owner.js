/**
 * Fixture for test/obj.link-resolution.test.js: links to `target` in its own
 * folder (link-folders/one/target.js).
 */
const YassORM = require('../../../../lib');

const Owner = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_link_owner_one',
	schema: {
		id: t.uuidKey,
		target: t.linked('target'),
	},
}));

module.exports = Owner;
module.exports.default = Owner;
