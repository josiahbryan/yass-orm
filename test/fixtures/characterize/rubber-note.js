/**
 * Fixture for test/obj.characterize.rubber-subclass.test.js: a Rubber-style model
 * with no createdBy/updatedBy (so its findOrCreate falls through to yass's),
 * linking to rubber-account.js. Rubber sets `uuidLinkedIds`, so the link
 * column holds a uuid; set here only while the definition is converted.
 */
const config = require('../../../lib/config');
const { createBaseClass } = require('./rubber-base');

const definition = ({ types: t }) => {
	const { uuidLinkedIds } = config;
	config.uuidLinkedIds = true;
	try {
		return {
			table: 'yass_char_rubber_note',
			schema: {
				id: t.uuidKey,
				body: t.string,
				account: t.linked('rubber-account'),
			},
		};
	} finally {
		config.uuidLinkedIds = uuidLinkedIds;
	}
};

class RubberNote extends createBaseClass(definition) {}

module.exports = RubberNote;
module.exports.default = RubberNote;
module.exports.definition = definition;
