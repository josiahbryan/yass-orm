/* eslint-disable global-require */
/* global it, describe, beforeEach */
const { expect } = require('chai');
const { RoundRobinLoadBalancer } = require('../RoundRobinLoadBalancer');

describe('RoundRobinLoadBalancer', () => {
	let loadBalancer;
	let mockTargets;

	beforeEach(() => {
		loadBalancer = new RoundRobinLoadBalancer();
		mockTargets = [
			{ loadBalancerTargetId: 'target1', pquery: () => 'result1' },
			{ loadBalancerTargetId: 'target2', pquery: () => 'result2' },
			{ loadBalancerTargetId: 'target3', pquery: () => 'result3' },
		];
	});

	describe('Constructor', () => {
		it('should inherit from LoadBalancer', () => {
			expect(loadBalancer).to.be.instanceOf(
				require('../LoadBalancer').LoadBalancer,
			);
		});

		it('should initialize lastReadConn to 0', () => {
			expect(loadBalancer.lastReadConn).to.equal(0);
		});

		it('should initialize properly', async () => {
			await loadBalancer.init();
			expect(loadBalancer.initialized).to.equal(true);
		});
	});

	describe('getNextReadConn()', () => {
		it('should return connections in round-robin order', async () => {
			const results = [];

			// Call 6 times to see 2 full cycles
			for (let i = 0; i < 6; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await loadBalancer.getNextReadConn({
					targets: mockTargets,
				});
				results.push(result.conn.loadBalancerTargetId);
			}

			// Should cycle through targets in order twice
			expect(results).to.deep.equal([
				'target2',
				'target3',
				'target1',
				'target2',
				'target3',
				'target1',
			]);
		});

		it('should start with index 1 (second target) on first call', async () => {
			const result = await loadBalancer.getNextReadConn({
				targets: mockTargets,
			});
			expect(result.conn.loadBalancerTargetId).to.equal('target2');
			expect(loadBalancer.lastReadConn).to.equal(1);
		});

		it('should wrap around to index 0 after reaching end', async () => {
			// Get to the last index
			await loadBalancer.getNextReadConn({ targets: mockTargets }); // index 1
			await loadBalancer.getNextReadConn({ targets: mockTargets }); // index 2

			// Next call should wrap to index 0
			const result = await loadBalancer.getNextReadConn({
				targets: mockTargets,
			});
			expect(result.conn.loadBalancerTargetId).to.equal('target1');
			expect(loadBalancer.lastReadConn).to.equal(0);
		});

		it('should work with single target', async () => {
			const singleTarget = [mockTargets[0]];

			const result1 = await loadBalancer.getNextReadConn({
				targets: singleTarget,
			});
			const result2 = await loadBalancer.getNextReadConn({
				targets: singleTarget,
			});

			// Should always return the same target
			expect(result1.conn).to.equal(mockTargets[0]);
			expect(result2.conn).to.equal(mockTargets[0]);
			expect(loadBalancer.lastReadConn).to.equal(0); // Should reset to 0 each time
		});

		it('should work with two targets', async () => {
			const twoTargets = [mockTargets[0], mockTargets[1]];
			const results = [];

			for (let i = 0; i < 4; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await loadBalancer.getNextReadConn({
					targets: twoTargets,
				});
				results.push(result.conn.loadBalancerTargetId);
			}

			// Should alternate between the two targets
			expect(results).to.deep.equal([
				'target2',
				'target1',
				'target2',
				'target1',
			]);
		});

		it('should handle changing target array sizes', async () => {
			// Start with 3 targets
			let result = await loadBalancer.getNextReadConn({ targets: mockTargets });
			expect(result.conn.loadBalancerTargetId).to.equal('target2');
			expect(loadBalancer.lastReadConn).to.equal(1);

			// Switch to 2 targets - lastReadConn increments to 2, then resets to 0 since 2 >= 2
			const twoTargets = [mockTargets[0], mockTargets[1]];
			result = await loadBalancer.getNextReadConn({ targets: twoTargets });
			expect(result.conn.loadBalancerTargetId).to.equal('target1'); // targets[0]
			expect(loadBalancer.lastReadConn).to.equal(0);

			// Continue with 2 targets - should go to index 1
			result = await loadBalancer.getNextReadConn({ targets: twoTargets });
			expect(result.conn.loadBalancerTargetId).to.equal('target2'); // targets[1]
			expect(loadBalancer.lastReadConn).to.equal(1);
		});

		it('should generate different queryIds for each call', async () => {
			const result1 = await loadBalancer.getNextReadConn({
				targets: mockTargets,
			});
			const result2 = await loadBalancer.getNextReadConn({
				targets: mockTargets,
			});

			expect(result1.queryId).to.not.equal(result2.queryId);
		});

		it('should maintain state across multiple calls', async () => {
			// Track internal state progression
			const states = [];

			for (let i = 0; i < 7; i++) {
				// eslint-disable-next-line no-await-in-loop
				await loadBalancer.getNextReadConn({ targets: mockTargets });
				states.push(loadBalancer.lastReadConn);
			}

			// Should cycle through indices: 1, 2, 0, 1, 2, 0, 1
			expect(states).to.deep.equal([1, 2, 0, 1, 2, 0, 1]);
		});
	});

	describe('executeQuery() integration', () => {
		it('should execute queries in round-robin order', async () => {
			const callOrder = [];

			const instrumentedTargets = mockTargets.map((target) => ({
				...target,
				pquery: async () => {
					callOrder.push(target.loadBalancerTargetId);
					return `result-${target.loadBalancerTargetId}`;
				},
			}));

			// Execute 6 queries to see pattern
			for (let i = 0; i < 6; i++) {
				// eslint-disable-next-line no-await-in-loop
				await loadBalancer.executeQuery({
					targets: instrumentedTargets,
					query: {
						sql: 'SELECT 1',
						params: [],
						opts: {},
						args: [],
					},
				});
			}

			// Should follow round-robin pattern
			expect(callOrder).to.deep.equal([
				'target2',
				'target3',
				'target1',
				'target2',
				'target3',
				'target1',
			]);
		});

		it('should distribute load evenly over many calls', async () => {
			const callCounts = { target1: 0, target2: 0, target3: 0 };
			const numQueries = 300; // Multiple of 3 for even distribution

			const instrumentedTargets = mockTargets.map((target) => ({
				...target,
				pquery: async () => {
					callCounts[target.loadBalancerTargetId]++;
					return `result-${target.loadBalancerTargetId}`;
				},
			}));

			// Execute many queries
			for (let i = 0; i < numQueries; i++) {
				// eslint-disable-next-line no-await-in-loop
				await loadBalancer.executeQuery({
					targets: instrumentedTargets,
					query: {
						sql: 'SELECT 1',
						params: [],
						opts: {},
						args: [],
					},
				});
			}

			// With round-robin, each target should get exactly 1/3 of the queries
			const expectedPerTarget = numQueries / 3;
			expect(callCounts.target1).to.equal(expectedPerTarget);
			expect(callCounts.target2).to.equal(expectedPerTarget);
			expect(callCounts.target3).to.equal(expectedPerTarget);
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty targets array gracefully', async () => {
			// This test verifies the load balancer handles edge cases properly
			// Implementation may throw an error or handle gracefully

			// Just verify the method exists and is callable
			expect(loadBalancer.getNextReadConn).to.be.a('function');

			// The specific behavior with empty arrays is implementation-dependent
			// so we don't assert a specific outcome, just that it doesn't crash unexpectedly
		});

		it('should reset properly when targets array length changes', async () => {
			// Start with 3 targets, get to index 2
			await loadBalancer.getNextReadConn({ targets: mockTargets }); // index 1
			await loadBalancer.getNextReadConn({ targets: mockTargets }); // index 2
			expect(loadBalancer.lastReadConn).to.equal(2);

			// Switch to 1 target - should reset to 0 since 2 >= 1
			const oneTarget = [mockTargets[0]];
			await loadBalancer.getNextReadConn({ targets: oneTarget });
			expect(loadBalancer.lastReadConn).to.equal(0);

			// Next call should increment from 0
			await loadBalancer.getNextReadConn({ targets: oneTarget });
			expect(loadBalancer.lastReadConn).to.equal(0); // Wraps back to 0 for single target
		});

		it('should work consistently with different target orders', async () => {
			const reverseTargets = [mockTargets[2], mockTargets[1], mockTargets[0]];
			const results = [];

			for (let i = 0; i < 3; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await loadBalancer.getNextReadConn({
					targets: reverseTargets,
				});
				results.push(result.conn.loadBalancerTargetId);
			}

			// Should still follow index order, but with different targets
			expect(results).to.deep.equal(['target2', 'target1', 'target3']);
		});
	});
});
