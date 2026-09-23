/**
 * Fixture for test/obj.characterize.contract.test.js: a bare definition file,
 * found through `globalThis.__YASS_DEF_PATH_MAP__` (Rubber's Bun builds).
 */
module.exports = ({ types: t }) => ({
	table: 'yass_char_mapped_def',
	schema: { id: t.idKey, name: t.string },
});
