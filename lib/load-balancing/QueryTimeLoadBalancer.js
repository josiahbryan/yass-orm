/* eslint-disable no-param-reassign */
/* eslint-disable no-unused-vars */
const { LoadBalancer } = require('./LoadBalancer');

class QueryTimeLoadBalancer extends LoadBalancer {
	constructor(options = {}) {
		super();

		// Configuration options
		this.config = {
			emaAlpha: 0.2, // EMA decay factor (0.1-0.3 typical)
			queryTimeoutMs: 2 * 60_000, // 2 minute query timeout
			circuitBreakerFailureThreshold: 5, // failures before opening circuit
			circuitBreakerSuccessThreshold: 3, // successes to close circuit
			circuitBreakerTimeoutMs: 60_000, // 1 minute before trying HALF_OPEN
			maxRetries: 3, // max retries across all connections
			healthCheckIntervalMs: 30_000, // health check every 30 seconds
			targetMetricsTtlMs: 30_000, // 30 seconds TTL for unused target metrics
			...options,
		};

		// Options that can be overridden per-target via loadBalancerOptions
		this.perTargetConfigKeys = [
			'emaAlpha',
			'queryTimeoutMs',
			'circuitBreakerFailureThreshold',
			'circuitBreakerSuccessThreshold',
			'circuitBreakerTimeoutMs',
			'maxRetries', // Add maxRetries to per-target options
		];

		// Track metrics per target ID (not connection index)
		this.targetMetrics = new Map();

		// Track current target set to detect topology changes
		this.currentTargetSetId = null;

		// Track individual queries by unique ID
		this.activeQueries = new Map(); // queryId -> { targetId, connection, startTime, timeoutHandle }
		this.nextQueryId = 0;

		// Circuit breaker states
		this.CIRCUIT_STATES = {
			CLOSED: 'CLOSED',
			OPEN: 'OPEN',
			HALF_OPEN: 'HALF_OPEN',
		};

		// Start health monitoring
		this.startHealthMonitoring();
	}

	/**
	 * Create default metrics for a new target
	 */
	createDefaultMetrics(targetOptions = {}) {
		return {
			// EMA-based query time tracking
			emaQueryTime: 0, // Exponential moving average of query times
			lastQueryTime: 0, // Most recent query time
			activeQueryCount: 0, // current number of running queries
			totalQueries: 0, // total queries processed

			// Health monitoring
			consecutiveFailures: 0,
			consecutiveSuccesses: 0,
			totalFailures: 0,
			totalSuccesses: 0,
			lastFailureTime: null,
			lastSuccessTime: null,

			// Circuit breaker state
			circuitState: this.CIRCUIT_STATES.CLOSED,
			circuitOpenedAt: null,
			halfOpenAttempts: 0,

			// Error tracking
			recentErrors: [], // sliding window of recent errors
			errorTypes: new Map(), // count of different error types

			// Target-specific configuration
			targetOptions,
			lastAccessTime: Date.now(), // For TTL cleanup
		};
	}

	/**
	 * Detect if target set has changed and reinitialize if needed
	 */
	handleTargetSetChange(targets) {
		const targetSetId = targets.map((t) => t.loadBalancerTargetId).join('|');

		if (this.currentTargetSetId === targetSetId) {
			// Same target set, just update lastAccessTime for existing targets
			targets.forEach((target) => {
				const metrics = this.targetMetrics.get(target.loadBalancerTargetId);
				if (metrics) {
					metrics.lastAccessTime = Date.now();
					// Update target options in case they changed
					metrics.targetOptions = target.loadBalancerOptions || {};
				}
			});
			return false; // No change
		}

		// Target set changed - preserve existing metrics for targets that remain
		const newTargetIds = new Set(targets.map((t) => t.loadBalancerTargetId));
		const existingMetrics = new Map();

		// Preserve metrics for targets that still exist
		Array.from(this.targetMetrics.entries()).forEach(([targetId, metrics]) => {
			if (newTargetIds.has(targetId)) {
				metrics.lastAccessTime = Date.now();
				existingMetrics.set(targetId, metrics);
			}
		});

		// Initialize metrics for new targets
		targets.forEach((target) => {
			const targetId = target.loadBalancerTargetId;
			if (!existingMetrics.has(targetId)) {
				existingMetrics.set(
					targetId,
					this.createDefaultMetrics(target.loadBalancerOptions || {}),
				);
			} else {
				// Update options for existing targets
				existingMetrics.get(targetId).targetOptions =
					target.loadBalancerOptions || {};
			}
		});

		this.targetMetrics = existingMetrics;
		this.currentTargetSetId = targetSetId;
		return true; // Changed
	}

