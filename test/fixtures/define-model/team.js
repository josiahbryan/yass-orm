/* eslint-disable global-require */
/**
 * Fixture for test/define-model.test.js: registered as 'dm-team', and links
 * back to its lead by lazy reference.
 */
const { defineModel } = require('../../../lib');

const Team = defineModel({
	table: 'yass_dm_team',
	prefix: 'team',
	schema: (t) => ({
		id: t.stringKey,
		name: t.string,
		lead: t.linked(() => require('./member')),
	}),
});

module.exports = Team;
