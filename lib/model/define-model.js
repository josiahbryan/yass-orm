/**
 * defineModel(): a model from an inline schema, with its TypeScript types
 * inferred from that schema (index.d.ts), so a new model needs no generated
 * `.d.ts` or `.zod.ts`:
 *
 * ```js
 * const User = defineModel({
 *   table: 'users',
 *   prefix: 'usr',
 *   schema: (t) => ({ id: t.stringKey, name: t.string, org: t.linked(() => Org) }),
 * });
 * class UserModel extends User { greet() { ... } }
 * ```
 *
 * The class is the one loadDefinition() makes (lib/model/definition-loader.js),
 * plus:
 * - `Model.definition`: the definition function, `({ types }) => ({ table, schema })`;
 * - `Model.defaultTable`, and `Model.useTable(name)` to rename the table
 *   before first use (applyTableNames() does it for a list of models);
 * - `Model.zod`: a zod schema for the model's data (lib/model/zod.js).
 *
 * The schema is built (convertDefinition) when first read, not when defined,
 * so a table can be renamed, and the config read, at startup.
 */
const parentModule = require('parent-module');
const path = require('path');
const { convertDefinition } = require('../def-to-schema');
const { createModelClass, fileUrlToPath } = require('./definition-loader');
const { DEFINED_MODEL, isDefinedModel, describeLink } = require('./registry');
const { loadZod, buildZodSchema } = require('./zod');

/**
 * The table a defined model's schema was built with, once it has been (its
 * name can't change after), else undefined. Shared with every subclass.
 */
const BUILT_TABLE = Symbol('yass-orm.definedModelBuiltTable');

/** Throws unless `name` is the table a built schema already has. */
const checkNotBuilt = (Model, name) => {
	const builtTable = Model[BUILT_TABLE];
	if (builtTable !== undefined && name !== builtTable) {
		throw new Error(
			`useTable('${name}'): the model's table is already '${builtTable}', and its schema has been read; set table names at startup, before first use`,
		);
	}
};

const checkTableName = (name, where) => {
	if (typeof name !== 'string' || !name) {
		throw new TypeError(
			`${where}: the table name must be a non-empty string, got ${describeLink(
				name,
			)}`,
		);
	}
};

/**
 * Defines a model.
 *
 * @param {Object} options
 * @param {string} options.table The table (its default name: see useTable)
 * @param {Function} options.schema `(t) => ({ field: t.string, ... })`
 * @param {string} [options.prefix] Id prefix: ids are `<prefix>_<timeOrderedId>`
 * @returns {Function} The model class
 *
 * Any other key (`indexes`, `triggers`, `includeCommonFields`, `options`, ...)
 * goes into the definition as it would in a definition file.
 */
const defineModel = (options) => {
	const { table, schema, prefix, ...rest } = options || {};
	if (typeof table !== 'string' || !table) {
		throw new TypeError(
			`defineModel: \`table\` must be a non-empty string, got ${describeLink(
				table,
			)}`,
		);
	}
	if (typeof schema !== 'function') {
		throw new TypeError(
			`defineModel('${table}'): \`schema\` must be a function: (t) => ({ ... })`,
		);
	}

	// Path links (`t.linked('./user')`) resolve from the caller's folder, as
	// they do for loadDefinition().
	const basePath = path.dirname(fileUrlToPath(parentModule()));

	let currentTable = table;
	let built;
	let zodSchema;

	const definition = ({ types }) => ({
		...rest,
		...(prefix ? { objectIdPrefix: prefix } : {}),
		table: currentTable,
		schema: schema(types),
	});

	const Model = createModelClass({
		basePath,
		getSchema: () => {
			if (!built) {
				built = convertDefinition(definition);
			}
			return built;
		},
		objectIdPrefix: prefix || rest.objectIdPrefix,
	});

	Object.defineProperties(Model, {
		[DEFINED_MODEL]: { value: true },
		definition: { value: definition },
		defaultTable: { value: table },
		useTable: {
			/**
			 * Renames the table. Only before the schema is first read (by a
			 * query, or `schema()`/`table()`/`fields()`): after that, only the
			 * same name. Shared with every subclass.
			 *
			 * @param {string} name
			 * @returns {Function} The class it was called on
			 */
			value: function useTable(name) {
				checkTableName(name, 'useTable');
				checkNotBuilt(Model, name);
				currentTable = name;
				return this;
			},
		},
		[BUILT_TABLE]: {
			get() {
				return built ? currentTable : undefined;
			},
		},
		zod: {
			/**
			 * A zod schema for the model's data, built on first read. It doesn't
			 * build the model's schema (which would fix its table name): the
			 * fields don't depend on the table.
			 */
			get() {
				if (!zodSchema) {
					// One source whether or not the schema is built yet, so the
					// shape doesn't depend on when `zod` is first read.
					const { fieldMap } = built || convertDefinition(definition);
					zodSchema = buildZodSchema(
						Object.values(fieldMap),
						loadZod(basePath),
					);
				}
				return zodSchema;
			},
		},
	});

	return Model;
};

/**
 * Renames the tables of defineModel() models: each takes the name given for
 * its default table in `tables`, else `tablePrefix` + its default name.
 * Checks everything before renaming anything: a name in `tables` that is no
 * model's default table, two models on one table, and a new name for a model
 * whose schema has been read all throw.
 *
 * @param {Function[]|Object<string, Function>} models
 * @param {Object} [options]
 * @param {Object<string, string>} [options.tables] Default table name -> table name
 * @param {string} [options.tablePrefix]
 * @returns {Object<string, string>} Default table name -> table name, for every model
 */
const applyTableNames = (models, { tables = {}, tablePrefix = '' } = {}) => {
	const list = Array.isArray(models) ? models : Object.values(models || {});
	list.forEach((Model) => {
		if (!isDefinedModel(Model)) {
			throw new TypeError(
				`applyTableNames: not a defineModel() model: ${describeLink(Model)}`,
			);
		}
	});

	const defaults = new Set(list.map((Model) => Model.defaultTable));
	Object.keys(tables).forEach((name) => {
		if (!defaults.has(name)) {
			throw new Error(
				`applyTableNames: no model has the default table '${name}'`,
			);
		}
	});

	const resolved = {};
	// Table name -> the definition using it. A subclass shares its model's
	// definition, so the two are one table, not a clash.
	const owners = new Map();
	list.forEach((Model) => {
		const name =
			tables[Model.defaultTable] !== undefined
				? tables[Model.defaultTable]
				: `${tablePrefix}${Model.defaultTable}`;
		checkTableName(name, `applyTableNames('${Model.defaultTable}')`);
		const owner = owners.get(name);
		if (owner && owner.definition !== Model.definition) {
			throw new Error(
				`applyTableNames: '${owner.defaultTable}' and '${Model.defaultTable}' would both use table '${name}'`,
			);
		}
		owners.set(name, Model);
		// A model whose schema was read keeps its table: throw before renaming any.
		checkNotBuilt(Model, name);
		resolved[Model.defaultTable] = name;
	});

	list.forEach((Model) => Model.useTable(resolved[Model.defaultTable]));
	return resolved;
};

module.exports = { defineModel, applyTableNames };
