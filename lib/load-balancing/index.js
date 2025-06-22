const { RandomLoadBalancer } = require('./RandomLoadBalancer');
const { RoundRobinLoadBalancer } = require('./RoundRobinLoadBalancer');

const defaultReadBalanceStrategy = 'roundRobin';

const loadBalancerStrategies = {
	random: RandomLoadBalancer,
	roundRobin: RoundRobinLoadBalancer,
	custom: undefined, // can be set at runtime to a custom LoadBalancer class
};

class LoadBalancerManager {
	constructor(strategy = defaultReadBalanceStrategy, options = {}) {
		this.strategy = strategy;
		this.defaultStrategy = strategy;
		this.options = options;
		this.activeLoadBalancer = null;
		this.initializationPromise = null; // Prevent race conditions
		this.isDestroyed = false;

		// Event listeners for monitoring (optional)
		this.eventListeners = {
			'strategy-changed': [],
			'load-balancer-initialized': [],
			'load-balancer-destroyed': [],
			error: [],
		};
	}

	/**
	 * Add event listener
	 */
	on(event, listener) {
		if (!this.eventListeners[event]) {
			this.eventListeners[event] = [];
		}
		this.eventListeners[event].push(listener);
	}

	/**
	 * Remove event listener
	 */
	off(event, listener) {
		if (this.eventListeners[event]) {
			this.eventListeners[event] = this.eventListeners[event].filter(
				(l) => l !== listener,
			);
		}
	}

	/**
	 * Emit event to listeners
	 */
	emit(event, data) {
		if (this.eventListeners[event]) {
			this.eventListeners[event].forEach((listener) => {
				try {
					listener(data);
				} catch (error) {
					// Don't let listener errors break the manager
					// Silently ignore listener errors to prevent cascading failures
				}
			});
		}
	}

	/**
	 * Get or initialize the active load balancer (thread-safe)
	 */
	async getLoadBalancer() {
		if (this.isDestroyed) {
			throw new Error('LoadBalancerManager has been destroyed');
		}

		// If already initialized, return immediately
		if (this.activeLoadBalancer) {
			return this.activeLoadBalancer;
		}

		// If initialization is in progress, wait for it
		if (this.initializationPromise) {
			return this.initializationPromise;
		}

		// Start initialization
		this.initializationPromise = this._initializeLoadBalancer();

		try {
			this.activeLoadBalancer = await this.initializationPromise;
			this.emit('load-balancer-initialized', {
				strategy: this.strategy,
				loadBalancer: this.activeLoadBalancer,
			});
			return this.activeLoadBalancer;
		} catch (error) {
			this.emit('error', { type: 'initialization', error });
			throw error;
		} finally {
			this.initializationPromise = null;
		}
	}

	/**
	 * Internal method to initialize load balancer
	 */
	async _initializeLoadBalancer() {
		const LoadBalancerClass =
			loadBalancerStrategies[this.strategy] ||
			loadBalancerStrategies[this.defaultStrategy];

		if (!LoadBalancerClass) {
			throw new Error(
				`Unknown load balancer strategy: ${
					this.strategy
				}. Available: ${Object.keys(loadBalancerStrategies).join(', ')}`,
			);
		}

		try {
			const loadBalancer = new LoadBalancerClass(this.options);
			await loadBalancer.init();
			return loadBalancer;
		} catch (error) {
			throw new Error(
				`Failed to initialize ${this.strategy} load balancer: ${error.message}`,
			);
		}
	}

	/**
	 * Execute query with automatic fallback
	 */
	async executeQuery({ targets, query: { sql, params, opts, args } }) {
		if (this.isDestroyed) {
			throw new Error('LoadBalancerManager has been destroyed');
		}

		try {
			const loadBalancer = await this.getLoadBalancer();
			return await loadBalancer.executeQuery({
				targets,
				query: { sql, params, opts, args },
			});
		} catch (error) {
			this.emit('error', {
				type: 'query-execution',
				error,
				sql,
				params,
				opts,
				args,
			});

			// Optional: Implement fallback to basic round-robin if current strategy fails catastrophically
			if (this.options.enableFallback && this.strategy !== 'roundRobin') {
				try {
					// Fallback to roundRobin strategy
					await this.setStrategy('roundRobin');
					const fallbackBalancer = await this.getLoadBalancer();
					return await fallbackBalancer.executeQuery({
						targets,
						query: { sql, params, opts, args },
					});
				} catch (fallbackError) {
					this.emit('error', {
						type: 'fallback-failed',
						error: fallbackError,
						originalError: error,
					});
					throw fallbackError;
				}
			}

			throw error;
		}
	}

