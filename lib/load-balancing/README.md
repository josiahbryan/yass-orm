# Load Balancer Strategies

This folder contains a comprehensive load balancing system for database read operations. The system supports multiple strategies including Round Robin (default) and Random, plus the ability to add custom strategies.

## Quick Start

The basic "Round Robin" strategy has been the default for a long time and cycles through read-only connections sequentially. The "Random" strategy was added as a simple alternative that randomly selects from available connections.

## Architecture Overview

The load balancing system consists of three main components:

1. **LoadBalancer Base Class** - Defines the interface and configuration hierarchy
2. **Strategy Implementations** - Specific algorithms (RoundRobin, Random, etc.)
3. **LoadBalancerManager** - Manages strategy lifecycle, events, and fallback behavior

## Configuration Hierarchy

The system supports a powerful 3-level configuration hierarchy for maximum flexibility:

### 1. Global Configuration (Constructor)

```javascript
loadBalanceManager.setStrategy('custom', {
	queryTimeoutMs: 30000,
	maxRetries: 3,
	customOption: 'value',
});
```

(See notes on setting custom strategies below under `Enterprise Integration`)

### 2. Per-Target Configuration (Config File)

```javascript
readonlyNodes: [
	{
		host: 'slow-db.example.com',
		loadBalancerOptions: {
			queryTimeoutMs: 60000, // 1 minute for slow server
			maxRetries: 5, // More retries for unreliable server
			customOption: 'value', // Strategy-specific options
		},
	},
];
```

### 3. Per-Query Configuration (Application Code)

```javascript
await conn.roQuery(
	'SELECT * FROM large_table',
	{},
	{
		loadBalancerOptions: {
			queryTimeoutMs: 120000, // 2 minutes for this specific query
			maxRetries: 1, // Single attempt for this query
		},
	},
);
```

## Target Structure

The `targets` array contains instantiated connections to readonly nodes with these important properties:

- **`loadBalancerTargetId`** - Unique identifier like `${db}:${host}:${port}` for tracking servers across connection instance changes
- **`loadBalancerOptions`** - Per-host configuration options from your config file, passed through to your load balancer
- **`async clone()`** - Returns a new connection instance for the same server (useful for server-side query killing)
- **Standard MariaDB methods** - `pquery()`, `query()`, etc.

## Creating Custom Load Balancers

### Simple Strategy

For basic load balancing, extend the `LoadBalancer` base class and implement `getNextReadConn()`:

```javascript
class RandomLoadBalancer extends LoadBalancer {
	async getNextReadConn({ targets }) {
		return {
			queryId: Math.random(),
			conn: targets[Math.floor(Math.random() * targets.length)],
		};
	}
}
```

### Advanced Strategy with Configuration

For more sophisticated strategies, use the configuration hierarchy and override `executeQuery()`:

```javascript
class WeightedLoadBalancer extends LoadBalancer {
	constructor(options = {}) {
		super();
		this.config = {
			defaultWeight: 1,
			healthCheckInterval: 30000,
			...options,
		};
		this.perTargetConfigKeys = ['weight', 'priority'];
	}

	async executeQuery({ targets, query }) {
		// Get per-target weights using 3-level hierarchy
		const weightedTargets = targets.map((target) => ({
			target,
			weight: this.getTargetConfig({
				targetId: target.loadBalancerTargetId,
				configKey: 'weight',
				defaultValue: this.config.defaultWeight,
				queryLevelOptions: query.opts?.loadBalancerOptions || {},
				targetMetrics: this.targetMetrics,
			}),
		}));

		// Implement weighted selection logic...
		const selected = this.selectWeightedTarget(weightedTargets);
		return await selected.target.pquery(query.sql, query.params, query.opts);
	}
}
```

## LoadBalancerManager

The `LoadBalancerManager` handles strategy lifecycle, events, and provides enterprise features. It is instantiated automatically by the library and exported so you can update it at runtime.

> NOTE:
You can change any relevant "global" configuration props via the 2nd arg of `setCustomLoadBalancer`  and `setStrategy`. None of the built-in strategies support any global configuration options, but custom balancers likely will if you create your own.

### Examples Manager Usage

```javascript
const { loadBalancerManager } = require('yass-orm');

// Event monitoring
loadBalancerManager.on('error', (data) => {
	console.log(`Query failed: ${data.error.message}`);
});

loadBalancerManager.on('strategy-changed', (data) => {
	console.log(`Switched from ${data.oldStrategy} to ${data.newStrategy}`);
});

// Runtime strategy changes
await loadBalancerManager.setStrategy('random', { /* config props */ });

// Custom strategies (see more notes below under 'Enterprise Integration')
await loadBalancerManager.setCustomLoadBalancer(MyCustomLoadBalancer, {
	customOption: 'value',
});

// Health monitoring
const health = await manager.healthCheck();
const stats = await manager.getStats();
```


## Built-in Strategies

### Round Robin (`roundRobin`)

Cycles through targets sequentially. Provides perfectly even distribution and predictable behavior.

```javascript
const { loadBalancerManager } = require('yass-orm');
await loadBalanceManager.setStrategy('roundRobin');
```

### Random (`random`)

Randomly selects targets. Provides good distribution over time with simpler logic.

```javascript
const { loadBalancerManager } = require('yass-orm');
await loadBalanceManager.setStrategy('random');
```

### Custom (`custom`)

Uses whatever previously-set custom strategy class you gave it. (See `Enterprise Integration` below.)

```javascript
const { loadBalancerManager } = require('yass-orm');
await loadBalanceManager.setStrategy('custom');
```

## Enterprise Integration

For enterprise packages, you can inject custom load balancers globally:

```javascript
// The `loadBalancerManager` is the instantiated load balance manager actively used internally
const { LoadBalancer, loadBalancerManager } = require('yass-orm');

// Create your EnterpriseLoadBalancer class
class EnterpriseLoadBalancer extends LoadBalancer {
	// Do fancy stuff here...
}

// Pass the class itself to the library, the library will instantiate internally.
// This automatically switches strategies internally to use your balancer here for the next query.
// (This sets the class used for strategy named 'custom')
await loadBalancerManager.setCustomLoadBalancer(EnterpriseLoadBalancer);

// You can always remove the custom balancer if needed later
await loadBalancerManager.removeCustomLoadBalancer();

// ... or set a new strategy instead of removing
await loadBalanceManager.setStrategy('roundRobin');
```

## Target Identity & Metrics

The system uses **target identity** (`loadBalancerTargetId`) rather than connection instances for tracking. This enables:

- **Global state sharing** across the entire application
- **Persistent metrics** that survive connection churn
- **Dynamic target membership** per query
- **Consistent routing decisions** across process restarts

Target identity format: `${database}:${host}:${port}`

## Testing

Comprehensive test suites are available in the `test/` directory:

- **LoadBalancer.test.js** - Base class functionality and configuration hierarchy
- **RandomLoadBalancer.test.js** - Random selection and statistical distribution
- **RoundRobinLoadBalancer.test.js** - Sequential cycling and state management
- **LoadBalancerManager.test.js** - Strategy management and event system

Run tests with: `npm test`

## Migration from Legacy

The load balancing system is fully backward compatible. Existing configurations will continue to work, and you can gradually adopt advanced features like per-target configuration and intelligent routing as needed.
