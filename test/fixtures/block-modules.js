/**
 * Preload (`node --require`) that makes packages look uninstalled.
 *
 * `YASS_BLOCK_MODULES` is a comma-separated list of package names. Resolving any
 * of them, or any path inside one (`pg/lib/x`), throws exactly what Node throws
 * for a package that isn't there: a `MODULE_NOT_FOUND` error. Used by
 * test/optional-deps.test.js to check that yass-orm runs without its optional
 * drivers, and that it names the missing package when one is needed.
 */
const Module = require('module');

const blocked = new Set(
	`${process.env.YASS_BLOCK_MODULES || ''}`
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean),
);

const packageName = (request) => {
	const parts = `${request}`.split('/');
	return request.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

// eslint-disable-next-line no-underscore-dangle
const resolveFilename = Module._resolveFilename;
// eslint-disable-next-line no-underscore-dangle
Module._resolveFilename = function blockedResolve(request, ...rest) {
	if (blocked.has(packageName(request))) {
		const err = new Error(`Cannot find module '${request}'`);
		err.code = 'MODULE_NOT_FOUND';
		throw err;
	}
	return resolveFilename.call(this, request, ...rest);
};
