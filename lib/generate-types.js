/* eslint-disable no-restricted-syntax */
/* eslint-disable no-await-in-loop */
/**
 * generate-types.js
 *
 * Generates TypeScript type definitions from yass-orm model definitions.
 *
 * This reads schema definitions (e.g., pallas-task.js) and outputs co-located
 * .d.ts files with proper TypeScript types for:
 * - Instance properties (fields from schema)
 * - Static model methods (search, get, create, etc.)
 * - Linked model references
 *
 * Usage:
 *   const { generateTypesForFile } = require('./generate-types');
 *   await generateTypesForFile('/path/to/model-def.js');
 *
 * Or via CLI:
 *   node bin/generate-types /path/to/model-def.js
 */

/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { convertDefinition } = require('./def-to-schema');

// Create a require function that can be used for loading model definitions.
// This is needed because model definitions may use CJS require() even in ESM packages.
const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'));

/**
 * Map yass-orm SQL types to TypeScript types.
 *
 * @param {object} field - Field definition from convertDefinition()
 * @returns {string} TypeScript type string
 */
function mapFieldToTsType(field) {
	const { type, linkedModel, isObject, objectSchema } = field;

	// Linked fields are stored as string IDs
	if (linkedModel) {
		return 'string';
	}

	// Object/JSON fields
	if (isObject) {
		if (objectSchema && Object.keys(objectSchema).length > 0) {
			// Has expanded sub-schema - build nested type
			const subFields = Object.entries(objectSchema)
				.map(([key, subField]) => {
					const subType = mapFieldToTsType(subField);
					// Remove field prefix to get actual key name
					const actualKey = subField.subfield || key;
					return `${actualKey}?: ${subType}`;
				})
				.join(';\n\t\t');
			return `{\n\t\t${subFields};\n\t}`;
		}
		// Generic object
		return 'Record<string, unknown>';
	}

	// Map SQL types to TS types
	switch (type) {
		case 'uuidKey':
		case 'char(36)':
		case 'varchar':
		case 'longtext':
		case 'date': // MySQL date stored as YYYY-MM-DD string
		case 'time': // MySQL time stored as HH:MM:SS string
			return 'string';

		case 'integer':
		case 'double':
			return 'number';

		case 'int(1)': // boolean
			return 'boolean';

		case 'datetime':
			return 'Date | null';

		default:
			// Unknown type - use any with comment
			console.warn(`Unknown type '${type}' for field, using 'unknown'`);
			return 'unknown';
	}
}

/**
 * Convert kebab-case or snake_case to PascalCase.
 *
 * @param {string} str - Input string (e.g., 'pallas-task' or 'pallas_task')
 * @returns {string} PascalCase string (e.g., 'PallasTask')
 */
function toPascalCase(str) {
	return str
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join('');
}

/**
 * Generate TypeScript interface for model instance properties.
 *
 * @param {object} convertedSchema - Schema from convertDefinition()
 * @returns {string} TypeScript interface code
 */
function generateInstanceInterface(convertedSchema) {
	const { fields, table } = convertedSchema;

	// Derive interface name from table name
	const baseName = toPascalCase(table.replace(/s$/, '')); // Remove trailing 's' for singular
	const interfaceName = `${baseName}Instance`;

	// Build field definitions
	const fieldDefs = fields
		.map((field) => {
			const { field: fieldName, linkedModel, options, _type } = field;

			// Skip internal fields
			if (fieldName === 'isDeleted') {
				return `\t/** Soft delete flag */\n\tisDeleted: boolean`;
			}

			// Handle linked fields with comment
			if (linkedModel) {
				// Clean up linked model name (remove path, just get model name)
				const modelName = linkedModel.split('/').pop().replace(/\.js$/, '');
				const linkedPascal = toPascalCase(modelName);
				return `\t/** Linked ${linkedPascal} ID */\n\t${fieldName}: string`;
			}

			// Handle enum types - generate union type
			// Enums are defined with t.enum(['a', 'b']) which sets _type='enum' and options=[...]
			if (
				_type === 'enum' &&
				options &&
				Array.isArray(options) &&
				options.length > 0
			) {
				const unionType = options.map((v) => `'${v}'`).join(' | ');
				return `\t${fieldName}: ${unionType} | null`;
			}

			const tsType = mapFieldToTsType(field);
			return `\t${fieldName}: ${tsType}`;
		})
		.join(';\n');

	return `/**
 * Instance properties for ${table} records.
 * AUTO-GENERATED from schema definition - DO NOT EDIT MANUALLY.
 */
export interface ${interfaceName} {
${fieldDefs};
}`;
}

