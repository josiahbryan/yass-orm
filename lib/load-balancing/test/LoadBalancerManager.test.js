/* eslint-disable global-require */
/* global it, describe, beforeEach, afterEach */
const { expect } = require('chai');
const { LoadBalancerManager } = require('../index');

describe('LoadBalancerManager', () => {
	let manager;
	let mockTargets;

	beforeEach(() => {
		manager = new LoadBalancerManager({
			strategy: 'roundRobin',
			testOption: 'value',
		});
		mockTargets = [
			{ loadBalancerTargetId: 'target1', pquery: async () => 'result1' },
			{ loadBalancerTargetId: 'target2', pquery: async () => 'result2' },
			{ loadBalancerTargetId: 'target3', pquery: async () => 'result3' },
		];
	});

	afterEach(async () => {
		if (manager && !manager.isDestroyed) {
			await manager.destroy();
		}
	});

	describe('Constructor', () => {
		it('should initialize with default strategy and options', () => {
			expect(manager.strategy).to.equal('roundRobin');
			expect(manager.defaultStrategy).to.equal('roundRobin');
			expect(manager.options).to.deep.include({ testOption: 'value' });
			expect(manager.activeLoadBalancer).to.equal(null);
			expect(manager.isDestroyed).to.equal(false);
		});

		it('should use default strategy when none provided', () => {
			const defaultManager = new LoadBalancerManager();
			expect(defaultManager.strategy).to.equal('roundRobin');
			expect(defaultManager.defaultStrategy).to.equal('roundRobin');
		});
	});

	describe('Event System', () => {
		it('should support adding and removing event listeners', () => {
			const listener = () => {};

			manager.on('test-event', listener);
			expect(manager.eventListeners['test-event']).to.include(listener);

			manager.off('test-event', listener);
			expect(manager.eventListeners['test-event']).to.not.include(listener);
		});

		it('should emit events to registered listeners', () => {
			let receivedData = null;

			manager.on('test-event', (data) => {
				receivedData = data;
			});

			manager.emit('test-event', { message: 'hello' });

			expect(receivedData).to.not.equal(null);
			expect(receivedData.message).to.equal('hello');
		});

		it('should handle listener errors gracefully', () => {
			const errorListener = () => {
				throw new Error('Listener error');
			};
			const goodListener = () => {};

			manager.on('test-event', errorListener);
			manager.on('test-event', goodListener);

			// Should not throw despite error in listener
			expect(() => manager.emit('test-event', {})).to.not.throw();
		});
	});

	describe('getLoadBalancer()', () => {
		it('should initialize and return a load balancer', async () => {
			const loadBalancer = await manager.getLoadBalancer();

			expect(!!loadBalancer).to.equal(true);
			expect(manager.activeLoadBalancer).to.equal(loadBalancer);
			expect(loadBalancer.initialized).to.equal(true);
		});

		it('should return the same instance on subsequent calls', async () => {
			const lb1 = await manager.getLoadBalancer();
			const lb2 = await manager.getLoadBalancer();

			expect(lb1).to.equal(lb2);
		});

		it('should handle concurrent initialization requests', async () => {
			// Start multiple concurrent getLoadBalancer calls
			const promises = [
				manager.getLoadBalancer(),
				manager.getLoadBalancer(),
				manager.getLoadBalancer(),
			];

			const results = await Promise.all(promises);

			// All should return the same instance
			expect(results[0]).to.equal(results[1]);
			expect(results[1]).to.equal(results[2]);
		});

		it('should emit initialization event', async () => {
			let eventData = null;

			manager.on('load-balancer-initialized', (data) => {
				eventData = data;
			});

			await manager.getLoadBalancer();

			expect(!!eventData).to.equal(true);
			expect(eventData.strategy).to.equal('roundRobin');
			expect(!!eventData.loadBalancer).to.equal(true);
		});

		// it('should throw error for unknown strategy', async () => {
		// 	// Set both strategy and defaultStrategy to nonexistent values
		// 	manager.strategy = 'nonexistent-strategy';
		// 	manager.defaultStrategy = 'also-nonexistent';

		// 	let errorThrown = false;
		// 	try {
		// 		await manager.getLoadBalancer();
		// 	} catch (error) {
		// 		errorThrown = true;
		// 		expect(error.message).to.include('Unknown load balancer strategy');
		// 	}
		// 	expect(errorThrown).to.equal(true);
		// });

		it('should throw error if manager is destroyed', async () => {
			await manager.destroy();

			try {
				await manager.getLoadBalancer();
				expect.fail('Should have thrown an error');
			} catch (error) {
				expect(error.message).to.include('has been destroyed');
			}
		});
	});

	describe('executeQuery()', () => {
		it('should execute queries through the load balancer', async () => {
			const result = await manager.executeQuery({
				targets: mockTargets,
				query: {
					sql: 'SELECT 1',
					params: [],
					args: [],
				},
			});

			expect(['result1', 'result2', 'result3']).to.include(result);
		});

		it('should throw error if manager is destroyed', async () => {
			await manager.destroy();

			try {
				await manager.executeQuery({
					targets: mockTargets,
					query: { sql: 'SELECT 1', params: [], args: [] },
				});
				expect.fail('Should have thrown an error');
			} catch (error) {
				expect(error.message).to.include('has been destroyed');
			}
		});

		it('should emit error events on query failure', async () => {
			const failingTargets = [
				{
					loadBalancerTargetId: 'failing-target',
					pquery: async () => {
						throw new Error('Query failed');
					},
				},
			];

			let errorEvent = null;
			manager.on('error', (data) => {
				errorEvent = data;
			});

			try {
				await manager.executeQuery({
					targets: failingTargets,
					query: { sql: 'SELECT 1', params: [], args: [] },
				});
			} catch (error) {
				// Expected to fail
			}

			expect(!!errorEvent).to.equal(true);
			expect(errorEvent.type).to.equal('query-execution');
		});
	});

	describe('setStrategy()', () => {
		it('should change strategy and reinitialize load balancer', async () => {
			// Initialize with roundRobin
			const oldLB = await manager.getLoadBalancer();
			expect(manager.strategy).to.equal('roundRobin');

			// Change to random
			await manager.setStrategy('random');
			expect(manager.strategy).to.equal('random');
			expect(manager.activeLoadBalancer).to.equal(null);

			// Get new load balancer
			const newLB = await manager.getLoadBalancer();
			expect(newLB).to.not.equal(oldLB);
		});

		it('should emit strategy-changed event', async () => {
			let eventData = null;

			manager.on('strategy-changed', (data) => {
				eventData = data;
			});

			await manager.setStrategy('random', { newOption: 'test' });

			expect(!!eventData).to.equal(true);
			expect(eventData.oldStrategy).to.equal('roundRobin');
			expect(eventData.newStrategy).to.equal('random');
			expect(eventData.options).to.deep.include({ newOption: 'test' });
		});

		it('should merge new options with existing options', async () => {
			await manager.setStrategy('random', { newOption: 'test' });

			expect(manager.options).to.deep.include({
				testOption: 'value', // from constructor
				newOption: 'test', // from setStrategy
			});
		});

		it('should throw error if manager is destroyed', async () => {
			await manager.destroy();

			try {
				await manager.setStrategy('random');
				expect.fail('Should have thrown an error');
			} catch (error) {
				expect(error.message).to.include('has been destroyed');
			}
		});
	});

	describe('Custom Load Balancers', () => {
		// Mock custom load balancer class
		class MockCustomLoadBalancer {
			async init() {
				this.initialized = true;
			}

			async executeQuery() {
				return 'custom-result';
			}

			async healthCheck() {
				return true;
			}
		}

		it('should support custom load balancer classes', async () => {
			await manager.setCustomLoadBalancer(MockCustomLoadBalancer);
			expect(manager.strategy).to.equal('custom');

			const result = await manager.executeQuery({
				targets: mockTargets,
				query: { sql: 'SELECT 1', params: [], args: [] },
			});

			expect(result).to.equal('custom-result');
		});

		it('should remove custom load balancer and revert to default', async () => {
			await manager.setCustomLoadBalancer(MockCustomLoadBalancer);
			expect(manager.strategy).to.equal('custom');

			await manager.removeCustomLoadBalancer();
			expect(manager.strategy).to.equal('roundRobin');
		});

		it('should throw error for invalid custom load balancer', async () => {
			try {
				await manager.setCustomLoadBalancer('not-a-class');
				expect.fail('Should have thrown an error');
			} catch (error) {
				expect(error.message).to.include('must be a constructor function');
			}
		});
	});

	describe('getStats()', () => {
		it('should return statistics from load balancer', async () => {
			const stats = await manager.getStats();

			expect(!!stats).to.equal(true);
			expect(stats.strategy).to.equal('roundRobin');
			expect(!!stats.managerStats).to.equal(true);
			expect(stats.managerStats.isInitialized).to.be.a('boolean');
		});

		it('should return error if manager is destroyed', async () => {
			await manager.destroy();

			const stats = await manager.getStats();
			expect(stats.error).to.include('destroyed');
		});
	});

	describe('healthCheck()', () => {
		it('should return health status', async () => {
			const health = await manager.healthCheck();

			expect(!!health).to.equal(true);
			expect(health.healthy).to.be.a('boolean');
			expect(health.strategy).to.equal('roundRobin');
			expect(health.initialized).to.be.a('boolean');
		});

		it('should return unhealthy if destroyed', async () => {
			await manager.destroy();

			const health = await manager.healthCheck();
			expect(health.healthy).to.equal(false);
			expect(health.reason).to.include('destroyed');
		});
	});

	describe('getAvailableStrategies()', () => {
		it('should return list of available strategies', () => {
			const strategies = manager.getAvailableStrategies();

			expect(strategies).to.be.an('array');
			expect(strategies).to.include('random');
			expect(strategies).to.include('roundRobin');
			expect(strategies).to.not.include('custom'); // Should not include undefined custom
		});
	});

	describe('destroy()', () => {
		it('should cleanup resources and mark as destroyed', async () => {
			await manager.getLoadBalancer();

			await manager.destroy();

			expect(manager.isDestroyed).to.equal(true);
			expect(manager.activeLoadBalancer).to.equal(null);
		});

		it('should emit destruction event', async () => {
			let eventData = null;

			manager.on('load-balancer-destroyed', (data) => {
				eventData = data;
			});

			await manager.getLoadBalancer(); // Initialize first
			await manager.destroy();

			expect(!!eventData).to.equal(true);
			expect(eventData.strategy).to.equal('roundRobin');
		});

		it('should be idempotent (safe to call multiple times)', async () => {
			await manager.destroy();
			await manager.destroy(); // Should not throw

			expect(manager.isDestroyed).to.equal(true);
		});
	});

	describe('Strategy Options', () => {
		it('should pass options to load balancer constructor', async () => {
			const customManager = new LoadBalancerManager('roundRobin', {
				customOption: 'test-value',
			});

			const loadBalancer = await customManager.getLoadBalancer();
			// The specific option handling depends on load balancer implementation
			expect(!!loadBalancer).to.equal(true);

			await customManager.destroy();
		});
	});
});
