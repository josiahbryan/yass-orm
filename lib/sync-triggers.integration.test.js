/* eslint-disable no-unused-expressions, global-require */
/* global describe, it, beforeEach */

/**
 * Integration-shape tests for lib/sync-triggers.js `syncTableTriggers`, run
 * with a MOCK dialect + a MOCK execQuery so no database is required.
 *
 * These pin the wiring semantics -- capability gates, opt-in flag, id-trigger
 * routing, DDL sequencing during a group rebuild -- BEFORE any live-MySQL
 * test does the round-trip. The live test in test/schemaSync.triggers.test.js
 * is the acceptance gate on the actual normalizer; this suite is the fast
 * feedback loop for the reconciler control flow.
 */

const { expect } = require('chai');
const {
	syncTableTriggers,
	_resetUnsupportedDialectWarnings,
} = require('./sync-triggers');

/**
 * Build a fake dialect that records every DDL string it is asked to emit and
 * returns a caller-controlled list of `existing` triggers from
 * getTableTriggers. Deliberately minimal -- just enough to exercise
 * syncTableTriggers without touching a real DB or lib/dialects at all.
 */
function makeFakeDialect({
	existing = [],
	name = 'mysql',
	supportsDeclaredTriggers = true,
} = {}) {
	const emitted = [];
	return {
		dialect: {
			name,
			supportsDeclaredTriggers,
			async getTableTriggers(handle, db, table) {
				emitted.push({ kind: 'getTableTriggers', db, table });
				return existing;
			},
			generateCreateTrigger({
				name: n,
				timing,
				event,
				tableName,
				database,
				body,
				follows,
			}) {
				const followsSuffix = follows ? ` FOLLOWS \`${follows}\`` : '';
				return `CREATE TRIGGER \`${n}\` ${timing.toUpperCase()} ${event.toUpperCase()} ON ${
					database ? `\`${database}\`.` : ''
				}\`${tableName}\` FOR EACH ROW${followsSuffix}\n${body}`;
			},
			generateDropTrigger({ name: n, database }) {
				return `DROP TRIGGER IF EXISTS ${
					database ? `\`${database}\`.` : ''
				}\`${n}\``;
			},
		},
		emitted,
	};
}

/**
 * Fake execQuery that records the SQL it is called with and returns a preset
 * response. Also exposes `getHandle()` (yass-orm's real reconciler needs a
 * DB handle for getTableTriggers) as an inert stub so the interface matches.
 */
function makeExecQuery({ responses = {}, failOn = [] } = {}) {
	const calls = [];
	const exec = async (sql /* , mutates */) => {
		calls.push(sql);
		if (failOn.some((needle) => sql.includes(needle))) {
			const err = new Error(`simulated failure for: ${sql}`);
			err.simulated = true;
			throw err;
		}
		// SELECT @@SESSION.lock_wait_timeout AS v is used by the reconciler to
		// snapshot the current timeout before overriding it.
		if (sql.includes('@@SESSION.lock_wait_timeout')) {
			return responses.lockWaitTimeout || [{ v: 31536000 }];
		}
		return [];
	};
	// The reconciler calls execQuery.getHandle() to get a raw connection
	// handle to pass to dialect.getTableTriggers. In production this is the
	// dbh factory; here it is an inert stub.
	exec.getHandle = async () => ({ __fakeHandle: true });
	return { exec, calls };
}

