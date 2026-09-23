/**
 * Fixture for test/obj.link-styles.test.js: the target of a registered-name
 * link. Its file name is not the name it is registered under, so a path
 * lookup can never find it.
 */
const YassORM = require('../../../../lib');

const definition = ({ types: t }) => ({
	table: 'yass_link_publisher',
	schema: {
		id: t.idKey,
		name: t.string,
	},
});

const LinkPublisher = YassORM.loadDefinition(definition);

module.exports = LinkPublisher;
module.exports.default = LinkPublisher;
module.exports.definition = definition;
