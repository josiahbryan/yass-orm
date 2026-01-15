/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-use-before-define */
const config = require('./config');
const { parseIdField } = require('./parseIdField');

const { commonFields, uuidLinkedIds } = config;

const CLIENT_ONLY_FIELD = 'CLIENT_ONLY_FIELD';

/**
 * Creates a chainable type that supports fluent API pattern like Zod/Yup.
 * The returned object is callable (for backward compat with t.datetime())
 * and has chainable methods for adding metadata.
 *
 * @param {object} baseType - The base type definition (type, nativeType, etc.)
 * @param {function|null} optionsHandler - Optional handler for when called with options
 * @returns {function} A callable chainable type
 */
/**
 * Helper to extract current type data from a chainable (strips methods and markers)
 * @param {object} obj - Chainable type object
 * @returns {object} Plain object with only data properties
 */
function getChainableTypeData(obj) {
	const data = {};
	for (const key of Object.keys(obj)) {
		if (
			typeof obj[key] !== 'function' &&
			key !== '__isChainableType' &&
			key !== '__optionsHandler'
		) {
			data[key] = obj[key];
		}
	}
	return data;
}

function createChainableType(baseType, optionsHandler = null) {
	// Create a callable function that handles backward compat
	// t.datetime() should work the same as t.datetime
	const chainable = function chainableType(options) {
		// If called with no options or undefined/null, return self (backward compat)
		if (options === undefined || options === null) {
			return chainable;
		}
		// If there's a custom options handler (for datetime, date, time, etc.), use it
		if (optionsHandler) {
			return optionsHandler(options);
		}
		// Otherwise merge options into the type
		const currentData = getChainableTypeData(chainable);
		return createChainableType({ ...currentData, ...options }, optionsHandler);
	};

	// Copy all base type properties onto the function FIRST
	// This ensures data values are preserved
	Object.assign(chainable, baseType);

	// Mark this as a chainable type for expandType() to recognize
	chainable.__isChainableType = true;

	// Store the options handler for use in methods
	chainable.__optionsHandler = optionsHandler;

	// ============================================
	// Universal chainable methods (all types)
	// Methods read the current state from the chainable itself, not a closure
	// ============================================

	/**
	 * Add a description for documentation (JSDoc, Zod .describe(), MySQL COMMENT)
	 * @param {string} desc - Description text
	 */
	chainable.description = function setDescription(desc) {
		const currentData = getChainableTypeData(this);
		return createChainableType(
			{ ...currentData, _description: desc },
			this.__optionsHandler,
		);
	};

	/**
	 * Set a default value for the field
	 * @param {*} value - Default value
	 * Only add the method if 'default' isn't already a data value
	 */
	if (
		!Object.prototype.hasOwnProperty.call(baseType, 'default') ||
		typeof baseType.default === 'function'
	) {
		chainable.default = function setDefaultValue(value) {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, default: value, null: 0 },
				this.__optionsHandler,
			);
		};
	}

	/**
	 * Add an example value for documentation
	 * @param {*} value - Example value
	 */
	chainable.example = function setExample(value) {
		const currentData = getChainableTypeData(this);
		return createChainableType(
			{ ...currentData, _example: value },
			this.__optionsHandler,
		);
	};

	/**
	 * Mark the field as nullable
	 */
	chainable.nullable = function setNullable() {
		const currentData = getChainableTypeData(this);
		return createChainableType(
			{ ...currentData, null: 1 },
			this.__optionsHandler,
		);
	};

	// ============================================
	// Type-specific chainable methods
	// ============================================

	// String methods (varchar, longtext, char types)
	const isStringType =
		baseType.type === 'varchar' ||
		baseType.type === 'longtext' ||
		(baseType.type && baseType.type.startsWith('char'));

	if (isStringType) {
		/**
		 * Set minimum length for string validation
		 * @param {number} n - Minimum length
		 */
		chainable.minLength = function setMinLength(n) {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _minLength: n },
				this.__optionsHandler,
			);
		};

		/**
		 * Set maximum length for string validation
		 * @param {number} n - Maximum length
		 */
		chainable.maxLength = function setMaxLength(n) {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _maxLength: n },
				this.__optionsHandler,
			);
		};

		/**
		 * Set a regex pattern for string validation
		 * @param {RegExp|string} pattern - Regex pattern
		 */
		chainable.pattern = function setPattern(pattern) {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _pattern: pattern },
				this.__optionsHandler,
			);
		};

		/**
		 * Mark as email format
		 */
		chainable.email = function setEmailFormat() {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _format: 'email' },
				this.__optionsHandler,
			);
		};

		/**
		 * Mark as URL format
		 */
		chainable.url = function setUrlFormat() {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _format: 'url' },
				this.__optionsHandler,
			);
		};
	}

	// Number methods (integer, double types)
	const isNumberType =
		baseType.type === 'integer' || baseType.type === 'double';

	if (isNumberType) {
		/**
		 * Set minimum value for number validation
		 * @param {number} n - Minimum value
		 */
		chainable.min = function setMin(n) {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _min: n },
				this.__optionsHandler,
			);
		};

		/**
		 * Set maximum value for number validation
		 * @param {number} n - Maximum value
		 */
		chainable.max = function setMax(n) {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _max: n },
				this.__optionsHandler,
			);
		};

		/**
		 * Mark as positive (> 0)
		 */
		chainable.positive = function setPositive() {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _positive: true },
				this.__optionsHandler,
			);
		};

		/**
		 * Mark as negative (< 0)
		 */
		chainable.negative = function setNegative() {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _negative: true },
				this.__optionsHandler,
			);
		};

		/**
		 * Mark as non-negative (>= 0)
		 */
		chainable.nonnegative = function setNonnegative() {
			const currentData = getChainableTypeData(this);
			return createChainableType(
				{ ...currentData, _nonnegative: true },
				this.__optionsHandler,
			);
		};
	}

	return chainable;
}

