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
 * Extract model class name from a linked model path.
 * Handles both full paths (/path/to/pallas-group.ts) and simple names (pallas-group).
 *
 * @param {string} linkedModel - The linkedModel value (could be path or name)
 * @returns {string} PascalCase class name (e.g., 'PallasGroup')
 */
function getLinkedModelClassName(linkedModel) {
	// Extract basename without extension
	const basename = path.basename(linkedModel).replace(/\.(js|ts|cjs|mjs)$/, '');
	return toPascalCase(basename);
}

/**
 * Map yass-orm SQL types to TypeScript types.
 *
 * @param {object} field - Field definition from convertDefinition()
 * @param {Map} linkedModelImports - Map to collect linked model imports (mutated)
 * @param {string} outputDir - Directory where the .d.ts will be output
 * @returns {string} TypeScript type string
 */
function mapFieldToTsType(field, linkedModelImports = null, outputDir = null) {
	const { type, linkedModel, isObject, isArray, arrayItemType, objectSchema } =
		field;

	// Linked fields are inflated to model instances at runtime.
	// Use the actual model class type.
	if (linkedModel) {
		const className = getLinkedModelClassName(linkedModel);

		// Track this import if we have the imports map
		if (linkedModelImports && outputDir) {
			// Calculate relative import path from output dir to linked model
			// linkedModel is the full resolved path (e.g., /path/to/models/pallas-group.ts)
			const linkedModelDir = path.dirname(linkedModel);
			const linkedModelBase = path
				.basename(linkedModel)
				.replace(/\.(js|ts|cjs|mjs)$/, '');

			// Get relative path from output directory to linked model directory
			let relativePath = path.relative(outputDir, linkedModelDir);
			if (!relativePath.startsWith('.')) {
				relativePath = `./${relativePath}`;
			}

			const importPath = path.join(relativePath, linkedModelBase);
			linkedModelImports.set(linkedModel, { className, importPath });
		}

		return className;
	}

	// Array fields (t.array(t.string), etc.)
	if (isArray) {
		const itemType = arrayItemType || 'any';
		return `${itemType}[]`;
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

// Supported model file extensions, in order of preference (same as yass-orm)
const MODEL_EXTENSIONS = ['.js', '.ts', '.cjs', '.mjs'];

/**
 * Try to find a model file with the given base path (tries all extensions).
 * @param {string} resolvedBase - Base path without extension
 * @returns {string|null} - Found file path or null
 */
function tryFindModelWithExtensions(resolvedBase) {
	// Check if it already has a known extension
	const hasKnownExtension = MODEL_EXTENSIONS.some((ext) =>
		resolvedBase.endsWith(ext),
	);

	if (hasKnownExtension) {
		if (fs.existsSync(resolvedBase)) {
			return resolvedBase;
		}
		return null;
	}

	// Try each extension in order of preference
	for (const ext of MODEL_EXTENSIONS) {
		const pathWithExt = `${resolvedBase}${ext}`;
		if (fs.existsSync(pathWithExt)) {
			return pathWithExt;
		}
	}

	return null;
}

/**
 * Resolve a bare module name to an actual file path.
 * Uses the same logic as yass-orm's _resolveModelClass, with additional
 * handling for the defs/ -> models/ directory pattern used in Rubber.
 *
 * For bare module names (no path separators), we need to find the MODEL file,
 * not the definition file. So we prioritize searching in models/ directory.
 *
 * Two patterns are supported:
 * 1. Standard pattern: defs/ is a child of models/ (e.g., models/defs/)
 *    - Models are in the PARENT directory (models/)
 * 2. Sibling pattern: defs/ is a sibling of models/ (e.g., db/defs/ and db/models/)
 *    - Models are in the sibling models/ directory
 *
 * @param {string} modelName - Bare module name (e.g., 'account')
 * @param {string} basePath - Directory to resolve relative to (typically defs/)
 * @returns {string|null} - Resolved file path or null if not found
 */
function resolveLinkedModelPath(modelName, basePath) {
	const basePathDir = path.basename(basePath);
	const parentDir = path.dirname(basePath);
	const parentDirName = path.basename(parentDir);

	// If definition is in a 'defs/' directory, try to find the model file
	// This is important: we want the model file, not the definition file!
	if (basePathDir === 'defs') {
		// Pattern 1 (Standard): defs/ is a child of models/ (e.g., models/defs/)
		// In this case, models are in the PARENT directory
		if (parentDirName === 'models') {
			const modelsBase = path.resolve(parentDir, modelName);
			const found = tryFindModelWithExtensions(modelsBase);
			if (found) {
				return found;
			}
		}

		// Pattern 2 (Sibling): defs/ is a sibling of models/ (e.g., db/defs/ and db/models/)
		// In this case, models are in a sibling models/ directory
		const siblingModelsDir = path.join(parentDir, 'models');
		if (fs.existsSync(siblingModelsDir)) {
			const modelsBase = path.resolve(siblingModelsDir, modelName);
			const found = tryFindModelWithExtensions(modelsBase);
			if (found) {
				return found;
			}
		}
	}

	// Fall back to resolving from the base path directly (same directory)
	const resolvedBase = path.resolve(basePath, modelName);
	return tryFindModelWithExtensions(resolvedBase);
}

/**
 * Convert an absolute path to a workspace-relative import path if it matches a workspace root.
 *
 * @param {string} absolutePath - Absolute path to the model file
 * @param {string[]} workspaceRoots - Array of workspace root names (e.g., ['backend', 'shared'])
 * @returns {string|null} Workspace-relative path (e.g., 'backend/src/db/models/user') or null if no match
 */
function toWorkspaceRelativeImport(absolutePath, workspaceRoots) {
	if (!workspaceRoots || workspaceRoots.length === 0) {
		return null;
	}

	// Convert to posix path for consistent matching
	const posixPath = absolutePath.split(path.sep).join('/');

	// Find the LAST (deepest) matching workspace root to avoid incorrect matches
	// e.g., for '/managed-apps/pallas/backend/models/...' we want 'managed-apps' not 'backend'
	let bestMatch = null;
	let bestIndex = -1;

	for (const root of workspaceRoots) {
		// Find the root directory in the path
		const rootPattern = `/${root}/`;
		// Use the earliest (leftmost) match to get the full path
		const firstIndex = posixPath.indexOf(rootPattern);
		if (firstIndex !== -1 && (bestIndex === -1 || firstIndex < bestIndex)) {
			bestIndex = firstIndex;
			bestMatch = root;
		}
	}

	if (bestMatch !== null) {
		// Extract path starting from the root
		const relativePart = posixPath.substring(bestIndex + 1); // +1 to skip leading /
		// Remove file extension for import
		return relativePart.replace(/\.(js|ts|cjs|mjs)$/, '');
	}

	return null;
}

/**
 * Generate TypeScript interface for model instance properties.
 *
 * @param {object} convertedSchema - Schema from convertDefinition()
 * @param {Map} linkedModelImports - Map to collect linked model imports (mutated)
 * @param {string} outputDir - Directory where the .d.ts will be output
 * @param {string} definitionDir - Directory containing the model definition (for resolving bare module names)
 * @param {string[]} workspaceRoots - Array of workspace root names for import path optimization
 * @returns {string} TypeScript interface code
 */
function generateInstanceInterface(
	convertedSchema,
	linkedModelImports,
	outputDir,
	definitionDir,
	workspaceRoots = [],
) {
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

			// Handle linked fields - import strategy depends on whether model is TS or JS:
			// - TypeScript models (.ts): Import the class type (has custom methods + ORM methods)
			// - JavaScript models (.js): Import the Instance interface (only has schema fields)
			if (linkedModel) {
				let resolvedLinkedModel = linkedModel;

				// Check if this is a "bare module name" (no path separators, no extension)
				// like t.linked('account') vs t.linked('./models/account.js')
				const isBareModuleName =
					!linkedModel.includes('/') && !linkedModel.includes('\\');

				// For bare module names, try to resolve using yass-orm's resolution logic
				if (isBareModuleName && definitionDir) {
					const resolvedPath = resolveLinkedModelPath(
						linkedModel,
						definitionDir,
					);
					if (resolvedPath) {
						resolvedLinkedModel = resolvedPath;
					} else {
						// Can't resolve - fall back to unknown type
						const className = getLinkedModelClassName(linkedModel);
						return `\t/** Linked ${className} (unresolved: ${linkedModel}) */\n\t${fieldName}: unknown`;
					}
				}

				const className = getLinkedModelClassName(resolvedLinkedModel);
				const linkedModelDir = path.dirname(resolvedLinkedModel);
				const linkedModelBase = path
					.basename(resolvedLinkedModel)
					.replace(/\.(js|ts|cjs|mjs)$/, '');
				const linkedModelExt = path.extname(resolvedLinkedModel);
				const isTypeScriptModel = linkedModelExt === '.ts';

				// For TS models: use the class type (preserves custom methods)
				// For JS models: use the Instance interface (from generated .d.ts)
				const typeName = isTypeScriptModel ? className : `${className}Instance`;

				// Track import
				if (linkedModelImports && outputDir) {
					let isNamedImport = !isTypeScriptModel; // JS = named, TS = default

					// Try workspace-relative import first (e.g., 'backend/src/db/models/user')
					let importPath = toWorkspaceRelativeImport(
						resolvedLinkedModel,
						workspaceRoots,
					);

					if (!importPath) {
						// Fall back to relative path
						const relativePath = path.relative(outputDir, linkedModelDir);
						const posixRelativePath = relativePath
							? relativePath.split(path.sep).join('/')
							: '.';
						importPath = `${posixRelativePath}/${linkedModelBase}`;
						// Ensure import starts with ./ for same-directory or relative paths
						if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
							importPath = `./${importPath}`;
						}
					}

					linkedModelImports.set(resolvedLinkedModel, {
						className: typeName,
						importPath,
						isNamedImport,
					});
				}
				return `\t/** Linked ${className} */\n\t${fieldName}: ${typeName}`;
			}

			// Handle enum types - generate union type
			// Enums are defined with t.enum(['a', 'b']) which sets _type='enum' and options=[...]
			// Format as multi-line union for prettier compatibility
			if (
				_type === 'enum' &&
				options &&
				Array.isArray(options) &&
				options.length > 0
			) {
				const unionLines = options.map((v) => `\t\t| '${v}'`).join('\n');
				return `\t${fieldName}:\n${unionLines}\n\t\t| null`;
			}

			const tsType = mapFieldToTsType(field);
			return `\t${fieldName}: ${tsType}`;
		})
		.join(';\n');

	return `

/**
 * Instance properties for ${table} records.
 * Extends DatabaseObjectInstanceMethods to include ORM methods (jsonify, patch, etc.)
 * AUTO-GENERATED from schema definition - DO NOT EDIT MANUALLY.
 */
export interface ${interfaceName} extends DatabaseObjectInstanceMethods {
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

	// Generate model interface with prettier-compatible multi-line method signatures
	return `/**
 * Static model interface for ${table}.
 * Provides typed static methods (search, get, create, etc.)
 */