/**
 * Generate TypeScript type for static model class.
 *
 * @param {object} convertedSchema - Schema from convertDefinition()
 * @returns {string} TypeScript type code
 */
function generateModelType(convertedSchema) {
	const { table } = convertedSchema;

	// Derive type names from table name
	const baseName = toPascalCase(table.replace(/s$/, ''));
	const instanceName = `${baseName}Instance`;
	const modelTypeName = `${baseName}Model`;

	return `/**
 * Static model type for ${table}.
 * Provides typed static methods (search, get, create, etc.)
 */
export type ${modelTypeName} = {
	/** Table name */
	table(): string;

	/** Search for multiple records */
	search(query: Record<string, unknown>): Promise<${instanceName}[]>;

	/** Search for a single record */
	searchOne(query: Record<string, unknown>): Promise<${instanceName} | null>;

	/** Get by ID */
	get(id: string, opts?: { allowCached?: boolean }): Promise<${instanceName} | null>;

	/** Get multiple by IDs */
	getMultiple(ids: string[], opts?: { allowCached?: boolean }): Promise<${instanceName}[]>;

	/** Create a new record */
	create(data: Partial<${instanceName}>): Promise<${instanceName}>;

	/** Find or create a record */
	findOrCreate(
		fields: Partial<${instanceName}>,
		patchIf?: Partial<${instanceName}>,
		patchIfFalsey?: Partial<${instanceName}>,
	): Promise<${instanceName}>;

	/** Execute raw SQL and return typed results */
	fromSql(sql: string, params?: Record<string, unknown>): Promise<${instanceName}[]>;

	/** Execute raw SQL (for COUNT, etc.) or callback with database handle */
	withDbh(sql: string, params?: Record<string, unknown>): Promise<unknown[]>;
	withDbh<T>(callback: (dbh: unknown) => T | Promise<T>): Promise<T>;

	/** Get cached instance by ID */
	getCachedId(id: string, span?: unknown): Promise<${instanceName} | undefined>;

	/** Set cached instance */
	setCachedId(id: string, instance: ${instanceName}): Promise<${instanceName}>;

	/** Inflate raw data to typed instance */
	inflate(data: Record<string, unknown>, span?: unknown): Promise<${instanceName} | null>;
};`;
}

/**
 * Generate the default export type that combines instance and model.
 *
 * @param {object} convertedSchema - Schema from convertDefinition()
 * @returns {string} TypeScript export code
 */
function generateDefaultExport(convertedSchema) {
	const { table } = convertedSchema;
	const baseName = toPascalCase(table.replace(/s$/, ''));
	const modelTypeName = `${baseName}Model`;

	return `/**
 * Default export type - use this when importing the model.
 *
 * @example
 * import ${baseName} from './${path.basename(table.replace(/_/g, '-'))}.js';
 * const task = await ${baseName}.get('123');
 * console.log(task.id); // typed!
 */
declare const _default: ${modelTypeName};
export default _default;`;
}

/**
 * Generate complete .d.ts file content for a model definition.
 *
 * @param {string} definitionPath - Path to model definition .js file
 * @returns {string} Complete TypeScript declaration file content
 */