/**
 * Strips chainable method properties from a type object, returning only the data fields.
 * Used by expandType() to clean up before passing to downstream consumers.
 *
 * @param {object} typeObj - The type object (possibly with chainable methods)
 * @returns {object} Clean type object with only data properties
 */
// Known chainable method names that should be stripped from type objects
// Note: 'default' is special - it can be both a method and a data property,
// so we check if the value is actually a chainable method function
const CHAINABLE_METHOD_NAMES = new Set([
	'description',
	'example',
	'nullable',
	'minLength',
	'maxLength',
	'pattern',
	'email',
	'url',
	'min',
	'max',
	'positive',
	'negative',
	'nonnegative',
	'minItems',
	'maxItems',
]);

/**
 * Check if a value is a chainable method (our method, not a native constructor)
 * @param {*} value - The value to check
 * @param {string} key - The property name
 * @returns {boolean} True if this is a chainable method to skip
 */
function isChainableMethod(value, key) {
	if (typeof value !== 'function') {
		return false;
	}

	// Known method names are always methods
	if (CHAINABLE_METHOD_NAMES.has(key)) {
		return true;
	}

	// 'default' is special - check if it's a method vs a native constructor
	if (key === 'default') {
		// Check if it's a native constructor by reference
		const nativeConstructors = [
			String,
			Number,
			Boolean,
			Date,
			Object,
			Array,
			Function,
		];
		if (nativeConstructors.includes(value)) {
			return false;
		}
		// Our method is named 'setDefaultValue' or is anonymous
		if (
			!value.name ||
			value.name === '' ||
			value.name === 'anonymous' ||
			value.name === 'setDefaultValue'
		) {
			return true;
		}
	}

	return false;
}

function stripChainableMethods(typeObj) {
	if (!typeObj) {
		return typeObj;
	}

	// If it's a chainable type (function with __isChainableType), extract just the data properties
	if (typeObj.__isChainableType || typeof typeObj === 'function') {
		const result = {};
		Object.keys(typeObj).forEach((key) => {
			// Skip internal markers
			if (key === '__isChainableType' || key === '__optionsHandler') {
				return;
			}
			// Skip chainable methods
			if (isChainableMethod(typeObj[key], key)) {
				return;
			}
			result[key] = typeObj[key];
		});
		return result;
	}

	// For regular objects, return as-is
	if (typeof typeObj !== 'object') {
		return typeObj;
	}

	return typeObj;
}

/**
 * Wraps a macro type function (like t.object() or t.array() result) with chainable methods.
 * The chainable metadata is stored on the wrapper and merged into the result when expanded.
 *
 * @param {function} macroFn - The macro function to wrap
 * @param {object} metadata - Initial metadata (e.g., _description)
 * @returns {function} Wrapped function with chainable methods
 */
