/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-use-before-define */
const config = require('./config');
const { parseIdField } = require('./parseIdField');

const { commonFields, uuidLinkedIds } = config;

const CLIENT_ONLY_FIELD = 'CLIENT_ONLY_FIELD';

const SqlSchemaDefinitionTypes = {
	uuidKey: { type: 'uuidKey', nativeType: String },
	idKey: { type: 'idKey', nativeType: Number },
	// Basic 'varchar' type (use 'text' for longtext)
	string: { type: 'varchar', nativeType: String },
	// Number -> 'integer'
	int: { type: 'integer', nativeType: Number },
	// @alias for integer since often people use integer accidentally
	integer: { type: 'integer', nativeType: Number },
	// Number -> 'double'
	real: { type: 'double', nativeType: Number },
	// @alias for real since people use float sometimes
	float: { type: 'double', nativeType: Number },
	// @alias for real - common JS naming
	number: { type: 'double', nativeType: Number },
	// Large integers - stored as varchar for JS BigInt compatibility
	// JavaScript can't safely handle integers > 2^53-1, so we store as string
	bigint: { type: 'varchar', nativeType: String },
	// UUID field (not primary key) - char(36) for UUID format
	uuid: { type: 'char(36)', nativeType: String },
	// Generic "any" type - stored as longtext JSON, accepts any value
	any: { type: 'longtext', nativeType: Object, isAny: true },
	// longtext (use 'string' for varchar)
	text: { type: 'longtext', nativeType: String },
	// boolean -> 'int(1)'
	bool: { type: 'int(1)', null: 0, default: 0, nativeType: Boolean },
	// @alias for bool
	boolean: { type: 'int(1)', null: 0, default: 0, nativeType: Boolean },
	// 'object' is an ember type in our client that stores JS objects as JSON.
	// server-side we store as longtext
	// object: { type: 'longtext' },
	// object() - Store JSON objects with optional schema for type generation
	// Options:
	//   - expand/schema: Define sub-fields (legacy wrappers) - EXPANDS to SQL columns by default
	//   - Direct schema fields: t.object({ field1: t.string, ... }) - NO expansion (types only)
	//   - noExpand: true/false - Override default expansion behavior
	//
	// Default behavior:
	//   - Direct schema: t.object({ name: t.string }) -> noExpand=true (just types, no SQL columns)
	//   - Legacy wrapper: t.object({ schema: { name: t.string } }) -> noExpand=false (SQL columns)
	//   - Explicit override: t.object({ schema: {...}, noExpand: true }) -> no SQL columns
	object: (options) => {
		return (field, model, expandedModel) => {
			const extension = {};

			// Track whether this is the new direct format or legacy wrapper format
			let isDirectFormat = false;

			// Support three formats:
			// 1. t.object({ expand: {...} }) - legacy expand wrapper -> expands by default
			// 2. t.object({ schema: {...} }) - legacy schema wrapper -> expands by default
			// 3. t.object({ field1: t.string, ... }) - direct schema fields -> NO expansion by default
			// 4. t.object({ schema: {...}, noExpand: true }) - explicit override
			let schemaObj = null;
			if (options) {
				if (options.expand || options.schema) {
					// Legacy wrapped format - expands by default
					schemaObj = options.expand || options.schema;
					isDirectFormat = false;
				} else if (typeof options === 'object') {
					// Check if options contains type definitions directly
					// Type definitions are either functions (t.enum, t.datetime, t.array) or
					// objects with type/linkedModel properties
					// Skip special keys like 'noExpand'
					const optionKeys = Object.keys(options).filter(
						(k) => k !== 'noExpand',
					);
					if (optionKeys.length > 0) {
						const hasTypeFields = optionKeys.some((key) => {
							const v = options[key];
							return (
								v &&
								(typeof v === 'function' ||
									v.type ||
									v.linkedModel ||
									v.nativeType)
							);
						});
						if (hasTypeFields) {
							// Direct format - NO expansion by default (types only)
							isDirectFormat = true;
							schemaObj = {};
							optionKeys.forEach((key) => {
								schemaObj[key] = options[key];
							});
						}
					}
				}
			}

			// Determine noExpand based on format and explicit override
			// - Direct format defaults to noExpand=true (types only, no SQL columns)
			// - Legacy format defaults to noExpand=false (expand to SQL columns)
			// - Explicit noExpand option overrides the default
			const { noExpand: explicitNoExpand } = options || {};
			const noExpand =
				typeof explicitNoExpand === 'boolean'
					? explicitNoExpand // Explicit override
					: isDirectFormat; // Default: true for direct, false for legacy

			// Build schema info for TypeScript/Zod type generation
			// This is used by generate-types.js even if noExpand is true
			const typeSchemaInfo = {};
			if (schemaObj) {
				Object.keys(schemaObj).forEach((key) => {
					const fqField = `${field}_${key}`;
					const type = schemaObj[key];
					typeSchemaInfo[fqField] = Object.assign(
						{},
						expandType(type, fqField, model, expandedModel),
						{
							subfield: key,
							field: fqField,
						},
					);

					// Only add to extension (creating SQL columns) if NOT noExpand
					if (!noExpand) {
						extension[fqField] = typeSchemaInfo[fqField];
					}
				});
			}

			return {
				macroType: true,
				type: {
					type: 'longtext',
					isObject: true,
					// objectSchema is used by generate-types.js for TypeScript/Zod
					// It always contains the full schema info regardless of noExpand
					objectSchema: typeSchemaInfo,
				},
				// extension only contains fields when noExpand is false
				// This controls what SQL columns get created
				extension,
			};
		};
	},
	// @alias for object as array is just stored as a json object anyway
	// But we mark isArray:true so type generators can distinguish arrays from objects
	array: function array(itemType) {
		// For future use, not yet implemented.
		// This makes array(model) work as an alias for linked(model, { array: true })
		// Disabling for now because this would break code that expects t.array() to be an alias for t.object()
		// if (typeof model === 'string') {
		// 	return this.linked(model, { array: true });
		// }

		// using 'function' instead of '=>' to keep the context of 'this'
		// so if someone overrides the types object (e.g. in a project for extensions
		// they can still use this.array() to get the same result)
		//
		// NOT passing in options because sub-schemas would not be properly
		// represent in SQL columns if passed through.
		const objectResult = this.object(/* options */);

		// Determine item type for type generation
		let arrayItemType = 'any';
		let isComplexItemType = false;

		if (itemType) {
			if (itemType === SqlSchemaDefinitionTypes.string) {
				arrayItemType = 'string';
			} else if (
				itemType === SqlSchemaDefinitionTypes.int ||
				itemType === SqlSchemaDefinitionTypes.integer
			) {
				arrayItemType = 'number';
			} else if (
				itemType === SqlSchemaDefinitionTypes.bool ||
				itemType === SqlSchemaDefinitionTypes.boolean
			) {
				arrayItemType = 'boolean';
			} else if (typeof itemType === 'function') {
				// Complex type like t.object({...}) or t.enum([...])
				// Mark for later expansion when we have the field name
				isComplexItemType = true;
				arrayItemType = 'object'; // Will be refined after expansion
			} else if (
				typeof itemType === 'object' &&
				(itemType.type || itemType._type)
			) {
				// Direct type object like t.string (not called as function)
				if (itemType._type === 'enum') {
					arrayItemType = 'enum';
				} else if (
					itemType.type === 'varchar' ||
					itemType.type === 'longtext'
				) {
					arrayItemType = 'string';
				} else if (itemType.type === 'integer' || itemType.type === 'double') {
					arrayItemType = 'number';
				} else if (itemType.type === 'int(1)') {
					arrayItemType = 'boolean';
				}
			}
		}

		// Return a wrapper that marks this as an array and captures the item type
		return (field, model, expandedModel) => {
			const result =
				typeof objectResult === 'function'
					? objectResult(field, model, expandedModel)
					: objectResult;

			// Mark the result type as an array
			if (result.type) {
				result.type.isArray = true;
				result.type.arrayItemType = arrayItemType;

				// For complex item types (like t.object({...})), expand them now
				// to capture the nested schema for type generation
				if (isComplexItemType && typeof itemType === 'function') {
					// Expand the item type function to get its schema
					const itemResult = itemType(`${field}_item`, model, expandedModel);
					if (itemResult) {
						// Handle macroType results (from t.object)
						const itemTypeInfo = itemResult.macroType
							? itemResult.type
							: itemResult;

						if (itemTypeInfo) {
							if (itemTypeInfo.isObject && itemTypeInfo.objectSchema) {
								// Array of objects - capture the schema
								result.type.arrayItemType = 'object';
								result.type.arrayItemSchema = itemTypeInfo.objectSchema;
							} else if (
								itemTypeInfo._type === 'enum' &&
								itemTypeInfo.options
							) {
								// Array of enums
								result.type.arrayItemType = 'enum';
								result.type.arrayItemEnumOptions = itemTypeInfo.options;
							}
						}
					}
				}
			}

			return result;
		};
	},
	linked: (type, { array = false } = {}) => {
		// Better join when ID is int as well
		// uuidLinkedIds is required for id: t.uuidKey to work with t.linked - applies to ALL fields
		// TODO: Look into supporting casting the char(36) for better join performance - TBD what the best approach is
		let dataType = uuidLinkedIds ? 'char(36)' : 'int';

		// This is for future support of t.linked('model', { array: true })
		if (array) {
			dataType = 'longtext';
		}

		// Linked type is not relevant for mysql
		return {
			type: dataType,
			linkedModel: type,
		};
	},
	// @alias for linked, used as a hint for some parsers that want to know the parent model
	// vs just the linked model. Parent implies a single relationship
	// (e.g. Org > User where user.parent('org'), and org.hasMany('user') is a hint on the org model,
	// and user.linked('address') is a legitimate link to the address model,
	// but address is not a parent of the user model)
	// Again, this is just a hint for some parsers that want to know the parent model, not actually
	// relevant to the database or the ORM functionality.
	parent: function parent(type) {
		return this.linked(type);
	},
	// hasMany is simply a hint on the server, not a literal type in the database
	hasMany: (/* type, options */) => {
		return CLIENT_ONLY_FIELD;
	},
	// Enum type - stored as varchar with options array for validation/type generation
	// Usage: t.enum(['option1', 'option2'], { default: 'option1' })
	enum: (options, configOptions = {}) => {
		const {
			default: defaultProp,
			defaultValue = defaultProp || options[0],
			...configRest
		} = configOptions;
		return {
			...configRest,
			defaultValue,
			type: 'varchar',
			nativeType: String,
			options, // array of enum keys
			_type: 'enum',
		};
	},

	// Colors are stored as text
	color: { type: 'varchar', isColor: true },
	// Date is a literal type in mysql, native type though is a String since javascript has no "simple date"
	// MySQL will store/retrieve in YYYY-MM-DD format
	// ref https://dev.mysql.com/doc/refman/8.0/en/datetime.html
	date: (attrOptions) => {
		let opts = {
			type: 'date',
			nativeType: String,
		};
		if (attrOptions && attrOptions.defaultValue) {
			opts.null = 0;
			opts.default = attrOptions.defaultValue;
		}
		return opts;
	},
	// Datetime is a literal type in mysql
	datetime: (attrOptions) => {
		let opts = {
			type: 'datetime',
			nativeType: Date,
		};
		if (attrOptions && attrOptions.defaultValue) {
			opts.null = 0;
			opts.default = attrOptions.defaultValue;
		}
		return opts;
	},
	// Time is a literal type in mysql
	// Time is stored as hhh:mm:ss (can be more than 24 hours)
	// https://dev.mysql.com/doc/refman/8.0/en/time.html
	time: (attrOptions) => {
		let opts = {
			type: 'time',
			nativeType: String,
		};
		if (attrOptions && attrOptions.defaultValue) {
			opts.null = 0;
			opts.default = attrOptions.defaultValue;
		}
		return opts;
	},
};

