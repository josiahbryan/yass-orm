/* global describe, it, before */
const { expect } = require('chai');
const { spawnSync } = require('child_process');
const path = require('path');

const config = require('../lib/config');
const pkg = require('../package.json');
const {
	requireOptional,
	MISSING_DEPENDENCY,
} = require('../lib/optional-dependency');
const { getDialect } = require('../lib/dialects');

/**
 * `pg`, `better-sqlite3` and `node-sql-parser` are optional (3.0): a consumer
 * installs only the drivers its dialects use. Each is loaded the first time
 * something needs it, and a missing one fails with an error that names it.
 *
 * "Missing" is simulated in a child process with test/fixtures/block-modules.js,
 * which makes the listed packages fail to resolve exactly as an uninstalled
 * package does.
 */

const OPTIONAL = ['pg', 'better-sqlite3', 'node-sql-parser'];
const rootDir = path.resolve(__dirname, '..');
const blocker = path.join(__dirname, 'fixtures', 'block-modules.js');

// Run `script` (CommonJS: no top-level await) or `args` in a fresh node with
// `blocked` packages unresolvable; returns spawnSync's result.
const runChild = (script, { blocked = [], args = [], env = {} } = {}) => {
	const result = spawnSync(
		process.execPath,
		['--require', blocker, ...(script ? ['-e', script] : []), ...args],
		{
			cwd: rootDir,
			env: {
				...process.env,
				YASS_BLOCK_MODULES: blocked.join(','),
				ROOT: rootDir,
				...env,
			},
			encoding: 'utf8',
		},
	);
	return result;
};

