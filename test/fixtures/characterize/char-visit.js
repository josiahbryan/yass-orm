/**
 * Fixture for test/obj.characterize.links.test.js: a definition wrapped the way
 * Rubber wraps its defs (withRelativeModelLinks), so `t.linked` receives
 * absolute paths: `char-vet` is found in `sub/` (a search folder), and
 * `char-person` falls through to the default models folder (this one).
 */
const path = require('path');
const YassORM = require('../../../lib');
const withRelativeModelLinks = require('../../helpers/withRelativeModelLinks');

const definition = withRelativeModelLinks(
	'.',
	({ types: t }) => ({
		table: 'yass_char_visit',
		schema: {
			id: t.idKey,
			pet: t.linked('char-pet'),
			vet: t.linked('char-vet'),
			owner: t.linked('char-person'),
		},
	}),
	{ localPath: __dirname, paths: [path.join(__dirname, 'sub')] },
);

const CharVisit = YassORM.loadDefinition(definition);

module.exports = CharVisit;
module.exports.default = CharVisit;
module.exports.definition = definition;