	/**
	 * Start periodic health monitoring
	 */
	startHealthMonitoring() {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
		}

		this.healthCheckInterval = setInterval(() => {
			this.performHealthCheck();
		}, this.config.healthCheckIntervalMs);
	}

	/**
	 * Perform health check on all targets
	 */
	performHealthCheck() {
		const now = Date.now();
		const oneHourAgo = now - 60 * 60 * 1000;
		const ttlCutoff = now - this.config.targetMetricsTtlMs;

		// Clean up old target metrics and perform health checks
		const targetEntries = Array.from(this.targetMetrics.entries());

		// First pass: identify targets to remove
		const targetsToRemove = targetEntries
			.filter(([targetId, metrics]) => metrics.lastAccessTime < ttlCutoff)
			.map(([targetId, metrics]) => targetId);

		// Remove expired targets
		targetsToRemove.forEach((targetId) => this.targetMetrics.delete(targetId));

		// Second pass: perform health checks on remaining targets
		targetEntries
			.filter(([targetId, metrics]) => !targetsToRemove.includes(targetId))
			.forEach(([targetId, metrics]) => {
				// Transition OPEN -> HALF_OPEN after timeout
				if (metrics.circuitState === this.CIRCUIT_STATES.OPEN) {
					const timeSinceOpened = now - (metrics.circuitOpenedAt || 0);
					const breakerTimeoutMs = this.getTargetConfig({
						targetId,
						configKey: 'circuitBreakerTimeoutMs',
						targetMetrics: this.targetMetrics,
					});
					if (timeSinceOpened >= breakerTimeoutMs) {
						metrics.circuitState = this.CIRCUIT_STATES.HALF_OPEN;
						metrics.halfOpenAttempts = 0;
					}
				}

				// Clean up old errors (keep last 100 or last hour)
				metrics.recentErrors = metrics.recentErrors
					.filter((error) => error.timestamp > oneHourAgo)
					.slice(-100);
			});
	}

	// getTargetConfig() method now inherited from base LoadBalancer class

	/**
	 * Get or create metrics for a target
	 */
	getTargetMetrics(targetId, targetOptions = {}) {
		let metrics = this.targetMetrics.get(targetId);
		if (!metrics) {
			metrics = this.createDefaultMetrics(targetOptions);
			this.targetMetrics.set(targetId, metrics);
		}
		metrics.lastAccessTime = Date.now();
		return metrics;
	}

	/**
	 * Record a successful query
	 */
	recordSuccess(targetId, queryTime) {
		const metrics = this.getTargetMetrics(targetId);

		// Get target-specific EMA alpha
		const emaAlpha = this.getTargetConfig({
			targetId,
			configKey: 'emaAlpha',
			targetMetrics: this.targetMetrics,
		});

		// Update EMA query time
		if (metrics.emaQueryTime === 0) {
			metrics.emaQueryTime = queryTime;
		} else {
			metrics.emaQueryTime =
				emaAlpha * queryTime + (1 - emaAlpha) * metrics.emaQueryTime;
		}

		metrics.lastQueryTime = queryTime;
		metrics.totalQueries++;
		metrics.totalSuccesses++;
		metrics.consecutiveSuccesses++;
		metrics.consecutiveFailures = 0; // Reset failure counter
		metrics.lastSuccessTime = Date.now();

		// Circuit breaker logic for successful queries
		if (metrics.circuitState === this.CIRCUIT_STATES.HALF_OPEN) {
			const successThreshold = this.getTargetConfig({
				targetId,
				configKey: 'circuitBreakerSuccessThreshold',
				targetMetrics: this.targetMetrics,
			});
			if (metrics.consecutiveSuccesses >= successThreshold) {
				metrics.circuitState = this.CIRCUIT_STATES.CLOSED;
			}
		}
	}

	/**
	 * Record a failed query
	 */
	recordFailure(targetId, error) {
		const metrics = this.getTargetMetrics(targetId);

		const errorInfo = {
			timestamp: Date.now(),
			type: error.name || 'UnknownError',
			message: error.message,
			code: error.code,
		};

		metrics.recentErrors.push(errorInfo);
		metrics.totalFailures++;
		metrics.consecutiveFailures++;
		metrics.consecutiveSuccesses = 0; // Reset success counter
		metrics.lastFailureTime = Date.now();

		// Track error types
		const errorType = errorInfo.type;
		metrics.errorTypes.set(
			errorType,
			(metrics.errorTypes.get(errorType) || 0) + 1,
		);

		// Circuit breaker logic for failed queries
		if (metrics.circuitState === this.CIRCUIT_STATES.CLOSED) {
			const failureThreshold = this.getTargetConfig({
				targetId,
				configKey: 'circuitBreakerFailureThreshold',
				targetMetrics: this.targetMetrics,
			});
			if (metrics.consecutiveFailures >= failureThreshold) {
				metrics.circuitState = this.CIRCUIT_STATES.OPEN;
				metrics.circuitOpenedAt = Date.now();
			}
		} else if (metrics.circuitState === this.CIRCUIT_STATES.HALF_OPEN) {
			// Any failure in HALF_OPEN goes back to OPEN
			metrics.circuitState = this.CIRCUIT_STATES.OPEN;
			metrics.circuitOpenedAt = Date.now();
		}
	}

	async queryStarted(queryId, opts) {
		const queryInfo = this.activeQueries.get(queryId);
		if (!queryInfo) return;

		const { targetId } = queryInfo;
		const metrics = this.getTargetMetrics(targetId);

		// Extract query-level options
		const queryLevelOptions = (opts && opts.loadBalancerOptions) || {};

		// Use 3-level hierarchy for timeout
		const timeoutMs = this.getTargetConfig({
			targetId,
			configKey: 'queryTimeoutMs',
			queryLevelOptions,
			targetMetrics: this.targetMetrics,
		});

		// Record start time and increment active query count
		queryInfo.startTime = Date.now();
		metrics.activeQueryCount++;

		// Set up query timeout
		queryInfo.timeoutHandle = setTimeout(() => {
			this.handleQueryTimeout(queryId);
		}, timeoutMs);
	}

	async queryFinished(queryId) {
		const queryInfo = this.activeQueries.get(queryId);
		if (!queryInfo) return;

		const { targetId, startTime, timeoutHandle } = queryInfo;
		const metrics = this.getTargetMetrics(targetId);
		if (!startTime) return;

		// Clear timeout
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}

		const queryTime = Date.now() - startTime;

		// Record successful query
		this.recordSuccess(targetId, queryTime);

		// Update counters
		metrics.activeQueryCount = Math.max(0, metrics.activeQueryCount - 1);

		// Clean up
		this.activeQueries.delete(queryId);
	}

	/**
	 * Handle query timeout
	 */
	async handleQueryTimeout(queryId) {
		const queryInfo = this.activeQueries.get(queryId);
		if (!queryInfo) return;

		const { targetId, connection } = queryInfo;
		const metrics = this.getTargetMetrics(targetId);
		const timeoutMs = this.getTargetConfig({
			targetId,
			configKey: 'queryTimeoutMs',
			targetMetrics: this.targetMetrics,
		});

		// Try to kill the query on the server side
		if (connection && connection.threadId && connection.clone) {
			try {
				// Use a separate connection to kill the query to avoid interfering with the original connection
				const killConnection = await connection.clone();

				// NOTE to self: This LIKELY will result in the entire nodejs process aborting, which is **okay** in prod!
				// If the process aborts, it will just be restarted automatically. But, it's a small price to pay
				// to ensure we kill the thread on the db server that is consuming resources.
				await killConnection.query(`KILL ${connection.threadId}`);
				await killConnection.end();
			} catch (killError) {
				// Killing the query is best effort - ignore failures silently
				// Users can enable debug logging via config if needed
			}
		}

		const timeoutError = new Error(`Query timeout after ${timeoutMs}ms`);
		timeoutError.name = 'QueryTimeoutError';
		timeoutError.code = 'QUERY_TIMEOUT';

		this.recordFailure(targetId, timeoutError);
	}

	/**
	 * Check if a target is available (not in OPEN circuit state)
	 */
	isTargetAvailable(targetId) {
		const metrics = this.targetMetrics.get(targetId);
		if (!metrics) return true; // New targets are considered available

		return metrics.circuitState !== this.CIRCUIT_STATES.OPEN;
	}

	/**
	 * Calculate a load score for a target (lower score = less loaded)
	 * Factors considered:
	 * - EMA query time (60% weight)
	 * - Number of currently active queries (25% weight)
	 * - Circuit breaker state and health (15% weight)
	 */
	getTargetLoadScore(targetId, targetsCount) {
		const metrics = this.targetMetrics.get(targetId);
		if (!metrics) return 0; // New targets get best score

		// If circuit is OPEN, return very high score to avoid this target
		if (metrics.circuitState === this.CIRCUIT_STATES.OPEN) {
			return Infinity;
		}

		// Base score from EMA query time
		const queryTimeWeight = 0.6;
		const activeQueriesWeight = 0.25;
		const healthWeight = 0.15;

		// Normalize EMA query time (0-2000ms scale)
		const normalizedQueryTime = Math.min(metrics.emaQueryTime / 2000, 1);

		// Active queries penalty
		const normalizedActiveQueries = metrics.activeQueryCount / targetsCount;

		// Health score based on recent error rate and circuit state
		let healthScore = 0;
		if (metrics.circuitState === this.CIRCUIT_STATES.HALF_OPEN) {
			healthScore = 0.5; // Penalty for being in half-open state
		}

		// Add penalty for recent failures
		const recentFailureRate =
			metrics.recentErrors.length / Math.max(metrics.totalQueries, 1);
		healthScore += Math.min(recentFailureRate * 2, 1); // Cap at 1.0

		const score =
			normalizedQueryTime * queryTimeWeight +
			normalizedActiveQueries * activeQueriesWeight +
			healthScore * healthWeight;

		return score;
	}

	/**
	 * Get ordered list of targets by load score (best first)
	 */
	getOrderedTargets(targets) {
		const availableTargets = targets
			.filter((target) => this.isTargetAvailable(target.loadBalancerTargetId))
			.map((target) => ({
				target,
				targetId: target.loadBalancerTargetId,
				score: this.getTargetLoadScore(
					target.loadBalancerTargetId,
					targets.length,
				),
			}));

		// Sort by score (lower is better)
		return availableTargets.sort((a, b) => a.score - b.score);
	}

	/**
	 * Get target statistics for debugging/monitoring
	 */
	getConnectionStats() {
		const stats = {};
		Array.from(this.targetMetrics.entries()).forEach(([targetId, metrics]) => {
			// Get effective config values for this target (per-target + global, query-level would override at runtime)
			const effectiveConfig = {};
			this.perTargetConfigKeys.forEach((configKey) => {
				effectiveConfig[configKey] = this.getTargetConfig({
					targetId,
					configKey,
					targetMetrics: this.targetMetrics,
				});
			});

			stats[targetId] = {
				activeQueries: metrics.activeQueryCount,
				emaQueryTime: Math.round(metrics.emaQueryTime),
				lastQueryTime: metrics.lastQueryTime,
				totalQueries: metrics.totalQueries,
				totalSuccesses: metrics.totalSuccesses,
				totalFailures: metrics.totalFailures,
				consecutiveFailures: metrics.consecutiveFailures,
				consecutiveSuccesses: metrics.consecutiveSuccesses,
				circuitState: metrics.circuitState,
				recentErrorCount: metrics.recentErrors.length,
				loadScore:
					metrics.totalQueries > 0 ? this.getTargetLoadScore(targetId, 1) : 0,
				errorTypes: Object.fromEntries(metrics.errorTypes),
				targetOptions: metrics.targetOptions,
				effectiveConfig, // Per-target + global config (query-level options would override these at runtime)
				lastAccessTime: metrics.lastAccessTime,
			};
		});
		return stats;
	}

	/**
	 * Try to execute query on a single target
	 */
	async tryTarget(target, query) {
		const { sql, params, args } = query;
		const targetId = target.loadBalancerTargetId;
		const queryId = `query_${this.nextQueryId++}`;

		// Track the query with connection reference for potential killing
		this.activeQueries.set(queryId, {
			targetId,
			connection: target, // Store connection for server-side query killing
			startTime: null,
			timeoutHandle: null,
		});

		await this.queryStarted(queryId, query.opts);

		try {
			const result = await target.pquery(sql, params, ...args);
			await this.queryFinished(queryId);
			return result;
		} catch (queryError) {
			// Record failure but clean up query tracking
			this.recordFailure(targetId, queryError);
			this.activeQueries.delete(queryId);
			throw queryError;
		}
	}

	/**
	 * Try targets sequentially until one succeeds
	 */
	async tryTargets(orderedTargets, query) {
		if (orderedTargets.length === 0) {
			throw new Error('[QueryTimeLoadBalancer] No healthy targets available');
		}

		let lastError = null;

		// Try each target sequentially (await in loop is intentional for retry logic)
		// eslint-disable-next-line no-await-in-loop
		for (let i = 0; i < orderedTargets.length; i++) {
			const targetInfo = orderedTargets[i];
			try {
				// eslint-disable-next-line no-await-in-loop
				return await this.tryTarget(targetInfo.target, query);
			} catch (error) {
				lastError = error;
				// Continue to next target if this isn't the last one
				if (i === orderedTargets.length - 1) {
					// This was the last target, throw the error
					throw error;
				}
			}
		}

		// This shouldn't be reached, but just in case
		throw lastError || new Error('[QueryTimeLoadBalancer] All targets failed');
	}

	/**
	 * Override executeQuery to implement circuit breaker and retry logic
	 */
	async executeQuery({ targets, query }) {
		// Handle target set changes
		this.handleTargetSetChange(targets);

		// Extract query-level options
		const queryLevelOptions =
			(query.opts && query.opts.loadBalancerOptions) || {};

		// Use 3-level hierarchy for maxRetries (note: using any target for config lookup since maxRetries applies globally per query)
		const targetId =
			targets.length > 0 ? targets[0].loadBalancerTargetId : null;
		const maxRetries = targetId
			? this.getTargetConfig({
					targetId,
					configKey: 'maxRetries',
					queryLevelOptions,
					targetMetrics: this.targetMetrics,
			  })
			: queryLevelOptions.maxRetries || this.config.maxRetries;

		let lastError = null;

		// Try up to maxRetries times with exponential backoff
		// eslint-disable-next-line no-await-in-loop
		for (let attemptIndex = 0; attemptIndex < maxRetries; attemptIndex++) {
			try {
				const orderedTargets = this.getOrderedTargets(targets);
				// eslint-disable-next-line no-await-in-loop
				return await this.tryTargets(orderedTargets, query);
			} catch (error) {
				lastError = error;

				// If this is the last attempt, throw the error
				if (attemptIndex === maxRetries - 1) {
					throw (
						lastError || new Error(`Query failed after ${maxRetries} attempts`)
					);
				}

				// Wait before retrying with exponential backoff
				const backoffMs = Math.min(100 * 2 ** attemptIndex, 5000);
				// eslint-disable-next-line no-await-in-loop
				await new Promise((resolve) => setTimeout(resolve, backoffMs));

				// Continue to next attempt
			}
		}

		// This shouldn't be reached, but just in case
		throw lastError || new Error(`Query failed after ${maxRetries} attempts`);
	}

	/**
	 * Cleanup method to clear intervals
	 */
	destroy() {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
			this.healthCheckInterval = null;
		}

		// Clear any remaining timeouts
		Array.from(this.activeQueries.values()).forEach((queryInfo) => {
			if (queryInfo.timeoutHandle) {
				clearTimeout(queryInfo.timeoutHandle);
			}
		});

		this.activeQueries.clear();
		this.targetMetrics.clear();
	}
}

module.exports = { QueryTimeLoadBalancer };