const lastJson = (result) => {
	const lines = `${result.stdout || ''}`.trim().split('\n');
	try {
		return JSON.parse(lines[lines.length - 1]);
	} catch (err) {
		throw new Error(
			`child printed no JSON (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
		);
	}
};

// Catch what `fn` throws or rejects with, as a plain object the parent can check.
const CAPTURE = `
	const capture = async (fn) => {
		try {
			await fn();
			return { threw: false };
		} catch (err) {
			return { threw: true, code: err.code, message: err.message };
		}
	};
`;

describe('#optional dependencies', function optionalDepsSuite() {
	this.timeout(60000);

	describe('package.json', () => {
		it('lists pg, better-sqlite3 and node-sql-parser as optional peers, not dependencies', () => {
			OPTIONAL.forEach((name) => {
				expect(pkg.dependencies, name).to.not.have.property(name);
				expect(pkg.optionalDependencies || {}, name).to.not.have.property(name);
				expect(pkg.peerDependencies, name).to.have.property(name);
				expect(pkg.peerDependenciesMeta[name], name).to.deep.equal({
					optional: true,
				});
				// Still installed here, so the suite can test every dialect.
				expect(pkg.devDependencies, name).to.have.property(name);
			});
		});

		it('keeps mariadb, the default dialect, a regular dependency', () => {
			expect(pkg.dependencies).to.have.property('mariadb');
			expect(pkg.peerDependencies || {}).to.not.have.property('mariadb');
		});
	});

	describe('requireOptional()', () => {
		it('returns an installed package', () => {
			expect(requireOptional('chai', { feature: 'a test' }).expect).to.equal(
				expect,
			);
		});

		it('names a missing package, what needs it, and how to install it', () => {
			let caught;
			try {
				requireOptional('yass-orm-no-such-package', {
					feature: 'the widget dialect',
				});
			} catch (err) {
				caught = err;
			}
			expect(caught, 'should throw').to.be.an('error');
			expect(caught.code).to.equal(MISSING_DEPENDENCY);
			expect(caught.message).to.include('"yass-orm-no-such-package"');
			expect(caught.message).to.include('the widget dialect');
			expect(caught.message).to.include('npm install yass-orm-no-such-package');
			expect(caught.cause && caught.cause.code).to.equal('MODULE_NOT_FOUND');
		});

		it('puts the supported version range in the install hint for a known peer', () => {
			const result = runChild(
				`${CAPTURE}
				const { requireOptional } = require(process.env.ROOT + '/lib/optional-dependency');
				capture(() => requireOptional('pg', { feature: 'x' })).then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: ['pg'] },
			);
			const out = lastJson(result);
			expect(out.message).to.include(
				`npm install pg@"${pkg.peerDependencies.pg}"`,
			);
		});

		it("does not blame the package when one of the package's own imports is missing", () => {
			// pg is installed, but pg-types (which pg requires) is not: that is a broken
			// install of pg, not a missing pg, and the original error must come through.
			const result = runChild(
				`${CAPTURE}
				const { requireOptional } = require(process.env.ROOT + '/lib/optional-dependency');
				capture(() => requireOptional('pg', { feature: 'x' })).then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: ['pg-types'] },
			);
			const out = lastJson(result);
			expect(out.threw).to.equal(true);
			expect(out.code).to.equal('MODULE_NOT_FOUND');
			expect(out.message).to.include("'pg-types'");
		});
	});

	describe('with every driver installed', () => {
		it('SQLite runs a query (better-sqlite3 and node-sql-parser)', async () => {
			const db = await getDialect('sqlite').createPool({
				filename: ':memory:',
			});
			try {
				const [row] = await db.pquery('select :a + 1 as two', { a: 1 });
				expect(Number(row.two)).to.equal(2);
			} finally {
				await db.end();
			}
		});

		it('Postgres rewrites named parameters (node-sql-parser)', () => {
			const out = getDialect('postgres').transformSql(
				'select * from t where a = :a',
				{ a: 1 },
			);
			expect(out.sql).to.match(/\$1/);
		});

		it('Postgres loads pg when it builds a pool', async () => {
			// The pool connects lazily, so this doesn't need a server.
			const pool = await getDialect('postgres').createPool({
				host: '127.0.0.1',
				port: 1,
				user: 'nobody',
				password: 'x',
				schema: 'none',
			});
			expect(pool).to.be.an('object');
			await pool.end();
		});
	});

	describe('with pg, better-sqlite3 and node-sql-parser all missing', () => {
		it('requiring yass-orm and all its modules still works', () => {
			const result = runChild(
				`const lib = require(process.env.ROOT + '/lib');
				require(process.env.ROOT + '/lib/sync-to-db');
				require(process.env.ROOT + '/lib/dialects');
				const loaded = Object.keys(require.cache).filter((f) => /node_modules\\/(pg|better-sqlite3|node-sql-parser)\\//.test(f));
				console.log(JSON.stringify({ ok: typeof lib.loadDefinition === 'function', loaded }));`,
				{ blocked: OPTIONAL },
			);
			const out = lastJson(result);
			expect(out).to.deep.equal({ ok: true, loaded: [] });
		});

		it('Postgres names pg when it builds a pool', () => {
			const result = runChild(
				`${CAPTURE}
				const { getDialect } = require(process.env.ROOT + '/lib/dialects');
				capture(() => getDialect('postgres').createPool({ host: '127.0.0.1', port: 1 }))
					.then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: OPTIONAL },
			);
			const out = lastJson(result);
			expect(out.threw).to.equal(true);
			expect(out.code).to.equal(MISSING_DEPENDENCY);
			expect(out.message).to.include('"pg"');
			expect(out.message).to.include('PostgreSQL');
		});

		it('SQLite names better-sqlite3 when it opens a database', () => {
			const result = runChild(
				`${CAPTURE}
				const { getDialect } = require(process.env.ROOT + '/lib/dialects');
				capture(() => getDialect('sqlite').createPool({ filename: ':memory:' }))
					.then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: OPTIONAL },
			);
			const out = lastJson(result);
			expect(out.threw).to.equal(true);
			expect(out.code).to.equal(MISSING_DEPENDENCY);
			expect(out.message).to.include('"better-sqlite3"');
			expect(out.message).to.include('SQLite');
		});

		it('comparing a partial index predicate names node-sql-parser', () => {
			const result = runChild(
				`${CAPTURE}
				const { canonicalizeIndexPredicateViaAst } = require(process.env.ROOT + '/lib/sql-transform/indexPredicate');
				capture(() => canonicalizeIndexPredicateViaAst('a = 1')).then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: OPTIONAL },
			);
			const out = lastJson(result);
			expect(out.threw).to.equal(true);
			expect(out.code).to.equal(MISSING_DEPENDENCY);
			expect(out.message).to.include('"node-sql-parser"');
		});
	});

	describe('with only node-sql-parser missing', () => {
		it('Postgres names node-sql-parser instead of sending the SQL untransformed', () => {
			const result = runChild(
				`${CAPTURE}
				const { getDialect } = require(process.env.ROOT + '/lib/dialects');
				capture(() => getDialect('postgres').transformSql('select :a', { a: 1 }))
					.then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: ['node-sql-parser'] },
			);
			const out = lastJson(result);
			expect(out.threw).to.equal(true);
			expect(out.code).to.equal(MISSING_DEPENDENCY);
			expect(out.message).to.include('"node-sql-parser"');
			expect(out.message).to.include('PostgreSQL');
		});

		it('SQLite names node-sql-parser when it runs a query', () => {
			const result = runChild(
				`${CAPTURE}
				const { getDialect } = require(process.env.ROOT + '/lib/dialects');
				capture(async () => {
					const db = await getDialect('sqlite').createPool({ filename: ':memory:' });
					try { await db.pquery('select :a as a', { a: 1 }); } finally { await db.end(); }
				}).then((r) => console.log(JSON.stringify(r)));`,
				{ blocked: ['node-sql-parser'] },
			);
			const out = lastJson(result);
			expect(out.threw).to.equal(true);
			expect(out.code).to.equal(MISSING_DEPENDENCY);
			expect(out.message).to.include('"node-sql-parser"');
			expect(out.message).to.include('SQLite');
		});
	});

	describe('MySQL with none of the optional packages installed', () => {
		before(function mysqlOnly() {
			if ((config.dialect || 'mysql') !== 'mysql') {
				this.skip();
			}
		});

		it('syncs a schema (bin/schema-sync)', () => {
			const result = runChild(null, {
				blocked: OPTIONAL,
				args: [
					path.join(rootDir, 'bin', 'schema-sync'),
					path.join(__dirname, 'fakeSchema.js'),
				],
			});
			expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0);
			expect(result.stderr).to.not.match(/node-sql-parser|better-sqlite3/);
		});

		it('creates, reads and deletes a model row', () => {
			const result = runChild(
				`const YassORM = require(process.env.ROOT + '/lib');
				const { dbh, closeAllConnections } = require(process.env.ROOT + '/lib/dbh');
				(async () => {
					const Model = YassORM.loadDefinition(require(process.env.ROOT + '/test/fakeSchema').default);
					const row = await Model.create({ name: 'optional-deps' });
					const [back] = await (await dbh()).pquery('select name from yass_test1 where id=:id', row);
					await row.reallyDelete();
					const loaded = Object.keys(require.cache).filter((f) => /node_modules\\/(pg|better-sqlite3|node-sql-parser)\\//.test(f));
					console.log(JSON.stringify({ name: back.name, loaded }));
					await closeAllConnections();
				})().catch((err) => { console.log(JSON.stringify({ error: err.message })); process.exitCode = 1; });`,
				{ blocked: OPTIONAL },
			);
			expect(lastJson(result)).to.deep.equal({
				name: 'optional-deps',
				loaded: [],
			});
		});
	});
});
