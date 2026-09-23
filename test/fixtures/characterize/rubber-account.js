/**
 * Fixture for test/obj.characterize.rubber-subclass.test.js: a Rubber-style model
 * (uuid ids, createdBy/updatedBy, an enum) on the createBaseClass() model in
 * rubber-base.js.
 */
const { createBaseClass } = require('./rubber-base');

const definition = ({ types: t }) => ({
	table: 'yass_char_rubber_account',
	schema: {
		id: t.uuidKey,
		name: t.string,
		status: t.enum(['active', 'paused']),
		createdBy: t.string,
		updatedBy: t.string,
		createdAt: t.datetime,
		updatedAt: t.datetime,
	},
});

class RubberAccount extends createBaseClass(definition) {}

module.exports = RubberAccount;
module.exports.default = RubberAccount;
module.exports.definition = definition;
