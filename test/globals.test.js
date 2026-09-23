/* global describe, it */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const globals = require('../lib/globals');

const libDir = path.join(__dirname, '..', 'lib');

// Every .js file under lib/, tests excluded, comment lines dropped.
const libSources = (dir = libDir) =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return libSources(file);
		if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) {
			return [];
		}
		const code = fs
			.readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
			.join('\n');
		return [{ file: path.relative(libDir, file), code }];
	});

/**
 * lib/globals.js owns every globalThis key yass uses (step 4 of the
 * modernization plan). The keys, their names and their adopt-if-set behavior
 * are public: Rubber writes four of them for its Bun builds, and a second copy
 * of yass (one package loaded twice) must share the rest.
 */
describe('#YASS-ORM globals (the one module that owns the globalThis keys)', () => {
	it('no other lib/ module reads or writes globalThis', () => {
		const offenders = libSources()
			.filter(({ file }) => file !== 'globals.js')
			.filter(({ code }) => /\bglobalThis\b/.test(code))
			.map(({ file }) => file);
		expect(offenders).to.deep.equal([]);
	});

	it('lists every key it owns', () => {
		expect(globals.KEYS).to.deep.equal({
			objectCache: '__YASS_ORM_OBJECT_CACHE__',
			modelClassCache: '__YASS_ORM_MODEL_CLASS_CACHE__',
			modelDefinitionCache: '__YASS_ORM_MODEL_DEFINITION_CACHE__',
			pathCache: '__YASS_ORM_PATH_CACHE__',
			globalChangeHooks: '__YASS_ORM_GLOBAL_CHANGE_HOOKS__',
			modelRegistry: '__YASS_ORM_MODEL_REGISTRY__',
			definitionIndex: '__YASS_ORM_DEFINITION_INDEX__',
			modelPathIndex: '__YASS_ORM_MODEL_PATH_INDEX__',
			pathResolver: '__YASS_ORM_PATH_RESOLVER__',
			defPathMap: '__YASS_DEF_PATH_MAP__',
		});
	});

	it("yass's own stores are the globalThis values", () => {
		expect(globals.objectCache).to.equal(globalThis.__YASS_ORM_OBJECT_CACHE__);
		expect(globals.modelClassCache).to.equal(
			globalThis.__YASS_ORM_MODEL_CLASS_CACHE__,
		);
		expect(globals.modelDefinitionCache).to.equal(
			globalThis.__YASS_ORM_MODEL_DEFINITION_CACHE__,
		);
		expect(globals.pathCache).to.equal(globalThis.__YASS_ORM_PATH_CACHE__);
		expect(globals.globalChangeHooks).to.equal(
			globalThis.__YASS_ORM_GLOBAL_CHANGE_HOOKS__,
		);
		expect(globals.modelRegistry).to.equal(
			globalThis.__YASS_ORM_MODEL_REGISTRY__,
		);
		expect(globals.modelRegistry).to.be.an.instanceOf(Map);
	});

	it('the keys a consumer writes are read live, on each use', () => {
		const saved = {
			index: globalThis.__YASS_ORM_MODEL_PATH_INDEX__,
			resolver: globalThis.__YASS_ORM_PATH_RESOLVER__,
			map: globalThis.__YASS_DEF_PATH_MAP__,
			defs: globalThis.__YASS_ORM_DEFINITION_INDEX__,
		};
		try {
			const index = new Map();
			const resolver = (p) => p;
			const map = { a: '/a.js' };
			const defs = new Map();
			globalThis.__YASS_ORM_MODEL_PATH_INDEX__ = index;
			globalThis.__YASS_ORM_PATH_RESOLVER__ = resolver;
			globalThis.__YASS_DEF_PATH_MAP__ = map;
			globalThis.__YASS_ORM_DEFINITION_INDEX__ = defs;
			expect(globals.modelPathIndex()).to.equal(index);
			expect(globals.pathResolver()).to.equal(resolver);
			expect(globals.defPathMap()).to.equal(map);
			expect(globals.definitionIndex()).to.equal(defs);

			delete globalThis.__YASS_ORM_DEFINITION_INDEX__;
			expect(globals.definitionIndex()).to.equal(undefined);
			// Created on first write, as registerDefinition() always has.
			const created = globals.definitionIndex({ create: true });
			expect(created).to.be.an.instanceOf(Map);
			expect(globalThis.__YASS_ORM_DEFINITION_INDEX__).to.equal(created);
		} finally {
			Object.entries({
				__YASS_ORM_MODEL_PATH_INDEX__: saved.index,
				__YASS_ORM_PATH_RESOLVER__: saved.resolver,
				__YASS_DEF_PATH_MAP__: saved.map,
				__YASS_ORM_DEFINITION_INDEX__: saved.defs,
			}).forEach(([key, value]) => {
				if (value === undefined) delete globalThis[key];
				else globalThis[key] = value;
			});
		}
	});

	it('adopts the model registry already on globalThis (a second copy of yass shares it)', () => {
		const script = [
			'const shared = new Map();',
			'globalThis.__YASS_ORM_MODEL_REGISTRY__ = shared;',
			`const yass = require(${JSON.stringify(libDir)});`,
			"const Model = yass.loadDefinition(({ types: t }) => ({ table: 'yass_g', schema: { id: t.idKey } }));",
			"yass.registerModel('g', Model);",
			"console.log(JSON.stringify({ same: shared.get('g') === Model }));",
		].join('\n');
		const run = spawnSync(process.execPath, ['-e', script], {
			cwd: path.join(__dirname, '..'),
			env: process.env,
			encoding: 'utf8',
		});
		expect(run.status, run.stderr).to.equal(0);
		expect(JSON.parse(run.stdout.trim().split('\n').pop())).to.deep.equal({
			same: true,
		});
	});
});