function generateTypesContent(definitionPath) {
	// Load the definition using require for CJS compatibility
	// (model definitions use CJS require() even in ESM packages)
	const resolvedPath = path.resolve(process.cwd(), definitionPath);
	const definitionModule = requireFromCwd(resolvedPath);
	const definition = definitionModule.default || definitionModule;

	const convertedSchema = convertDefinition(definition);

	// Generate each section
	const instanceInterface = generateInstanceInterface(convertedSchema);
	const modelType = generateModelType(convertedSchema);
	const defaultExport = generateDefaultExport(convertedSchema);

	// Combine into complete file
	const fileName = path.basename(definitionPath);
	const content = `/**
 * TypeScript type definitions for ${fileName}
 *
 * AUTO-GENERATED by yass-orm generate-types - DO NOT EDIT MANUALLY.
 * Re-generate with: npx yass-orm generate-types ${definitionPath}
 */

${instanceInterface}

${modelType}

${defaultExport}
`;

	return content;
}

/**
 * Determine the best output path for the .d.ts file.
 *
 * If the definition is in a `defs/` folder and there's a corresponding
 * model file one level up, output next to the model file so TypeScript
 * picks up the types automatically when importing the model.
 *
 * @param {string} definitionPath - Path to model definition .js file
 * @returns {string} Output path for the .d.ts file
 */
function determineOutputPath(definitionPath) {
	const resolvedPath = path.resolve(definitionPath);
	const dir = path.dirname(resolvedPath);
	const basename = path.basename(resolvedPath, '.js');

	// Check if we're in a defs/ folder
	if (path.basename(dir) === 'defs') {
		const parentDir = path.dirname(dir);
		const modelFilePath = path.join(parentDir, `${basename}.js`);

		// If model file exists one level up, put .d.ts there
		if (fs.existsSync(modelFilePath)) {
			return path.join(parentDir, `${basename}.d.ts`);
		}
	}

	// Default: output next to the definition file
	return resolvedPath.replace(/\.js$/, '.d.ts');
}

/**
 * Generate and write .d.ts file for a model definition.
 *
 * Smart output path detection:
 * - If def is in `defs/` folder and model exists one level up, outputs there
 * - Otherwise outputs next to the definition file
 *
 * @param {string} definitionPath - Path to model definition .js file
 * @param {object} options - Options
 * @param {boolean} options.dryRun - If true, only log what would be written
 * @param {boolean} options.verbose - If true, log more details
 * @returns {Promise<{path: string, content: string}>} Result with path and content
 */
async function generateTypesForFile(definitionPath, options = {}) {
	const { dryRun = false, verbose = false } = options;

	try {
		// Generate content
		const content = generateTypesContent(definitionPath);

		// Determine output path (smart: next to model if in defs/, else next to def)
		const outputPath = determineOutputPath(definitionPath);

		if (dryRun) {
			console.log(`[dry-run] Would write: ${outputPath}`);
			if (verbose) {
				console.log(content);
			}
		} else {
			fs.writeFileSync(outputPath, content, 'utf8');
			console.log(`Generated: ${outputPath}`);
		}

		return { path: outputPath, content };
	} catch (error) {
		console.error(`Failed to generate types for ${definitionPath}:`, error);
		throw error;
	}
}

/**
 * Generate types for multiple definition files.
 *
 * @param {string[]} definitionPaths - Array of paths to definition files
 * @param {object} options - Options passed to generateTypesForFile
 * @returns {Promise<Array<{path: string, content: string}>>} Results
 */
async function generateTypesForFiles(definitionPaths, options = {}) {
	const results = [];

	for (const defPath of definitionPaths) {
		try {
			const result = await generateTypesForFile(defPath, options);
			results.push(result);
		} catch (error) {
			// Log but continue with other files
			console.error(`Skipping ${defPath} due to error:`, error.message);
		}
	}

	return results;
}

module.exports = {
	generateTypesForFile,
	generateTypesForFiles,
	generateTypesContent,
	mapFieldToTsType,
	toPascalCase,
};
