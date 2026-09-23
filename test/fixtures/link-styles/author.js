/**
 * Fixture for test/obj.link-styles.test.js: links by lazy reference.
 * `book.js` links back here, so the two form a require cycle. In CommonJS a
 * cycle hands one side a half-built `module.exports`, so the cycle-safe thunk
 * requires inside the function: `() => require('./book')`. A self-link can
 * name the class directly, since the thunk runs long after this file loads.
 */
const YassORM = require('../../../lib');

const definition = ({ types: t }) => ({
	table: 'yass_link_author',
	schema: {
		id: t.idKey,
		name: t.string,
		favoriteBook: t.linked(() => require('./book')),
		// eslint-disable-next-line no-use-before-define
		mentor: t.linked(() => LinkAuthor),
	},
});

const LinkAuthor = YassORM.loadDefinition(definition);

module.exports = LinkAuthor;
module.exports.default = LinkAuthor;
module.exports.definition = definition;
