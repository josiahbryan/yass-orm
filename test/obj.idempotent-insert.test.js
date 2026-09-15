/* eslint-disable no-console */
/* eslint-disable no-unused-expressions */
/* global describe, it, before, after, beforeEach, afterEach */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const Orm = require('../lib/index');
const { dbh } = require('../lib/dbh');

/**
 * BC-3823 — `Model.createIgnore`, the model-layer face of `dbh.createIgnore`.
 *
 * WHY SQLITE, AND WHY A HAND-BUILT TABLE. The race arms need a real UNIQUE
 * constraint and real concurrency, and they need the collision to be
 * DETERMINISTIC rather than lucky. A local SQLite file gives both with no
 * server, and `dbh({ dialect: 'sqlite' })` resolves the dialect PER
 * CONNECTION (lib/dbh.js:454,531), so this suite runs under the repo's
 * default MySQL config without a special npm script — a test that only runs
 * when someone remembers a `YASS_CONFIG=` prefix is a test that does not run.
 * The models are pointed at that connection by overriding the static `dbh()`,
 * which is the single seam `_runOn` resolves its handle through
 * (lib/obj.js:432).
 *
 * 🔴 READ THIS BEFORE ADDING A "BETTER" END-TO-END TEST OF `conflictColumns`.
 * No dialect's `buildInsertIgnoreSql` currently READS `conflictColumns`:
 * MySQLDialect.js:285, SQLiteDialect.js:266 and PostgresDialect.js:300 each
 * take the parameter and each carry an explicit `eslint-disable
 * no-unused-vars` over it. So a WRONG derivation emits byte-identical SQL on
 * every dialect and every insert still behaves correctly — an end-to-end
 * insert is structurally incapable of failing on it. (Contrast
 * `buildUpsertSql`, which genuinely requires it: SQLiteDialect.js:290 THROWS
 * without it. That is the sibling method, and it is why the parameter is
 * worth resolving correctly even while inert here.)
 *
 * The derivation is therefore pinned at the only two layers where it CAN
 * fail:
 *   1. `resolveConflictColumns` called directly — deterministic, total.
 *   2. a SPY on `conn.createIgnore` proving the resolved value actually
 *      REACHES the connection layer. Without (2), (1) could be perfect while
 *      `createIgnore` passed `undefined` down and nothing would notice.
 */

const tempFile = path.join('/tmp', `yass-obj-idempotent-${process.pid}.sqlite`);

/** One unique index, plus non-unique shorthands that must NOT be candidates. */
const pairDef = ({ types: t }) => ({
	table: 'ci_pair',
	schema: {
		id: t.uuidKey,
		tenant: t.string,
		itemKey: t.string,
		note: t.string,
	},
	indexes: {
		// Array shorthand cannot carry `unique`, so it can never pollute the
		// derivation. This is the same shape as the `isDeleted` index
		// schema-sync injects into every table.
		tenantIdx: ['tenant'],
		pairIdx: { columns: ['tenant', 'itemKey'], unique: true },
	},
	includeCommonFields: false,
});

/** Two unique indexes -> ambiguous, must throw unless `uniqueIndex` names one. */
const twoUniqueDef = ({ types: t }) => ({
	table: 'ci_two_unique',
	schema: {
		id: t.uuidKey,
		alpha: t.string,
		beta: t.string,
	},
	indexes: {
		// Deliberately spelled `cols` here and `columns` above: both are
		// accepted aliases and the shared resolver must read either.
		alphaIdx: { cols: ['alpha'], unique: true },
		betaIdx: { columns: ['beta'], unique: true },
		notUnique: { columns: ['alpha', 'beta'] },
	},
	includeCommonFields: false,
});

/**
 * `unique: 1` rather than `unique: true`. schema-sync emits a REAL unique
 * index for this (it tests truthiness), so the deriver must see it too --
 * a strict `=== true` here made the DDL emitter and the deriver disagree.
 */
const truthyUniqueDef = ({ types: t }) => ({
	table: 'ci_truthy_unique',
	schema: { id: t.uuidKey, slug: t.string },
	indexes: { slugIdx: { columns: ['slug'], unique: 1 } },
	includeCommonFields: false,
});

/** Zero unique indexes -> no derivable conflict target, must throw. */
const noUniqueDef = ({ types: t }) => ({
	table: 'ci_no_unique',
	schema: { id: t.uuidKey, label: t.string },
	indexes: { labelIdx: ['label'] },
	includeCommonFields: false,
});

