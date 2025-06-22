/* eslint-disable global-require */
/* global it, describe, beforeEach */
const { expect } = require('chai');
const { LoadBalancer } = require('../LoadBalancer');

describe('LoadBalancer Base Class', () => {
	let loadBalancer;

	beforeEach(() => {
		loadBalancer = new LoadBalancer();
	});

	describe('Constructor', () => {
		it('should initialize with default values', () => {
			expect(loadBalancer.initialized).to.equal(false);
			expect(loadBalancer.config).to.deep.equal({});
			expect(loadBalancer.perTargetConfigKeys).to.deep.equal([]);
		});
	});

	describe('init()', () => {
		it('should set initialized to true', async () => {
			await loadBalancer.init();
			expect(loadBalancer.initialized).to.equal(true);
		});
	});

	describe('healthCheck()', () => {
		it('should return false when not initialized', async () => {
			const result = await loadBalancer.healthCheck();
			expect(result).to.equal(false);
		});

		it('should return true when initialized', async () => {
			await loadBalancer.init();
			const result = await loadBalancer.healthCheck();
			expect(result).to.equal(true);
		});
	});

	describe('getTargetConfig()', () => {
		beforeEach(() => {
			// Set up a load balancer with some config
			loadBalancer.config = {
				timeout: 5000,
				retries: 3,
				custom: 'global-value',
			};
			loadBalancer.perTargetConfigKeys = ['timeout', 'retries', 'custom'];
		});

		it('should return global config value when no overrides', () => {
			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
			});
			expect(result).to.equal(5000);
		});

		it('should return default value when config key not found', () => {
			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'nonexistent',
				defaultValue: 'fallback',
			});
			expect(result).to.equal('fallback');
		});

		it('should return null when config key not found and no default', () => {
			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'nonexistent',
			});
			expect(result).to.equal(null);
		});

		it('should prefer per-target options over global config', () => {
			const targetMetrics = new Map();
			targetMetrics.set('target1', {
				targetOptions: {
					timeout: 10000,
				},
			});

			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
				targetMetrics,
			});
			expect(result).to.equal(10000);
		});

		it('should prefer per-query options over per-target options', () => {
			const targetMetrics = new Map();
			targetMetrics.set('target1', {
				targetOptions: {
					timeout: 10000,
				},
			});

			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
				queryLevelOptions: {
					timeout: 15000,
				},
				targetMetrics,
			});
			expect(result).to.equal(15000);
		});

		it('should respect perTargetConfigKeys restriction', () => {
			loadBalancer.perTargetConfigKeys = ['timeout']; // Only timeout is overridable

			const targetMetrics = new Map();
			targetMetrics.set('target1', {
				targetOptions: {
					timeout: 10000,
					retries: 5, // This should be ignored
				},
			});

			const timeoutResult = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
				targetMetrics,
			});
			const retriesResult = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'retries',
				targetMetrics,
			});

			expect(timeoutResult).to.equal(10000); // Should use per-target
			expect(retriesResult).to.equal(3); // Should use global (per-target ignored)
		});

		it('should handle missing target metrics gracefully', () => {
			const targetMetrics = new Map();
			// No metrics for target1

			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
				targetMetrics,
			});
			expect(result).to.equal(5000); // Should fall back to global
		});

		it('should handle missing targetOptions in metrics', () => {
			const targetMetrics = new Map();
			targetMetrics.set('target1', {
				// No targetOptions property
				someOtherProperty: 'value',
			});

			const result = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
				targetMetrics,
			});
			expect(result).to.equal(5000); // Should fall back to global
		});

		it('should handle complex 3-level hierarchy scenario', () => {
			const targetMetrics = new Map();
			targetMetrics.set('target1', {
				targetOptions: {
					timeout: 10000,
					retries: 5,
					custom: 'target-value',
				},
			});

			// Test query overrides target overrides global
			const queryResult = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'timeout',
				queryLevelOptions: { timeout: 20000 },
				targetMetrics,
			});
			expect(queryResult).to.equal(20000);

			// Test target overrides global
			const targetResult = loadBalancer.getTargetConfig({
				targetId: 'target1',
				configKey: 'retries',
				targetMetrics,
			});
			expect(targetResult).to.equal(5);

			// Test global fallback
			const globalResult = loadBalancer.getTargetConfig({
				targetId: 'target2', // Different target with no overrides
				configKey: 'retries',
				targetMetrics,
			});
			expect(globalResult).to.equal(3);
		});
	});

	describe('queryStarted() and queryFinished()', () => {
		it('should be no-op by default', async () => {
			// These are abstract methods that do nothing in base class
			await loadBalancer.queryStarted('query1');
			await loadBalancer.queryFinished('query1');
			// No assertions needed - just checking they don't throw
		});
	});

	describe('executeQuery()', () => {
		it('should use getNextReadConn() when available', async () => {
			const mockTargets = [
				{ loadBalancerTargetId: 'target1', pquery: () => 'result1' },
				{ loadBalancerTargetId: 'target2', pquery: () => 'result2' },
			];

			// Override getNextReadConn to return predictable result
			loadBalancer.getNextReadConn = async () => ({
				queryId: 'test-query',
				conn: mockTargets[0],
			});

			const result = await loadBalancer.executeQuery({
				targets: mockTargets,
				query: {
					sql: 'SELECT 1',
					params: [],
					opts: {},
					args: [],
				},
			});

			expect(result).to.equal('result1');
		});

		it('should throw error when getNextReadConn returns no connection', async () => {
			const mockTargets = [
				{ loadBalancerTargetId: 'target1', pquery: () => 'result1' },
			];

			// Override getNextReadConn to return no connection
			loadBalancer.getNextReadConn = async () => ({
				queryId: 'test-query',
				conn: null,
			});

			try {
				await loadBalancer.executeQuery({
					targets: mockTargets,
					query: {
						sql: 'SELECT 1',
						params: [],
						opts: {},
						args: [],
					},
				});
				expect.fail('Should have thrown an error');
			} catch (error) {
				expect(error.message).to.include('No connection available');
			}
		});

		it('should call queryStarted and queryFinished around query execution', async () => {
			const mockTargets = [
				{
					loadBalancerTargetId: 'target1',
					pquery: async () => {
						// Simulate async query
						await new Promise((resolve) => setTimeout(resolve, 1));
						return 'result1';
					},
				},
			];

			const calls = [];

			// Override methods to track calls
			loadBalancer.getNextReadConn = async () => ({
				queryId: 'test-query',
				conn: mockTargets[0],
			});

			loadBalancer.queryStarted = async (queryId) => {
				calls.push(`started-${queryId}`);
			};

			loadBalancer.queryFinished = async (queryId) => {
				calls.push(`finished-${queryId}`);
			};

			const result = await loadBalancer.executeQuery({
				targets: mockTargets,
				query: {
					sql: 'SELECT 1',
					params: [],
					opts: {},
					args: [],
				},
			});

			expect(result).to.equal('result1');
			expect(calls).to.deep.equal([
				'started-test-query',
				'finished-test-query',
			]);
		});

		it('should call queryFinished even when query throws error', async () => {
			const mockTargets = [
				{
					loadBalancerTargetId: 'target1',
					pquery: async () => {
						throw new Error('Query failed');
					},
				},
			];

			const calls = [];

			loadBalancer.getNextReadConn = async () => ({
				queryId: 'test-query',
				conn: mockTargets[0],
			});

			loadBalancer.queryStarted = async (queryId) => {
				calls.push(`started-${queryId}`);
			};

			loadBalancer.queryFinished = async (queryId) => {
				calls.push(`finished-${queryId}`);
			};

			try {
				await loadBalancer.executeQuery({
					targets: mockTargets,
					query: {
						sql: 'SELECT 1',
						params: [],
						opts: {},
						args: [],
					},
				});
				expect.fail('Should have thrown an error');
			} catch (error) {
				expect(error.message).to.equal('Query failed');
			}

			// queryFinished should still be called due to finally block
			expect(calls).to.deep.equal([
				'started-test-query',
				'finished-test-query',
			]);
		});
	});
});