export interface ${modelTypeName} {
	/** Table name */
	table(): string;

	/** Search for multiple records */
	search(
		query: Record<string, unknown>,
	): Promise<${instanceName}[]>;

	/** Search for a single record */
	searchOne(
		query: Record<string, unknown>,
	): Promise<${instanceName} | null>;

	/** Get by ID */
	get(
		id: string,
		opts?: { allowCached?: boolean },
	): Promise<${instanceName} | null>;

	/** Get multiple by IDs */
	getMultiple(
		ids: string[],
		opts?: { allowCached?: boolean },
	): Promise<${instanceName}[]>;

	/** Create a new record */
	create(
		data: Partial<${instanceName}>,
	): Promise<${instanceName}>;

	/** Find or create a record */
	findOrCreate(
		fields: Partial<${instanceName}>,
		patchIf?: Partial<${instanceName}>,
		patchIfFalsey?: Partial<${instanceName}>,
	): Promise<${instanceName}>;

	/** Execute raw SQL and return typed results */
	fromSql(
		sql: string,
		params?: Record<string, unknown>,
	): Promise<${instanceName}[]>;

	/** Execute raw SQL (for COUNT, etc.) or callback with database handle */
	withDbh(
		sql: string,
		params?: Record<string, unknown>,
	): Promise<unknown[]>;
	withDbh<T>(callback: (dbh: unknown) => T | Promise<T>): Promise<T>;

