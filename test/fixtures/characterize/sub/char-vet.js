/**
 * Fixture for test/obj.characterize.links.test.js: links up a folder
 * (`../char-person`), relative to this file.
 */
const YassORM = require('../../../../lib');

const definition = ({ types: t }) => ({
	table: 'yass_char_vet',
	schema: {
		id: t.idKey,
		name: t.string,
		clinicOwner: t.linked('../char-person'),
	},
});

const CharVet = YassORM.loadDefinition(definition);

module.exports = CharVet;
module.exports.default = CharVet;
// For schema sync: a fresh convertDefinition() per sync, never Model.schema()
module.exports.definition = definition;
