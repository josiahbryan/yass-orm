/* eslint-disable no-unused-vars */
/**
 * ESM Compatibility Tests
 *
 * These tests verify that yass-orm works correctly when:
 * 1. Imported from ESM modules (using import syntax)
 * 2. Loading ESM model files
 * 3. Handling file:// URLs from parentModule()
 * 4. Cross-boundary cache behavior (CJS/ESM)
 */

/* global it, describe, beforeEach, afterEach */
import { expect } from 'chai';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

// Import yass-orm using ESM import syntax
import YassORM from '../lib/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('#YASS-ORM ESM Compatibility', () => {
	const tempFiles = [];

	// Helper to create temp files and track them for cleanup
	const createTempFile = (filename, content) => {
		const filepath = join(__dirname, filename);
		writeFileSync(filepath, content);
		tempFiles.push(filepath);
		return filepath;
	};

	afterEach(() => {
		// Clean up all temp files
		tempFiles.forEach((file) => {
			if (existsSync(file)) {
				unlinkSync(file);
			}
		});
		tempFiles.length = 0;
	});

	describe('ESM Import', () => {
		it('should export loadDefinition when imported via ESM', () => {
			expect(typeof YassORM.loadDefinition).to.equal('function');
		});

		it('should export DatabaseObject when imported via ESM', () => {
			expect(typeof YassORM.DatabaseObject).to.equal('function');
		});

		it('should export convertDefinition when imported via ESM', () => {
			expect(typeof YassORM.convertDefinition).to.equal('function');
		});

		it('should create a class from loadDefinition when called from ESM', () => {
			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `esm_test_${Date.now()}`,
				schema: {
					id: t.idKey,
					name: t.string,
				},
			}));

			expect(typeof TestClass).to.equal('function');
			expect(typeof TestClass.schema).to.equal('function');
			expect(TestClass.schema().fieldMap.id.type).to.equal('idKey');
		});
	});

	describe('file:// URL handling', () => {
		it('should handle file:// URLs in fileUrlToPath helper', () => {
			// The fileUrlToPath helper in obj.js handles file:// URLs
			// This is exercised when loadDefinition is called from ESM modules
			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `file_url_test_${Date.now()}`,
				schema: {
					id: t.idKey,
					name: t.string,
				},
			}));

			// basePath() should return a valid filesystem path, not a file:// URL
			const basePath = TestClass.basePath();
			expect(basePath).to.not.include('file://');
			expect(basePath).to.include(__dirname);
		});
	});

	describe('Loading CJS model files from ESM context', () => {
		it('should load a CommonJS model file when resolved from ESM', async () => {
			// Create a CJS model file
			const modelContent = `
const YassORM = require('../lib');
module.exports = YassORM.loadDefinition(({ types: t }) => ({
	table: 'cjs_model_from_esm',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));
`;
			createTempFile('cjs-model-test.js', modelContent);

			// Create a test class that links to the CJS model
			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `esm_with_linked_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('cjs-model-test'),
				},
			}));

			// Override basePath to point to test directory
			TestClass.basePath = () => __dirname;

			// Resolve the model class
			const ModelClass = await TestClass._resolveModelClass('cjs-model-test');
			expect(typeof ModelClass).to.equal('function');
			expect(ModelClass.table()).to.equal('cjs_model_from_esm');
		});
	});

	describe('Loading ESM model files', () => {
		it('should load an ESM model file with default export', async () => {
			// Create an ESM-style model file (still CJS syntax but with ES6 default pattern)
			const modelContent = `
const YassORM = require('../lib');
const Model = YassORM.loadDefinition(({ types: t }) => ({
	table: 'esm_style_model',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));
module.exports = { default: Model };
`;
			createTempFile('esm-style-model.js', modelContent);

			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `test_esm_loader_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('esm-style-model'),
				},
			}));

			TestClass.basePath = () => __dirname;

			const ModelClass = await TestClass._resolveModelClass('esm-style-model');
			expect(typeof ModelClass).to.equal('function');
			expect(ModelClass.table()).to.equal('esm_style_model');
		});

		it('should handle direct module.exports (common CJS pattern)', async () => {
			// Create a model with direct module.exports (most common pattern)
			const modelContent = `
const YassORM = require('../lib');
module.exports = YassORM.loadDefinition(({ types: t }) => ({
	table: 'direct_export_model',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));
`;
			createTempFile('direct-export-model.js', modelContent);

			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `test_direct_export_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('direct-export-model'),
				},
			}));

			TestClass.basePath = () => __dirname;

			const ModelClass = await TestClass._resolveModelClass(
				'direct-export-model',
			);
			expect(typeof ModelClass).to.equal('function');
			expect(ModelClass.table()).to.equal('direct_export_model');
		});
	});

	describe('globalThis Cache Behavior', () => {
		it('should use global cache that persists across module loads', () => {
			// The caches use globalThis to survive ESM module duplication
			// Verify that the global caches exist
			expect(globalThis.__YASS_ORM_OBJECT_CACHE__).to.be.an('object');
			expect(globalThis.__YASS_ORM_MODEL_CLASS_CACHE__).to.be.an('object');
			expect(globalThis.__YASS_ORM_MODEL_DEFINITION_CACHE__).to.be.an('object');
			expect(globalThis.__YASS_ORM_PATH_CACHE__).to.be.instanceOf(Map);
		});

		it('should share model class cache between calls', async () => {
			// Create a model file
			const modelContent = `
const YassORM = require('../lib');
module.exports = YassORM.loadDefinition(({ types: t }) => ({
	table: 'cache_test_model',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));
`;
			createTempFile('cache-test-model.js', modelContent);

			const TestClass1 = YassORM.loadDefinition(({ types: t }) => ({
				table: `cache_test_1_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('cache-test-model'),
				},
			}));

			const TestClass2 = YassORM.loadDefinition(({ types: t }) => ({
				table: `cache_test_2_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('cache-test-model'),
				},
			}));

			TestClass1.basePath = () => __dirname;
			TestClass2.basePath = () => __dirname;

			// Load from first class
			const ModelClass1 = await TestClass1._resolveModelClass(
				'cache-test-model',
			);

			// Load from second class - should return same cached class
			const ModelClass2 = await TestClass2._resolveModelClass(
				'cache-test-model',
			);

			// Should be the exact same class reference due to caching
			expect(ModelClass1).to.equal(ModelClass2);
		});
	});

	describe('Cross-boundary behavior', () => {
		it('should maintain instanceof checks across module boundaries', async () => {
			// Create a model file
			const modelContent = `
const YassORM = require('../lib');
module.exports = YassORM.loadDefinition(({ types: t }) => ({
	table: 'instanceof_test_model',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));
`;
			createTempFile('instanceof-test-model.js', modelContent);

			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `instanceof_parent_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('instanceof-test-model'),
				},
			}));

			TestClass.basePath = () => __dirname;

			const ModelClass = await TestClass._resolveModelClass(
				'instanceof-test-model',
			);

			// Both should be functions (classes)
			expect(typeof ModelClass).to.equal('function');

			// The model class should extend DatabaseObject
			// This verifies the class hierarchy works across module boundaries
			expect(ModelClass.prototype).to.be.instanceOf(
				YassORM.DatabaseObject.prototype.constructor,
			);
		});
	});

	describe('Path handling edge cases', () => {
		it('should handle paths with special characters', async () => {
			// Create a model file with a complex name
			const modelContent = `
const YassORM = require('../lib');
module.exports = YassORM.loadDefinition(({ types: t }) => ({
	table: 'special_char_model',
	schema: {
		id: t.idKey,
		name: t.string,
	},
}));
`;
			createTempFile('model-with-dashes.js', modelContent);

			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `special_test_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('model-with-dashes'),
				},
			}));

			TestClass.basePath = () => __dirname;

			const ModelClass = await TestClass._resolveModelClass(
				'model-with-dashes',
			);
			expect(typeof ModelClass).to.equal('function');
		});

		it('should normalize paths correctly regardless of trailing slashes', async () => {
			const modelContent = `
const YassORM = require('../lib');
module.exports = YassORM.loadDefinition(({ types: t }) => ({
	table: 'path_normalize_model',
	schema: {
		id: t.idKey,
	},
}));
`;
			createTempFile('path-normalize-model.js', modelContent);

			const TestClass = YassORM.loadDefinition(({ types: t }) => ({
				table: `path_test_${Date.now()}`,
				schema: {
					id: t.idKey,
					linkedModel: t.linked('./path-normalize-model'),
				},
			}));

			// Test with trailing slash in basePath
			TestClass.basePath = () => `${__dirname}/`;

			const ModelClass = await TestClass._resolveModelClass(
				'./path-normalize-model',
			);
			expect(typeof ModelClass).to.equal('function');
		});
	});
});
