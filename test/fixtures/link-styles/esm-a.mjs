// Fixture for test/obj.link-styles.test.js: an ES module cycle (esm-a <->
// esm-b) linked by lazy reference to the imported binding itself. ESM
// bindings are live, so `() => EsmB` sees the finished class when it runs.
import YassORM from '../../../lib/index.js';
// eslint-disable-next-line import/no-cycle
import EsmB from './esm-b.mjs';

const EsmA = YassORM.loadDefinition(({ types: t }) => ({
	table: 'yass_link_esm_a',
	schema: { id: t.idKey, b: t.linked(() => EsmB) },
}));

export default EsmA;
