// Fixture for test/obj.link-styles.test.js: the other half of the esm-a cycle.
import YassORM from '../../../lib/index.js';
// eslint-disable-next-line import/no-cycle
import EsmA from './esm-a.mjs';

const EsmB = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_link_esm_b',
	schema: { id: t.idKey, a: t.linked(() => EsmA) },
}));

export default EsmB;
