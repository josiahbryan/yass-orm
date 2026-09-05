exports.default = ({ types: t }) => ({
	table: 'yass_test2',
	schema: {
		id: t.uuidKey,
		name: t.string,
		nonce: t.string,
	},

	indexes: {
		idx_name: ['name'],
		idx_nonce: ['nonce DESC'],
		idx_name_and_nonce: '(name, nonce(3))',
		idx_name_fulltext: ['fulltext', 'name'],
	},

	// Exercise the declared-trigger reconciler under `npm run test:schema-sync`
	// so the smoke test proves the plumbing at least CREATE-and-runs-clean end
	// to end. MUST be a no-op: this table is also `test/test.js`'s uuid-key
	// fixture, and a mutating body (e.g. UPPER(name)) fails those assertions
	// after schema-sync. The live idempotency/ordering/opt-in gates live in
	// test/schemaSync.triggers.test.js on their own tables.
	triggers: {
		yass_test2_schema_sync_smoke: {
			timing: 'before',
			event: 'insert',
			body: `BEGIN
				SET NEW.nonce = NEW.nonce;
			END`,
		},
	},
});
