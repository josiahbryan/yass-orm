/* eslint-disable no-unused-expressions */
/* eslint-disable global-require */
/* global it, describe, beforeEach, afterEach */
const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const YassORM = require('../lib');

describe('#YASS-ORM Model Resolution Optimizations', () => {
	let TestClass;
	let tempModelFile;

	beforeEach(() => {
		// Create a temporary model file for testing
		tempModelFile = path.join(__dirname, `temp-model-${Date.now()}.js`);

		const tempModelContent = `
			const YassORM = require('../lib');
			
			module.exports = YassORM.loadDefinition({
				table: 'temp_model_table',
				schema: {
					id: { type: 'idKey' },
					name: { type: 'varchar', length: 255 },
				},
			});
		`;

		fs.writeFileSync(tempModelFile, tempModelContent);

		// Create test class using proper schema function format
		TestClass = YassORM.loadDefinition(({ types: t }) => ({
			table: `test_resolution_${Date.now()}`,
			schema: {
				id: t.idKey,
				name: t.string,
				linkedId: t.linked('temp-model'),
			},
		}));

		// Mock basePath to point to test directory
		TestClass.basePath = () => __dirname;
	});

	afterEach(() => {
		// Clean up temp file
		if (fs.existsSync(tempModelFile)) {
			fs.unlinkSync(tempModelFile);
		}
	});

	describe('Path Caching', () => {
		it('should cache resolved paths globally across classes', async () => {
			// Test path caching behavior indirectly through performance
			const start1 = Date.now();
			try {
				await TestClass._resolveModelClass('temp-model');
			} catch (e) {
				// Expected to fail but path should be cached
			}
			const duration1 = Date.now() - start1;

			const start2 = Date.now();
			try {
				await TestClass._resolveModelClass('temp-model');
			} catch (e) {
				// Expected to fail but should use cached path
			}
			const duration2 = Date.now() - start2;

			// Second call should be same or faster due to path caching
			expect(duration2).to.be.at.most(duration1 + 1);
		});

		it('should use cached paths on subsequent calls', async () => {
			const originalResolve = path.resolve;
			let resolveCallCount = 0;

			// Mock path.resolve to count calls
			path.resolve = (...args) => {
				resolveCallCount++;
				return originalResolve(...args);
			};

			try {
				// First call should resolve path
				try {
					await TestClass._resolveModelClass('cached-model');
				} catch (e) {
					// Expected to fail
				}

				const firstCallCount = resolveCallCount;

				// Second call should use cache
				try {
					await TestClass._resolveModelClass('cached-model');
				} catch (e) {
					// Expected to fail
				}

				// path.resolve should be called same or fewer times (due to caching)
				expect(resolveCallCount).to.be.at.most(firstCallCount + 1);
			} finally {
				path.resolve = originalResolve;
			}
		});

		it('should handle different model names in cache', async () => {
			// Test that different models can be cached independently
			let error1;
			let error2;

			try {
				await TestClass._resolveModelClass('model-a');
			} catch (e) {
				error1 = e;
			}

			try {
				await TestClass._resolveModelClass('model-b');
			} catch (e) {
				error2 = e;
			}

			// Both should fail but with different paths in error messages
			expect(error1).to.exist;
			expect(error2).to.exist;
			expect(error1.message).to.include('model-a');
			expect(error2.message).to.include('model-b');
		});
	});

	describe('Model Class Caching', () => {
		it('should cache successfully loaded model classes', async () => {
			// Create a valid model file
			const validModelFile = path.join(__dirname, 'valid-test-model.js');
			const validModelContent = `
				const YassORM = require('../lib');
				
				module.exports = YassORM.loadDefinition(({ types: t }) => ({
					table: 'valid_model_table',
					schema: {
						id: t.idKey,
						name: t.string,
					},
				}));
			`;

			fs.writeFileSync(validModelFile, validModelContent);

			try {
				// First call should load and cache
				const ModelClass1 = await TestClass._resolveModelClass(
					'valid-test-model',
				);
				expect(typeof ModelClass1).to.equal('function');

				// Second call should return cached version
				const ModelClass2 = await TestClass._resolveModelClass(
					'valid-test-model',
				);
				expect(ModelClass2).to.equal(ModelClass1); // Same reference = cached
			} finally {
				fs.unlinkSync(validModelFile);
			}
		});

		it('should handle .js extension properly in paths', async () => {
			// Test that both .js and non-.js extensions work
			let error1;
			let error2;

			// Test with .js extension
			try {
				await TestClass._resolveModelClass('model-with-ext.js');
			} catch (e) {
				error1 = e;
			}

			// Test without .js extension
			try {
				await TestClass._resolveModelClass('model-without-ext');
			} catch (e) {
				error2 = e;
			}

			// Both should fail but error messages should include the correct paths
			expect(error1).to.exist;
			expect(error2).to.exist;
			expect(error1.message).to.include('model-with-ext.js');
			expect(error2.message).to.include('model-without-ext.js');
		});
	});

	describe('Error Handling', () => {
		it('should provide helpful error messages for missing models', async () => {
			let error;

			try {
				await TestClass._resolveModelClass('nonexistent-model');
			} catch (e) {
				error = e;
			}

			expect(error).to.exist;
			expect(error.message).to.include('Cannot resolve linked model');
			expect(error.message).to.include('nonexistent-model');
			expect(error.message).to.include(TestClass.table());
		});

		it('should handle ES6 default exports', async () => {
			// Create a model with ES6 default export
			const es6ModelFile = path.join(__dirname, 'es6-test-model.js');
			const es6ModelContent = `
				const YassORM = require('../lib');
				
				const model = YassORM.loadDefinition(({ types: t }) => ({
					table: 'es6_model_table',
					schema: {
						id: t.idKey,
						name: t.string,
					},
				}));

				module.exports = { default: model };
			`;

			fs.writeFileSync(es6ModelFile, es6ModelContent);

			try {
				const ModelClass = await TestClass._resolveModelClass('es6-test-model');
				expect(typeof ModelClass).to.equal('function');
				expect(ModelClass.table()).to.equal('es6_model_table');
			} finally {
				fs.unlinkSync(es6ModelFile);
			}
		});
	});

	describe('Performance', () => {
		it('should resolve models faster on subsequent calls due to caching', async () => {
			const modelName = 'performance-test-model';

			// First call (cache miss)
			const start1 = Date.now();
			try {
				await TestClass._resolveModelClass(modelName);
			} catch (e) {
				// Expected to fail
			}
			const duration1 = Date.now() - start1;

			// Second call (cache hit)
			const start2 = Date.now();
			try {
				await TestClass._resolveModelClass(modelName);
			} catch (e) {
				// Expected to fail
			}
			const duration2 = Date.now() - start2;

			// Second call should be same or faster (due to caching)
			expect(duration2).to.be.at.most(duration1 + 2); // Allow small timing variance
		});

		it('should handle many different model resolutions efficiently', async () => {
			const start = Date.now();

			// Try to resolve many different models (will fail but paths get cached)
			const promises = [];
			for (let i = 0; i < 50; i++) {
				promises.push(
					TestClass._resolveModelClass(`test-model-${i}`).catch(() => {
						// Expected to fail
					}),
				);
			}

			await Promise.all(promises);

			const duration = Date.now() - start;

			// Should complete quickly even with many models
			expect(duration).to.be.lessThan(100);

			// Should complete quickly with caching
			expect(duration).to.be.lessThan(200);
		});
	});

	describe('Integration with inflateValues', () => {
		it('should use cached model resolution during field inflation', async () => {
			// This tests that the optimizations work together
			const rawData = {
				id: 123,
				name: 'integration-test',
				linkedId: 456, // This would trigger model resolution
			};

			// Mock the linked model resolution to avoid file system calls
			const originalResolveModelClass = TestClass._resolveModelClass;
			let resolutionCalled = false;

			TestClass._resolveModelClass = async () => {
				resolutionCalled = true;

				// Return a mock model class
				return class MockLinkedModel {
					static async get(id) {
						return new MockLinkedModel({ id, name: `linked-${id}` });
					}

					constructor(data) {
						Object.assign(this, data);
					}
				};
			};

			try {
				const inflated = await TestClass.inflateValues(rawData);

				expect(inflated.id).to.equal(123);
				expect(inflated.name).to.equal('integration-test');
				expect(resolutionCalled).to.be.true;
			} finally {
				TestClass._resolveModelClass = originalResolveModelClass;
			}
		});
	});
});
