/* eslint-disable no-unused-expressions, global-require */
/* global describe, it */

/**
 * Unit tests for lib/sync-triggers.js pure helpers.
 *
 * These run on every dialect (no database required). They cover:
 *   - normalizeTriggerBody: strips comments + whitespace so a body coming back
 *     from MySQL's information_schema compares EQUAL to what we wrote.
 *   - resolveTriggerBody: chooses the right dialect-keyed body (or bare string).
 *   - validateTriggerSpec: throws at convert time on a bad timing/event/body.
 *   - planTriggerReconciliation: computes per timing+event GROUP drift and the
 *     undeclared-drop set that syncTableTriggers acts on.
 *
 * The live-MySQL idempotency test in test/schemaSync.triggers.test.js is the
 * real acceptance gate; these unit tests are the fast red/green feedback loop.
 */

const { expect } = require('chai');
const {
	normalizeTriggerBody,
	resolveTriggerBody,
	validateTriggerSpec,
	planTriggerReconciliation,
	triggersEqual,
} = require('./sync-triggers');

describe('#sync-triggers normalizeTriggerBody', () => {
	it('collapses runs of whitespace to a single space and trims', () => {
		expect(normalizeTriggerBody('BEGIN\n\tSET x = 1;\nEND')).to.equal(
			'BEGIN SET x = 1; END',
		);
		expect(normalizeTriggerBody('   BEGIN   END   ')).to.equal('BEGIN END');
	});

	it('drops a trailing semicolon (MySQL sometimes stores the body without one)', () => {
		expect(normalizeTriggerBody('BEGIN END;')).to.equal('BEGIN END');
		expect(normalizeTriggerBody('BEGIN END ; ')).to.equal('BEGIN END');
	});

	it('strips -- line comments up to end of line', () => {
		expect(
			normalizeTriggerBody(`BEGIN
			-- explain why we do this
			SET x = 1;
			END`),
		).to.equal('BEGIN SET x = 1; END');
	});

	it('strips /* block */ comments including nested newlines', () => {
		expect(
			normalizeTriggerBody(`BEGIN /* multi
			line block */ SET x = 1; END`),
		).to.equal('BEGIN SET x = 1; END');
	});

	it('preserves case of body text (MySQL preserves case in ACTION_STATEMENT)', () => {
		// Case folding here would MASK a change that flips a literal from 'Foo' to
		// 'foo' -- which changes what the trigger actually stores.
		const body = "BEGIN SET NEW.name = 'Foo'; END";
		expect(normalizeTriggerBody(body)).to.equal(
			"BEGIN SET NEW.name = 'Foo'; END",
		);
		expect(normalizeTriggerBody(body)).to.not.equal(
			normalizeTriggerBody("BEGIN SET NEW.name = 'foo'; END"),
		);
	});

	it('is null-safe / empty-safe', () => {
		expect(normalizeTriggerBody('')).to.equal('');
		expect(normalizeTriggerBody(null)).to.equal('');
		expect(normalizeTriggerBody(undefined)).to.equal('');
	});

	it('does NOT treat `--` or `/*` inside a SINGLE-QUOTED string literal as a comment start', () => {
		// A body that stores `--` or `/* */` as literal text (e.g. writing a
		// pre-formatted audit line into another table) must not have that
		// content silently deleted by the normalizer. If it did, two bodies
		// that differ ONLY inside a string literal would compare EQUAL and
		// schema-sync would think a real body change was cosmetic drift and
		// leave the old trigger in place -- a false NEGATIVE that hides a
		// semantic change.
		const a = normalizeTriggerBody("BEGIN SET NEW.note = 'v1 -- audit'; END");
		const b = normalizeTriggerBody("BEGIN SET NEW.note = 'v2 -- audit'; END");
		expect(a).to.not.equal(b);
		// And the literal `--` inside a string still round-trips: not
		// stripped, not collapsed. Spaces inside a string literal must
		// stay intact.
		expect(a).to.equal("BEGIN SET NEW.note = 'v1 -- audit'; END");
	});

	it('does NOT treat `--` or `/*` inside a DOUBLE-QUOTED string literal as a comment start', () => {
		// MySQL accepts double-quoted strings under default sql_mode (they
		// become identifiers only under ANSI_QUOTES). A body containing
		// `"a /* b */ c"` must preserve that byte-for-byte.
		const body = 'BEGIN SET NEW.note = "a /* b */ c"; END';
		expect(normalizeTriggerBody(body)).to.equal(
			'BEGIN SET NEW.note = "a /* b */ c"; END',
		);
	});

	it('does NOT treat `--` inside a BACKTICK-QUOTED identifier as a comment start', () => {
		// Real MySQL corner: `` `weird--col` `` is a valid identifier. Some
		// legacy schemas use hyphenated column names quoted this way. The
		// normalizer must leave the backtick section alone.
		const body = 'BEGIN SET NEW.`weird--col` = 1; END';
		expect(normalizeTriggerBody(body)).to.equal(
			'BEGIN SET NEW.`weird--col` = 1; END',
		);
	});

	it("handles escaped quotes inside a string literal (\\' and doubled quotes)", () => {
		// MySQL accepts both `\'` and `''` to embed a single-quote inside a
		// single-quoted string. The normalizer must recognise both so the
		// string does not "close early" and let a following `--` be treated
		// as a comment start.
		const withBackslash = "BEGIN SET NEW.note = 'it\\'s -- fine'; END";
		expect(normalizeTriggerBody(withBackslash)).to.equal(
			"BEGIN SET NEW.note = 'it\\'s -- fine'; END",
		);
		const withDoubled = "BEGIN SET NEW.note = 'it''s -- fine'; END";
		expect(normalizeTriggerBody(withDoubled)).to.equal(
			"BEGIN SET NEW.note = 'it''s -- fine'; END",
		);
	});

	it('preserves whitespace INSIDE string literals while still collapsing whitespace outside them', () => {
		// This one pins the invariant that made me care about the lexer:
		// spaces inside `'   '` are part of the value and must survive
		// normalization; spaces outside are formatting and must collapse.
		expect(
			normalizeTriggerBody("BEGIN\n\t\tSET x = '   spaced   '  ;\nEND"),
		).to.equal("BEGIN SET x = '   spaced   ' ; END");
	});
});

