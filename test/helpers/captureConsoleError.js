/**
 * captureConsoleError — shared test helper that swaps in a capturing
 * console.error during a block. Use to suppress noisy "=== Error
 * processing query ===" banners that pquery prints by design AND to
 * assert how many of those banners fired.
 *
 * Usage with mocha:
 *
 *   const { captureConsoleError } = require('./helpers/captureConsoleError');
 *   let cap;
 *   beforeEach(() => { cap = captureConsoleError.install(); });
 *   afterEach(() => { cap.restore(); });
 *   it('does not log', async () => {
 *     await thingThatShouldNotError();
 *     expect(cap.loudCount()).to.equal(0);
 *   });
 *
 * Or as a one-shot for a single block:
 *
 *   const captured = await captureConsoleError.during(async () => { ... });
 */

const PQUERY_BANNER = '=== Error processing query ===';

function install() {
	const captured = [];
	// eslint-disable-next-line no-console
	const original = console.error;
	// eslint-disable-next-line no-console
	console.error = (...args) => captured.push(args);

	return {
		captured,
		loudCount() {
			return captured.filter((args) =>
				args.some(
					(a) => typeof a === 'string' && a.includes(PQUERY_BANNER),
				),
			).length;
		},
		restore() {
			// eslint-disable-next-line no-console
			console.error = original;
		},
	};
}

async function during(fn) {
	const cap = install();
	try {
		await fn();
	} finally {
		cap.restore();
	}
	return cap.captured;
}

module.exports = {
	captureConsoleError: { install, during },
};
