/* eslint-disable no-param-reassign, no-console */
/**
 * Rows in and out of model instances: inflate (row -> cached instance, links
 * loaded), inflateValues (column values -> JS values), deflateValues (the
 * reverse), updating an instance after a write, and jsonify.
 *
 * DatabaseObject's methods of the same names are thin delegates to these, and
 * these call back through the class or instance (`Model.getCachedId(...)`,
 * `instance.afterChangeHook(...)`), so a subclass override of any of them
 * (Rubber's `getCachedId(id, span)`, `setCachedId`, `afterChangeHook`) sees
 * the same calls, in the same order, as before the split.
 */
const { AsyncLocalStorage } = require('async_hooks');
const { jsonSafeStringify } = require('../jsonSafeStringify');
const { jsonSafeParse } = require('../jsonSafeParse');
const { txInstanceCache } = require('../txInstanceCache');
const { deflateValue } = require('../dbh');
const { promisePoolMap } = require('../promiseMap');
const { LOADED_AT, readIssuedAt, stampLoadedAt } = require('./loaded-at');
const { reapplyUnsavedSets } = require('./auto-save');

// Private: only inflate() may construct a model instance (see the
// DatabaseObject constructor).
const FROM_INFLATE_SYMBOL = Symbol('FROM_INFLATE_SYMBOL');
// Used to guard against recursion in inflate()
const INFLATE_GUARD_SYMBOL = Symbol('INFLATE_GUARD_SYMBOL');

/**
 * The instance for `data`'s row: the cached one freshened, or a new one
 * cached, with its links loaded. `loadedAt` is when the read that produced
 * `data` was issued (see lib/model/loaded-at.js; by default, now, or the
 * transaction's start): a cached instance holding data from a later read or
 * write keeps it.
 */
const inflate = async (
	Model,
	data,
	span = undefined,
	promisePoolMapConfig,
	{ tx, loadedAt = readIssuedAt(tx) } = {},
) => {
	const idField = Model.idField();
	if (!data) {
		return null;
	}
	const { [idField]: id } = data;
	if (!id) {
		console.trace(
			`inflate: invalid data (data was had no id at ${idField}):`,
			data,
		);
		return null;
	}

	// Inside a transaction, instances live in the transaction's own cache
	// until it commits (see lib/txInstanceCache.js); the shared cache and
	// getCachedId/setCachedId are not touched.
	const txCache = txInstanceCache(tx);

	// 'await' so we can allow subclasses to do async work and block if needed
	let cached = txCache
		? txCache.get(Model, id)
		: await Model.getCachedId(id, span);

	if (!cached) {
		cached = new Model({ id, [idField]: id }, FROM_INFLATE_SYMBOL);
		stampLoadedAt(cached, loadedAt);
		if (txCache) {
			txCache.set(Model, id, cached, { created: true });
		} else {
			// 'await' so we can allow subclasses to do async work and block if needed
			await Model.setCachedId(id, cached, span);
		}
	} else if (!txCache && cached[LOADED_AT] > loadedAt) {
		// The shared cache's instance holds data from a later read or write
		// than this one: keep it. (A transaction's own instances all read from
		// its snapshot, so they are always freshened.)
		return cached;
	}

	// For linked models, the call stack goes inflateValues > _resolvedLinkedModel > get > inflate (other class)
	// So by setting this here, we can shortcut the inflate() call (above)
	// because we "know" the inflate will finish and we just return the ref to the object
	// that will eventually get filled in
	cached[INFLATE_GUARD_SYMBOL] = true;

	// Inflate objects and linked models
	const inflatedData = await Model.inflateValues(
		data,
		span,
		promisePoolMapConfig,
		{ tx },
	);

	// Freshen cached data or set data first time
	const fields = Model.fields();
	for (let i = 0; i < fields.length; i++) {
		const row = fields[i];
		cached[row.field] = inflatedData[row.field];
	}
	reapplyUnsavedSets(cached);
	stampLoadedAt(cached, loadedAt);

	// Remove guard and return final object
	delete cached[INFLATE_GUARD_SYMBOL];

	// Set the object in the cache gently (Object.assign-like-functionality if it exists already)
	// 'await' so we can allow subclasses to do async work and block if needed
	if (!txCache) {
		await Model.setCachedId(id, cached);
	}

	return cached;
};

/**
 * Column values to JS values, per the schema: dates, numbers, booleans, JSON,
 * and links (loaded through `Model._resolvedLinkedModel`).
 */
