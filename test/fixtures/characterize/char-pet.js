/**
 * Fixture for test/obj.characterize.links.test.js: links by a bare name in its own
 * folder (`char-person`) and by a relative path into a subfolder
 * (`./sub/char-vet`).
 */
const YassORM = require('../../../lib');

const definition = ({ types: t }) => ({
	table: 'yass_char_pet',
	schema: {
		id: t.idKey,
		name: t.string,
		owner: t.linked('char-person'),
		vet: t.linked('./sub/char-vet'),
	},
});

const CharPet = YassORM.loadDefinition(definition);

module.exports = CharPet;
module.exports.default = CharPet;
// For schema sync: a fresh convertDefinition() per sync, never Model.schema()
module.exports.definition = definition;
