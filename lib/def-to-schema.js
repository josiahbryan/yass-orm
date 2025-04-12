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
	// longtext (use 'string' for varchar)
	text: { type: 'longtext', nativeType: String },
	// boolean -> 'int(1)'
	bool: { type: 'int(1)', null: 0, default: 0, nativeType: Boolean },
	// @alias for bool
	boolean: { type: 'int(1)', null: 0, default: 0, nativeType: Boolean },
	// 'object' is an ember type in our client that stores JS objects as JSON.
	// server-side we store as longtext
	// object: { type: 'longtext' },
	object: (options) => {
		return (field, model, expandedModel) => {
			const extension = {};
			if (options && (options.expand || options.schema)) {
				const x = options.expand || options.schema;
				Object.keys(x).forEach((key) => {
					const fqField = `${field}_${key}`;
					const type = x[key];
					extension[fqField] = Object.assign(
						{},
						expandType(type, fqField, model, expandedModel),
						{
							subfield: key,
							field: fqField,
						},
					);
				});
			}

			return {
				macroType: true,
				type: {
					type: 'longtext',
					isObject: true,
					objectSchema: extension,
				},
				extension,
			};
		};
	},
	// @alias for object as array is just stored as a json object anyway
	array: function array(/* model, options */) {
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
		return this.object(/* options */);
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
