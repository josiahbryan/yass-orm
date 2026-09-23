/* global describe, it */
const path = require('path');
const { expect } = require('chai');

const OwnerOne = require('./fixtures/link-folders/one/owner');
const OwnerTwo = require('./fixtures/link-folders/two/owner');

const folder = (name) => path.join(__dirname, 'fixtures', 'link-folders', name);

/**
 * Linked-model resolution, no database needed: resolving a link imports the
 * model file, and inflating an already-inflated link must not query.
 */
describe('#YASS-ORM linked-model resolution', () => {
	describe('the resolved-path cache is keyed by the linking model folder', () => {
		it('resolves the same relative name to a different file in each folder', async () => {
			// Both owners link to 'target'; each folder has its own target.js.
			expect(OwnerOne.basePath()).to.equal(folder('one'));
			expect(OwnerTwo.basePath()).to.equal(folder('two'));

			const TargetOne = await OwnerOne._resolveModelClass('target');
			const TargetTwo = await OwnerTwo._resolveModelClass('target');

			expect(TargetOne.table()).to.equal('yass_link_target_one');
			expect(TargetTwo.table()).to.equal('yass_link_target_two');
			expect(TargetTwo).to.not.equal(TargetOne);
		});

		it('still reuses the resolution for repeat lookups from one folder', async () => {
			const first = await OwnerOne._resolveModelClass('target');
			const second = await OwnerOne._resolveModelClass('target');
			expect(second).to.equal(first);
		});
	});

	describe('a link value that is already an instance of the linked model', () => {
		it('is kept as it is, without another get()', async () => {
			const Target = await OwnerOne._resolveModelClass('target');
			Target.clearCache();

			// An inflated target that is NOT in the cache and not in any table:
			// a get() for it would have to query (and find nothing).
			const target = await Target.inflate({ id: 'target-1', name: 'T' });
			Target.clearCache();

			const originalGet = Target.get;
			let getCalls = 0;
			Target.get = function countingGet(...args) {
				getCalls += 1;
				return originalGet.apply(this, args);
			};
			try {
				const values = await OwnerOne.inflateValues({
					id: 'owner-1',
					target,
				});
				expect(values.target).to.equal(target);
				expect(getCalls).to.equal(0);
			} finally {
				Target.get = originalGet;
			}
		});

		it('an id is still resolved through get() (control)', async () => {
			const Target = await OwnerOne._resolveModelClass('target');
			const target = await Target.inflate({ id: 'target-2', name: 'T2' });

			const originalGet = Target.get;
			const calls = [];
			Target.get = function recordingGet(...args) {
				calls.push(args);
				return originalGet.apply(this, args);
			};
			try {
				const values = await OwnerOne.inflateValues({
					id: 'owner-2',
					target: 'target-2',
				});
				// Served from the cache (allowCached), so no query either.
				expect(values.target).to.equal(target);
				expect(calls).to.have.length(1);
				expect(calls[0][0]).to.equal('target-2');
			} finally {
				Target.get = originalGet;
			}
		});
	});
});