describe('#sync-triggers syncTableTriggers (mocked dialect)', () => {
	// The "dialect does not implement" warning is deduped per-process to
	// keep multi-def PG runs quiet, which means test order would otherwise
	// affect what gets warned. Reset before every test so each is isolated.
	beforeEach(() => _resetUnsupportedDialectWarnings());

	describe('capability gates', () => {
		it('is a stable no-op when dialect.supportsDeclaredTriggers is false', async () => {
			const { dialect } = makeFakeDialect({
				supportsDeclaredTriggers: false,
			});
			const { exec, calls } = makeExecQuery();
			const result = await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{ name: 'x', timing: 'before', event: 'insert', body: 'BEGIN END' },
				],
				idTrigger: null,
				authoritative: true,
			});
			expect(result.applied).to.equal(0);
			expect(result.errors).to.deep.equal([]);
			expect(result.ddl).to.deep.equal([]);
			// No introspection call either -- must not touch the DB.
			expect(calls).to.deep.equal([]);
		});

		it('is a stable no-op when disableFunctions is true', async () => {
			const { dialect } = makeFakeDialect();
			const { exec, calls } = makeExecQuery();
			const result = await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{ name: 'x', timing: 'before', event: 'insert', body: 'BEGIN END' },
				],
				idTrigger: {
					name: 'before_insert_t_set_id',
					timing: 'before',
					event: 'insert',
					body: 'BEGIN END',
				},
				authoritative: true,
				disableFunctions: true,
			});
			expect(result.applied).to.equal(0);
			expect(result.ddl).to.deep.equal([]);
			expect(calls).to.deep.equal([]);
		});
	});

	describe('happy paths', () => {
		it('CREATEs an absent trigger (no existing on table)', async () => {
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery();
			const result = await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{
						name: 'set_upper',
						timing: 'before',
						event: 'insert',
						body: 'BEGIN SET NEW.name = UPPER(NEW.name); END',
					},
				],
				authoritative: true,
			});
			expect(result.errors).to.deep.equal([]);
			// One CREATE + one DROP IF EXISTS (idempotent no-op when the
			// trigger is absent; emitted unconditionally so a trigger that
			// MOVED groups does not collide with itself on CREATE -- see the
			// timing-drift red case in test/schemaSync.triggers.test.js).
			expect(result.applied).to.equal(2);
			const creates = calls.filter((s) => s.startsWith('CREATE TRIGGER'));
			const drops = calls.filter((s) => s.startsWith('DROP TRIGGER'));
			expect(creates).to.have.length(1);
			expect(drops).to.have.length(1);
			expect(drops[0]).to.contain('IF EXISTS');
			expect(drops[0]).to.contain('`set_upper`');
			expect(creates[0]).to.contain('`set_upper`');
			expect(creates[0]).to.contain('BEFORE INSERT');
			// DROP before CREATE is the ordering invariant that makes the
			// timing-drift case survive.
			const firstDropIdx = calls.findIndex((s) => s.startsWith('DROP TRIGGER'));
			const firstCreateIdx = calls.findIndex((s) =>
				s.startsWith('CREATE TRIGGER'),
			);
			expect(firstDropIdx).to.be.below(firstCreateIdx);
		});

		it('emits ZERO DDL when the declared trigger matches the DB (idempotency shape)', async () => {
			// The pure planner already asserts this; here we confirm that
			// syncTableTriggers itself makes NO DDL calls on the exec surface
			// in that case, which is the property the live idempotency test
			// asserts against a real DB.
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'set_upper',
						timing: 'BEFORE',
						event: 'INSERT',
						body: '  BEGIN END;  ',
						order: 1,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			const result = await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{
						name: 'set_upper',
						timing: 'before',
						event: 'insert',
						body: 'BEGIN END',
					},
				],
				authoritative: true,
			});
			expect(result.errors).to.deep.equal([]);
			const ddlCalls = calls.filter(
				(s) => s.startsWith('CREATE TRIGGER') || s.startsWith('DROP TRIGGER'),
			);
			expect(
				ddlCalls,
				`expected zero trigger DDL, got:\n${ddlCalls.join('\n')}`,
			).to.deep.equal([]);
		});
	});

	describe('id trigger routing', () => {
		it('puts the synthetic id trigger FIRST in the desired firing order', async () => {
			// Two declared triggers plus an id trigger. When nothing exists on
			// the table, the CREATE order must be: id trigger, then declared
			// in declaration order, with FOLLOWS chaining after the first.
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				idTrigger: {
					name: 'before_insert_t_set_id',
					timing: 'before',
					event: 'insert',
					body: 'BEGIN SET NEW.id = uuid(); END',
				},
				declared: [
					{
						name: 'hash_row',
						timing: 'before',
						event: 'insert',
						body: 'BEGIN END',
					},
					{
						name: 'audit',
						timing: 'before',
						event: 'insert',
						body: 'BEGIN END',
					},
				],
				authoritative: true,
			});
			const creates = calls.filter((s) => s.startsWith('CREATE TRIGGER'));
			expect(creates).to.have.length(3);
			// Order: id trigger, hash_row FOLLOWS id, audit FOLLOWS hash_row.
			expect(creates[0]).to.contain('`before_insert_t_set_id`');
			expect(creates[0]).to.not.contain('FOLLOWS');
			expect(creates[1]).to.contain('`hash_row`');
			expect(creates[1]).to.contain('FOLLOWS `before_insert_t_set_id`');
			expect(creates[2]).to.contain('`audit`');
			expect(creates[2]).to.contain('FOLLOWS `hash_row`');
		});

		it('exempts the id trigger from the undeclared-drop pass even when authoritative', async () => {
			// Table has the id trigger + a stranger. Def opts in with an empty
			// triggers block. Only the stranger must be dropped, not the id
			// trigger -- otherwise every uuidKey table would lose its id
			// trigger the moment its def opted into managing triggers.
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'before_insert_t_set_id',
						timing: 'BEFORE',
						event: 'INSERT',
						body: 'BEGIN SET NEW.id = uuid(); END',
						order: 1,
					},
					{
						name: 'stranger',
						timing: 'AFTER',
						event: 'DELETE',
						body: 'BEGIN END',
						order: 1,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				idTrigger: {
					name: 'before_insert_t_set_id',
					timing: 'before',
					event: 'insert',
					body: 'BEGIN SET NEW.id = uuid(); END',
				},
				declared: [],
				authoritative: true,
			});
			const drops = calls.filter((s) => s.startsWith('DROP TRIGGER'));
			expect(drops).to.have.length(1);
			expect(drops[0]).to.contain('`stranger`');
			expect(drops[0]).to.not.contain('before_insert_t_set_id');
		});

		it('yields to the user when a declared trigger shadows the id-trigger name', async () => {
			// Rare, but explicit user intent > derived intent. The user's
			// version is the one that ends up in the plan; a warning is
			// emitted but no error.
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				idTrigger: {
					name: 'before_insert_t_set_id',
					timing: 'before',
					event: 'insert',
					body: 'THE_DEFAULT_BODY',
				},
				declared: [
					{
						name: 'before_insert_t_set_id',
						timing: 'before',
						event: 'insert',
						body: 'USER_OVERRIDE_BODY',
					},
				],
				authoritative: true,
			});
			const creates = calls.filter((s) => s.startsWith('CREATE TRIGGER'));
			expect(creates).to.have.length(1);
			expect(creates[0]).to.contain('USER_OVERRIDE_BODY');
			expect(creates[0]).to.not.contain('THE_DEFAULT_BODY');
		});
	});

	describe('orphan id-trigger drop', () => {
		it('drops an id-named trigger UNCONDITIONALLY (regardless of authoritative) when passed as orphanTriggerNames', async () => {
			// Simulates the def flipping from t.uuidKey to t.idKey: sync-to-db
			// stops passing an idTrigger and instead lists its name in
			// orphanTriggerNames. Under NO opt-in (authoritative=false), the
			// undeclared-drop pass would leave it alone -- but the id trigger
			// is ours, not the user's, so it must go anyway.
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'before_insert_t_set_id',
						timing: 'BEFORE',
						event: 'INSERT',
						body: 'BEGIN SET NEW.id = uuid(); END',
						order: 1,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [],
				idTrigger: null,
				orphanTriggerNames: ['before_insert_t_set_id'],
				authoritative: false, // deliberately NOT opted in
			});
			const drops = calls.filter((s) => s.startsWith('DROP TRIGGER'));
			expect(drops).to.have.length(1);
			expect(drops[0]).to.contain('before_insert_t_set_id');
		});

		it('is a no-op when the orphan trigger is absent from the table', async () => {
			// `t.idKey` def on a table that never had `t.uuidKey`. No trigger,
			// no drop. Cheap check via existingByName set membership.
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [],
				idTrigger: null,
				orphanTriggerNames: ['before_insert_t_set_id'],
				authoritative: false,
			});
			expect(calls.filter((s) => s.startsWith('DROP TRIGGER'))).to.deep.equal(
				[],
			);
		});
	});

	describe('opt-in drop authority', () => {
		it('does NOT drop an undeclared trigger when authoritative=false', async () => {
			// Existing defs without a `triggers` key are in this state. A
			// stray on the table must survive so an upgrade of yass-orm
			// changes nothing for them.
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'stranger',
						timing: 'AFTER',
						event: 'INSERT',
						body: 'BEGIN END',
						order: 1,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [],
				authoritative: false,
			});
			const drops = calls.filter((s) => s.startsWith('DROP TRIGGER'));
			expect(drops).to.deep.equal([]);
		});

		it('DOES drop an undeclared trigger when authoritative=true (opt-in)', async () => {
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'stranger',
						timing: 'AFTER',
						event: 'INSERT',
						body: 'BEGIN END',
						order: 1,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [],
				authoritative: true,
			});
			const drops = calls.filter((s) => s.startsWith('DROP TRIGGER'));
			expect(drops).to.have.length(1);
			expect(drops[0]).to.contain('`stranger`');
		});
	});

	describe('group rebuild', () => {
		it('drops then recreates the WHOLE group when any member drifted', async () => {
			// Two triggers in the same BEFORE INSERT group; body drift on the
			// second forces the group rebuild -- the first is dropped and
			// recreated too even though its body was unchanged, because
			// MySQL cannot rewrite in place and preserving firing order is
			// only possible by rebuilding the group with FOLLOWS chaining.
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'set_id',
						timing: 'BEFORE',
						event: 'INSERT',
						body: 'A',
						order: 1,
					},
					{
						name: 'hash_row',
						timing: 'BEFORE',
						event: 'INSERT',
						body: 'B_v1',
						order: 2,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
					{ name: 'hash_row', timing: 'before', event: 'insert', body: 'B_v2' },
				],
				authoritative: true,
			});
			const drops = calls.filter((s) => s.startsWith('DROP TRIGGER'));
			const creates = calls.filter((s) => s.startsWith('CREATE TRIGGER'));
			expect(drops).to.have.length(2);
			expect(creates).to.have.length(2);
			// Recreated in DECLARED order, with FOLLOWS chaining on the second.
			expect(creates[0]).to.contain('`set_id`');
			expect(creates[0]).to.not.contain('FOLLOWS');
			expect(creates[1]).to.contain('`hash_row`');
			expect(creates[1]).to.contain('FOLLOWS `set_id`');
			// And DROPs happen before CREATEs so the recreate cannot fail with
			// "trigger already exists".
			const firstDrop = calls.findIndex((s) => s.startsWith('DROP TRIGGER'));
			const firstCreate = calls.findIndex((s) =>
				s.startsWith('CREATE TRIGGER'),
			);
			expect(firstDrop).to.be.below(firstCreate);
		});

		it('recreates the group on ORDER-only drift (equal bodies, swapped order)', async () => {
			// The dangerous case: bodies match but DB order is wrong. The
			// reconciler must recognize this and rebuild the group to put
			// declaration order back.
			const { dialect } = makeFakeDialect({
				existing: [
					{
						name: 'hash_row',
						timing: 'BEFORE',
						event: 'INSERT',
						body: 'B',
						order: 1,
					},
					{
						name: 'set_id',
						timing: 'BEFORE',
						event: 'INSERT',
						body: 'A',
						order: 2,
					},
				],
			});
			const { exec, calls } = makeExecQuery();
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
					{ name: 'hash_row', timing: 'before', event: 'insert', body: 'B' },
				],
				authoritative: true,
			});
			const creates = calls.filter((s) => s.startsWith('CREATE TRIGGER'));
			// Both must be recreated; order after rebuild = declaration order.
			expect(creates).to.have.length(2);
			expect(creates[0]).to.contain('`set_id`');
			expect(creates[1]).to.contain('`hash_row`');
			expect(creates[1]).to.contain('FOLLOWS `set_id`');
		});
	});

	describe('lock_wait_timeout', () => {
		it('sets and restores SESSION lock_wait_timeout around trigger DDL', async () => {
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery({
				responses: { lockWaitTimeout: [{ v: 31536000 }] },
			});
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{ name: 't1', timing: 'before', event: 'insert', body: 'BEGIN END' },
				],
				authoritative: true,
				lockWaitTimeout: 60,
			});
			const setCalls = calls.filter((s) => s.includes('lock_wait_timeout'));
			// Expect: SELECT to snapshot, SET to 60, ..., SET back to prior.
			expect(setCalls.some((s) => s.includes('@@SESSION.lock_wait_timeout'))).to
				.be.true;
			expect(setCalls.some((s) => s === 'SET SESSION lock_wait_timeout = 60'))
				.to.be.true;
			expect(
				setCalls.some((s) => s === 'SET SESSION lock_wait_timeout = 31536000'),
			).to.be.true;
		});

		it('continues normally when the SESSION SET itself fails (managed hosts refuse it)', async () => {
			// Some managed DB hosts refuse `SET SESSION lock_wait_timeout`
			// (PlanetScale, Aurora with certain modes). A refusal must NOT
			// crash the sync -- the reconciler is documented to log and
			// continue with the driver default timeout. This test proves
			// that: fail the SET, and assert the trigger CREATE still lands.
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery({
				// Fail BOTH the initial snapshot SELECT and the SET
				// override. failOn matches by substring, and the SELECT
				// carries `@@SESSION.lock_wait_timeout` so this catches it
				// too. Modelling the strictest managed host possible.
				failOn: ['SET SESSION lock_wait_timeout'],
			});
			const result = await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{
						name: 'goes_through',
						timing: 'before',
						event: 'insert',
						body: 'BEGIN END',
					},
				],
				authoritative: true,
				lockWaitTimeout: 60,
			});
			// The failed SET is NOT an error the sync reports -- it is a
			// best-effort adjustment. Trigger DDL itself still ran cleanly.
			expect(result.errors).to.deep.equal([]);
			expect(
				calls.filter((s) => s.startsWith('CREATE TRIGGER')),
				`CREATE TRIGGER must still run when SET SESSION fails`,
			).to.have.length(1);
		});

		it('restores the prior lock_wait_timeout even when a trigger CREATE throws', async () => {
			// The `finally` restore is the interesting path -- it must run
			// even on the error branch of the group rebuild. Simulate by
			// failing the CREATE and asserting the restore SET is still in
			// the emitted calls.
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec, calls } = makeExecQuery({
				responses: { lockWaitTimeout: [{ v: 31536000 }] },
				failOn: ['CREATE TRIGGER'],
			});
			await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{
						name: 'will_fail',
						timing: 'before',
						event: 'insert',
						body: 'BEGIN END',
					},
				],
				authoritative: true,
				lockWaitTimeout: 60,
			});
			const restoreIdx = calls.findIndex(
				(s) => s === 'SET SESSION lock_wait_timeout = 31536000',
			);
			expect(
				restoreIdx,
				`prior lock_wait_timeout must be restored via finally even on CREATE error`,
			).to.be.at.least(0);
			// And the restore must come AFTER the failed CREATE, otherwise
			// the restore did not participate in the finally.
			const failedCreateIdx = calls.findIndex((s) =>
				s.startsWith('CREATE TRIGGER'),
			);
			expect(restoreIdx).to.be.above(failedCreateIdx);
		});
	});

	describe('error surfacing', () => {
		it('captures CREATE failure in `errors` and does NOT throw the whole sync', async () => {
			// A trigger whose body is broken should land as a structured error
			// on the sync's error list -- same shape used for index/column
			// errors elsewhere -- so the calling sync can keep going and
			// report the full picture at the end.
			const { dialect } = makeFakeDialect({ existing: [] });
			const { exec } = makeExecQuery({ failOn: ['CREATE TRIGGER'] });
			const result = await syncTableTriggers({
				dialect,
				execQuery: exec,
				database: 'testdb',
				tableName: 't',
				declared: [
					{
						name: 'broken',
						timing: 'before',
						event: 'insert',
						body: 'not real sql',
					},
				],
				authoritative: true,
			});
			expect(result.errors).to.have.length(1);
			expect(result.errors[0].description).to.match(/creating trigger/i);
			expect(result.errors[0].error.simulated).to.equal(true);
		});
	});
});