describe('#Model.createIgnore (BC-3823)', function suite() {
	this.timeout(30000);

	let conn;
	let Pair;
	let TwoUnique;
	let NoUnique;
	let TruthyUnique;

	/** Bind a loaded model to this suite's SQLite handle. */
	const bind = (Model) => {
		// eslint-disable-next-line no-param-reassign
		Model.dbh = async () => conn;
		return Model;
	};

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempFile,
			ignoreCachedConnections: true,
		});

		Pair = bind(await Orm.loadDefinition(pairDef));
		TwoUnique = bind(await Orm.loadDefinition(twoUniqueDef));
		NoUnique = bind(await Orm.loadDefinition(noUniqueDef));
		TruthyUnique = bind(await Orm.loadDefinition(truthyUniqueDef));
	});

	beforeEach(async () => {
		// Fresh table per test — no inter-test ordering dependency, and a
		// `--grep` run of any single test still works.
		await conn.query('DROP TABLE IF EXISTS ci_pair');
		await conn.query(`
			CREATE TABLE ci_pair (
				id TEXT PRIMARY KEY,
				tenant TEXT NOT NULL,
				itemKey TEXT NOT NULL,
				note TEXT,
				isDeleted INTEGER DEFAULT 0,
				createdAt TEXT,
				updatedAt TEXT,
				UNIQUE (tenant, itemKey)
			)
		`);
		Pair.clearCache();
	});

	after(async () => {
		// 🔴 DELIBERATELY *NOT* `closeAllConnections()`. That closes the SHARED
		// MySQL pool that later suites in the same mocha process depend on —
		// measured on this file: calling it took the full run from 9 failing
		// to 82 failing, all `pool is closed`, in suites that have nothing to
		// do with this one. `test/obj.transaction.test.js` carries the same
		// warning in its own `after()`. Close only the handle this suite
		// opened; it is keyed to a private sqlite file, so nothing else can be
		// holding it.
		if (conn && typeof conn.end === 'function') {
			await conn.end();
		}
		try {
			fs.unlinkSync(tempFile);
		} catch (err) {
			/* ignore */
		}
	});

	const physicalRows = async () =>
		Array.from(await conn.pquery('select * from ci_pair', {}));

	// ====================================================================
	// THE DISCRIMINATING PAIR. Both arms hit the SAME table through the SAME
	// connection in the SAME file, so neither can be a different-instrument
	// artifact. The RED arm is what makes the GREEN arm mean anything: it
	// proves a duplicate-key error IS reachable here. Without it, "no throw"
	// is equally consistent with "the constraint does not exist".
	// ====================================================================
	describe('race closure (red control + green)', () => {
		it('RED CONTROL: two concurrent create() on one unique pair — at least one THROWS', async () => {
			const results = await Promise.allSettled([
				Pair.create({ tenant: 'acme', itemKey: 'k-red', note: 'a' }),
				Pair.create({ tenant: 'acme', itemKey: 'k-red', note: 'b' }),
			]);

			const rejected = results.filter((r) => r.status === 'rejected');

			expect(
				rejected.length,
				'INSTRUMENT DEAD: two concurrent create() of the same unique pair did ' +
					'NOT produce a duplicate-key error, which means the UNIQUE ' +
					'constraint on (tenant, itemKey) is absent on this database. The ' +
					'green arm below cannot distinguish "race closed" from "no ' +
					'constraint" and proves NOTHING until this passes.',
			).to.be.greaterThan(0);

			// And the surviving state is still exactly one row — i.e. the
			// constraint is doing the work, not luck.
			expect((await physicalRows()).length).to.equal(1);
		});

		it('GREEN: two concurrent createIgnore() on one unique pair — ZERO throws, exactly one insert', async () => {
			const results = await Promise.allSettled([
				Pair.createIgnore({ tenant: 'acme', itemKey: 'k-green', note: 'a' }),
				Pair.createIgnore({ tenant: 'acme', itemKey: 'k-green', note: 'b' }),
			]);

			const rejected = results.filter((r) => r.status === 'rejected');
			expect(
				rejected.map((r) => String(r.reason)),
				'createIgnore must never surface a duplicate-key error',
			).to.deep.equal([]);

			const values = results.map((r) => r.value);
			const inserted = values.filter((v) => v !== null);
			const skipped = values.filter((v) => v === null);

			expect(inserted.length, 'exactly ONE caller may insert').to.equal(1);
			expect(skipped.length, 'the other must get null, not a row').to.equal(1);
			expect(
				(await physicalRows()).length,
				'exactly one PHYSICAL row — 0 means both no-opped, 2 means the ' +
					'constraint did not hold',
			).to.equal(1);
		});
	});

	// ====================================================================
	// Basic contract
	// ====================================================================
	describe('contract', () => {
		it('returns an inflated instance when the row is actually inserted', async () => {
			const row = await Pair.createIgnore({
				tenant: 'acme',
				itemKey: 'k1',
				note: 'hello',
			});
			expect(row).to.exist;
			expect(row.id).to.be.a('string');
			expect(row.tenant).to.equal('acme');
			expect(row.note).to.equal('hello');
			expect(row).to.be.instanceOf(Pair);
		});

		it('returns null — not a throw, not the occupant — on a UNIQUE conflict', async () => {
			await Pair.createIgnore({ tenant: 'acme', itemKey: 'k2', note: 'first' });
			const second = await Pair.createIgnore({
				tenant: 'acme',
				itemKey: 'k2',
				note: 'second',
			});

			expect(second).to.equal(null);

			const rows = await physicalRows();
			expect(rows.length).to.equal(1);
			expect(
				rows[0].note,
				'the conflicting insert must not have overwritten the occupant',
			).to.equal('first');
		});

		it('still throws on a NON-conflict error (missing NOT NULL column)', async () => {
			let threw = null;
			try {
				// `tenant` is NOT NULL with no default.
				await Pair.createIgnore({ itemKey: 'k3' });
			} catch (err) {
				threw = err;
			}
			expect(
				threw,
				'a NOT NULL violation is not a conflict and must NOT be swallowed',
			).to.exist;
		});
	});

	// ====================================================================
	// Hooks — invisible in the consumer, so asserted here.
	// ====================================================================
	describe('change hooks', () => {
		let unregister;
		let received;

		beforeEach(() => {
			received = [];
			unregister = Orm.registerGlobalChangeHook((payload) =>
				received.push(payload),
			);
		});

		afterEach(() => {
			if (unregister) unregister();
		});

		it('inserted path fires afterCreateHook, afterChangeHook and the global hook exactly once', async () => {
			const fired = [];
			const OriginalAfterCreate = Pair.prototype.afterCreateHook;
			const OriginalAfterChange = Pair.prototype.afterChangeHook;
			Pair.prototype.afterCreateHook = async function afterCreate(opts) {
				fired.push('afterCreateHook');
				return OriginalAfterCreate.call(this, opts);
			};
			Pair.prototype.afterChangeHook = async function afterChange(opts) {
				fired.push('afterChangeHook');
				return OriginalAfterChange.call(this, opts);
			};

			try {
				const row = await Pair.createIgnore({
					tenant: 'acme',
					itemKey: 'k-hooks',
					note: 'n',
				});

				expect(fired).to.deep.equal(['afterCreateHook', 'afterChangeHook']);
				expect(
					received.length,
					'global change hook fires exactly once',
				).to.equal(1);
				expect(received[0].wasCreated).to.equal(true);
				expect(received[0].id).to.equal(row.id);
				expect(received[0].modelName).to.equal(Pair.table());
				expect(received[0].changedFields).to.have.property('tenant', 'acme');
			} finally {
				Pair.prototype.afterCreateHook = OriginalAfterCreate;
				Pair.prototype.afterChangeHook = OriginalAfterChange;
			}
		});

		it('CONFLICT path fires NOTHING — a skipped insert is not a create', async () => {
			await Pair.createIgnore({ tenant: 'acme', itemKey: 'k-noh', note: 'a' });
			received.length = 0;

			const fired = [];
			const OriginalAfterCreate = Pair.prototype.afterCreateHook;
			Pair.prototype.afterCreateHook = async function afterCreate(opts) {
				fired.push('afterCreateHook');
				return OriginalAfterCreate.call(this, opts);
			};

			try {
				const result = await Pair.createIgnore({
					tenant: 'acme',
					itemKey: 'k-noh',
					note: 'b',
				});
				expect(result).to.equal(null);
				expect(fired, 'no instance hook may fire on a conflict').to.deep.equal(
					[],
				);
				expect(
					received,
					'no global change hook may fire on a conflict — subscribers would ' +
						'be told a row appeared when none did',
				).to.deep.equal([]);
			} finally {
				Pair.prototype.afterCreateHook = OriginalAfterCreate;
			}
		});
	});

	// ====================================================================
	// conflictColumns derivation. See the header: this is the ONLY layer at
	// which a wrong derivation is observable today.
	// ====================================================================
	describe('resolveConflictColumns (derivation)', () => {
		it('derives from the single unique index, ignoring non-unique shorthands', () => {
			expect(Pair.resolveConflictColumns()).to.deep.equal([
				'tenant',
				'itemKey',
			]);
		});

		it('reads the `cols` alias as well as `columns`', () => {
			expect(
				TwoUnique.resolveConflictColumns({ uniqueIndex: 'alphaIdx' }),
			).to.deep.equal(['alpha']);
			expect(
				TwoUnique.resolveConflictColumns({ uniqueIndex: 'betaIdx' }),
			).to.deep.equal(['beta']);
		});

		it('uses an explicit conflictColumns VERBATIM, with no derivation', () => {
			expect(
				Pair.resolveConflictColumns({ conflictColumns: ['note'] }),
			).to.deep.equal(['note']);
			// Even on a model where derivation would THROW.
			expect(
				NoUnique.resolveConflictColumns({ conflictColumns: ['label'] }),
			).to.deep.equal(['label']);
		});

		it('accepts `unique: 1`, matching what schema-sync actually emits DDL for', () => {
			// sync-to-db decides uniqueness with a TRUTHY test, so `unique: 1`
			// produces a real UNIQUE index. A strict `=== true` here made the
			// deriver blind to an index that physically exists and throw
			// "declares no unique:true index" on a model that has one. Both
			// sides now read isUniqueIndexSpec from one module.
			expect(TruthyUnique.resolveConflictColumns()).to.deep.equal(['slug']);
		});

		it('THROWS when two unique indexes make the target ambiguous, naming both', () => {
			expect(() => TwoUnique.resolveConflictColumns()).to.throw(
				/2 unique indexes.*alphaIdx.*betaIdx.*uniqueIndex/s,
			);
		});

		it('THROWS when the model declares no unique index at all', () => {
			expect(() => NoUnique.resolveConflictColumns()).to.throw(
				/no 'unique: true' index/,
			);
		});

		it('THROWS when the named uniqueIndex does not exist', () => {
			expect(() =>
				Pair.resolveConflictColumns({ uniqueIndex: 'nopeIdx' }),
			).to.throw(/uniqueIndex 'nopeIdx' is not declared/);
		});

		it('THROWS when the named index exists but is NOT unique', () => {
			expect(() =>
				TwoUnique.resolveConflictColumns({ uniqueIndex: 'notUnique' }),
			).to.throw(/is NOT 'unique: true'/);
		});

		it('never returns undefined — an unresolvable target is an error, not a default', () => {
			// The reassuring-direction failure this guards: undefined is inert
			// on every dialect TODAY, so a fall-through would ship a defect
			// that only wakes up when a dialect starts emitting a targeted
			// conflict clause.
			[
				() => NoUnique.resolveConflictColumns(),
				() => TwoUnique.resolveConflictColumns(),
				() => Pair.resolveConflictColumns({ uniqueIndex: 'tenantIdx' }),
			].forEach((fn) => {
				let value;
				let threw = false;
				try {
					value = fn();
				} catch (err) {
					threw = true;
				}
				expect(
					threw,
					`expected a throw, got ${JSON.stringify(value)}`,
				).to.equal(true);
			});
		});

		it('createIgnore() rejects (does not insert) when the target is underivable', async () => {
			await conn.query('DROP TABLE IF EXISTS ci_no_unique');
			await conn.query(
				`CREATE TABLE ci_no_unique (id TEXT PRIMARY KEY, label TEXT, isDeleted INTEGER DEFAULT 0, createdAt TEXT, updatedAt TEXT)`,
			);

			let threw = null;
			try {
				await NoUnique.createIgnore({ label: 'x' });
			} catch (err) {
				threw = err;
			}
			expect(threw, 'must throw rather than insert').to.exist;
			expect(String(threw)).to.match(/no 'unique: true' index/);

			const rows = Array.from(
				await conn.pquery('select * from ci_no_unique', {}),
			);
			expect(
				rows.length,
				'the throw must happen BEFORE the write, not after',
			).to.equal(0);
		});

		it('SPY: the derived columns actually REACH conn.createIgnore', async () => {
			// Without this arm the derivation could be perfect while
			// createIgnore passed `undefined` down, and — because no dialect
			// reads the value — every other test in this file would still pass.
			const seen = [];
			const original = conn.createIgnore;
			conn.createIgnore = async function spy(table, fields, opts) {
				seen.push({ table, opts });
				return original.call(this, table, fields, opts);
			};

			try {
				await Pair.createIgnore({ tenant: 'acme', itemKey: 'k-spy' });
				await Pair.createIgnore(
					{
						tenant: 'acme',
						itemKey: 'k-spy2',
						// explicit override must win over derivation
						// eslint-disable-next-line no-undef
					},
					{ conflictColumns: ['note'] },
				);
			} finally {
				conn.createIgnore = original;
			}

			expect(seen.length).to.equal(2);
			expect(seen[0].table).to.equal('ci_pair');
			expect(
				seen[0].opts.conflictColumns,
				'the DERIVED target must reach the connection layer',
			).to.deep.equal(['tenant', 'itemKey']);
			expect(
				seen[1].opts.conflictColumns,
				'an explicit override must reach the connection layer unchanged',
			).to.deep.equal(['note']);
		});
	});
});
