/* eslint-disable global-require */
/* global it, describe, beforeEach */
const { expect } = require('chai');
const { RandomLoadBalancer } = require('../RandomLoadBalancer');

describe('RandomLoadBalancer', () => {
	let loadBalancer;
	let mockTargets;

	beforeEach(() => {
		loadBalancer = new RandomLoadBalancer();
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

		it('should initialize properly', async () => {
			await loadBalancer.init();
			expect(loadBalancer.initialized).to.equal(true);
		});
	});

	describe('getNextReadConn()', () => {
		it('should return a connection from the targets array', async () => {
			const result = await loadBalancer.getNextReadConn({
				targets: mockTargets,
			});

			expect(result).to.have.property('queryId');
			expect(result).to.have.property('conn');
			expect(result.queryId).to.be.a('number');
			expect(mockTargets).to.include(result.conn);
		});

		it('should return different connections over multiple calls', async () => {
			const results = [];
			const numCalls = 20; // Enough to statistically get different values

			for (let i = 0; i < numCalls; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await loadBalancer.getNextReadConn({
					targets: mockTargets,
				});
				results.push(result.conn.loadBalancerTargetId);
			}

			// With 20 calls and 3 targets, we should get some variety
			// (there's a tiny chance this could fail randomly, but very unlikely)
			const uniqueTargets = new Set(results);
			expect(uniqueTargets.size).to.be.greaterThan(1);
		});

		it('should work with single target', async () => {
			const singleTarget = [mockTargets[0]];
			const result = await loadBalancer.getNextReadConn({
				targets: singleTarget,
			});

			expect(result.conn).to.equal(mockTargets[0]);
		});

		it('should work with two targets', async () => {
			const twoTargets = [mockTargets[0], mockTargets[1]];
			const results = [];

			// Run multiple times to check both targets are selected
			for (let i = 0; i < 10; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await loadBalancer.getNextReadConn({
					targets: twoTargets,
				});
				results.push(result.conn.loadBalancerTargetId);
			}

			const uniqueTargets = new Set(results);
			// Should eventually hit both targets
			expect(uniqueTargets.size).to.be.greaterThan(0);
			expect([...uniqueTargets]).to.satisfy((targets) =>
				targets.every((t) => ['target1', 'target2'].includes(t)),
			);
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
	});

	describe('executeQuery() integration', () => {
		it('should execute queries on random targets', async () => {
			// Track which targets get called
			const callCounts = { target1: 0, target2: 0, target3: 0 };

			const instrumentedTargets = mockTargets.map((target) => ({
				...target,
				pquery: async () => {
					callCounts[target.loadBalancerTargetId]++;
					return `result-${target.loadBalancerTargetId}`;
				},
			}));

			// Execute multiple queries
			const results = [];
			for (let i = 0; i < 15; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await loadBalancer.executeQuery({
					targets: instrumentedTargets,
					query: {
						sql: 'SELECT 1',
						params: [],
						opts: {},
						args: [],
					},
				});
				results.push(result);
			}

			// Should have called multiple different targets
			const calledTargets = Object.values(callCounts).filter(
				(count) => count > 0,
			);
			expect(calledTargets.length).to.be.greaterThan(1);

			// All calls should sum to total queries
			const totalCalls = Object.values(callCounts).reduce(
				(sum, count) => sum + count,
				0,
			);
			expect(totalCalls).to.equal(15);
		});
	});

	describe('Statistical Distribution Test', () => {
		it('should distribute load roughly evenly over many calls', async () => {
			const callCounts = { target1: 0, target2: 0, target3: 0 };
			const numQueries = 300; // Large sample size

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

			// Check that distribution is roughly even (within 30% of expected)
			const expectedPerTarget = numQueries / 3;
			const tolerance = expectedPerTarget * 0.3;

			Object.values(callCounts).forEach((count) => {
				expect(count).to.be.greaterThan(expectedPerTarget - tolerance);
				expect(count).to.be.lessThan(expectedPerTarget + tolerance);
			});

			// Ensure all targets were hit
			Object.values(callCounts).forEach((count) => {
				expect(count).to.be.greaterThan(0);
			});
		});
	});
});