	/**
	 * Get statistics from active load balancer
	 */
	async getStats() {
		if (this.isDestroyed) {
			return { error: 'Manager destroyed' };
		}

		try {
			const loadBalancer = await this.getLoadBalancer();

			// Check if load balancer has stats method
			if (typeof loadBalancer.getConnectionStats === 'function') {
				return {
					strategy: this.strategy,
					connections: loadBalancer.getConnectionStats(),
					managerStats: {
						isInitialized: !!this.activeLoadBalancer,
						strategy: this.strategy,
					},
				};
			}

			return {
				strategy: this.strategy,
				managerStats: {
					isInitialized: !!this.activeLoadBalancer,
					strategy: this.strategy,
				},
			};
		} catch (error) {
			return { error: error.message };
		}
	}

	/**
	 * Change strategy with proper cleanup
	 */
	async setStrategy(newStrategy, newOptions = {}) {
		if (this.isDestroyed) {
			throw new Error('LoadBalancerManager has been destroyed');
		}

		const oldStrategy = this.strategy;
		const oldLoadBalancer = this.activeLoadBalancer;

		try {
			// Cleanup existing load balancer
			if (oldLoadBalancer && typeof oldLoadBalancer.destroy === 'function') {
				await oldLoadBalancer.destroy();
				this.emit('load-balancer-destroyed', { strategy: oldStrategy });
			}

			// Update configuration
			this.strategy = newStrategy;
			this.options = { ...this.options, ...newOptions };
			this.activeLoadBalancer = null;
			this.initializationPromise = null;

			// Emit strategy change event
			this.emit('strategy-changed', {
				oldStrategy,
				newStrategy,
				options: this.options,
			});
		} catch (error) {
			// Rollback if cleanup failed
			this.strategy = oldStrategy;
			this.activeLoadBalancer = oldLoadBalancer;
			this.emit('error', { type: 'strategy-change', error });
			throw new Error(
				`Failed to change strategy from ${oldStrategy} to ${newStrategy}: ${error.message}`,
			);
		}
	}

	/**
	 * Set custom load balancer class
	 */
	setCustomLoadBalancer(LoadBalancerClass, options = {}) {
		if (!LoadBalancerClass || typeof LoadBalancerClass !== 'function') {
			throw new Error(
				'Custom load balancer must be a constructor function/class',
			);
		}

		loadBalancerStrategies.custom = LoadBalancerClass;
		return this.setStrategy('custom', options);
	}

	/**
	 * Remove custom load balancer and revert to default
	 */
	async removeCustomLoadBalancer() {
		loadBalancerStrategies.custom = undefined;
		return this.setStrategy(this.defaultStrategy);
	}

	/**
	 * Get available strategies
	 */
	getAvailableStrategies() {
		return Object.keys(loadBalancerStrategies).filter(
			(key) => loadBalancerStrategies[key] !== undefined,
		);
	}

	/**
	 * Health check - verify manager and load balancer are working
	 */
	async healthCheck() {
		if (this.isDestroyed) {
			return { healthy: false, reason: 'Manager destroyed' };
		}

		try {
			const loadBalancer = await this.getLoadBalancer();

			// Basic health check
			const hasRequiredMethods =
				typeof loadBalancer.executeQuery === 'function';

			return {
				health: await loadBalancer.healthCheck(),
				healthy: hasRequiredMethods,
				strategy: this.strategy,
				initialized: !!this.activeLoadBalancer,
			};
		} catch (error) {
			return {
				healthy: false,
				reason: error.message,
			};
		}
	}

	/**
	 * Properly destroy the manager and cleanup resources
	 */
	async destroy() {
		if (this.isDestroyed) {
			return;
		}

		this.isDestroyed = true;

		try {
			// Wait for any pending initialization
			if (this.initializationPromise) {
				await this.initializationPromise;
			}

			// Cleanup active load balancer
			if (
				this.activeLoadBalancer &&
				typeof this.activeLoadBalancer.destroy === 'function'
			) {
				await this.activeLoadBalancer.destroy();
				this.emit('load-balancer-destroyed', { strategy: this.strategy });
			}

			// Clear references
			this.activeLoadBalancer = null;
			this.initializationPromise = null;
			this.eventListeners = {};
		} catch (error) {
			this.emit('error', { type: 'destroy', error });
			throw error;
		}
	}
}

module.exports = {
	LoadBalancerManager,
	defaultReadBalanceStrategy,
	RandomLoadBalancer,
	RoundRobinLoadBalancer,
};
