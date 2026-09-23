/**
 * Fixture for test/obj.characterize.links.test.js: a person who may link to
 * another person (`bestFriend`, a self-link, so a row can be its own friend).
 * Lives in a file because links resolve from disk.
 */
const YassORM = require('../../../lib');

const definition = ({ types: t }) => ({
	table: 'yass_char_person',
	schema: {
		id: t.idKey,
		name: t.string,
		bestFriend: t.linked('char-person'),
	},
});

const CharPerson = YassORM.loadDefinition(definition);

module.exports = CharPerson;
module.exports.default = CharPerson;
// For schema sync: a fresh convertDefinition() per sync, never Model.schema()
module.exports.definition = definition;