const inflateValues = async (
	Model,
	data,
	span,
	promisePoolMapConfig,
	{ tx } = {},
) => {
	// Guard against undefined data (can happen if record was deleted during async operation)
	if (data === undefined || data === null) {
		return undefined;
	}

	const effectivePromisePoolMapConfig =
		promisePoolMapConfig || Model.promisePoolMapConfig;
	const inflatedData = {};
	await promisePoolMap(
		Model.fields(),
		async (row) => {
			let value = data[row.field];
			if (value === null) {
				value = null;
			} else if (value === undefined) {
				value = undefined;
			} else if (row.linkedModel) {
				// TODO: Look into supporting t.linked('model', { array: true })
				// where both would deflate to an array of ids, and then we can inflate to an array of objects
				// This code is not yet implemented, but would be nice to have...

				let spanClone = span;
				if (spanClone) {
					spanClone = {
						...spanClone,
						stack: [
							...spanClone.stack,
							{
								table: Model.table(),
								field: row.field,
								value: `${value}`,
								linkedModel: row.linkedModel,
							},
						],
					};
				}
				value = await Model._resolvedLinkedModel(
					row.linkedModel,
					value,
					spanClone,
					{ tx },
				);
			} else if (row.isObject) {
				if (typeof value === 'string' || value instanceof String) {
					const parsed = jsonSafeParse(value);
					if (parsed === undefined && data[row.field]) {
						const { [Model.idField()]: id } = data;
						console.warn(
							`Error parsing JSON in ${Model.table()}.${
								row.field
							}#${id} - original json:\n\n<<${data[row.field]}>>\n\n`,
						);
					} else {
						value = parsed;
					}
				}
				// else: Not going to try to parse, because it might not be a string
			} else if (row.nativeType === Boolean) {
				// Allowing casting incase db returns int for booleans
				// eslint-disable-next-line eqeqeq
				value = value == '1';
			} else if (row.nativeType === String) {
				if (row.type === 'date' && value instanceof Date) {
					// mariadb connector tries to be TOO smart/helpful by casting
					// 'date'-type columns to `Date` objects - which implies a timezone and time,
					// but MySQL doesn't store data like that, it only stores YYYY-MM-DD,
					// so represent in javascript as strings, not Dates
					// eslint-disable-next-line prefer-destructuring
					value = value.toISOString().split('T')[0];
				} else {
					value = String(value);
				}
			} else if (row.nativeType === Date) {
				// A Date from the driver is already the right instant: keep it.
				// (Round-tripping it through `${value}` -- Date#toString -- drops
				// the milliseconds.) A string is a UTC wall clock, fraction kept.
				value =
					value instanceof Date
						? new Date(value.getTime())
						: new Date(
								`${value}`.replace(
									/^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2}:\d{2})(\.\d+)?\s*$/,
									(m, day, time, frac) => `${day}T${time}${frac || '.000'}Z`,
								),
						  );
			} else if (row.nativeType === Number) {
				value = parseFloat(value);
			} else if (row.nativeType) {
				// eslint-disable-next-line new-cap
				value = new row.nativeType(value);
			}

			inflatedData[row.field] = value;
		},
		effectivePromisePoolMapConfig,
	);

	return inflatedData;
};

/**
 * An object field's value as JSON, with its subfields also written to their
 * own columns (in `deflatedData`) unless the field is `noExpand`.
 */
const processObjectSchema = (
	Model,
	deflatedData = {},
	row = {},
	value = null,
) => {
	if (value) {
		// Only expand subfields to separate columns if noExpand is false
		// When noExpand is true (default for direct t.object({ ... }) format),
		// we only store as JSON, not in individual columns
		if (row.objectSchema && !row.noExpand) {
			Object.values(row.objectSchema).forEach((subrow) => {
				if (subrow.isObject) {
					const finalValue = Model._processObjectSchema(
						deflatedData,
						subrow,
						value[subrow.subfield],
					);

					if (finalValue !== undefined) {
						deflatedData[subrow.field] = finalValue;
					}
				} else {
					const finalValue = deflateValue(value[subrow.subfield], subrow);
					if (finalValue !== undefined) {
						deflatedData[subrow.field] = finalValue;
					}
				}
			});
		}
		value = jsonSafeStringify(value, 0);
	}
	return value;
};

