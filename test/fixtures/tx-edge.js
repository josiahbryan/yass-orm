/**
 * Test fixture model with linked fields, used to prove that `{ tx }` threads all
 * the way through `create` -> `inflate` -> `inflateValues` -> `_resolvedLinkedModel`.
 *
 * Without that threading, the linked fields resolve on a different pooled
 * connection that cannot see the uncommitted rows, and come back silently null.
 */
const YassORM = require('../../lib');

const TxEdge = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_tx_edge',
	schema: {
		id: t.idKey,
		label: t.string,
		fromNode: t.linked('tx-node'),
		toNode: t.linked('tx-node'),
	},
}));

module.exports = TxEdge;
module.exports.default = TxEdge;
