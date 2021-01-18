/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-use-before-define */
const config = require('./config');

const { commonFields, uuidLinkedIds } = config;

const CLIENT_ONLY_FIELD = 'CLIENT_ONLY_FIELD';

const SqlSchemaDefinitionTypes = {
	uuidKey: { type: 'uuidKey', nativeType: String },
	idKey: { type: 'idKey', nativeType: Number },
	string: { type: 'varchar', nativeType: String },
	int: { type: 'integer', nativeType: Number },
	real: { type: 'double', nativeType: Number },
	text: { type: 'longtext', nativeType: String },
	bool: { type: 'int(1)', null: 0, default: 0, nativeType: Boolean },
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
	linked: (type) => {
		// Linked type is not relevant for mysql
		return {
			// Better join when ID is int as well
			// uuidLinkedIds is required for id: t.uuidKey to work with t.linked - applies to ALL fields
			type: uuidLinkedIds ? 'char(36)' : 'int',
			linkedModel: type,
		};
	},
	// hasMany is simply a hint on the server, not a literal type in the database
	hasMany: (/* type, options */) => {
		return CLIENT_ONLY_FIELD;
	},
	// Colors are stored as text
	color: { type: 'varchar', isColor: true },
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
	time: (attrOptions) => {
		let opts = {
			type: 'time',
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
	if (expandType.__redefinedModel) jsonModel = expandType.__redefinedModel;

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

const parseIdField = (table) => {
	if (table.indexOf('.') > 0) {
		const parts = table.split('.');
		return { table: parts[0], idField: parts[1] };
	}
	return { table, idField: 'id' };
};

function toSchema(definition) {
	// definition is a function that accepts a context to setup the actual model
	if (typeof definition !== 'function')
		throw new Error('definition is not a function');

	const model = definition(SqlSchemaDefinitionContext);
	if (!model.schema) throw new Error('definition.schema does not exist');

	const isDeletedSchema = (context) => {
		return model.legacyExternalSchema
			? {}
			: {
					isDeleted: context.types.bool,
			  };
	};

	// Add isDeleted regardless of model.includeCommonFields
	model.schema = Object.assign(
		{},
		model.schema,
		isDeletedSchema(SqlSchemaDefinitionContext),
	);

	if (model.includeCommonFields)
		model.schema = Object.assign(
			{},
			model.schema,
			commonFields(SqlSchemaDefinitionContext.types),
		);

	const fields = Object.keys(model.schema);
	if (!fields.length) throw new Error('definition.schema is empty');

	let jsonModel = {};
	let fieldList = [];
	const fieldMap = {};
	expandType.fieldList = fieldList;
	fields.forEach((field) => {
		const value = expandType(model.schema[field], field, model, jsonModel);
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

	jsonModel.options = {};
	if (model.indexes) {
		jsonModel.options.indexes = model.indexes;
	}

	// Put fieldMap after id assignment so schemas can define id as uuidKey if desired
	const { idField } = parseIdField(model.table);
	jsonModel.fieldMap = Object.assign(
		{},
		{
			[idField]: Object.assign(
				expandType(SqlSchemaDefinitionTypes.idKey, idField, model, jsonModel),
				{ field: idField },
			),
		},
		fieldMap,
	);

	jsonModel.fields = fieldList;
	jsonModel.table = model.table;
	jsonModel.legacyExternalSchema = model.legacyExternalSchema;
	jsonModel.stringifyAs = model.stringifyAs;

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
