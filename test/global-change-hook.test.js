/* global describe, it, beforeEach, afterEach */
const { expect } = require('chai');
const Orm = require('../lib/index');

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
	let unregister;
	let received;

	beforeEach(() => {
		FakeModel = Orm.loadDefinition(fakeSchema);
		received = [];
		unregister = Orm.registerGlobalChangeHook((payload) => {
			received.push(payload);
		});
	});

	afterEach(async () => {
		if (unregister) unregister();
	});

	it('fires with wasCreated:true after create()', async () => {
		const instance = await FakeModel.create({ name: 'alpha' });
		expect(received.length).to.be.at.least(1);

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

		expect(received.length).to.be.at.least(1);
		const payload = received[received.length - 1];
		expect(payload.wasCreated).to.equal(false);
		expect(payload.id).to.equal(instance.id);
		expect(payload.modelName).to.equal(FakeModel.table());
		expect(payload.changedFields).to.have.property('name', 'beta');
		// updatedAt must NOT appear in changedFields (managed-key strip)
		expect(payload.changedFields).to.not.have.property('updatedAt');

		await instance.reallyDelete();
	});

	it('fires with isDeleted in changedFields after remove()', async () => {
		const instance = await FakeModel.create({ name: 'to-remove' });
		received.length = 0;

		await instance.remove();

		expect(received.length).to.be.at.least(1);
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
});
