/**
 * Fixture for test/obj.cache-scope.test.js: a model that links to itself, so a
 * row can be its own parent. Lives in a file because links resolve from disk.
 */
const YassORM = require('../../lib');

const CacheSelfLink = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_cache_self',
	schema: {
		id: t.idKey,
		name: t.string,
		parent: t.linked('cache-self-link'),
	},
}));

module.exports = CacheSelfLink;
module.exports.default = CacheSelfLink;
