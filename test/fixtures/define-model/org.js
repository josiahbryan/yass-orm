/**
 * Fixture for test/define-model.test.js: a model from defineModel(), with
 * methods on a subclass. `member.js` links here and back, a require cycle, so
 * the thunks there require inside the function.
 */
const { defineModel } = require('../../../lib');

const Org = defineModel({
	table: 'yass_dm_org',
	prefix: 'org',
	schema: (t) => ({
		id: t.stringKey,
		name: t.string.default(''),
		slug: t.string.exact(),
		seats: t.int,
		active: t.bool,
		plan: t.enum(['free', 'pro']),
		settings: t.object({ theme: t.string }),
		tags: t.array(t.string),
		foundedAt: t.datetime.precision(3),
		// A self-link: the thunk runs long after this file has loaded.
		// eslint-disable-next-line no-use-before-define
		parent: t.linked(() => OrgModel),
	}),
});

class OrgModel extends Org {
	get label() {
		return `${this.name} (${this.seats || 0})`;
	}

	static bySlug(slug) {
		return this.searchOne({ slug });
	}
}

module.exports = OrgModel;
module.exports.Org = Org;
