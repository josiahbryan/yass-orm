/* eslint-disable no-unused-vars */

const { jsonSafeStringify } = require('../jsonSafeStringify');

/**
 * Base class for database load balancing strategies.
 *
 * This class defines the contract for routing database queries across multiple target connections
 * based on configurable strategies (round-robin, query time, etc.). Load balancers support a
 * 3-level configuration hierarchy for maximum flexibility.
 *
 * ## 3-Level Configuration Hierarchy
 *
 * Configuration options are resolved in the following priority order:
 * 1. **Per-Query Options** (highest priority) - Passed via `opts.loadBalancerOptions`
 * 2. **Per-Target Options** (medium priority) - Set via `target.loadBalancerOptions`
 * 3. **Global Options** (lowest priority) - Set in load balancer constructor
 *
 * ### Global Configuration (Constructor)
 * ```javascript
 * new CustomLoadBalancer({
 *   queryTimeoutMs: 30000,
 *   maxRetries: 3,
 *   customOption: 'value'
 * });
 * ```
 *
 * ### Per-Target Configuration (dbh.js)
 * ```javascript
 * readonlyNodes: [{
 *   host: 'slow-db.example.com',
 *   loadBalancerOptions: {
 *     queryTimeoutMs: 60000,    // 1 minute for slow server
 *     maxRetries: 5,            // More retries for unreliable server
 *     customOption: 'value'     // Strategy-specific options
 *   }
 * }]
 * ```
 *
 * ### Per-Query Configuration (Application Code)
 * ```javascript
 * await conn.roQuery(
 *   'SELECT * FROM large_table',
 *   [],
 *   {
 *     loadBalancerOptions: {
 *       queryTimeoutMs: 120000,  // 2 minutes for this specific query
 *       maxRetries: 1            // Single attempt for this query
 *     }
 *   }
 * );
 * ```
 *
 * ## Target Structure
 *
 * Each target connection object must include:
 * - `loadBalancerTargetId` (string) - Unique identifier (e.g., "mydb:host:port")
 * - `loadBalancerOptions` (object, optional) - Per-target configuration overrides
 * - Standard connection methods (`pquery`, etc.)
 *
 * ## Implementation Guidelines
 *
 * When extending this class:
 * 1. Override `executeQuery()` for custom routing logic
 * 2. Use `queryStarted()` and `queryFinished()` for metrics tracking
 * 3. Implement `healthCheck()` for readiness probes
 * 4. Support configuration hierarchy via `getTargetConfig()` helper method
 * 5. Use object-based parameters for `getTargetConfig()` calls for readability
 * 6. Store target metrics by `loadBalancerTargetId`, not connection instance
 * 7. Define `this.config` object with default options in constructor
 * 8. Define `this.perTargetConfigKeys` array with overridable option names
 *
 * ### Usage Example for Custom Load Balancer
 * ```javascript
 * class MyLoadBalancer extends LoadBalancer {
 *   constructor(options = {}) {
 *     super();
 *     this.config = { retries: 3, timeout: 30000, ...options };
 *     this.perTargetConfigKeys = ['retries', 'timeout'];
 *   }
 *
 *   async executeQuery({ targets, query }) {
 *     const queryOptions = query.opts?.loadBalancerOptions || {};
 *     const retries = this.getTargetConfig({
 *       targetId: targets[0].loadBalancerTargetId,
 *       configKey: 'retries',
 *       queryLevelOptions: queryOptions,
 *       targetMetrics: this.targetMetrics
 *     });
 *     // Use retries with full 3-level hierarchy support
 *   }
 * }
 * ```
 *
 * @abstract
 */
class LoadBalancer {
	/**
	 * Creates a new load balancer instance.
	 *
	 * @param {Object} [options={}] - Global configuration options
	 */
	constructor() {
		this.initialized = false;

		// Subclasses should override these in their constructor:
		// this.config = { option1: defaultValue1, option2: defaultValue2, ...options };
		// this.perTargetConfigKeys = ['option1', 'option2']; // keys that can be overridden per-target
		this.config = {};
		this.perTargetConfigKeys = [];
	}

	/**
	 * Get effective config value with 3-level hierarchy:
	 * 1. Per-query loadBalancerOptions (highest priority)
	 * 2. Per-target loadBalancerOptions (medium priority)
	 * 3. Global config (lowest priority)
	 *
	 * @param {Object} params - Configuration parameters
	 * @param {string} params.targetId - Target identifier to get config for
	 * @param {string} params.configKey - Configuration key to retrieve
	 * @param {*} [params.defaultValue=null] - Default value if not found in any level
	 * @param {Object} [params.queryLevelOptions={}] - Per-query options from opts.loadBalancerOptions
	 * @param {Map} [params.targetMetrics=null] - Target metrics map containing targetOptions (optional)
	 * @returns {*} The effective configuration value
	 */
	getTargetConfig({
		targetId,
		configKey,
		defaultValue = null,
		queryLevelOptions = {},
		targetMetrics = null,
	}) {
		// Level 1: Check per-query options first
		if (
			this.perTargetConfigKeys.includes(configKey) &&
			queryLevelOptions &&
			queryLevelOptions[configKey] !== undefined
		) {
			return queryLevelOptions[configKey];
		}

		// Level 2: Check per-target options (try targetMetrics map if provided)
		if (this.perTargetConfigKeys.includes(configKey) && targetMetrics) {
			const metrics = targetMetrics.get(targetId);
			if (
				metrics &&
				metrics.targetOptions &&
				metrics.targetOptions[configKey] !== undefined
			) {
				return metrics.targetOptions[configKey];
			}
		}

		// Level 3: Fall back to global config
		return this.config[configKey] !== undefined
			? this.config[configKey]
			: defaultValue;
	}

