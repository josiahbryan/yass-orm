/* eslint-disable global-require */
/**
 * Fixture for test/define-model.test.js: links by lazy reference (to a
 * subclass, through a require cycle) and by registered name ('dm-team').
 */
const { defineModel } = require('../../../lib');

const Member = defineModel({
	table: 'yass_dm_member',
	prefix: 'mem',
	schema: (t) => ({
		id: t.stringKey,
		email: t.string.exact(),
		org: t.linked(() => require('./org')),
		team: t.linked('dm-team'),
	}),
});

module.exports = Member;