describe('#sync-triggers resolveTriggerBody', () => {
	it('returns a bare string body as-is for any dialect', () => {
		const body = 'BEGIN SET NEW.id = uuid(); END';
		expect(resolveTriggerBody({ body }, 'mysql')).to.equal(body);
		expect(resolveTriggerBody({ body }, 'postgres')).to.equal(body);
		expect(resolveTriggerBody({ body }, 'sqlite')).to.equal(body);
	});

	it('picks the dialect-keyed body matching the active dialect', () => {
		const spec = {
			body: { mysql: 'MYSQL_BODY', pg: 'PG_BODY', sqlite: 'SQLITE_BODY' },
		};
		expect(resolveTriggerBody(spec, 'mysql')).to.equal('MYSQL_BODY');
		expect(resolveTriggerBody(spec, 'postgres')).to.equal('PG_BODY');
		expect(resolveTriggerBody(spec, 'sqlite')).to.equal('SQLITE_BODY');
	});

	it('accepts both `pg` and `postgres` as the postgres key', () => {
		// The dialect names its own name `postgres` (see PostgresDialect.name), but
		// the schema-author-facing spelling is `pg` in the plan. Both must work so
		// existing docs and typed cases stay valid.
		expect(resolveTriggerBody({ body: { pg: 'A' } }, 'postgres')).to.equal('A');
		expect(
			resolveTriggerBody({ body: { postgres: 'B' } }, 'postgres'),
		).to.equal('B');
	});

	it('returns null when the spec is dialect-keyed but this dialect has no entry (skip signal)', () => {
		// The reconciler treats null as "skip stably" -- the trigger is removed
		// from the desired set so it does not affect ordering or the drop pass,
		// mirroring the supportsMultiValuedIndexes skip path.
		expect(resolveTriggerBody({ body: { pg: 'X' } }, 'mysql')).to.equal(null);
	});
});

