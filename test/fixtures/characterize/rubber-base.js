/**
 * Fixture for test/obj.characterize.rubber-subclass.test.js: a CommonJS model of
 * Rubber's `backend/src/db/models/_shared-base.js` `createBaseClass()`, cut
 * down to the parts that meet yass: the overrides of `get`,
 * `getCachedId(id, span)`, `setCachedId`, `removeCachedId`,
 * `afterChangeHook(txOptions)`, `afterCreateHook(txOptions)`,
 * `patch(data, options)`, `findOrCreate` and `jsonify`. Their bodies follow
 * Rubber's (a TTL cache becomes a Map, the async zone an AsyncLocalStorage,
 * broadcasts a log entry).
 *
 * Each override records a call in `calls`, so a test can see the order yass
 * calls them in and that it reached them through `this`. `inflate`, `create`
 * and `searchOne` are logged too; Rubber does not override those (they are
 * spies only, passing straight through).
 */
const { AsyncLocalStorage } = require('async_hooks');
const YassORM = require('../../../lib');

const calls = [];
const zone = new AsyncLocalStorage();

/** Runs `fn` as Rubber's apiRouteAdapters do: with a user in the async zone. */
const runAs = (user, fn) => zone.run({ user }, fn);

const record = (Model, method, ...details) =>
	calls.push([Model.name, method, ...details]);

const spanName = (span) => (span ? span.name : undefined);

const createBaseClass = (definition) => {
	const instanceCache = new Map();

	const DynamicBase = class extends YassORM.loadDefinition(definition) {
		static async get(id, ...args) {
			record(this, 'get', id);
			return super.get(id, ...args);
		}

		async jsonify() {
			return super.jsonify({ excludeLinked: true });
		}

		static getInstanceCacheKey(id) {
			return `${this.name}:${id}`;
		}

		static async getCachedId(id, span) {
			record(this, 'getCachedId', id, spanName(span));
			return instanceCache.get(this.getInstanceCacheKey(id));
		}

		static async setCachedId(id, instance) {
			record(this, 'setCachedId', id);
			const cachedInstance = instanceCache.get(this.getInstanceCacheKey(id));
			if (cachedInstance) {
				this.fields().forEach(({ field }) => {
					cachedInstance[field] = instance[field];
				});
			} else {
				instanceCache.set(this.getInstanceCacheKey(id), instance);
			}
			// Rubber returns the instance it was given, not the cached one.
			return instance;
		}

		static removeCachedId(id) {
			record(this, 'removeCachedId', id);
			return instanceCache.delete(this.getInstanceCacheKey(id));
		}

		static removeEntireCache() {
			instanceCache.clear();
		}

		async afterChangeHook(txOptions) {
			await super.afterChangeHook(txOptions);
			record(this.constructor, 'afterChangeHook', txOptions);
		}

		async afterCreateHook(txOptions) {
			await super.afterCreateHook(txOptions);
			record(this.constructor, 'afterCreateHook', txOptions);

			const { user: zoneUser } = zone.getStore() || {};
			const { fieldMap } = this.constructor.schema();
			const patch = {};
			if (zoneUser && !this.createdBy && fieldMap.createdBy) {
				patch.createdBy = zoneUser;
			}
			Object.entries(fieldMap).forEach(([fieldName, field]) => {
				if (field._type !== 'enum') return;
				const { default: defaultProp, defaultValue = defaultProp } = field;
				if (
					this[fieldName] === undefined &&
					![null, undefined, false].includes(defaultValue)
				) {
					patch[fieldName] = defaultValue;
				}
			});
			if (Object.keys(patch).length > 0) {
				return this.patch(patch, txOptions);
			}
			return this;
		}

		async patch(data, options) {
			record(this.constructor, 'patch', Object.keys(data || {}), options);
			const { user: zoneUser } = zone.getStore() || {};
			const { fieldMap } = this.constructor.schema();
			const patch = {
				...data,
				...this.constructor.applyEnumDefaults(
					{ ...this, ...data },
					Object.keys(data || {}),
				),
			};
			if (!!zoneUser && !(data && data.updatedBy) && fieldMap.updatedBy) {
				patch.updatedBy = zoneUser;
			}
			return super.patch(patch, options);
		}

		static async findOrCreate(
			fields,
			patchIf = {},
			patchIfFalsey = {},
			...extraArgs
		) {
			record(this, 'findOrCreate', fields);
			const { fieldMap } = this.schema();
			const hasCreatedBy = fieldMap.createdBy;
			const hasUpdatedBy = fieldMap.updatedBy;
			if (!hasCreatedBy && !hasUpdatedBy) {
				return super.findOrCreate(fields, patchIf, patchIfFalsey, ...extraArgs);
			}

			const { user: zoneUser } = zone.getStore() || {};
			const { tx } = extraArgs[0] || {};

			const vettedFields = {};
			Object.entries(fields).forEach(([key, value]) => {
				if (fieldMap[key] && value !== undefined) {
					vettedFields[key] = value;
				}
			});

			const existingObject = await this.searchOne(vettedFields, undefined, {
				tx,
			});
			if (existingObject) {
				const patch = {};
				Object.keys(patchIf || {}).forEach((valueKey) => {
					if (
						JSON.stringify(existingObject[valueKey]) !==
						JSON.stringify(patchIf[valueKey])
					) {
						patch[valueKey] = patchIf[valueKey];
					}
				});
				Object.keys(patchIfFalsey || {}).forEach((valueKey) => {
					if (!existingObject[valueKey]) {
						patch[valueKey] = patchIfFalsey[valueKey];
					}
				});
				Object.assign(
					patch,
					this.applyEnumDefaults(
						{ ...existingObject, ...patch },
						Object.keys(patch),
					),
				);
				if (Object.keys(patch).length > 0) {
					if (!patch.updatedBy && hasUpdatedBy) {
						patch.updatedBy = zoneUser;
					}
					await existingObject.patch(patch, { tx });
				}
				return existingObject;
			}

			const patch = { ...fields, ...patchIf, ...patchIfFalsey };
			if (!patch.createdBy && hasCreatedBy) {
				patch.createdBy = zoneUser;
			}
			if (!patch.updatedBy && hasUpdatedBy) {
				patch.updatedBy = zoneUser;
			}
			Object.assign(patch, this.applyEnumDefaults(patch));
			return this.create(patch, { tx });
		}

		static applyEnumDefaults(existingData, restrictToFields) {
			const { fieldMap } = this.schema();
			const allowedFields = restrictToFields ? new Set(restrictToFields) : null;
			const patch = {};
			const FALSE_SET = [null, undefined, false, 0, ''];
			Object.entries(fieldMap).forEach(([fieldName, field]) => {
				if (field._type !== 'enum') return;
				if (allowedFields && !allowedFields.has(fieldName)) return;
				const { default: defaultProp, defaultValue = defaultProp } = field;
				if (
					FALSE_SET.includes(existingData[fieldName]) &&
					!FALSE_SET.includes(defaultValue)
				) {
					patch[fieldName] = defaultValue;
				}
			});
			return patch;
		}

		// Spies (Rubber does not override these).
		static async inflate(data, span, ...rest) {
			record(this, 'inflate', data ? data[this.idField()] : data);
			return super.inflate(data, span, ...rest);
		}

		static async create(data, options) {
			record(this, 'create', options);
			return super.create(data, options);
		}

		static async searchOne(fields, options, txOptions) {
			record(this, 'searchOne', fields, txOptions);
			return super.searchOne(fields, options, txOptions);
		}
	};

	return DynamicBase;
};

module.exports = { createBaseClass, calls, runAs };
