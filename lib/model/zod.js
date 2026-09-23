/**
 * `Model.zod` for defineModel() models: a zod schema for the model's data,
 * built at run time from its converted schema (what generate-types' `.zod.ts`
 * files hold for loadDefinition models).
 *
 * It matches the types index.d.ts infers (`ModelData`):
 * - every field is optional;
 * - null is allowed exactly where the column is nullable (not a key, no
 *   default, not t.bool);
 * - a link is its id (a string or a number);
 * - inside a JSON field (t.object, t.array), a datetime is its ISO string,
 *   as JSON gives it back;
 * - keys that aren't columns are dropped (zod's default).
 *
 * zod isn't a dependency of yass: it's loaded from the app that defined the
 * model (or from wherever yass can see it), on the first read of `Model.zod`.
 */
const path = require('path');
const { createRequire } = require('module');

/**
 * The zod module, from the first requirer that finds it.
 *
 * @param {string|Function[]} from The folder to resolve from (the model's), or require functions to try
 * @returns {Object} zod's `z`
 */
const loadZod = (from) => {
	const requirers = Array.isArray(from)
		? from
		: // eslint-disable-next-line global-require
		  [createRequire(path.join(from, 'noop.js')), require];
	// eslint-disable-next-line no-restricted-syntax
	for (const requireFrom of requirers) {
		try {
			const zod = requireFrom('zod');
			return zod.z || zod;
		} catch (error) {
			if (error.code !== 'MODULE_NOT_FOUND') {
				throw error;
			}
		}
	}
	throw new Error(
		"Model.zod needs the 'zod' package (version 3.25 or later): install it in your app",
	);
};

/** True unless the column is NOT NULL (the same test schema sync makes). */
const isNullable = (row) =>
	!['uuidKey', 'idKey'].includes(row.type) &&
	!['NO', '0'].includes(`${row.null}`.toUpperCase());

const stringChecks = (schema, row) => {
	let result = schema;
	if (row._minLength !== undefined) result = result.min(row._minLength);
	if (row._maxLength !== undefined) result = result.max(row._maxLength);
	if (row._pattern) {
		result = result.regex(
			row._pattern instanceof RegExp ? row._pattern : new RegExp(row._pattern),
		);
	}
	if (row._format === 'email') result = result.email();
	if (row._format === 'url') result = result.url();
	return result;
};

const numberChecks = (schema, row) => {
	let result = schema;
	if (row._min !== undefined) result = result.min(row._min);
	if (row._max !== undefined) result = result.max(row._max);
	if (row._positive) result = result.positive();
	if (row._negative) result = result.negative();
	if (row._nonnegative) result = result.nonnegative();
	return result;
};

/** An enum's options: z.enum for strings, literals otherwise. */
const enumOf = (z, options) => {
	if (options.every((option) => typeof option === 'string')) {
		return z.enum(options);
	}
	const literals = options.map((option) => z.literal(option));
	return literals.length === 1 ? literals[0] : z.union(literals);
};

/** An object's sub-fields (rows keyed by their full column name), in JSON. */
const shapeOf = (z, subRows) =>
	z.object(
		Object.fromEntries(
			Object.values(subRows).map((row) => [
				row.subfield,
				// eslint-disable-next-line no-use-before-define
				fieldSchema(z, row, { inJson: true }),
			]),
		),
	);

const arrayItemOf = (z, row) => {
	switch (row.arrayItemType) {
		case 'string':
			return z.string();
		case 'bigint':
			return z.string().regex(/^-?\d+$/);
		case 'number':
			return z.number();
		case 'boolean':
			return z.boolean();
		case 'enum':
			return row.arrayItemEnumOptions && row.arrayItemEnumOptions.length
				? enumOf(z, row.arrayItemEnumOptions)
				: z.unknown();
		case 'object':
			return row.arrayItemSchema && Object.keys(row.arrayItemSchema).length
				? shapeOf(z, row.arrayItemSchema)
				: z.unknown();
		default:
			return z.unknown();
	}
};

/** One column's value, before null and optional. */
const valueSchema = (z, row, { inJson }) => {
	if (row.linkedModel) {
		return z.union([z.string(), z.number()]);
	}
	if (
		row._type === 'enum' &&
		Array.isArray(row.options) &&
		row.options.length
	) {
		return enumOf(z, row.options);
	}
	if (row.isArray) {
		let schema = z.array(arrayItemOf(z, row));
		if (row._minItems !== undefined) schema = schema.min(row._minItems);
		if (row._maxItems !== undefined) schema = schema.max(row._maxItems);
		return schema;
	}
	if (row.isObject) {
		return row.objectSchema && Object.keys(row.objectSchema).length
			? shapeOf(z, row.objectSchema)
			: z.record(z.string(), z.unknown());
	}
	if (row.isAny) {
		return z.unknown();
	}
	const type = /^varchar\(\d+\)$/i.test(`${row.type}`) ? 'varchar' : row.type;
	switch (type) {
		case 'idKey':
			return z.number().int();
		case 'integer':
			return numberChecks(z.number().int(), row);
		case 'double':
			return numberChecks(z.number(), row);
		case 'int(1)':
			return z.boolean();
		case 'datetime':
			// A Date, or a string/number one is made from. Not z.coerce.date():
			// it turns null into 1970-01-01, so a NOT NULL datetime took null.
			return inJson
				? z.string()
				: z.preprocess(
						(value) =>
							typeof value === 'string' || typeof value === 'number'
								? new Date(value)
								: value,
						z.date(),
				  );
		case 'bigint':
			return z.string().regex(/^-?\d+$/);
		case 'uuidKey':
		case 'char(36)':
		case 'date':
		case 'time':
			return z.string();
		case 'varchar':
		case 'longtext':
			return stringChecks(z.string(), row);
		default:
			return z.unknown();
	}
};

/** One column: its value, nullable where the column is, and optional. */
const fieldSchema = (z, row, { inJson = false } = {}) => {
	let schema = valueSchema(z, row, { inJson });
	if (row._description) schema = schema.describe(row._description);
	if (isNullable(row)) schema = schema.nullable();
	return schema.optional();
};

/**
 * The zod schema for a model's data.
 *
 * @param {Object[]} fields The model's field rows (`Model.fields()`)
 * @param {Object} z zod
 * @returns {Object} A zod object schema
 */
const buildZodSchema = (fields, z) =>
	z.object(
		Object.fromEntries(
			fields
				// A t.object's expanded sub-columns are part of the object.
				.filter((row) => !row.subfield)
				.map((row) => [row.field, fieldSchema(z, row)]),
		),
	);

module.exports = { loadZod, buildZodSchema };