describe('#sync-triggers validateTriggerSpec', () => {
	it('accepts a valid before-insert spec with a string body', () => {
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: 'BEGIN END',
			}),
		).to.not.throw();
	});

	it('accepts case-insensitive timing/event', () => {
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'BEFORE',
				event: 'UPDATE',
				body: 'BEGIN END',
			}),
		).to.not.throw();
	});

	it('throws when the spec is not an object', () => {
		expect(() => validateTriggerSpec('t1', 'BEFORE INSERT ON x ...')).to.throw(
			/must be an object/,
		);
		expect(() => validateTriggerSpec('t1', null)).to.throw();
	});

	it('throws on an unknown timing', () => {
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'instead of',
				event: 'insert',
				body: 'x',
			}),
		).to.throw(/timing/);
	});

	it('throws on an unknown event', () => {
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'truncate',
				body: 'x',
			}),
		).to.throw(/event/);
	});

	it('throws when body is missing or empty', () => {
		expect(() =>
			validateTriggerSpec('t1', { timing: 'before', event: 'insert' }),
		).to.throw(/body/);
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: '',
			}),
		).to.throw(/body/);
	});

	it('throws when dialect-keyed body has no known dialect key', () => {
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: { oracle: 'x' },
			}),
		).to.throw(/dialect/);
	});

	it('throws when the body contains a leftover table-name template placeholder', () => {
		// The engine writes the ON clause itself, so a leftover table
		// template in the body means the author expected interpolation
		// that never happened -- the trigger would end up firing SQL
		// against a table LITERALLY named that placeholder, which either
		// fails loudly at CREATE time or (worse) silently succeeds if
		// such a table exists. Fail LOUDLY at convert time.
		const leftoverTableTemplate = `\${table}`;
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: `BEGIN INSERT INTO ${leftoverTableTemplate}_audit VALUES (NEW.id); END`,
			}),
		).to.throw(/\$\{table\}/);
	});

	it('throws when a dialect-keyed body VALUE is not a non-empty string', () => {
		// Without this check a spec like `body: { mysql: 42 }` sails through
		// convert-time validation and only surfaces later inside
		// generateCreateTrigger as a corrupt DDL string. Fail LOUDLY at the
		// load point instead, same voice as the multi-valued-index cast
		// validation upstream in def-to-schema.
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: { mysql: 42 },
			}),
		).to.throw(/body.*mysql.*string/i);
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: { mysql: '' },
			}),
		).to.throw(/body.*mysql.*string/i);
		expect(() =>
			validateTriggerSpec('t1', {
				timing: 'before',
				event: 'insert',
				body: { mysql: 'BEGIN END', pg: null },
			}),
		).to.throw(/body.*pg.*string/i);
	});
});

describe('#sync-triggers triggersEqual', () => {
	it('is true when timing/event/normalized body all match (case-insensitive on timing/event)', () => {
		expect(
			triggersEqual(
				{ timing: 'before', event: 'insert', body: 'BEGIN END' },
				{ timing: 'BEFORE', event: 'INSERT', body: '  BEGIN END;  ' },
			),
		).to.be.true;
	});

	it('is false when timing differs', () => {
		expect(
			triggersEqual(
				{ timing: 'before', event: 'insert', body: 'BEGIN END' },
				{ timing: 'after', event: 'insert', body: 'BEGIN END' },
			),
		).to.be.false;
	});

	it('is false when event differs', () => {
		expect(
			triggersEqual(
				{ timing: 'before', event: 'insert', body: 'BEGIN END' },
				{ timing: 'before', event: 'update', body: 'BEGIN END' },
			),
		).to.be.false;
	});

	it('is false when body differs after normalization (literal-only change)', () => {
		expect(
			triggersEqual(
				{ timing: 'before', event: 'insert', body: "SET x = 'Foo'" },
				{ timing: 'before', event: 'insert', body: "SET x = 'foo'" },
			),
		).to.be.false;
	});
});

