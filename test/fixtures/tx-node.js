/**
 * Test fixture model for model-level transaction binding (`{ tx }`).
 *
 * Lives in its own file (rather than being defined inline in the test) because
 * `_resolvedLinkedModel` resolves linked models from disk relative to the
 * defining module's directory — `tx-edge` links to `tx-node` by name.
 */
const YassORM = require('../../lib');

const TxNode = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_tx_node',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));

module.exports = TxNode;
module.exports.default = TxNode;
