/* eslint-disable no-console */
/**
 * Resolving a link (`t.linked(x)`) to its model class, and loading a linked
 * row. DatabaseObject's `_resolveModelClass` and `_resolvedLinkedModel` are
 * thin delegates to these, so a subclass (or a test) can still override them.
 *
 * `resolveModelClass` dispatches on the link's type:
 * - a function: a lazy reference, `t.linked(() => Model)` (or the class itself);
 * - a string registered in the model registry: that model;
 * - anything else: the path resolution yass has always done, unchanged
 *   (withRelativeModelLinks' absolute paths, the path cache, Rubber's Bun
 *   model path index and path resolver).
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const url = require('url');
const { jsonSafeStringify } = require('../jsonSafeStringify');
const { isDebugEnabled } = require('../debug');
const globals = require('../globals');
const {
	isModelClass,
	describeLink,
	getRegisteredModel,
} = require('./registry');

const promiseExists = util.promisify(fs.exists);

/**
 * `{ default: Model }` (a module namespace, or an ESM default export) and a
 * double-wrapped default, unwrapped to the model.
 */
const unwrapModule = (value) => {
	let unwrapped = value;
	for (let i = 0; i < 2 && unwrapped && !isModelClass(unwrapped); i++) {
		if (!unwrapped.default) break;
		unwrapped = unwrapped.default;
	}
	return unwrapped;
};

// A lazy reference's model class, once it has resolved: the reference runs
// on first read, not on every linked row (a dynamic import() is not free).
const resolvedReferences = new WeakMap();

/**
 * A lazy reference: calls the function (awaiting it, so `() => import(...)`
 * works) and checks it gave a model class. A model class given directly is
 * returned as it is. Only a successful resolution is remembered, so a
 * reference read too early can still resolve later.
 */
const resolveReference = async (Model, reference, errorHint) => {
	if (isModelClass(reference)) {
		return reference;
	}
	const known = resolvedReferences.get(reference);
	if (known) {
		return known;
	}

	const where = `Cannot resolve linked model ${describeLink(
		reference,
	)} on table '${Model.table()}' ${errorHint}`.trim();

	let target;
	try {
		target = unwrapModule(await reference());
	} catch (error) {
		const wrapped = new Error(
			`${where}: the reference threw: ${error.message}`,
		);
		wrapped.cause = error;
		throw wrapped;
	}

	if (!isModelClass(target)) {
		throw new Error(
			`${where}: the reference returned ${describeLink(
				target,
			)}, not a model class (read too early in an import cycle? In CommonJS, require inside the function: () => require('./model'))`,
		);
	}
	resolvedReferences.set(reference, target);
	return target;
};

/**
 * Today's path resolution, moved here unchanged from lib/obj.js.
 */
