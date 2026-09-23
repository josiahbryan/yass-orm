/**
 * Load a package yass-orm doesn't install for you.
 *
 * `pg`, `better-sqlite3` and `node-sql-parser` are optional peer dependencies
 * (3.0): a consumer installs the ones its dialects need. Each is required the
 * first time something uses it, through here, so a missing one fails with an
 * error that says which package, what needed it, and how to install it, rather
 * than Node's bare "Cannot find module".
 */

const { peerDependencies = {} } = require('../package.json');

/** `err.code` of the error thrown for a package that isn't installed. */
const MISSING_DEPENDENCY = 'YASS_MISSING_DEPENDENCY';

// True only when `name` itself can't be found. A package that IS installed but
// can't load one of its own imports throws MODULE_NOT_FOUND too, naming that
// import instead; that's a broken install, and its error should come through as is.
const isMissing = (err, name) =>
	err &&
	err.code === 'MODULE_NOT_FOUND' &&
	`${err.message}`.split('\n')[0].includes(`'${name}'`);

// Loaded packages, by name. Some callers sit on hot paths (pg asks for a type
// parser per column of every result), so skip the resolver after the first load.
const loaded = new Map();

/**
 * Require an optional package.
 *
 * @param {string} name the package
 * @param {object} options
 * @param {string} options.feature what needs it, for the error ("the PostgreSQL dialect")
 * @returns {*} the package's exports
 * @throws {Error} with `code` MISSING_DEPENDENCY when the package isn't installed
 */
function requireOptional(name, { feature }) {
	if (loaded.has(name)) {
		return loaded.get(name);
	}
	try {
		// eslint-disable-next-line global-require, import/no-dynamic-require
		const mod = require(name);
		loaded.set(name, mod);
		return mod;
	} catch (err) {
		if (!isMissing(err, name)) {
			throw err;
		}
		const range = peerDependencies[name];
		const spec = range ? `${name}@"${range}"` : name;
		const missing = new Error(
			`yass-orm: ${feature} needs the "${name}" package, which isn't installed. ` +
				`Add it to your own dependencies: npm install ${spec}`,
			{ cause: err },
		);
		missing.code = MISSING_DEPENDENCY;
		throw missing;
	}
}

module.exports = { requireOptional, MISSING_DEPENDENCY };