	/**
	 * Initializes the load balancer.
	 *
	 * Override this method to perform setup tasks like establishing health check intervals,
	 * initializing metrics storage, or validating configuration.
	 *
	 * @returns {Promise<void>}
	 */
	async init() {
		// noop
		this.initialized = true;
	}

	/**
	 * Performs a health check on the load balancer.
	 *
	 * This method should return true if the load balancer is ready to route queries.
	 * Override for more sophisticated health checks like circuit breaker state,
	 * target availability, or resource thresholds.
	 *
	 * @returns {Promise<boolean>} True if healthy, false otherwise
	 */
	async healthCheck() {
		// If the load balancer is not initialized, it's not healthy.
		// This is a basic health check, can be overridden for more complex things like circuit breaking, etc.
		return this.initialized;
	}

	/**
	 * Called when a query starts execution.
	 *
	 * Use this hook to:
	 * - Start timing measurements
	 * - Increment active query counters
	 * - Set up query timeout handlers
	 * - Update target metrics
	 *
	 * @param {string} queryId - Unique identifier for this query
	 * @param {Object} [opts] - Query options including loadBalancerOptions
	 * @param {Object} [opts.loadBalancerOptions] - Per-query configuration overrides
	 * @returns {Promise<void>}
	 */
	async queryStarted(queryId) {
		// noop
	}

	/**
	 * Called when a query completes (successfully or with error).
	 *
	 * Use this hook to:
	 * - Record query execution time
	 * - Decrement active query counters
	 * - Update success/failure metrics
	 * - Clean up query tracking data
	 *
	 * @param {string} queryId - Unique identifier for this query
	 * @returns {Promise<void>}
	 */
	async queryFinished(queryId) {
		// noop
	}

	/**
	 * Selects the next connection for query execution.
	 *
	 * Override this method to implement your load balancing strategy:
	 * - Round-robin: cycle through targets sequentially
	 * - Query time: select fastest target based on historical performance
	 * - Random: select random healthy target
	 * - Weighted: prefer targets based on capacity/configuration
	 *
	 * @param {Object} params - Selection parameters
	 * @param {Array<Object>} params.targets - Available target connections
	 * @param {string} params.targets[].loadBalancerTargetId - Target identifier
	 * @param {Object} [params.targets[].loadBalancerOptions] - Per-target config
	 * @param {Object} params.query - Query details
	 * @param {string} params.query.sql - SQL statement
	 * @param {Array} params.query.params - Query parameters
	 * @param {Object} params.query.opts - Query options
	 * @param {Object} [params.query.opts.loadBalancerOptions] - Per-query config
	 * @param {Array} params.query.args - Additional arguments
	 * @returns {Promise<Object>} Selection result
	 * @returns {string} returns.queryId - Unique query identifier for tracking
	 * @returns {Object} returns.conn - Selected connection object
	 */
	async getNextReadConn({ targets, query: { sql, params, opts, args } }) {
		// noop
	}

	/**
	 * Executes a query using the load balancing strategy.
	 *
	 * This is the main entry point for query execution. The default implementation
	 * uses `getNextReadConn()` for simple target selection, but you can override
	 * this method entirely for advanced features like:
	 * - Circuit breaker patterns
	 * - Automatic retries with exponential backoff
	 * - Failover across multiple targets
	 * - Query timeout handling
	 * - Connection pooling
	 *
	 * @param {Object} params - Execution parameters
	 * @param {Array<Object>} params.targets - Available target connections
	 * @param {string} params.targets[].loadBalancerTargetId - Target identifier (e.g., "mydb:host:port")
	 * @param {Object} [params.targets[].loadBalancerOptions] - Per-target configuration
	 * @param {Function} params.targets[].pquery - Connection's parameterized query method
	 * @param {Object} params.query - Query to execute
	 * @param {string} params.query.sql - SQL statement
	 * @param {Array} params.query.params - Query parameters for placeholders
	 * @param {Object} params.query.opts - Query execution options
	 * @param {boolean} [params.query.opts.silenceErrors] - Suppress error logging
	 * @param {Object} [params.query.opts.loadBalancerOptions] - Per-query configuration overrides
	 * @param {Array} params.query.args - Additional arguments passed to pquery
	 * @returns {Promise<*>} Query result from the database
	 * @throws {Error} If no healthy targets available or all retries exhausted
	 */
	async executeQuery({ targets, query: { sql, params, opts, args } }) {
		const { queryId, conn } = await this.getNextReadConn({
			targets,
			query: { sql, params, opts, args },
		});
		if (!conn) {
			throw new Error(
				`[LoadBalancer] No connection available for query: '${sql}' with params: ${jsonSafeStringify(
					params,
					0,
				)}`,
			);
		}

		await this.queryStarted(queryId);
		try {
			return await conn.pquery(sql, params, opts, ...args);
		} finally {
			await this.queryFinished(queryId);
		}
	}

	/**
	 * Cleanup method to release resources.
	 *
	 * Override this method to perform cleanup tasks like:
	 * - Clearing intervals and timeouts
	 * - Closing connections
	 * - Clearing cached data
	 * - Releasing event listeners
	 *
	 * @returns {Promise<void>}
	 */
	async destroy() {
		// noop - base implementation does nothing
		// Subclasses should override this for specific cleanup
	}
}

module.exports = { LoadBalancer };