const resolveModelPath = async (Model, modelName, errorHint, span) => {
	// Check for path resolver - enables bundled executables to translate /$bunfs/ paths
	const pathResolver = globals.pathResolver();
	const resolvePath = (p) =>
		typeof pathResolver === 'function' ? pathResolver(p) : p;

	// Use global PATH_CACHE to avoid repeated path.resolve() calls. Keyed by
	// the linking model's folder as well as the name: the same relative name
	// means a different file from a different folder.
	const basePath = Model.basePath();
	const pathCacheKey = `${basePath}\0${modelName}`;
	let resolvedPath = globals.pathCache.get(pathCacheKey);
	if (!resolvedPath) {
		const resolvedModel = path.resolve(basePath, modelName);

		// Support multiple extensions for TypeScript/ESM models
		const hasKnownExtension = Model.MODEL_EXTENSIONS.some((ext) =>
			resolvedModel.endsWith(ext),
		);

		if (hasKnownExtension) {
			resolvedPath = resolvedModel;
		} else {
			// Try each extension in order of preference
			// Use path resolver for fs.existsSync checks (handles /$bunfs/ paths)
			resolvedPath =
				Model.MODEL_EXTENSIONS.map((ext) => `${resolvedModel}${ext}`).find(
					(p) => fs.existsSync(resolvePath(p)),
				) ||
				// Default to .js for error message consistency
				`${resolvedModel}.js`;
		}
		globals.pathCache.set(pathCacheKey, resolvedPath);
	}

	const { modelClassCache } = globals;
	const cached = modelClassCache[resolvedPath];
	if (cached) {
		if (isDebugEnabled('cache')) {
			console.log(
				`[resolveModelClass] [✅ cache hit ✅] Returning cached model class for ${resolvedPath}`,
				`${Object.keys(modelClassCache).length} Model Classes in cache`,
			);
		}
		return cached;
	}

	// Check global model path index - this enables bundled executables (e.g., bun build --compile)
	// to resolve linked models without filesystem access. Models register themselves via
	// indexModelClass() which populates globalThis.__YASS_ORM_MODEL_PATH_INDEX__
	const externalPathIndex = globals.modelPathIndex();
	if (externalPathIndex instanceof Map && externalPathIndex.size > 0) {
		// Normalize path to match how models are registered
		// This extracts just the suffix starting from 'defs/' or 'models/' to create a common key
		// that works for both bundled ($bunfs) and non-bundled filesystem paths
		let normalizedPath = resolvedPath.replace(/\.(js|ts|cjs|mjs)$/, '');
		const defsIdx = normalizedPath.lastIndexOf('/defs/');
		const modelsIdx = normalizedPath.lastIndexOf('/models/');
		const cutIdx = Math.max(defsIdx, modelsIdx);
		if (cutIdx !== -1) {
			normalizedPath = normalizedPath.substring(cutIdx + 1);
		}

		const registered = externalPathIndex.get(normalizedPath);
		if (registered) {
			if (isDebugEnabled('cache')) {
				console.log(
					`[resolveModelClass] [✅ external index hit ✅] Found model in global path index for ${normalizedPath}`,
				);
			}
			// Cache for future lookups
			modelClassCache[resolvedPath] = registered;
			return registered;
		}

		// Debug: log when we expected to find the model but didn't
		if (isDebugEnabled('cache', 'model-index')) {
			console.log(
				`[resolveModelClass] [❌ external index miss ❌] Looking for '${normalizedPath}', resolvedPath='${resolvedPath}', index has ${externalPathIndex.size} entries:`,
				Array.from(externalPathIndex.keys()).slice(0, 10),
			);
		}
	}

	// I discovered in prod that frequently the 'exists' and then 'require' opts could take many milliseconds which add up when prod volume spikes. (By many milliseconds, I mean I've sean ranges from 9ms to 30-40ms) When you realize that 30ms PER 'linked(...)' access - that adds up horribly. So, caching the resolution SHOULD reduce that time considerably.
	// Use path resolver for bundled executable support (translates /$bunfs/ to real paths)
	const actualPath = resolvePath(resolvedPath);
	if (
		isDebugEnabled('cache', 'path-resolver') ||
		(actualPath !== resolvedPath && isDebugEnabled('model-index'))
	) {
		console.log(
			`[resolveModelClass] Path resolution: ${resolvedPath} -> ${actualPath}`,
		);
	}

	const pathExists = await promiseExists(actualPath);
	if (!pathExists) {
		let errorSpan;
		if (span && span.stack.length) {
			errorSpan = `\n\nDebugging trace on where this call originated:\n${jsonSafeStringify(
				span,
				4,
			)}`;
		}
		throw new Error(
			`Cannot resolve linked model '${modelName}' (resolved to file path: '${resolvedPath}', actual path: '${actualPath}') on table '${Model.table()}' ${errorHint} ${
				errorSpan || ''
			}`,
		);
	}

	// Use dynamic import() for ESM compatibility - this ensures we use the same
	// module cache as ESM imports, so instanceof checks work correctly
	const importedModule = await import(url.pathToFileURL(actualPath).href);
	let ModelClass = importedModule.default || importedModule;
	if (ModelClass.default) {
		ModelClass = ModelClass.default; // handle double-wrapped defaults
	}

	// Cache the resolved model class in our global cache list
	modelClassCache[resolvedPath] = ModelClass;

	if (isDebugEnabled('cache')) {
		console.log(
			`[resolveModelClass] [❌ cache miss ❌] Loaded model class for ${resolvedPath}, cache keys now:`,
			Object.keys(modelClassCache),
			`${Object.keys(modelClassCache).length} Model Classes in cache`,
		);
	}

	return ModelClass;
};

/**
 * The model class a link names, from the model `Model` that links.
 *
 * @param {Function} Model The linking model class
 * @param {string|Function} link A lazy reference, a registered name, or a path
 * @param {string} [errorHint] Appended to a resolution error
 * @param {object} [span] Debugging trace, printed with a path resolution error
 * @returns {Promise<Function>} The linked model class
 */
const resolveModelClass = async (Model, link, errorHint = '', span) => {
	if (typeof link === 'function') {
		return resolveReference(Model, link, errorHint);
	}
	if (typeof link === 'string') {
		const registered = getRegisteredModel(link);
		if (registered) {
			return registered;
		}
	}
	return resolveModelPath(Model, link, errorHint, span);
};

/**
 * The linked row `modelId` as an instance of the class `link` names, from the
 * cache when it's there. Resolves the class through `Model._resolveModelClass`
 * and loads through the linked class's own `get`, so overrides of either see
 * the call.
 */
const resolvedLinkedModel = async (
	Model,
	link,
	modelId,
	span = undefined,
	{ tx } = {},
) => {
	const ModelClass = await Model._resolveModelClass(
		link,
		`(trying to look up ID '${modelId}')`,
		span,
	);

	// Certain inflateValue calls COULD incorrectly pass in an already-inflated
	// linked model. so don't force another call to get() if already inflated
	if (modelId instanceof ModelClass) {
		return modelId;
	}

	// Inside a transaction the linked row may be uncommitted, so this read MUST
	// run on `tx` - on any other pooled connection it resolves to null and the
	// returned instance silently carries null links.
	return ModelClass.get(modelId, { allowCached: true, span, tx }); // don't force "SELECT" again
};

module.exports = {
	resolveModelClass,
	resolvedLinkedModel,
};
