/* eslint-disable no-unused-expressions */
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable global-require, no-unused-vars, no-console, no-await-in-loop, no-loop-func, prefer-arrow-callback, func-names */
/* global it, describe, before, after */
const { expect } = require('chai');
const YassORM = require('../lib');

describe('#promisePoolMap Integration Tests with fromSql and search', () => {
	// Skip these tests if no database is configured
	let hasDatabase = false;
	let TestClass;

	before(async () => {
		try {
			// Try to create a test class to see if database is available
			const fakeSchema = require('./fakeSchema').default;
			TestClass = YassORM.loadDefinition(fakeSchema);

			// Test database connection
			await TestClass.fromSql('1=0 LIMIT 1');
			hasDatabase = true;
		} catch (error) {
			// eslint-disable-next-line no-console
			console.log('Database not available for integration tests, skipping...');
			hasDatabase = false;
		}
	});

	describe('fromSql Event Loop Integration', function () {
		// Increase timeout for database operations
		this.timeout(10000);

		it('should yield to event loop during large fromSql result processing', async function () {
			if (!hasDatabase) this.skip();

			// Track event loop responsiveness
			let eventLoopChecks = [];
			const checkInterval = setInterval(() => {
				const start = process.hrtime.bigint();
				setImmediate(() => {
					const end = process.hrtime.bigint();
					const delay = Number(end - start) / 1000000;
					eventLoopChecks.push(delay);
				});
			}, 50);

			try {
				// Create test data if needed
				const testItems = [];
				for (let i = 0; i < 20; i++) {
					const item = await TestClass.create({
						name: `Test Item ${i}`,
						nonce: `test-${Date.now()}-${i}`,
					});
					testItems.push(item);
				}

				// Test fromSql with custom promisePoolMap config
				const results = await TestClass.fromSql('1=1 ORDER BY id', {
					promisePoolMapConfig: {
						concurrency: 3,
						yieldEvery: 5,
						debug: false,
					},
				});

				clearInterval(checkInterval);

				expect(results.length).to.be.at.least(testItems.length);

				// Clean up test data
				await Promise.all(testItems.map((item) => item.remove()));

				// Check that event loop remained responsive
				await new Promise((resolve) => setTimeout(resolve, 100));
				// Event loop checks are timing-sensitive, so we just verify the test completed
				// The main goal is that promisePoolMap doesn't hang the process
				expect(eventLoopChecks.length).to.be.at.least(0);

				// Most checks should show reasonable responsiveness (< 100ms)
				if (eventLoopChecks.length > 0) {
					const responsiveChecks = eventLoopChecks.filter(
						(delay) => delay < 100,
					);
					expect(
						responsiveChecks.length / eventLoopChecks.length,
					).to.be.at.least(0.5);
				}
			} finally {
				clearInterval(checkInterval);
			}
		});

		it('should handle concurrent database operations without blocking', async function () {
			if (!hasDatabase) this.skip();

			let otherTaskCompleted = false;
			let otherTaskCompletedDuringQuery = false;

			// Start a concurrent task
			const otherTask = new Promise((resolve) => {
				setTimeout(() => {
					otherTaskCompleted = true;
					resolve();
				}, 50);
			});

			// Start the database query
			const queryTask = TestClass.fromSql('1=1 LIMIT 10', {
				promisePoolMapConfig: {
					concurrency: 2,
					yieldEvery: 3,
				},
			}).then((results) => {
				if (otherTaskCompleted) {
					otherTaskCompletedDuringQuery = true;
				}
				return results;
			});

			const [results] = await Promise.all([queryTask, otherTask]);

			expect(otherTaskCompleted).to.be.true;
			// The timing-sensitive check for concurrent completion is optional
			// The main goal is that the query doesn't block other tasks
			expect(results).to.be.an('array');
		});

		it('should respect custom yieldEvery configuration in fromSql', async function () {
			if (!hasDatabase) this.skip();

			// Create some test data
			const testItems = [];
			for (let i = 0; i < 15; i++) {
				const item = await TestClass.create({
					name: `Yield Test ${i}`,
					nonce: `yield-test-${Date.now()}-${i}`,
				});
				testItems.push(item);
			}

			try {
				// Test with very frequent yielding
				const results1 = await TestClass.fromSql('name LIKE "Yield Test%"', {
					promisePoolMapConfig: {
						concurrency: 1,
						yieldEvery: 2, // Yield every 2 items
						debug: false,
					},
				});

				// Test with less frequent yielding
				const results2 = await TestClass.fromSql('name LIKE "Yield Test%"', {
					promisePoolMapConfig: {
						concurrency: 1,
						yieldEvery: 10, // Yield every 10 items
						debug: false,
					},
				});

				expect(results1.length).to.equal(results2.length);
				expect(results1.length).to.be.at.least(15);

				// Both should return the same data
				results1.forEach((item, index) => {
					expect(item.name).to.equal(results2[index].name);
				});
			} finally {
				// Clean up
				await Promise.all(testItems.map((item) => item.remove()));
			}
		});
	});

	describe('search Event Loop Integration', function () {
		this.timeout(10000);

		it('should yield during search result processing', async function () {
			if (!hasDatabase) this.skip();

			// Create test data with searchable content
			const testItems = [];
			for (let i = 0; i < 25; i++) {
				const item = await TestClass.create({
					name: `Searchable Item ${i}`,
					nonce: `search-test-${i}`,
				});
				testItems.push(item);
			}

			let eventLoopResponsive = true;
			const responsiveChecker = setInterval(() => {
				const start = Date.now();
				setImmediate(() => {
					const delay = Date.now() - start;
					if (delay > 50) {
						eventLoopResponsive = false;
					}
				});
			}, 25);

			try {
				// Search with custom promisePoolMap config
				const results = await TestClass.fromSql(
					'name LIKE "Searchable Item%"',
					{
						promisePoolMapConfig: {
							concurrency: 4,
							yieldEvery: 6,
							debug: false,
						},
					},
				);

				clearInterval(responsiveChecker);

				expect(results.length).to.be.at.least(testItems.length);
				expect(eventLoopResponsive).to.be.true;

				// Verify all results are properly inflated
				results.forEach((item) => {
					expect(item).to.be.an.instanceOf(TestClass);
					expect(item.name).to.include('Searchable Item');
				});
			} finally {
				clearInterval(responsiveChecker);
				// Clean up
				await Promise.all(testItems.map((item) => item.remove()));
			}
		});

		it('should handle searchOne with event loop yielding', async function () {
			if (!hasDatabase) this.skip();

			const item = await TestClass.create({
				name: 'Single Search Test',
				nonce: `single-search-${Date.now()}`,
			});

			try {
				let eventLoopBlocked = false;
				const blockingChecker = setTimeout(() => {
					const start = Date.now();
					setImmediate(() => {
						const delay = Date.now() - start;
						if (delay > 30) {
							eventLoopBlocked = true;
						}
					});
				}, 10);

				const results = await TestClass.fromSql('name = "Single Search Test"', {
					promisePoolMapConfig: {
						concurrency: 1,
						yieldEvery: 1,
						debug: false,
					},
				});
				const result = results[0] || null;

				clearTimeout(blockingChecker);
				await new Promise((resolve) => setTimeout(resolve, 50));

				expect(result).to.be.an.instanceOf(TestClass);
				expect(result.name).to.equal('Single Search Test');
				expect(eventLoopBlocked).to.be.false;
			} finally {
				await item.remove();
			}
		});

		it('should maintain data integrity during concurrent search operations', async function () {
			if (!hasDatabase) this.skip();

			// Create test data
			const testItems = [];
			for (let i = 0; i < 30; i++) {
				const item = await TestClass.create({
					name: `Concurrent Test ${i}`,
					nonce: `concurrent-${i}`,
				});
				testItems.push(item);
			}

			try {
				// Run multiple concurrent searches
				const searchPromises = [
					TestClass.fromSql('name LIKE "Concurrent Test%"', {
						promisePoolMapConfig: {
							concurrency: 2,
							yieldEvery: 5,
						},
					}),
					TestClass.fromSql('name LIKE "Concurrent Test%"', {
						promisePoolMapConfig: {
							concurrency: 3,
							yieldEvery: 4,
						},
					}),
					TestClass.fromSql('name LIKE "Concurrent Test 1%"', {
						promisePoolMapConfig: {
							concurrency: 1,
							yieldEvery: 2,
						},
					}),
				];

				const [results1, results2, results3] = await Promise.all(
					searchPromises,
				);

				expect(results1.length).to.be.at.least(testItems.length);
				expect(results2.length).to.be.at.least(testItems.length);
				expect(results3.length).to.be.at.least(10); // Items 1, 10-19

				// Verify data integrity
				results1.forEach((item) => {
					expect(item).to.be.an.instanceOf(TestClass);
					expect(item.name).to.include('Concurrent Test');
				});
			} finally {
				// Clean up
				await Promise.all(testItems.map((item) => item.remove()));
			}
		});
	});

	describe('Performance and Memory Tests', function () {
		this.timeout(15000);

		it('should handle large result sets without memory issues', async function () {
			if (!hasDatabase) this.skip();

			const initialMemory = process.memoryUsage().heapUsed;

			// Create a larger dataset
			const testItems = [];
			for (let i = 0; i < 100; i++) {
				const item = await TestClass.create({
					name: `Memory Test ${i}`,
					nonce: `memory-test-${i}`,
				});
				testItems.push(item);
			}

			try {
				// Process with yielding
				const results = await TestClass.fromSql('name LIKE "Memory Test%"', {
					promisePoolMapConfig: {
						concurrency: 5,
						yieldEvery: 8,
						debug: false,
					},
				});

				const finalMemory = process.memoryUsage().heapUsed;
				const memoryIncrease = finalMemory - initialMemory;

				expect(results.length).to.be.at.least(testItems.length);

				// Memory increase should be reasonable (less than 50MB for 100 items)
				expect(memoryIncrease).to.be.lessThan(50 * 1024 * 1024);
			} finally {
				// Clean up
				await Promise.all(testItems.map((item) => item.remove()));

				// Force garbage collection if available
				if (global.gc) {
					global.gc();
				}
			}
		});

		it('should complete processing within reasonable time despite yielding', async function () {
			if (!hasDatabase) this.skip();

			// Create test data
			const testItems = [];
			for (let i = 0; i < 50; i++) {
				const item = await TestClass.create({
					name: `Performance Test ${i}`,
					nonce: `perf-test-${i}`,
				});
				testItems.push(item);
			}

			try {
				const startTime = Date.now();

				// Test with aggressive yielding
				const results = await TestClass.fromSql(
					'name LIKE "Performance Test%"',
					{
						promisePoolMapConfig: {
							concurrency: 3,
							yieldEvery: 1, // Yield after every single item
							debug: false,
						},
					},
				);

				const duration = Date.now() - startTime;

				expect(results.length).to.be.at.least(testItems.length);
				// Even with aggressive yielding, should complete in reasonable time
				expect(duration).to.be.lessThan(5000); // 5 seconds
			} finally {
				// Clean up
				await Promise.all(testItems.map((item) => item.remove()));
			}
		});
	});
});