SqlSchemaDefinitionTypes.object.__typeConverter = true;

const SqlSchemaDefinitionContext = {
	types: SqlSchemaDefinitionTypes,
};

function expandType(value, field, model, jsonModel) {
	if (expandType.__redefinedModel) {
		jsonModel = expandType.__redefinedModel;
	}

	if (!value) {
		throw new Error(`No valid type defined for field '${field}'`);
	}

	// If the user called t.object without args, this would be the case
	if (typeof value === 'function' && value.__typeConverter) value = value();

	// t.object() returns a function, so execute that now to get our values
	if (typeof value === 'function') {
		value = value(field, jsonModel);
	}

	// Apply values from things like t.object to our model
	if (value && value.macroType) {
		let ext = value.extension;
		if (typeof ext === 'function') {
			ext = ext(field);
		}

		if (ext) {
			// jsonModel = expandType.__redefinedModel = Object.assign(jsonModel, ext);
			Object.keys(ext).forEach((extField) => {
				let fieldRow = Object.assign({}, ext[extField], { field: extField });
				expandType.fieldList.push(fieldRow);
			});
		}

		value = value.type;
	}

	return value;
}

function toSchema(definition) {
	// definition is a function that accepts a context to setup the actual model
	if (typeof definition !== 'function')
		throw new Error('definition is not a function');

	const model = definition(SqlSchemaDefinitionContext);
	if (!model.schema) throw new Error('definition.schema does not exist');

	const {
		legacyExternalSchema,
		includeCommonFields,
		indexes,
		table,
		options,
		...passThruProps
	} = model;

	const isDeletedSchema = (context) => {
		return legacyExternalSchema
			? {}
			: {
					isDeleted: context.types.bool,
			  };
	};

	// Add isDeleted regardless of includeCommonFields
	let schema = Object.assign(
		{},
		model.schema,
		isDeletedSchema(SqlSchemaDefinitionContext),
	);

	if (includeCommonFields)
		schema = Object.assign(
			{},
			schema,
			commonFields(SqlSchemaDefinitionContext.types),
		);

	const fields = Object.keys(schema);
	if (!fields.length) throw new Error('definition.schema is empty');

	let jsonModel = {};

	let fieldList = [];
	const fieldMap = {};
	expandType.fieldList = fieldList;
	fields.forEach((field) => {
		const value = expandType(schema[field], field, model, jsonModel);
		if (expandType.__redefinedModel) {
			jsonModel = expandType.__redefinedModel;
			expandType.__redefinedModel = null;
		}
		// jsonModel[field] = value;

		if (value && value !== CLIENT_ONLY_FIELD) {
			let fieldRow = Object.assign({}, value, { field });
			fieldList.push(fieldRow);

			fieldMap[field] = fieldRow;
		}
	});

	jsonModel.options = options || {};
	if (indexes) {
		jsonModel.options.indexes = indexes;
	}

	// Put fieldMap after id assignment so schemas can define id as uuidKey if desired
	const { idField } = parseIdField(table);
	jsonModel.fieldMap = Object.assign(
		{},
		{
			[idField]: Object.assign(
				expandType(
					SqlSchemaDefinitionTypes.idKey,
					idField,
					{ ...model, schema },
					jsonModel,
				),
				{ field: idField },
			),
		},
		fieldMap,
	);

	Object.assign(jsonModel, {
		...passThruProps,
		table,
		legacyExternalSchema,
		fields: fieldList,
	});

	return jsonModel;
}

function convertDefinition(modelDefinition) {
	const schema = toSchema(
		modelDefinition.default ? modelDefinition.default : modelDefinition,
	);
	return schema;
}

module.exports = { convertDefinition };

// const modelDefinition = require(process.argv[2]).default;
// const schema = toSchema(modelDefinition);

// // This JSON will be read by the schema-sync from STDOUT and used to sync mysql with the modelDefinition
// console.log(JSON.stringify(schema));