function createChainableMacro(macroFn, metadata = {}) {
	// Create a wrapper function that calls the original and merges metadata
	const wrapper = function chainableMacroWrapper(field, model, expandedModel) {
		const result = macroFn(field, model, expandedModel);
		// Merge metadata into the type object
		if (result && result.type) {
			Object.assign(result.type, metadata);
		}
		return result;
	};

	// Mark as macro type converter for expandType()
	wrapper.__typeConverter = macroFn.__typeConverter;
	wrapper.__isChainableMacro = true;

	// Add chainable methods (universal)
	wrapper.description = (desc) =>
		createChainableMacro(macroFn, { ...metadata, _description: desc });

	wrapper.default = (value) =>
		createChainableMacro(macroFn, { ...metadata, default: value });

	wrapper.example = (value) =>
		createChainableMacro(macroFn, { ...metadata, _example: value });

	wrapper.nullable = () =>
		createChainableMacro(macroFn, { ...metadata, null: 1 });

	// Array-specific methods
	wrapper.minItems = (n) =>
		createChainableMacro(macroFn, { ...metadata, _minItems: n });

	wrapper.maxItems = (n) =>
		createChainableMacro(macroFn, { ...metadata, _maxItems: n });

	// Aliases for Zod compatibility (.min() and .max() for arrays)
	wrapper.min = wrapper.minItems;
	wrapper.max = wrapper.maxItems;

	return wrapper;
}

