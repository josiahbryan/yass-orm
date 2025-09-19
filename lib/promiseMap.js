/* eslint-disable no-await-in-loop */
/**
 * Utility to process elements of an array in sequence, `await`ing your
 * callback for each element before processing the next element.
 *
 * Think of it basically like `Array.map` but for async callbacks.
 *
 * Returns the results of each callback, just like `Array.map` would do.
 *
 * The difference between `promiseMap` and `Promise.all` is that `Promise.all`
 * runs all promises at once, whereas this processes items in sequence.
 *
 * @param {Array} list Array or `Promise` for an Array (will `await` the `list` value internally before processing)
 * @param {function} next Async called to process each element of the array, passed two args: `element` and `index`, where `element` is the current value of the array at row `index`. Return values are collected and returned in a list in the same order processed. This callback must finish before the next element is processed.
 * @param {bool|string} debug [default=`null`] If a truthy value is passed, will log to console along with a progress message. False by default.
 * @param {number} yieldEvery [default=10] Yield to event loop after every N completed items to prevent blocking.
 * @returns {Promise} `Promise` that resolves to an `Array` containing the return values from the `next` callback for each element.
 */

const DEFAULT_PROMISE_POOL_MAP_CONFIG = {
	concurrency: 4,
	debug: false,
	logger: console,
	throwErrors: false,
	yieldEvery: 8,
};

exports.DEFAULT_PROMISE_POOL_MAP_CONFIG = DEFAULT_PROMISE_POOL_MAP_CONFIG;

function updatePromiseMapDefaultConfig(config) {
	Object.assign(DEFAULT_PROMISE_POOL_MAP_CONFIG, config);
}

/**
 * Yields control to the event loop using the most appropriate method available
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
	// Use setImmediate if available (Node.js), otherwise fall back to setTimeout
	if (typeof setImmediate !== 'undefined') {
		return new Promise((resolve) => setImmediate(resolve));
	}
	// For browsers or environments without setImmediate
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function promiseMap(
	list = null,
	next = (/* d, idx */) => {},
	debug = null,
	yieldEvery = DEFAULT_PROMISE_POOL_MAP_CONFIG.yieldEvery,
) {
	const all = Array.from((await list) || []);
	const total = all.length;
	const results = [];

	for (let idx = 0; idx < all.length; idx++) {
		const result = await next(all[idx], idx);
		results.push(result);

		if (debug === true || typeof debug === 'string') {
			// eslint-disable-next-line no-console
			console.log(`[promiseMap:${debug}] Done ${results.length} / ${total}`);
		}

		// Yield to event loop periodically to prevent blocking
		if ((idx + 1) % yieldEvery === 0) {
			await yieldToEventLoop();
		}
	}

	return results;
}

exports.promiseMap = promiseMap;

/**
 * Processes a list of items with a specified concurrency limit, applying an async callback function to each item.
 * It maintains a queue of items to process, a set of currently executing promises, and an array to store results.
 * The function waits for all promises to complete before returning the results.
 *
 * @param {Array} list - The list of items to process.
 * @param {Function} callback - The async callback function to apply to each item.
 * @param {Object} [options] - Options object.
 * @param {number} [options.concurrency=5] - The maximum number of concurrent promises.
 * @param {boolean} [options.debug=false] - Whether to log debug information.
 * @param {Object} [options.logger=Logger] - Logger instance to use for debug/error messages.
 * @param {boolean} [options.throwErrors=false] - Whether to throw errors immediately or collect them.
 * @param {number} [options.yieldEvery=10] - Yield to event loop after every N completed items to prevent blocking.
 * @returns {Promise<Array>} A promise that resolves to an array of results.
 *
 * @example
 * ```javascript
 * const promises = new Array(10).fill().map(() => new Promise(x => setTimeout(x, 1000 * Math.random())));
 * const results = await promisePoolMap(promises, p => p, { concurrency: 3, debug: true });
 * console.log(results);
 * ```
 */

/**
 * promisePoolMap presents an almost identical API to promiseMap, but with the added ability to limit the number of concurrent promises that are running at any given time.
 *
 * Note this is covered by a unit test in the github:josiahbryan/rubber repo at /backend/src/utils/promisePoolMap.test.js
 */
async function promisePoolMap(
	listOrPromise,
	callback,
	{
		concurrency = DEFAULT_PROMISE_POOL_MAP_CONFIG.concurrency,
		debug = false,
		logger = DEFAULT_PROMISE_POOL_MAP_CONFIG.logger,
		throwErrors = DEFAULT_PROMISE_POOL_MAP_CONFIG.throwErrors,
		yieldEvery = DEFAULT_PROMISE_POOL_MAP_CONFIG.yieldEvery,
	} = {},
) {
	/*
		The `promisePoolMap` function processes a list of items with a specified concurrency limit, applying an async callback function to each item. It maintains a queue of items to process, a set of currently executing promises, and an array to store results. The function waits for all promises to complete before returning the results.

		Here's how this works:

			1. It takes a `list` of items to process, a `callback` function to apply to each item, and an options object with `concurrency` (renamed from `maxSimultaneous` for clarity) and `debug` parameters.

			2. It maintains a queue of items to process, a set of currently executing promises, and an array to store results.

			3. The `executeNext` function processes one item from the queue, adds its index to the executing set, and starts another item when it's done.

			4. The main loop starts up to `concurrency` number of promises initially.

			5. The function waits for all promises to complete before returning the results.

		You can use this function like this:

		```javascript
		const promises = new Array(10).fill().map(() => new Promise(x => setTimeout(x, 1000 * Math.random())));

		const results = await promisePoolMap(promises, p => p, { concurrency: 3, debug: true });
		console.log(results);
		```

		This will process the promises with a maximum of 3 running simultaneously. As soon as one promise finishes, another one starts if there are any left in the queue.

		The function maintains the order of results according to the input list, regardless of when each promise actually completes.
	*/

	if (!listOrPromise) {
		return [];
	}

	const list = await Promise.resolve(listOrPromise);
	if (!list?.length) {
		return [];
	}

	const results = new Array(list.length);
	const errors = [];
	let nextIndex = 0;
	let completedCount = 0;

	async function executeNext() {
		while (nextIndex < list.length) {
			const index = nextIndex++;

			try {
				const result = await callback(list[index], index);
				results[index] = result;
				completedCount++;

				if (debug) {
					logger.debug(
						`[promisePoolMap] Completed ${completedCount} / ${list.length}`,
					);
				}
			} catch (error) {
				logger.error(`[promisePoolMap] Error processing item ${index}`, error);
				errors.push({ index, error });

				if (throwErrors) {
					throw error;
				}
			}

			// Yield to event loop periodically to prevent blocking
			if (completedCount % yieldEvery === 0) {
				await yieldToEventLoop();
			}
		}
	}

	// Start concurrency number of execution chains
	await Promise.all(
		Array(Math.min(concurrency, list.length))
			.fill()
			.map(() => executeNext()),
	);

	// If there were any errors, throw the first one
	if (errors.length > 0) {
		throw errors[0].error;
	}

	return results;
}

exports.promisePoolMap = promisePoolMap;
exports.updatePromiseMapDefaultConfig = updatePromiseMapDefaultConfig;