/** JS values to column values, per the schema: the reverse of inflateValues. */
const deflateValues = (Model, object = {}, noUndefined) => {
	const deflatedData = {};
	const idField = Model.idField();
	const fields = Model.fields();
	for (let i = 0; i < fields.length; i++) {
		const row = fields[i];
		// Don't try to "deflate" a field that doesn't exist
		if (!(row.field in object)) {
			// eslint-disable-next-line no-continue
			continue;
		}

		let value = object[row.field];
		if (row.linkedModel && value && value[idField]) {
			value = value[idField];
		} else if (row.isObject) {
			const tmp = Model._processObjectSchema(deflatedData, row, value);
			if (tmp !== null) {
				value = tmp;
			}
		} else if (row.nativeType === Boolean) {
			if (noUndefined) {
				value = value === true ? 1 : 0;
			} else if (value !== undefined) {
				value = value === true ? 1 : 0;
			}
		} else {
			// from dbh.js; a DATETIME(n) field (`precision`) keeps its fraction
			value = deflateValue(value, row);
		}

		if (value !== undefined) {
			deflatedData[row.field] = value;
		}
	}

	// If a user of this class declares this hook, then allow them to get warnings,
	// otherwise, we don't check
	// `deflateValues` is STATIC, so `this` is already the class — reading
	// `this.constructor` here walked past it to `Function`, making this hook
	// permanently undefined and the diagnostic unreachable (BDL-2700).
	if (Model.warnOnInvalidDeflateKey) {
		const { fieldMap } = Model.schema();
		Object.keys(object).forEach((patchKey) => {
			if (!fieldMap[patchKey]) {
				Model.warnOnInvalidDeflateKey(
					`Warning: data given to a '${Model.name}' method gave a field that does not exist in the DB schema: '${patchKey}' - the ORM will just ignore it, but you might want to check that.`,
					{ name: Model.name, patchKey },
				);
			}
		});
	}

	return deflatedData;
};

/**
 * After a write: the row's values onto `instance`, the cache freshened, then
 * `instance.afterChangeHook({ tx })`.
 */
const updateProperties = async (instance, data, span, { tx } = {}) => {
	// Guard against undefined data (can happen if record was deleted during async operation)
	if (data === undefined || data === null) {
		// Record was likely deleted - return this instance as-is without updating
		// This prevents errors when a debounced operation tries to update a deleted record
		return instance;
	}

	const Model = instance.constructor;
	const inflatedData = await Model.inflateValues(data, span, undefined, {
		tx,
	});

	// Double-check inflateValues result (it should return undefined for undefined input)
	if (inflatedData === undefined || inflatedData === null) {
		return instance;
	}

	const fields = Model.fields();
	for (let i = 0; i < fields.length; i++) {
		const { field } = fields[i];
		instance[field] = inflatedData[field];
	}
	reapplyUnsavedSets(instance);

	// Freshen the cache for this ID with these new values
	const { [instance.idField()]: id } = instance;

	const txCache = txInstanceCache(tx);
	if (txCache) {
		// Stamped when the transaction commits (TxInstanceCache.publish).
		txCache.set(Model, id, instance, { written: true });
	} else {
		stampLoadedAt(instance);
		// 'await' so we can allow subclasses to do async work and block if needed
		await Model.setCachedId(id, instance);
	}

	await instance.afterChangeHook({ tx });

	return instance;
};

// The instances whose includeLinked jsonify() is running in this async call
// chain. Scoped to the chain, not stored on the instance: a concurrent,
// unrelated jsonify() of the same instance must not see it.
const jsonifyChain = new AsyncLocalStorage();

/**
 * `{ id, name }`, plus the non-link fields (`excludeLinked`) and/or each link
 * as its own jsonify() (`includeLinked`).
 *
 * A link cycle (a row that links to itself, or a subclass whose jsonify()
 * asks for its links, round a loop of rows) is cut where it closes: an
 * instance already expanding its links in this call chain doesn't expand
 * them again.
 */
const jsonify = async (
	instance,
	{ includeLinked = false, excludeLinked = false } = {},
) => {
	const chain = jsonifyChain.getStore();
	const followLinks = includeLinked && !(chain && chain.has(instance));

	const { id, name } = instance;
	const struct = { id };
	if (name !== undefined) {
		struct.name = name;
	}

	// Process fields based on the flags
	const fields = instance.constructor.fields();

	if (includeLinked || excludeLinked) {
		// Include regular (non-linked) fields only when excludeLinked=true
		if (excludeLinked) {
			for (let i = 0; i < fields.length; i++) {
				const field = fields[i];
				if (!field.linkedModel) {
					const value = instance[field.field];
					if (value !== null && value !== undefined) {
						struct[field.field] = value;
					}
				}
			}
		}

		// Include linked fields only if requested
		if (followLinks) {
			const linkedFields = fields.filter(
				(field) => field.linkedModel && instance[field.field],
			);

			await jsonifyChain.run(new Set(chain).add(instance), () =>
				promisePoolMap(linkedFields, async (field) => {
					const value = instance[field.field];
					struct[field.field] =
						typeof value.jsonify === 'function' ? await value.jsonify() : value;
				}),
			);
		}

		// Don't show isDeleted unless isDeleted for the sake of berevity
		if (!struct.isDeleted) {
			delete struct.isDeleted;
		}
	}

	return struct;
};

module.exports = {
	FROM_INFLATE_SYMBOL,
	inflate,
	inflateValues,
	processObjectSchema,
	deflateValues,
	updateProperties,
	jsonify,
};