const SqlSchemaDefinitionTypes = {
	// Primary key types
	uuidKey: createChainableType({ type: 'uuidKey', nativeType: String }),
	idKey: createChainableType({ type: 'idKey', nativeType: Number }),

	// Basic 'varchar' type (use 'text' for longtext)
	string: createChainableType({ type: 'varchar', nativeType: String }),

	// Number -> 'integer'
	int: createChainableType({ type: 'integer', nativeType: Number }),
	// @alias for integer since often people use integer accidentally
	integer: createChainableType({ type: 'integer', nativeType: Number }),

	// Number -> 'double'
	real: createChainableType({ type: 'double', nativeType: Number }),
	// @alias for real since people use float sometimes
	float: createChainableType({ type: 'double', nativeType: Number }),
	// @alias for real - common JS naming
	number: createChainableType({ type: 'double', nativeType: Number }),

	// Large integers - stored as varchar for JS BigInt compatibility
	// JavaScript can't safely handle integers > 2^53-1, so we store as string
	bigint: createChainableType({ type: 'varchar', nativeType: String }),

	// UUID field (not primary key) - char(36) for UUID format
	uuid: createChainableType({ type: 'char(36)', nativeType: String }),

	// Generic "any" type - stored as longtext JSON, accepts any value
	any: createChainableType({
		type: 'longtext',
		nativeType: Object,
		isAny: true,
	}),

	// longtext (use 'string' for varchar)
	text: createChainableType({ type: 'longtext', nativeType: String }),

	// boolean -> 'int(1)'
	bool: createChainableType({
		type: 'int(1)',
		null: 0,
		default: 0,
		nativeType: Boolean,
	}),
	// @alias for bool
	boolean: createChainableType({
		type: 'int(1)',
		null: 0,
		default: 0,
		nativeType: Boolean,
	}),
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
	//
	// Returns a chainable macro: t.object({...}).description('...')
	object: (options) => {
		const macroFn = (field, model, expandedModel) => {
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
									v.nativeType ||
									(typeof v === 'function' && v.__isChainableType))
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
					// noExpand controls whether subfields are written to separate DB columns
					// When true: only store as JSON in the main column
					// When false: also store subfields in individual columns (for indexing)
					noExpand,
				},
				// extension only contains fields when noExpand is false
				// This controls what SQL columns get created
				extension,
			};
		};

		// Return a chainable macro
		return createChainableMacro(macroFn);
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
			// Helper to check the type property of an item (handles chainable types)
			const getItemTypeProperty = (item) => {
				if (typeof item === 'function' && item.__isChainableType) {
					return item.type;
				}
				if (typeof item === 'object' && item) {
					return item.type;
				}
				return null;
			};

			const itemTypeValue = getItemTypeProperty(itemType);

			// Check if it's a string type (varchar or longtext)
			if (itemTypeValue === 'varchar' || itemTypeValue === 'longtext') {
				arrayItemType = 'string';
			} else if (itemTypeValue === 'integer' || itemTypeValue === 'double') {
				arrayItemType = 'number';
			} else if (itemTypeValue === 'int(1)') {
				arrayItemType = 'boolean';
			} else if (
				typeof itemType === 'function' &&
				!itemType.__isChainableType
			) {
				// Complex type like t.object({...}) or t.enum([...]) (not a simple chainable)
				// Mark for later expansion when we have the field name
				isComplexItemType = true;
				arrayItemType = 'object'; // Will be refined after expansion
			} else if (
				typeof itemType === 'object' &&
				(itemType.type || itemType._type)
			) {
				// Direct type object
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
			} else if (
				typeof itemType === 'function' &&
				itemType.__isChainableType &&
				itemType._type === 'enum'
			) {
				// Chainable enum type
				arrayItemType = 'enum';
			}
		}

		// Create a macro function that marks this as an array and captures the item type
		const macroFn = (field, model, expandedModel) => {
			// Handle chainable macro results from objectResult
			let result;
			if (typeof objectResult === 'function') {
				// If it's a chainable macro, call the underlying function
				if (objectResult.__isChainableMacro) {
					result = objectResult(field, model, expandedModel);
				} else {
					result = objectResult(field, model, expandedModel);
				}
			} else {
				result = objectResult;
			}

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

		// Return a chainable macro
		return createChainableMacro(macroFn);
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
		// Return chainable so users can do: t.linked('user').description('...')
		return createChainableType({
			type: dataType,
			linkedModel: type,
		});
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
	// Returns a chainable type: t.enum(['a', 'b']).description('...')
	enum: (options, configOptions = {}) => {
		const {
			default: defaultProp,
			defaultValue = defaultProp || options[0],
			...configRest
		} = configOptions;
		const baseType = {
			...configRest,
			defaultValue,
			type: 'varchar',
			nativeType: String,
			options, // array of enum keys
			_type: 'enum',
		};
		return createChainableType(baseType);
	},

	// Colors are stored as text
	color: createChainableType({
		type: 'varchar',
		isColor: true,
		nativeType: String,
	}),

	// Date is a literal type in mysql, native type though is a String since javascript has no "simple date"
	// MySQL will store/retrieve in YYYY-MM-DD format
	// ref https://dev.mysql.com/doc/refman/8.0/en/datetime.html
	// Supports both t.date and t.date({ defaultValue: ... })
	date: createChainableType(
		{ type: 'date', nativeType: String },
		// Options handler for backward compat: t.date({ defaultValue: '...' })
		(attrOptions) => {
			const baseType = {
				type: 'date',
				nativeType: String,
			};
			if (attrOptions && attrOptions.defaultValue) {
				baseType.null = 0;
				baseType.default = attrOptions.defaultValue;
			}
			return createChainableType(baseType);
		},
	),

	// Datetime is a literal type in mysql
	// Supports both t.datetime and t.datetime({ defaultValue: ... })
	datetime: createChainableType(
		{ type: 'datetime', nativeType: Date },
		// Options handler for backward compat: t.datetime({ defaultValue: '...' })
		(attrOptions) => {
			const baseType = {
				type: 'datetime',
				nativeType: Date,
			};
			if (attrOptions && attrOptions.defaultValue) {
				baseType.null = 0;
				baseType.default = attrOptions.defaultValue;
			}
			return createChainableType(baseType);
		},
	),

	// Time is a literal type in mysql
	// Time is stored as hhh:mm:ss (can be more than 24 hours)
	// https://dev.mysql.com/doc/refman/8.0/en/time.html
	// Supports both t.time and t.time({ defaultValue: ... })
	time: createChainableType(
		{ type: 'time', nativeType: String },
		// Options handler for backward compat: t.time({ defaultValue: '...' })
		(attrOptions) => {
			const baseType = {
				type: 'time',
				nativeType: String,
			};
			if (attrOptions && attrOptions.defaultValue) {
				baseType.null = 0;
				baseType.default = attrOptions.defaultValue;
			}
			return createChainableType(baseType);
		},
	),
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

	// Handle chainable types - these are functions with type properties
	// They can be used directly (t.string) or called (t.datetime())
	// When used directly, we extract the type properties from the function object
	if (typeof value === 'function' && value.__isChainableType) {
		// Extract data properties from the chainable, stripping methods
		value = stripChainableMethods(value);
	}

	// If the user called t.object without args, this would be the case
	if (typeof value === 'function' && value.__typeConverter) value = value();

	// t.object() returns a function, so execute that now to get our values
	if (typeof value === 'function') {
		value = value(field, jsonModel);
	}

	// After function execution, check again for chainable types
	// (in case the function returned a chainable)
	if (typeof value === 'function' && value.__isChainableType) {
		value = stripChainableMethods(value);
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

	// Final strip of chainable methods in case we got here via a different path
	value = stripChainableMethods(value);

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
