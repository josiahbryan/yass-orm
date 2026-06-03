/* global describe, it, beforeEach, afterEach */
const { expect } = require('chai');
const Orm = require('../lib/index');
const fakeSchemaCreatedAt = require('./fakeSchemaCreatedAt').default;

/**
 * Tests for registerGlobalChangeHook.
 *
 * Uses the same fakeSchema / MySQL-backed model that the existing test suite
 * uses (yass_test1).  The table is synced by `npm run test:schema-sync` which
 * runs before the mocha suites.
 */
describe('#Global Change Hook', () => {
	const fakeSchema = require('./fakeSchema').default;
	let FakeModel;
	let FakeModelWithCreatedAt;
	let unregister;
	let received;

	beforeEach(() => {
		FakeModel = Orm.loadDefinition(fakeSchema);
		FakeModelWithCreatedAt = Orm.loadDefinition(fakeSchemaCreatedAt);
		received = [];
		unregister = Orm.registerGlobalChangeHook((payload) => {
			received.push(payload);
		});
	});

	afterEach(async () => {
		if (unregister) unregister();
	});

	it('fires with wasCreated:true after create() — exactly once', async () => {
		const instance = await FakeModel.create({ name: 'alpha' });
		// Direct static create() must fire EXACTLY once (not "at least once")
		expect(received.length).to.equal(1);

		const payload = received.find((p) => p.wasCreated === true);
		expect(payload).to.exist;
		expect(payload.wasCreated).to.equal(true);
		expect(payload.id).to.equal(instance.id);
		expect(payload.modelName).to.equal(FakeModel.table());
		// changedFields should contain name=alpha (deflated = string 'alpha')
		expect(payload.changedFields).to.have.property('name', 'alpha');

		await instance.reallyDelete();
	});

	it('fires with wasCreated:false and only the changed field after patch()', async () => {
		const instance = await FakeModel.create({ name: 'before-patch' });
		// Clear create payloads so we only see the patch
		received.length = 0;

		await instance.patch({ name: 'beta' });

		// Direct patch() must fire EXACTLY once
		expect(received.length).to.equal(1);
		const payload = received[received.length - 1];
		expect(payload.wasCreated).to.equal(false);
		expect(payload.id).to.equal(instance.id);
		expect(payload.modelName).to.equal(FakeModel.table());
		expect(payload.changedFields).to.have.property('name', 'beta');
		// updatedAt must NOT appear in changedFields (managed-key strip)
		expect(payload.changedFields).to.not.have.property('updatedAt');

		await instance.reallyDelete();
	});

	it('fires with isDeleted in changedFields after remove() — exactly once', async () => {
		const instance = await FakeModel.create({ name: 'to-remove' });
		received.length = 0;

		await instance.remove();

		// Direct remove() (which is a patch) must fire EXACTLY once
		expect(received.length).to.equal(1);
		const payload = received[received.length - 1];
		expect(payload.wasCreated).to.equal(false);
		expect(payload.changedFields).to.have.property('isDeleted');

		// No reallyDelete needed – remove soft-deletes, table row cleaned up in test:schema-sync rerun
		await instance.reallyDelete();
	});

	it('a throwing hook does NOT break the write', async () => {
		// Register a bad hook that always throws
		const badUnregister = Orm.registerGlobalChangeHook(() => {
			throw new Error('hook exploded');
		});

		let instance;
		try {
			instance = await FakeModel.create({ name: 'survives-bad-hook' });
			expect(instance).to.exist;
			expect(instance.id).to.exist;
		} finally {
			badUnregister();
			if (instance) await instance.reallyDelete();
		}
	});

	it('unregister() stops delivery', async () => {
		// Unregister immediately
		unregister();
		unregister = null; // so afterEach doesn't double-call

		received.length = 0;
		const instance = await FakeModel.create({ name: 'unregistered' });
		expect(received.length).to.equal(0);

		await instance.reallyDelete();
	});

	// -------------------------------------------------------------------------
	// Fix 1: empty-change suppression
	// -------------------------------------------------------------------------

	it('empty-change patch fires NO hook event (Fix 1)', async () => {
		const instance = await FakeModel.create({ name: 'no-change-test' });
		received.length = 0;

		// Patching the field to its CURRENT value produces an empty diff after
		// patchIf compares existing vs desired — runGlobalChangeHooks suppresses it.
		await instance.patchIf({ name: instance.name });

		expect(received.length).to.equal(0);

		await instance.reallyDelete();
	});

	// -------------------------------------------------------------------------
	// Fix 1 anti-double-fire: findOrCreate with createdAt schema fires ONCE
	// -------------------------------------------------------------------------

	it('findOrCreate on a schema with createdAt fires exactly once with wasCreated:true (Fix 1 anti-double-fire)', async () => {
		// fakeSchemaCreatedAt has a `createdAt` field. Without Fix 1, the internal
		// `instance.patch({ createdAt: new Date() })` inside findOrCreate would fire
		// a second hook event (making two total instead of one).
		const instance = await FakeModelWithCreatedAt.findOrCreate({
			name: 'createdAt-double-fire-test',
		});

		try {
			// EXACTLY one event, wasCreated:true
			expect(received.length).to.equal(1);
			const payload = received[0];
			expect(payload.wasCreated).to.equal(true);
			expect(payload.id).to.equal(instance.id);
			expect(payload.modelName).to.equal(FakeModelWithCreatedAt.table());
		} finally {
			await instance.reallyDelete();
		}
	});

	// -------------------------------------------------------------------------
	// Fix 2 + Fix 3: patchIf fires when it writes, not when it doesn't
	// -------------------------------------------------------------------------

	it('patchIf fires once with only the changed field when it writes (Fix 2 + Fix 3)', async () => {
		const instance = await FakeModel.create({ name: 'patchif-write-test' });
		received.length = 0;

		// This value differs from the current 'patchif-write-test', so patchIf WILL write.
		await instance.patchIf({ name: 'patchif-new-value' });

		expect(received.length).to.equal(1);
		const payload = received[0];
		expect(payload.wasCreated).to.equal(false);
		expect(payload.id).to.equal(instance.id);
		// changedFields must contain ONLY the field that actually changed (name).
		// updatedAt is managed and must be stripped.
		expect(payload.changedFields).to.have.property('name', 'patchif-new-value');
		expect(payload.changedFields).to.not.have.property('updatedAt');

		// Now call patchIf with the SAME value — no write should happen, no hook.
		received.length = 0;
		await instance.patchIf({ name: instance.name });
		expect(received.length).to.equal(0);

		await instance.reallyDelete();
	});

	// -------------------------------------------------------------------------
	// Fix 3: findOrCreate found-and-patched reports only the real diff
	// -------------------------------------------------------------------------

	it('findOrCreate found-and-patched reports only genuinely-changed fields (Fix 3)', async () => {
		// Create the row first so findOrCreate will FIND it.
		const seed = await FakeModel.create({ name: 'foc-diff-test' });
		received.length = 0;

		// findOrCreate with patchIf that includes:
		//   - a field already at the target value (name → same value) — should NOT appear
		//   - a genuinely new value (jsonSample) — SHOULD appear
		const instance = await FakeModel.findOrCreate(
			{ name: 'foc-diff-test' },
			{ jsonSample: { key: 'new-value' } },
		);

		try {
			// One event for the patch of jsonSample; no event for name (already matches).
			expect(received.length).to.equal(1);
			const payload = received[0];
			expect(payload.wasCreated).to.equal(false);
			expect(payload.changedFields).to.have.property('jsonSample');
			// name was NOT changed — must not appear in changedFields
			expect(payload.changedFields).to.not.have.property('name');
		} finally {
			await seed.reallyDelete();
		}
	});
});