	/** Get cached instance by ID */
	getCachedId(
		id: string,
		span?: unknown,
	): Promise<${instanceName} | undefined>;

	/** Set cached instance */
	setCachedId(
		id: string,
		instance: ${instanceName},
	): Promise<${instanceName}>;

	/** Inflate raw data to typed instance */
	inflate(
		data: Record<string, unknown>,
		span?: unknown,
	): Promise<${instanceName} | null>;
}`;
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
 * @param {object} options - Options for content generation
 * @param {string} options.headerComment - Custom header comment to add
 * @param {string} options.outputDir - Output directory for .d.ts (for import path calculation)
 * @param {string[]} options.workspaceRoots - Array of workspace root paths (e.g., ['backend', 'shared'])
 *   When a linked model path crosses into one of these roots, the import will use
 *   the workspace-relative path (e.g., 'backend/src/db/models/user') instead of
 *   ugly relative paths (e.g., '../../../../../backend/src/db/models/user')
 * @returns {string} Complete TypeScript declaration file content
 */
function generateTypesContent(definitionPath, options = {}) {
	let { headerComment, outputDir, workspaceRoots = [] } = options;
	if (!headerComment) {
		headerComment = `Re-generate with: npx yass-orm generate-types ${definitionPath}`;
	}

	// If no outputDir provided, default to the definition's directory
	// (caller should ideally use generateTypesForFile which determines correct output path)
	if (!outputDir) {
		outputDir = path.dirname(path.resolve(process.cwd(), definitionPath));
	}

	// Load the definition using require for CJS compatibility
	// (model definitions use CJS require() even in ESM packages)
	const resolvedPath = path.resolve(process.cwd(), definitionPath);
	const definitionDir = path.dirname(resolvedPath);
	const definitionModule = requireFromCwd(resolvedPath);
	const definition = definitionModule.default || definitionModule;

	const convertedSchema = convertDefinition(definition);

	// Collect linked model imports
	const linkedModelImports = new Map();

	// Generate each section - pass definitionDir for bare module name resolution
	const instanceInterface = generateInstanceInterface(
		convertedSchema,
		linkedModelImports,
		outputDir,
		definitionDir,
		workspaceRoots,
	);
	const modelType = generateModelType(convertedSchema);
	const defaultExport = generateDefaultExport(convertedSchema);

	// Generate import statements for linked models (using named imports for Instance types)
	const importStatements = Array.from(linkedModelImports.values())
		.map(({ className, importPath, isNamedImport }) => {
			if (isNamedImport) {
				return `import type { ${className} } from '${importPath}';`;
			}
			return `import type ${className} from '${importPath}';`;
		})
		.join('\n');

	// Combine into complete file
	const fileName = path.basename(definitionPath);

	// Build header with optional custom comment
	const customHeader = headerComment ? ` *\n * ${headerComment}\n` : '';

	// Add imports section if we have any
	const importsSection = importStatements ? `${importStatements}\n\n` : '';

	const content = `/**
 * TypeScript type definitions for ${fileName}
 *
 * AUTO-GENERATED by yass-orm generate-types - DO NOT EDIT MANUALLY.
${customHeader} */

