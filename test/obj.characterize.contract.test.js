/* eslint-disable no-unused-expressions */
/* global describe, it, before, after */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const YassORM = require('../lib');
const dbhModule = require('../lib/dbh');
const config = require('../lib/config');
const libUtils = require('../lib/utils');
const CharPerson = require('./fixtures/characterize/char-person');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures', 'characterize');

/**
 * Characterization (step 3 of the modernization plan): the public contract
 * beyond the model API. The export list, the deep import paths and bin paths
 * Rubber uses, and the globalThis keys (yass's own, and the ones Rubber
 * writes for its Bun builds). No database needed.
 */
describe('#characterize public contract', function contractSuite() {
	this.timeout(30000);

	describe('exports', () => {
		it('the main module exports the documented names', () => {
			const functions = [
				'loadDefinition',
				'prefixedId',
				'timeOrderedId',
				'DatabaseObject',
				'convertDefinition',
				'retryIfConnectionLost',
				'LoadBalancer',
				'updatePromiseMapDefaultConfig',
				'closeAllConnections',
				'registerDefinition',
				'isUniqueViolation',
				'isConstraintError',
				'registerGlobalChangeHook',
			];
			const objects = [
				'QueryTiming',
				'QueryLogger',
				'libUtils',
				'dbhUtils',
				'config',
				'loadBalancerManager',
			];
			functions.forEach((name) =>
				expect(YassORM[name], name).to.be.a('function'),
			);
			objects.forEach((name) => expect(YassORM[name], name).to.be.an('object'));
		});

		it('dbhUtils, config and libUtils are the deep modules themselves', () => {
			expect(YassORM.dbhUtils).to.equal(dbhModule);
			expect(YassORM.config).to.equal(config);
			expect(YassORM.libUtils).to.equal(libUtils);
			expect(YassORM.DatabaseObject.QueryTiming).to.equal(YassORM.QueryTiming);
		});

		it('lib/dbh exports what Rubber reaches for', () => {
			[
				'dbh',
				'closeAllConnections',
				'deflateValue',
				'sqlEscape',
				'autoFixTable',
				'debugSql',
				'parseIdField',
				'LoadBalancer',
				'getDialect',
			].forEach((name) => expect(dbhModule[name], name).to.be.a('function'));
			expect(dbhModule.QueryTiming).to.be.an('object');
			expect(dbhModule.QueryLogger).to.be.an('object');
			expect(dbhModule.loadBalancerManager).to.be.an('object');
		});

		it('lib/config is a plain object of settings', () => {
			expect(Object.getPrototypeOf(config)).to.equal(Object.prototype);
			expect(config.schema).to.be.a('string');
			expect(config.commonFields).to.be.a('function');
		});
	});

	describe('closeAllConnections()', () => {
		// Fixed bug (step 3 found it; fixed in step 7): models get their handle
		// from lib/utils.js handle(), and schema sync from a module-level `dbh`
		// in lib/sync-to-db.js. Both cached it and were never told the pool was
		// closed, so after closeAllConnections() every model call (and every
		// syncSchemaToDb) failed with "pool is closed".
		it('models work again after closeAllConnections()', async () => {
			const Model = YassORM.loadDefinition(({ types: t }) => ({
				table: 'yass_char_reconnect',
				schema: { id: t.idKey },
			}));
			await Model.withDbh('select 1 as one');
			await YassORM.closeAllConnections();
			const [row] = await Model.withDbh('select 1 as one');
			expect(Number(row.one)).to.equal(1);
		});

		it('schema sync works again after closeAllConnections()', async () => {
			// eslint-disable-next-line global-require
			const { syncSchemaToDb } = require('../lib/sync-to-db');
			const schema = () =>
				YassORM.convertDefinition(({ types: t }) => ({
					table: 'yass_char_reconnect',
					schema: { id: t.idKey, name: t.string },
				}));
			expect((await syncSchemaToDb(schema())).errors).to.deep.equal([]);
			await YassORM.closeAllConnections();
			expect((await syncSchemaToDb(schema())).errors).to.deep.equal([]);
		});
	});

	describe('paths', () => {
		// A consumer's view: node_modules/yass-orm pointing at this checkout.
		let consumerDir;
		before(() => {
			consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yass-consumer-'));
			fs.mkdirSync(path.join(consumerDir, 'node_modules'));
			fs.symlinkSync(root, path.join(consumerDir, 'node_modules', 'yass-orm'));
		});
		after(() => {
			fs.rmSync(consumerDir, { recursive: true, force: true });
		});

		const resolveFromConsumer = (request) =>
			require.resolve(request, { paths: [consumerDir] });

		it('the deep imports Rubber uses resolve (no exports map blocks them)', () => {
			expect(pkg.exports).to.equal(undefined);
			expect(pkg.main).to.equal('lib/index.js');
			[
				'yass-orm',
				'yass-orm/lib/config.js',
				'yass-orm/lib/dbh',
				'yass-orm/lib/dbh.js',
				'yass-orm/lib/obj',
				'yass-orm/lib/sync-to-db',
				'yass-orm/lib/transactions',
			].forEach((request) =>
				expect(resolveFromConsumer(request), request).to.be.a('string'),
			);
		});

		it('ESM: default imports of deep paths, and named imports of the main module', () => {
			const probe = path.join(consumerDir, 'probe.mjs');
			fs.writeFileSync(
				probe,
				[
					"import ymConfig from 'yass-orm/lib/config.js';",
					"import yassDbh from 'yass-orm/lib/dbh.js';",
					'import {',
					'	DatabaseObject, dbhUtils, retryIfConnectionLost, config, QueryLogger,',
					'	libUtils, isUniqueViolation, convertDefinition, closeAllConnections,',
					'	loadDefinition, loadBalancerManager, LoadBalancer,',
					'	registerGlobalChangeHook, registerDefinition,',
					"} from 'yass-orm';",
					'const named = { DatabaseObject, dbhUtils, retryIfConnectionLost, config,',
					'	QueryLogger, libUtils, isUniqueViolation, convertDefinition,',
					'	closeAllConnections, loadDefinition, loadBalancerManager, LoadBalancer,',
					'	registerGlobalChangeHook, registerDefinition };',
					'console.log(JSON.stringify({',
					'	missing: Object.keys(named).filter((k) => named[k] === undefined),',
					'	configIsSame: ymConfig === config,',
					"	dbhIsFunction: typeof yassDbh.dbh === 'function',",
					'}));',
				].join('\n'),
			);
			const run = spawnSync(process.execPath, [probe], {
				cwd: consumerDir,
				env: process.env,
				encoding: 'utf8',
			});
			expect(run.status, run.stderr).to.equal(0);
			const lastLine = run.stdout.trim().split('\n').pop();
			expect(JSON.parse(lastLine)).to.deep.equal({
				missing: [],
				configIsSame: true,
				dbhIsFunction: true,
			});
		});

		describe('config resolution (how Rubber configures yass)', () => {
			// Runs a fresh node in the consumer dir and prints the config fields
			// asked for, as seen through both the deep import and the main module.
			const probeConfig = (env) => {
				const script = [
					"const deep = require('yass-orm/lib/config.js');",
					"const main = require('yass-orm').config;",
					'console.log(JSON.stringify({ same: deep === main,',
					'	host: deep.host, schema: deep.schema, port: deep.port,',
					'	uuidLinkedIds: deep.uuidLinkedIds, shared: deep.fromShared }));',
				].join('\n');
				const childEnv = { ...process.env, ...env };
				Object.keys(childEnv).forEach((key) => {
					if (childEnv[key] === undefined) delete childEnv[key];
				});
				const run = spawnSync(process.execPath, ['-e', script], {
					cwd: consumerDir,
					env: childEnv,
					encoding: 'utf8',
				});
				expect(run.status, run.stderr).to.equal(0);
				return JSON.parse(run.stdout.trim().split('\n').pop());
			};

			const userConfig = (host) =>
				[
					'module.exports = {',
					"	shared: { fromShared: 'yes', port: 4000 },",
					`	development: { host: '${host}-dev', schema: 'dev_s' },`,
					`	production: { host: '${host}-prod', schema: 'prod_s', uuidLinkedIds: true },`,
					'};',
				].join('\n');

			it('YASS_CONFIG names the file; YASS_ENV picks the block over NODE_ENV; defaults < shared < env block', () => {
				const file = path.join(consumerDir, 'explicit-config.cjs');
				fs.writeFileSync(file, userConfig('explicit'));
				expect(
					probeConfig({
						YASS_CONFIG: file,
						NODE_ENV: 'development',
						YASS_ENV: 'production',
					}),
				).to.deep.equal({
					same: true,
					host: 'explicit-prod',
					schema: 'prod_s',
					port: 4000,
					uuidLinkedIds: true,
					shared: 'yes',
				});
				expect(
					probeConfig({
						YASS_CONFIG: file,
						NODE_ENV: 'production',
						YASS_ENV: undefined,
					}).host,
				).to.equal('explicit-prod');
			});

			it('with no YASS_CONFIG, .yass-orm.cjs is found from the working directory (Rubber runs from backend/)', () => {
				fs.writeFileSync(
					path.join(consumerDir, '.yass-orm.cjs'),
					userConfig('cwd'),
				);
				try {
					expect(
						probeConfig({
							YASS_CONFIG: undefined,
							NODE_ENV: 'development',
							YASS_ENV: undefined,
						}),
					).to.deep.equal({
						same: true,
						host: 'cwd-dev',
						schema: 'dev_s',
						port: 4000,
						uuidLinkedIds: false,
						shared: 'yes',
					});
				} finally {
					fs.rmSync(path.join(consumerDir, '.yass-orm.cjs'));
				}
			});
		});

		it('the bin paths consumers call exist; schema-sync is the declared bin', () => {
			expect(pkg.bin).to.deep.equal({
				'yass-orm-schema-sync': 'bin/schema-sync',
			});
			[
				'bin/schema-sync',
				'bin/generate-types',
				'bin/export-schema',
				'bin/migrate-link-collation',
			].forEach((bin) =>
				expect(fs.existsSync(path.join(root, bin)), bin).to.equal(true),
			);
		});
	});

	describe('globalThis keys', () => {
		it('yass creates its own caches on globalThis when it loads', () => {
			expect(globalThis.__YASS_ORM_OBJECT_CACHE__).to.be.an('object');
			expect(globalThis.__YASS_ORM_MODEL_CLASS_CACHE__).to.be.an('object');
			expect(globalThis.__YASS_ORM_MODEL_DEFINITION_CACHE__).to.be.an('object');
			expect(globalThis.__YASS_ORM_PATH_CACHE__).to.be.an.instanceOf(Map);
			expect(globalThis.__YASS_ORM_GLOBAL_CHANGE_HOOKS__).to.be.an('array');
		});

		it('adopts values already on globalThis when it loads (a second copy of yass shares them)', () => {
			const script = [
				'const sentinels = {',
				'	__YASS_ORM_OBJECT_CACHE__: {},',
				'	__YASS_ORM_MODEL_CLASS_CACHE__: {},',
				'	__YASS_ORM_MODEL_DEFINITION_CACHE__: {},',
				'	__YASS_ORM_PATH_CACHE__: new Map(),',
				'	__YASS_ORM_GLOBAL_CHANGE_HOOKS__: [],',
				'};',
				'Object.assign(globalThis, sentinels);',
				`const yass = require(${JSON.stringify(path.join(root, 'lib'))});`,
				'const hook = () => {};',
				'yass.registerGlobalChangeHook(hook);',
				'console.log(JSON.stringify({',
				'	same: Object.keys(sentinels).filter((k) => globalThis[k] === sentinels[k]),',
				'	hookLanded: sentinels.__YASS_ORM_GLOBAL_CHANGE_HOOKS__.includes(hook),',
				'}));',
			].join('\n');
			const run = spawnSync(process.execPath, ['-e', script], {
				cwd: root,
				env: process.env,
				encoding: 'utf8',
			});
			expect(run.status, run.stderr).to.equal(0);
			const lastLine = run.stdout.trim().split('\n').pop();
			expect(JSON.parse(lastLine)).to.deep.equal({
				same: [
					'__YASS_ORM_OBJECT_CACHE__',
					'__YASS_ORM_MODEL_CLASS_CACHE__',
					'__YASS_ORM_MODEL_DEFINITION_CACHE__',
					'__YASS_ORM_PATH_CACHE__',
					'__YASS_ORM_GLOBAL_CHANGE_HOOKS__',
				],
				hookLanded: true,
			});
		});

		describe('keys a consumer writes (Rubber, for Bun builds)', () => {
			const saved = {};
			const keys = [
				'__YASS_ORM_MODEL_PATH_INDEX__',
				'__YASS_ORM_PATH_RESOLVER__',
				'__YASS_DEF_PATH_MAP__',
				'__YASS_ORM_DEFINITION_INDEX__',
			];
			before(() => {
				keys.forEach((key) => {
					saved[key] = globalThis[key];
				});
			});
			after(() => {
				keys.forEach((key) => {
					if (saved[key] === undefined) {
						delete globalThis[key];
					} else {
						globalThis[key] = saved[key];
					}
				});
			});

			// Each test links from a model defined in this file (basePath: test/).
			const linking = (linkName) =>
				YassORM.loadDefinition(({ types: t }) => ({
					table: 'yass_char_linking',
					schema: { id: t.idKey, other: t.linked(linkName) },
				}));

			it('__YASS_ORM_MODEL_PATH_INDEX__: a Map from "models/<name>" to a class resolves a link with no file', async () => {
				class Virtual extends YassORM.DatabaseObject {}
				globalThis.__YASS_ORM_MODEL_PATH_INDEX__ = new Map([
					['models/char-virtual-model', Virtual],
				]);
				const Linking = linking('models/char-virtual-model');
				expect(
					await Linking._resolveModelClass('models/char-virtual-model'),
				).to.equal(Virtual);
			});

			it('__YASS_ORM_PATH_RESOLVER__: maps a link path to the real file', async () => {
				const phantom = path.join(__dirname, 'phantom', 'char-person.js');
				const seen = [];
				globalThis.__YASS_ORM_PATH_RESOLVER__ = (p) => {
					seen.push(p);
					return p === phantom ? path.join(fixtureDir, 'char-person.js') : p;
				};
				const Linking = linking('phantom/char-person');
				const Resolved = await Linking._resolveModelClass(
					'phantom/char-person',
				);
				expect(Resolved).to.equal(CharPerson);
				expect(seen).to.include(phantom);
			});

			it('__YASS_DEF_PATH_MAP__: maps a definition file name to its real path', () => {
				globalThis.__YASS_DEF_PATH_MAP__ = {
					'char-plain-def': path.join(fixtureDir, 'defs', 'char-plain-def.js'),
				};
				const Model = YassORM.loadDefinition('./bundled/char-plain-def');
				expect(Model.table()).to.equal('yass_char_mapped_def');
			});

			// Rubber's Bun build does not set this global at run time: it passes
			// `define: { 'globalThis.__YASS_DEF_PATH_MAP__': <json> }` to
			// Bun.build (backend/scripts/build/bun/build-simple-agent.ts), which
			// replaces that exact expression in yass's source text. So the lookup
			// must stay spelled `globalThis.__YASS_DEF_PATH_MAP__` in lib/, not
			// read through an alias (`const g = globalThis; g[key]`) or a helper
			// that owns the globals: the test above would still pass, and every
			// bundled model definition would stop resolving.
			it('__YASS_DEF_PATH_MAP__ is read as the literal expression Bun `define` replaces', () => {
				const libDir = path.join(root, 'lib');
				const readers = fs
					.readdirSync(libDir)
					.filter((file) => file.endsWith('.js'))
					.filter((file) =>
						/(^|[^.\w])globalThis\.__YASS_DEF_PATH_MAP__\b/.test(
							fs
								.readFileSync(path.join(libDir, file), 'utf8')
								.split('\n')
								.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
								.join('\n'),
						),
					);
				expect(readers).to.not.deep.equal([]);
			});

			it('__YASS_ORM_DEFINITION_INDEX__: registerDefinition() fills it, loadDefinition() reads it', () => {
				const definition = ({ types: t }) => ({
					table: 'yass_char_registered_def',
					schema: { id: t.idKey },
				});
				YassORM.registerDefinition('char-registered-def', definition);
				expect(
					globalThis.__YASS_ORM_DEFINITION_INDEX__.get(
						'defs/char-registered-def',
					),
				).to.equal(definition);
				const Model = YassORM.loadDefinition('./defs/char-registered-def');
				expect(Model.table()).to.equal('yass_char_registered_def');
			});
		});
	});
});