describe('#sync-triggers planTriggerReconciliation', () => {
	it('marks a desired trigger absent from the DB as needing CREATE (drift on its group)', () => {
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
			],
			existing: [],
		});
		expect(plan.groupsToRecreate).to.have.length(1);
		expect(plan.groupsToRecreate[0]).to.include({
			timing: 'before',
			event: 'insert',
		});
		expect(plan.groupsToRecreate[0].names).to.deep.equal(['set_id']);
	});

	it('emits no work when desired == existing (idempotent second sync)', () => {
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
			],
			existing: [
				{
					name: 'set_id',
					timing: 'BEFORE',
					event: 'INSERT',
					body: '  A  ',
					order: 1,
				},
			],
		});
		expect(plan.groupsToRecreate).to.deep.equal([]);
		expect(plan.undeclaredToDrop).to.deep.equal([]);
	});

	it('detects body drift and recreates the whole group in desired order', () => {
		// Two triggers in the same BEFORE INSERT group. Only the second changed
		// body, but MySQL cannot rewrite a trigger in place -- and DROP+CREATE on
		// just the changed one moves it to the END of the chain, silently
		// reordering the first one behind it. The reconciler recreates the whole
		// group in desired order.
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
				{ name: 'hash_row', timing: 'before', event: 'insert', body: 'B_v2' },
			],
			existing: [
				{
					name: 'set_id',
					timing: 'before',
					event: 'insert',
					body: 'A',
					order: 1,
				},
				{
					name: 'hash_row',
					timing: 'before',
					event: 'insert',
					body: 'B_v1',
					order: 2,
				},
			],
		});
		expect(plan.groupsToRecreate).to.have.length(1);
		expect(plan.groupsToRecreate[0].names).to.deep.equal([
			'set_id',
			'hash_row',
		]);
		expect(plan.groupsToRecreate[0].reasons.some((r) => /hash_row/.test(r))).to
			.be.true;
	});

	it('detects ORDER-only drift (bodies equal, existing order swapped)', () => {
		// The dangerous case: DROP+CREATE moves a trigger to the end. If a prior
		// sync recreated set_id it now lands AFTER hash_row, so a hash_row that
		// reads NEW.id sees NULL. Order drift alone must trigger group recreate.
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
				{ name: 'hash_row', timing: 'before', event: 'insert', body: 'B' },
			],
			existing: [
				{
					name: 'hash_row',
					timing: 'before',
					event: 'insert',
					body: 'B',
					order: 1,
				},
				{
					name: 'set_id',
					timing: 'before',
					event: 'insert',
					body: 'A',
					order: 2,
				},
			],
		});
		expect(plan.groupsToRecreate).to.have.length(1);
		expect(plan.groupsToRecreate[0].names).to.deep.equal([
			'set_id',
			'hash_row',
		]);
		expect(plan.groupsToRecreate[0].reasons.some((r) => /order/i.test(r))).to.be
			.true;
	});

	it('ignores undeclared siblings inside a group for order comparison', () => {
		// A hand-created trigger with ACTION_ORDER between our two must NOT be
		// mistaken for order drift on our own set. When the def has not opted into
		// managing this table's triggers, the undeclared one stays put.
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
				{ name: 'hash_row', timing: 'before', event: 'insert', body: 'B' },
			],
			existing: [
				{
					name: 'set_id',
					timing: 'before',
					event: 'insert',
					body: 'A',
					order: 1,
				},
				{
					name: 'stranger',
					timing: 'before',
					event: 'insert',
					body: 'X',
					order: 2,
				},
				{
					name: 'hash_row',
					timing: 'before',
					event: 'insert',
					body: 'B',
					order: 3,
				},
			],
		});
		expect(plan.groupsToRecreate).to.deep.equal([]);
	});

	it('groups by timing+event so unrelated groups are not disturbed', () => {
		// Changing a BEFORE INSERT trigger must not recreate an AFTER UPDATE one.
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A_v2' },
				{ name: 'audit', timing: 'after', event: 'update', body: 'C' },
			],
			existing: [
				{
					name: 'set_id',
					timing: 'before',
					event: 'insert',
					body: 'A_v1',
					order: 1,
				},
				{
					name: 'audit',
					timing: 'after',
					event: 'update',
					body: 'C',
					order: 1,
				},
			],
		});
		expect(plan.groupsToRecreate).to.have.length(1);
		expect(plan.groupsToRecreate[0]).to.include({
			timing: 'before',
			event: 'insert',
		});
		expect(plan.groupsToRecreate[0].names).to.deep.equal(['set_id']);
	});

	it('lists undeclared triggers separately (caller decides opt-in drop policy)', () => {
		// The reconciler surfaces the undeclared set; the CALLER chooses whether
		// to drop based on whether the def has a `triggers` key (opt-in per table).
		const plan = planTriggerReconciliation({
			desired: [
				{ name: 'set_id', timing: 'before', event: 'insert', body: 'A' },
			],
			existing: [
				{
					name: 'set_id',
					timing: 'before',
					event: 'insert',
					body: 'A',
					order: 1,
				},
				{
					name: 'stranger',
					timing: 'after',
					event: 'delete',
					body: 'X',
					order: 1,
				},
			],
		});
		expect(plan.undeclaredToDrop).to.deep.equal(['stranger']);
	});

	it('exempts a name from `alwaysKeep` from undeclaredToDrop (id trigger is always exempt)', () => {
		// The synthetic id trigger is exempt from the drop pass in both opt-in
		// states. The caller passes its name in `alwaysKeep` so the reconciler
		// never reports it as undeclared even when it is not in the desired set.
		const plan = planTriggerReconciliation({
			desired: [],
			existing: [
				{
					name: 'before_insert_foo_set_id',
					timing: 'before',
					event: 'insert',
					body: 'A',
					order: 1,
				},
				{
					name: 'stranger',
					timing: 'before',
					event: 'update',
					body: 'X',
					order: 1,
				},
			],
			alwaysKeep: ['before_insert_foo_set_id'],
		});
		expect(plan.undeclaredToDrop).to.deep.equal(['stranger']);
	});
});