import type { DatabaseObjectInstanceMethods } from 'yass-orm';

${importsSection}${instanceInterface}

${modelType}

${defaultExport}
`;

	return content;
}

/**
 * Determine the output path for the .d.ts file and any alternate paths to clean up.
 *
 * Smart output based on model file type and directory structure:
 *
 * Pattern 1 - Standard (models/defs/):
 *   Definition: models/defs/schema.js
 *   TS Model:   models/model.ts     → Output to defs/, no cleanup
 *   JS Model:   models/model.js     → Output to models/, cleanup defs/
 *
 * Pattern 2 - Sibling (db/defs/ alongside db/models/):
 *   Definition: db/defs/schema.js
 *   Model:      db/models/model.js  → Output to db/models/, cleanup db/defs/
 *   Model:      db/models/model.ts  → Output to db/defs/, cleanup db/models/
 *
 * @param {string} definitionPath - Path to model definition .js file
 * @returns {{ outputPath: string, cleanupPaths: string[] }} Output path and paths to clean up
 */
function determineOutputPath(definitionPath) {
	const resolvedPath = path.resolve(definitionPath);
	const dir = path.dirname(resolvedPath);
	const basename = path.basename(resolvedPath, '.js');
	const dtsFilename = `${basename}.d.ts`;

	// Check if we're in a defs/ folder
	if (path.basename(dir) === 'defs') {
		const parentDir = path.dirname(dir);
		const parentDirName = path.basename(parentDir);

		// Pattern 2: Sibling structure (e.g., db/defs/ and db/models/)
		// Check if there's a sibling 'models' folder
		const siblingModelsDir = path.join(parentDir, 'models');
		if (
			parentDirName !== 'models' &&
			fs.existsSync(siblingModelsDir) &&
			fs.statSync(siblingModelsDir).isDirectory()
		) {
			const tsModelPath = path.join(siblingModelsDir, `${basename}.ts`);
			const jsModelPath = path.join(siblingModelsDir, `${basename}.js`);

			// If TypeScript model exists in sibling models/, keep types in defs/
			if (fs.existsSync(tsModelPath)) {
				return {
					outputPath: path.join(dir, dtsFilename),
					cleanupPaths: [path.join(siblingModelsDir, dtsFilename)],
				};
			}

			// If JS model exists in sibling models/, put types there
			if (fs.existsSync(jsModelPath)) {
				return {
					outputPath: path.join(siblingModelsDir, dtsFilename),
					cleanupPaths: [path.join(dir, dtsFilename)],
				};
			}

			// No model found - default to sibling models/ for cleanup safety
			return {
				outputPath: path.join(siblingModelsDir, dtsFilename),
				cleanupPaths: [path.join(dir, dtsFilename)],
			};
		}

		// Pattern 1: Standard structure (models/defs/)
		// Check parent folder for models
		const tsModelPath = path.join(parentDir, `${basename}.ts`);
		const jsModelPath = path.join(parentDir, `${basename}.js`);

		// If TypeScript model exists in parent, keep types in defs/ to avoid conflict
		if (fs.existsSync(tsModelPath)) {
			return {
				outputPath: path.join(dir, dtsFilename),
				cleanupPaths: [path.join(parentDir, dtsFilename)],
			};
		}

		// If JS model exists in parent, put types next to it for auto-discovery
		if (fs.existsSync(jsModelPath)) {
			return {
				outputPath: path.join(parentDir, dtsFilename),
				cleanupPaths: [path.join(dir, dtsFilename)],
			};
		}
	}

	// Default: output next to the definition file, no cleanup
	return {
		outputPath: resolvedPath.replace(/\.js$/, '.d.ts'),
		cleanupPaths: [],
	};
}

/**
 * Clean up old .d.ts files in alternate locations.
 *
 * @param {string[]} cleanupPaths - Paths to check and remove
 * @param {object} options - Options
 * @param {boolean} options.dryRun - If true, only log what would be deleted
 * @param {boolean} options.verbose - If true, log more details
 */
function cleanupOldTypeFiles(cleanupPaths, options = {}) {
	const { dryRun = false, verbose = false } = options;

	for (const filePath of cleanupPaths) {
		if (fs.existsSync(filePath)) {
			if (dryRun) {
				console.log(`[dry-run] Would remove old file: ${filePath}`);
			} else {
				fs.unlinkSync(filePath);
				if (verbose) {
					console.log(`Removed old file: ${filePath}`);
				}
			}
		}
	}
}

/**
 * Generate and write .d.ts file for a model definition.
 *
 * Types are output based on whether the model is TypeScript or JavaScript:
 * - TypeScript models: types go in defs/ (avoids .ts/.d.ts conflict)
 * - JavaScript models: types go next to model (TypeScript auto-discovers)
 *
 * @param {string} definitionPath - Path to model definition .js file
 * @param {object} options - Options
 * @param {boolean} options.dryRun - If true, only log what would be written
 * @param {boolean} options.verbose - If true, log more details
 * @param {string} options.headerComment - Custom comment to add to header
 * @param {string[]} options.workspaceRoots - Workspace root names for import optimization
 * @returns {Promise<{path: string, content: string}>} Result with path and content
 */
async function generateTypesForFile(definitionPath, options = {}) {
	const {
		dryRun = false,
		verbose = false,
		headerComment,
		workspaceRoots,
	} = options;

	try {
		// Determine output path first so we can calculate import paths
		const { outputPath, cleanupPaths } = determineOutputPath(definitionPath);
		const outputDir = path.dirname(outputPath);

		// Generate content with output directory for import path calculation
		const content = generateTypesContent(definitionPath, {
			headerComment,
			outputDir,
			workspaceRoots,
		});

		// Clean up old files in alternate locations
		if (cleanupPaths.length > 0) {
			cleanupOldTypeFiles(cleanupPaths, { dryRun, verbose });
		}

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
	determineOutputPath,
	cleanupOldTypeFiles,
	mapFieldToTsType,
	toPascalCase,
};
