/**
 * Fixture for test/obj.link-styles.test.js: links back to `author.js` by lazy
 * reference (a require cycle), and to a publisher by a registered name. No
 * file is named `link-publisher`, so only the model registry can resolve it.
 */
const YassORM = require('../../../lib');

const definition = ({ types: t }) => ({
	table: 'yass_link_book',
	schema: {
		id: t.idKey,
		title: t.string,
		author: t.linked(() => require('./author')),
		publisher: t.linked('link-publisher'),
	},
});

const LinkBook = YassORM.loadDefinition(definition);

module.exports = LinkBook;
module.exports.default = LinkBook;
module.exports.definition = definition;
