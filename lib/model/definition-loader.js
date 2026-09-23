/* eslint-disable no-console, global-require */
/**
 * Loading a model from its definition: loadDefinition(), the definition cache
 * and registerDefinition() for bundled executables.
 *
 * loadDefinition() calls parentModule() itself, so it must stay the function
 * the consumer calls (lib/obj.js re-exports it as it is, never wrapped): the
 * caller's folder is the base path its links resolve from.
 */
const parentModule = require('parent-module');
const path = require('path');
const url = require('url');
const { createRequire } = require('module');
const config = require('../config');
const { convertDefinition } = require('../def-to-schema');
const { prefixedId } = require('../objectId');
const { isDebugEnabled } = require('../debug');
const globals = require('../globals');

const { modelDefinitionCache } = globals;

// Helper to convert file URLs to paths (ESM compatibility)
const fileUrlToPath = (p) => {
	if (!p || typeof p !== 'string') return p;
	if (p.startsWith('file:')) {
		try {
			return url.fileURLToPath(p);
		} catch {
			// Fallback: manually strip file:// prefix
			return p.replace(/^file:\/\//, '');
		}
	}
	return p;
};

// Cache the definitions to prevent hitting disk every time the process
// loads the same file. Should never happen, but trying to reduce local
// disk access to the bare minimum.
const getCachedDefinition = (basePath, definitionFile) => {
	// Debug: log inputs to understand path structure in bundled executables
	if (isDebugEnabled('path-resolver')) {
		console.log(
			`[getCachedDefinition] INPUTS: basePath='${basePath}', definitionFile='${definitionFile}'`,
		);
	}
	const resolvedPath = path.resolve(basePath, definitionFile);
	const cached = modelDefinitionCache[resolvedPath];
	if (cached) {
		if (isDebugEnabled('cache')) {
			console.log(
				`[getCachedDefinition] [✅ cache hit ✅] Returning cached definition for ${resolvedPath}`,
				`${Object.keys(modelDefinitionCache).length} definitions in cache`,
			);
		}
		return cached;
	}

	// Check global definition index - this enables bundled executables (e.g., bun build --compile)
	// to provide definition functions without filesystem access. Definitions register themselves via
	// registerDefinition() which populates globalThis.__YASS_ORM_DEFINITION_INDEX__
	const externalDefIndex = globals.definitionIndex();
	if (externalDefIndex instanceof Map && externalDefIndex.size > 0) {
		// Normalize path to match how definitions are registered
		// This extracts just the suffix starting from 'defs/' to create a common key
		let normalizedPath = resolvedPath.replace(/\.(js|ts|cjs|mjs)$/, '');
		const defsIdx = normalizedPath.lastIndexOf('/defs/');
		if (defsIdx !== -1) {
			normalizedPath = normalizedPath.substring(defsIdx + 1);
		}

		const registered = externalDefIndex.get(normalizedPath);
		if (registered) {
			if (isDebugEnabled('cache')) {
				console.log(
					`[getCachedDefinition] [✅ external index hit ✅] Found definition in global index for ${normalizedPath}`,
				);
			}
			// Cache for future lookups
			modelDefinitionCache[resolvedPath] = registered;
			return registered;
		}

		// Debug: log when we expected to find the definition but didn't
		if (isDebugEnabled('cache', 'definition-index')) {
			console.log(
				`[getCachedDefinition] [❌ external index miss ❌] Looking for '${normalizedPath}', resolvedPath='${resolvedPath}', index has ${externalDefIndex.size} entries:`,
				Array.from(externalDefIndex.keys()).slice(0, 10),
			);
		}
	}

	// Check for def path map - this enables bundled executables (e.g., bun build --compile)
	// to resolve definitions by name when path information is lost during bundling.
	// The map is injected at build time via: define: { 'globalThis.__YASS_DEF_PATH_MAP__': JSON.stringify(map) }
	const defPathMap = globals.defPathMap();
	let actualPath = resolvedPath;

	if (defPathMap && typeof defPathMap === 'object') {
		// Extract the def name from the path (filename without extension)
		const defName = path
			.basename(resolvedPath)
			.replace(/\.(js|ts|cjs|mjs)$/, '');
		const mappedPath = defPathMap[defName];

		if (mappedPath) {
			actualPath = mappedPath;
			if (isDebugEnabled('cache', 'path-resolver')) {
				console.log(
					`[getCachedDefinition] Def map resolution: '${defName}' -> ${mappedPath}`,
				);
			}
		} else if (isDebugEnabled('path-resolver')) {
			console.log(
				`[getCachedDefinition] Def name '${defName}' not found in path map (${
					Object.keys(defPathMap).length
				} entries)`,
			);
		}
	}

	// Fallback: Check for path resolver function
	// This enables custom path translation (e.g., /$bunfs/ to real paths if pattern is known)
	if (actualPath === resolvedPath) {
		const pathResolver = globals.pathResolver();
		if (typeof pathResolver === 'function') {
			actualPath = pathResolver(resolvedPath);
		}
	}

	if (
		isDebugEnabled('cache', 'path-resolver') ||
		(actualPath !== resolvedPath && isDebugEnabled('definition-index'))
	) {
		console.log(
			`[getCachedDefinition] Path resolution: ${resolvedPath} -> ${actualPath}`,
		);
	}

	// Use createRequire for ESM compatibility - this creates a require function
	// that works in both CJS and ESM contexts
	const esmRequire = createRequire(url.pathToFileURL(actualPath).href);
	const definition = esmRequire(actualPath);
	modelDefinitionCache[resolvedPath] = definition; // Cache with original key for consistency

	if (isDebugEnabled('cache')) {
		console.log(
			`[getCachedDefinition] [❌ cache miss ❌] Loaded definition for ${resolvedPath}, cache keys now:`,
			Object.keys(modelDefinitionCache),
			`${Object.keys(modelDefinitionCache).length} definitions in cache`,
		);
	}
	return definition;
};

/**
 * loadDefinition - Convenience function so subclasses can do this:
 * ```
 * 		const base = require('yass-orm').loadDefinition('./defs/some-definition');
 * 		class MyModel extends base {
 * 			someMethod() { ... }
 * 		}
 * ```
 *
 * ES6 is also supported, so you can do this even:
 *
 * ```
 *      import { loadDefinition } from 'yass-orm';
 *
 *      class MyModel extends loadDefinition('./defs/some-definition') {
 *          // ...
 *      }
 * ```
 *
 * @param {String} definition File name of the definition to require()
 *
 * @returns {class} Class to extend (or just export again)
 */
const loadDefinition = (definitionFile) => {
	const parentModuleUrl = parentModule();
	const basePath = path.dirname(fileUrlToPath(parentModuleUrl));

	// Debug: log parentModule result to understand bundled path structure
	if (isDebugEnabled('path-resolver')) {
		// Also log the caller stack to see where this is coming from
		const stackLines = new Error().stack
			.split('\n')
			.slice(2, 6)
			.map((l) => l.trim());
		console.log(
			`[loadDefinition] parentModule()='${parentModuleUrl}', basePath='${basePath}', definitionFile='${definitionFile}'`,
		);
		console.log(`[loadDefinition] Stack: ${stackLines.join(' <- ')}`);
	}

	const definition =
		typeof definitionFile === 'function'
			? definitionFile
			: getCachedDefinition(basePath, definitionFile);

	const schema = convertDefinition(definition);

	// Allow consumers of this library to extend/override this
	// to add common functionality for all their classes.
	// For example, customizing the default 'jsonify' behavior,
	// or adding a Redis cache instead of in-memory cache, etc.
	// (Required here, not at the top: lib/obj.js requires this module.)
	const { baseClass = require('../obj').DatabaseObject } = config;

	const ModelClass = class extends baseClass {
		static basePath() {
			return basePath;
		}

		static schema() {
			return schema;
		}
	};

	// A def that declares `objectIdPrefix` gets prefixed, time-ordered ids
	// (`chat_0mfq3k2z1...`, see lib/objectId.js). Set only when declared, so every
	// other model keeps whatever generateObjectId it inherits (a configured
	// baseClass override included), and a subclass can still override it.
	if (schema.objectIdPrefix) {
		ModelClass.generateObjectId = () => prefixedId(schema.objectIdPrefix);
	}

	return ModelClass;
};

/**
 * Register a definition function for bundled executable support.
 * This enables bundled executables (e.g., bun build --compile) to pre-register
 * definition functions that loadDefinition can use without filesystem access.
 *
 * @param {string} name - The definition name/path (e.g., 'webhook-log' or 'defs/webhook-log')
 * @param {Function} defFn - The definition function that returns the schema
 *
 * @example
 * // In your defs file:
 * import { registerDefinition } from 'yass-orm';
 * const def = ({ types: t }) => ({ table: 'users', schema: { ... } });
 * registerDefinition('user', def);
 * export default def;
 */
const registerDefinition = (name, defFn) => {
	// Normalize the name to match lookup format: 'defs/name'
	const normalizedName = name.startsWith('defs/')
		? name
		: `defs/${name.replace(/\.(js|ts|cjs|mjs)$/, '')}`;
	globals.definitionIndex({ create: true }).set(normalizedName, defFn);
};

module.exports = {
	getCachedDefinition,
	loadDefinition,
	registerDefinition,
};
