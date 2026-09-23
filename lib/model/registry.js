/**
 * The model registry: names a `t.linked('name')` can resolve to without a
 * file path, and the startup link check.
 *
 * Registering is opt-in and additive. A string link whose name is not
 * registered resolves by path exactly as it always has, so nothing that
 * registers nothing (Rubber, today) sees any change.
 *
 * The Map lives on globalThis (`__YASS_ORM_MODEL_REGISTRY__`, see
 * lib/globals.js) so two copies of yass in one process share it.
 */
const { modelRegistry } = require('../globals');

/**
 * True for a model class: a DatabaseObject subclass, or anything shaped like
 * one. A lazy reference (`() => Model`) is not.
 *
 * @param {*} value
 * @returns {boolean}
 */
const isModelClass = (value) =>
	typeof value === 'function' &&
	typeof value.schema === 'function' &&
	typeof value.inflate === 'function';

/**
 * A short, readable label for a link: the string itself, a model class's
 * name, or a lazy reference's source text.
 *
 * @param {string|Function} link
 * @returns {string}
 */
const describeLink = (link) => {
	if (typeof link !== 'function') return `${link}`;
	if (isModelClass(link)) return link.name || '(anonymous model class)';
	const source = `${link}`.replace(/\s+/g, ' ');
	return source.length > 80 ? `${source.slice(0, 77)}...` : source;
};

const checkRegistration = (name, model) => {
	if (typeof name !== 'string' || !name) {
		throw new TypeError(
			`registerModel: the name must be a non-empty string, got ${describeLink(
				name,
			)}`,
		);
	}
	if (!isModelClass(model)) {
		throw new TypeError(
			`registerModel('${name}'): not a model class: ${describeLink(model)}`,
		);
	}
	const existing = modelRegistry.get(name);
	if (existing && existing !== model) {
		throw new Error(
			`registerModel('${name}'): already registered to another model (${
				existing.name
			}, table '${existing.table()}')`,
		);
	}
};

/**
 * Registers each model under its key, after checking them all (so a bad entry
 * registers none of them). The same model under the same name again is a
 * no-op; a different model under a taken name throws.
 *
 * @param {Object<string, Function>} models `{ name: ModelClass }`
 * @returns {Function} Unregisters the names this call added (those still pointing at these models)
 */
const registerModels = (models) => {
	const entries = Object.entries(models || {});
	entries.forEach(([name, model]) => checkRegistration(name, model));
	// Only the names this call adds: a repeat registration is a no-op, so its
	// unregister must not remove the earlier one.
	const added = entries.filter(([name]) => !modelRegistry.has(name));
	added.forEach(([name, model]) => modelRegistry.set(name, model));
	return function unregister() {
		added.forEach(([name, model]) => {
			if (modelRegistry.get(name) === model) {
				modelRegistry.delete(name);
			}
		});
	};
};

/**
 * Registers one model under `name`. See registerModels().
 *
 * @param {string} name
 * @param {Function} model
 * @returns {Function} Unregisters it
 */
const registerModel = (name, model) => registerModels({ [name]: model });

/**
 * The model registered under `name`, or undefined.
 *
 * @param {string} name
 * @returns {Function|undefined}
 */
const getRegisteredModel = (name) => modelRegistry.get(name);

/**
 * Resolves every link of every model given (by default, every registered
 * model) and reports all the ones that don't resolve, at once, rather than
 * each at its first read. Opt-in: call it at boot.
 *
 * Each link resolves exactly as a read would (lazy reference, registered
 * name, or path, including withRelativeModelLinks and the Bun path index), so
 * a path link's model file is imported, as its first read would.
 *
 * @param {Object} [options]
 * @param {Function[]|Object<string, Function>} [options.models] Models to check (default: the registered ones)
 * @param {boolean} [options.throwIfBroken=false] Throw one error listing every broken link
 * @returns {Promise<{ ok: boolean, checked: number, problems: Array<{ model: string, table: string, field: string, link: string, message: string }> }>}
 */
const checkLinks = async ({ models, throwIfBroken = false } = {}) => {
	let list;
	if (models === undefined) {
		list = [...modelRegistry.values()];
	} else {
		list = Array.isArray(models) ? models : Object.values(models);
	}

	const links = [...new Set(list)].flatMap((Model) =>
		Model.fields()
			.filter((field) => field.linkedModel)
			.map((field) => ({ Model, field })),
	);

	const results = await Promise.all(
		links.map(async ({ Model, field: { field, linkedModel } }) => {
			try {
				const Target = await Model._resolveModelClass(
					linkedModel,
					`(field '${field}')`,
				);
				if (!isModelClass(Target)) {
					throw new Error(
						`Linked model ${describeLink(
							linkedModel,
						)} on table '${Model.table()}' resolved to ${describeLink(
							Target,
						)}, not a model class`,
					);
				}
				return undefined;
			} catch (error) {
				return {
					model: Model.name,
					table: Model.table(),
					field,
					link: describeLink(linkedModel),
					message: error.message,
				};
			}
		}),
	);

	const problems = results.filter(Boolean);
	if (problems.length && throwIfBroken) {
		const error = new Error(
			`checkLinks: ${problems.length} broken link${
				problems.length === 1 ? '' : 's'
			}:\n${problems
				.map(
					({ table, field, link, message }) =>
						`  - ${table}.${field} -> ${link}: ${message}`,
				)
				.join('\n')}`,
		);
		error.problems = problems;
		throw error;
	}

	return { ok: problems.length === 0, checked: links.length, problems };
};

module.exports = {
	isModelClass,
	describeLink,
	registerModel,
	registerModels,
	getRegisteredModel,
	checkLinks,
};
