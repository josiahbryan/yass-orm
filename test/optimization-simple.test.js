/* eslint-disable no-unused-expressions */
/* eslint-disable global-require */
/* eslint-disable no-console */
/* global it, describe, beforeEach */
const { expect } = require('chai');
const YassORM = require('../lib');

describe('#YASS-ORM Core Optimizations', () => {
	const fakeSchema = require('./fakeSchema').default;
	let TestClass;

	beforeEach(() => {
		// Use the fakeSchema directly like the original tests do
		TestClass = YassORM.loadDefinition(fakeSchema);
	});

	describe('Static Method Caching', () => {
		it('should cache fields() results across calls', () => {
			// First call should compute and cache
			const fields1 = TestClass.fields();
			expect(Array.isArray(fields1)).to.be.true;
			expect(fields1.length).to.be.greaterThan(0);

			// Second call should return same cached instance
			const fields2 = TestClass.fields();
			expect(fields2).to.equal(fields1); // Same reference = cached

			// Note: Cache is now stored in private symbols, so we can't directly access it
			// but we can verify caching behavior by checking reference equality above
		});

		it('should cache idField() results across calls', () => {
			// First call should compute and cache
			const idField1 = TestClass.idField();
			expect(typeof idField1).to.equal('string');
			expect(idField1).to.equal('id');

			// Second call should return same cached value
			const idField2 = TestClass.idField();
			expect(idField2).to.equal(idField1);

			// Note: Cache is now stored in private symbols, so we can't directly access it
			// but we can verify caching behavior by checking value equality above
		});
	});

	describe('Static Method Performance', () => {
		it('should handle deflateValues efficiently with optimized loops', () => {
			const testData = {
				id: 123,
				name: 'test-object',
				date: '2023-01-01',
				isDeleted: false,
			};

			const deflated = TestClass.deflateValues(testData);

			expect(deflated).to.be.an('object');
			expect(deflated.id).to.equal(123);
			expect(deflated.name).to.equal('test-object');
			expect(deflated.date).to.equal('2023-01-01');
			expect(deflated.isDeleted).to.equal(0); // Boolean -> int conversion
		});

		it('should handle inflateValues efficiently with optimized loops', async () => {
			const rawData = {
				id: 123,
				name: 'test-object',
				date: '2023-01-01',
				isDeleted: 0, // From DB as int
			};

			const inflated = await TestClass.inflateValues(rawData);

			expect(inflated).to.be.an('object');
			expect(inflated.id).to.equal(123);
			expect(inflated.name).to.equal('test-object');
			expect(inflated.date).to.equal('2023-01-01');
			expect(inflated.isDeleted).to.equal(false); // int -> Boolean conversion
		});

		it('should handle early exit for null values in inflateValues', async () => {
			const rawData = {
				id: 123,
				name: null,
				date: undefined,
				isDeleted: 0,
			};

			const inflated = await TestClass.inflateValues(rawData);

			expect(inflated.id).to.equal(123);
			expect(inflated.name).to.be.null;
			expect(inflated.date).to.be.undefined;
			expect(inflated.isDeleted).to.equal(false);
		});
	});

	describe('Instance Methods with Proper ORM Patterns', () => {
		it('should create objects using proper ORM methods and test jsonify', async () => {
			const testData = {
				name: 'test-jsonify-object',
				date: '2023-01-01',
			};

			// Create using proper ORM method
			const instance = await TestClass.create(testData);

			// Test jsonify works with optimizations
			const json = await instance.jsonify({ excludeLinked: true });

			expect(json.id).to.not.be.null;
			expect(json.name).to.equal('test-jsonify-object');
			expect(json.date).to.equal('2023-01-01');

			// Test set method works with optimizations
			instance.set({ name: 'updated-name' });
			expect(instance.name).to.equal('updated-name');

			// Test set with object parameter
			instance.set({
				name: 'bulk-updated-name',
				date: '2023-12-31',
			});
			expect(instance.name).to.equal('bulk-updated-name');
			expect(instance.date).to.equal('2023-12-31');

			// Clean up
			await instance.reallyDelete();
		});

		it('should work with findOrCreate patterns', async () => {
			const testData = {
				name: 'findorcreate-test',
				date: '2023-01-01',
			};

			// First call should create
			const instance1 = await TestClass.findOrCreate(testData);
			expect(instance1.name).to.equal('findorcreate-test');

			// Second call should find existing
			const instance2 = await TestClass.findOrCreate(testData);
			expect(instance2.id).to.equal(instance1.id);

			// Clean up
			await instance1.reallyDelete();
		});

		it('should work with fromSql patterns', async () => {
			// Create some test data first
			const testData1 = { name: 'fromsql-test-1', date: '2023-01-01' };
			const testData2 = { name: 'fromsql-test-2', date: '2023-01-02' };

			const instance1 = await TestClass.create(testData1);
			const instance2 = await TestClass.create(testData2);

			try {
				// Use fromSql to get list of instances
				const instances = await TestClass.fromSql('name LIKE :pattern', {
					pattern: 'fromsql-test-%',
				});

				expect(Array.isArray(instances)).to.be.true;
				expect(instances.length).to.equal(2);
				expect(instances[0]).to.be.instanceOf(TestClass);
				expect(instances[1]).to.be.instanceOf(TestClass);

				// Verify they are proper instances
				expect(instances[0].id).to.not.be.null;
				expect(instances[1].id).to.not.be.null;
			} finally {
				// Clean up
				await instance1.reallyDelete();
				await instance2.reallyDelete();
			}
		});
	});

	describe('Performance Regression Tests', () => {
		it('should not recreate cached values on repeated calls', () => {
			// Test static method caching
			const fields1 = TestClass.fields();
			const fields2 = TestClass.fields();
			const fields3 = TestClass.fields();

			// All should be the exact same reference (cached)
			expect(fields1).to.equal(fields2);
			expect(fields2).to.equal(fields3);

			const idField1 = TestClass.idField();
			const idField2 = TestClass.idField();
			expect(idField1).to.equal(idField2);
		});

		it('should handle large datasets efficiently', async () => {
			// Create data with many fields to test loop efficiency
			const rawData = {};
			for (let i = 0; i < 50; i++) {
				rawData[`field${i}`] = `value${i}`;
			}
			rawData.id = 123;
			rawData.name = 'large-dataset-test';

			const start = Date.now();
			const inflated = await TestClass.inflateValues(rawData);
			const duration = Date.now() - start;

			// Should complete quickly with optimized loops
			expect(duration).to.be.lessThan(100);
			expect(inflated.id).to.equal(123);
			expect(inflated.name).to.equal('large-dataset-test');
		});

		it('should handle repeated deflateValues calls efficiently', () => {
			const testData = {
				name: 'repeated-deflate-test',
				date: '2023-01-01',
				isDeleted: false,
			};

			const start = Date.now();

			// Run multiple deflations to test caching
			for (let i = 0; i < 100; i++) {
				const deflated = TestClass.deflateValues({ ...testData, id: i });
				expect(deflated.id).to.equal(i);
			}

			const duration = Date.now() - start;

			// Should complete quickly with cached fields
			expect(duration).to.be.lessThan(50);
		});
	});

	describe('Path Caching (if applicable)', () => {
		it('should cache path resolution for model classes', async () => {
			// This tests the global PATH_CACHE optimization
			// PATH_CACHE is not exported, but we can test the behavior indirectly

			// Try to resolve a model twice (will fail but should cache the path)
			let error1;
			let error2;
			const start1 = Date.now();
			try {
				await TestClass._resolveModelClass('nonexistent-model');
			} catch (e) {
				error1 = e;
			}
			const duration1 = Date.now() - start1;

			const start2 = Date.now();
			try {
				await TestClass._resolveModelClass('nonexistent-model');
			} catch (e) {
				error2 = e;
			}
			const duration2 = Date.now() - start2;

			// Both should fail with same error, and path caching should work
			expect(error1).to.exist;
			expect(error2).to.exist;
			expect(error1.message).to.equal(error2.message);
			// Second call should be same or faster due to path caching
			expect(duration2).to.be.at.most(duration1 + 1); // Allow 1ms tolerance
		});
	});
});
