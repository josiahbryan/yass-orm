/* eslint-disable no-console, no-await-in-loop */
/* global describe, it, before, after */

/**
 * Live-MySQL acceptance tests for the schema-defined triggers feature.
 *
 * The defect class this feature has to survive is the same one the FULLTEXT-
 * prefix and multi-valued-index features had to survive: the DESIRED body we
 * would emit for a spec must NORMALIZE to the SAME string MySQL's catalog
 * reports back for that trigger. If it doesn't, schema-sync issues DROP +
 * CREATE on every single run -- silently, without erroring -- and each
 * rebuild holds a metadata lock that queues every write to the table.
 *
 * A unit test over the normalizer alone is STRUCTURALLY incapable of catching
 * that: the bug lives in the DISAGREEMENT between our string and MySQL's.
 * The `does not drop/recreate on a second sync` cases below are the RED/GREEN
 * gate. Every other test in this file is either scaffolding for those, or a
 * positive control that keeps the suite from passing by having the comparison
 * broken open in the always-equal direction.
 */

const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh, getDialect } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

const isMysql = () => (config.dialect || 'mysql') === 'mysql';

/**
 * Short-ish unique table suffix. MySQL caps identifiers at 64 chars, and the
 * synthetic id trigger name is `before_insert_<table>_set_id` (adds 21 chars
 * of framing), so the table itself must stay under ~43 chars. A full uuid()
 * minus dashes is 32 chars -- over budget once combined with prefixes like
 * `yass_trig_optin_`. Eight chars of hex is plenty of collision resistance
 * for the lifetime of one test run and leaves headroom.
 */
function shortId() {
	return uuid().replace(/-/g, '').slice(0, 8);
}

/**
 * Capture console.log output for the duration of `fn` and return the array of
 * lines. Used to detect trigger DDL emission (the reconciler logs each
 * group-rebuild as `Debug: (re)Creating trigger group ...`) the same way the
 * multi-valued-index acceptance test detects index DDL.
 */
async function captureLogs(fn) {
	const logs = [];
	const origLog = console.log;
	console.log = (...args) => {
		logs.push(args.join(' '));
	};
	try {
		await fn();
	} finally {
		console.log = origLog;
	}
	return logs;
}

async function fetchTriggers(tableName) {
	const conn = await dbh({ ignoreCachedConnections: true });
	try {
		return await getDialect('mysql').getTableTriggers(
			conn,
			config.schema,
			tableName,
		);
	} finally {
		await conn.end();
	}
}

async function dropTableIfExists(tableName) {
	const conn = await dbh({ ignoreCachedConnections: true });
	try {
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
	} finally {
		await conn.end();
	}
}

// ============================================================================
// Suite 1: idempotency, body & timing drift, ordering
// ============================================================================
describe('#schemaSync declared triggers -- idempotency and drift', () => {
	const tableName = `yass_trig_${shortId()}`;
	const setUpperName = 'set_name_upper';
	const noteInsertName = 'note_insert_time';

	// TWO triggers so the second-sync test can also exercise the multi-trigger
	// path (one in each group) rather than the trivial single-trigger case.
	const baseDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.uuidKey,
			name: t.string,
			lastInsertNote: t.string,
		},
		triggers: {
			[setUpperName]: {
				timing: 'before',
				event: 'insert',
				body: `BEGIN
					IF NEW.name IS NOT NULL THEN
						SET NEW.name = UPPER(NEW.name);
					END IF;
				END`,
			},
			[noteInsertName]: {
				timing: 'after',
				event: 'insert',
				body: `BEGIN
					-- unrelated group; not touched by set_name_upper changes
					SET @yass_last_note = CONCAT('inserted-', NEW.id);
				END`,
			},
		},
	});

	before(async function beforeTriggerSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		await dropTableIfExists(tableName);
		await syncSchemaToDb(YassORM.convertDefinition(baseDef));
	});

	after(async () => {
		if (!isMysql()) return;
		await dropTableIfExists(tableName);
	});

	it('creates all declared triggers on first sync with correct timing/event', async () => {
		const triggers = await fetchTriggers(tableName);
		const byName = Object.fromEntries(triggers.map((t) => [t.name, t]));
		expect(byName).to.have.property(setUpperName);
		expect(byName[setUpperName]).to.include({ timing: 'BEFORE', event: 'INSERT' });
		expect(byName).to.have.property(noteInsertName);
		expect(byName[noteInsertName]).to.include({ timing: 'AFTER', event: 'INSERT' });
	});

	it('applies the trigger effect on a real INSERT (behavior, not just catalog)', async () => {
		// Static presence in information_schema is not enough: MySQL will
		// accept a broken body at CREATE time on some server configs, so the
		// only reliable proof is that a fresh row shows the trigger's effect.
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const rowId = uuid();
			await conn.pquery(
				`INSERT INTO \`${tableName}\` (id, name) VALUES ('${rowId}', 'hello')`,
			);
			const [row] = await conn.pquery(
				`SELECT name FROM \`${tableName}\` WHERE id='${rowId}'`,
			);
			// UPPER('hello') = 'HELLO' -- proves the BEFORE INSERT trigger ran.
			expect(row.name).to.equal('HELLO');
		} finally {
			await conn.end();
		}
	});

	// THE ACCEPTANCE ASSERTION. The whole feature turns on this: syncing the
	// identical schema a second time must emit ZERO trigger DDL. If it does
	// not, we are living in the every-run-DROP-and-CREATE bug.
	it('does NOT drop/recreate any trigger on a second identical sync', async () => {
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(baseDef)),
		);
		const triggerDdlLogs = logs.filter(
			(l) =>
				l.includes('(re)Creating trigger group') ||
				l.includes('Trigger') && l.includes('removed'),
		);
		expect(
			triggerDdlLogs,
			`second sync must emit ZERO trigger DDL, got:\n${triggerDdlLogs.join('\n')}`,
		).to.deep.equal([]);
	});

	// POSITIVE CONTROL. A test that only ever asserts "nothing changed" can
	// pass with the comparison broken open in the always-equal direction --
	// exactly how the multi-valued-index bug slipped through for a while. A
	// genuinely different body MUST still be detected as drift.
	it('detects body drift and recreates the affected group only', async () => {
		const changedBody = `BEGIN
			-- v2: lowercase the value instead of uppercasing
			IF NEW.name IS NOT NULL THEN
				SET NEW.name = LOWER(NEW.name);
			END IF;
		END`;
		const changedDef = ({ types: t }) => ({
			...baseDef({ types: t }),
			triggers: {
				[setUpperName]: {
					timing: 'before',
					event: 'insert',
					body: changedBody,
				},
				[noteInsertName]: baseDef({ types: t }).triggers[noteInsertName],
			},
		});
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(changedDef)),
		);

		// Exactly one group rebuild: the BEFORE INSERT group. The unrelated
		// AFTER INSERT group must be left alone.
		const rebuildLogs = logs.filter((l) =>
			l.includes('(re)Creating trigger group'),
		);
		expect(rebuildLogs).to.have.length(1);
		expect(rebuildLogs[0]).to.contain('before insert');
		expect(rebuildLogs[0]).to.not.contain('after insert');

		// And the trigger's runtime behavior actually changed.
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const rowId = uuid();
			await conn.pquery(
				`INSERT INTO \`${tableName}\` (id, name) VALUES ('${rowId}', 'HeLLo')`,
			);
			const [row] = await conn.pquery(
				`SELECT name FROM \`${tableName}\` WHERE id='${rowId}'`,
			);
			expect(row.name).to.equal('hello');
		} finally {
			await conn.end();
		}
	});

	// Second axis of drift the reconciler must catch: timing/event.
	it('detects timing drift (before -> after) as a rebuild', async () => {
		const flippedDef = ({ types: t }) => ({
			...baseDef({ types: t }),
			triggers: {
				[setUpperName]: {
					timing: 'after', // was 'before'
					event: 'insert',
					body: `BEGIN
						-- can't mutate NEW in AFTER; use session var for the assertion
						SET @yass_after_ran = 1;
					END`,
				},
				[noteInsertName]: baseDef({ types: t }).triggers[noteInsertName],
			},
		});
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(flippedDef)),
		);
		// Since it moved from BEFORE INSERT -> AFTER INSERT, BOTH groups
		// change: the BEFORE group loses set_name_upper (which becomes
		// undeclared inside its old group -> caught by opt-in drop), and the
		// AFTER group gains it. Assert at least one rebuild involving the
		// AFTER INSERT group.
		const rebuildLogs = logs.filter((l) =>
			l.includes('(re)Creating trigger group'),
		);
		expect(
			rebuildLogs.some((l) => l.includes('after insert')),
			`expected an AFTER INSERT rebuild, got:\n${rebuildLogs.join('\n')}`,
		).to.equal(true);
		// After the move, information_schema should report the trigger in the
		// AFTER group.
		const triggers = await fetchTriggers(tableName);
		const upper = triggers.find((t) => t.name === setUpperName);
		expect(upper.timing).to.equal('AFTER');
	});
});

// ============================================================================
// Suite 2: ordering -- the id trigger fires first, and re-order is idempotent
// ============================================================================
describe('#schemaSync declared triggers -- ordering', () => {
	const tableName = `yass_trigo_${shortId()}`;

	// A user BEFORE INSERT trigger that READS NEW.id. If the id trigger fires
	// FIRST, NEW.id is populated (uuid()) and copyOfId ends up equal to id.
	// If the id trigger fires SECOND (which is the failure mode a naive DROP+
	// CREATE causes), NEW.id is empty at this point and copyOfId is empty.
	const copyIdName = 'copy_id_to_copy_field';
	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.uuidKey,
			copyOfId: t.string,
		},
		triggers: {
			[copyIdName]: {
				timing: 'before',
				event: 'insert',
				body: `BEGIN
					-- Reads NEW.id; only sees a value if the id trigger fired FIRST.
					IF (NEW.id IS NOT NULL AND NEW.id <> '') THEN
						SET NEW.copyOfId = NEW.id;
					END IF;
				END`,
			},
		},
	});

	before(async function beforeOrderingSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		await dropTableIfExists(tableName);
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		if (!isMysql()) return;
		await dropTableIfExists(tableName);
	});

	it('places the built-in id trigger BEFORE any user BEFORE INSERT trigger', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const rowId = uuid();
			// Do NOT supply id -- let the id trigger generate it. The user
			// trigger then reads NEW.id and copies it into copyOfId.
			await conn.pquery(
				`INSERT INTO \`${tableName}\` (copyOfId) VALUES ('sentinel-${rowId}')`,
			);
			const [row] = await conn.pquery(
				`SELECT id, copyOfId FROM \`${tableName}\` WHERE copyOfId <> 'sentinel-${rowId}' ORDER BY id DESC LIMIT 1`,
			);
			// The user trigger overwrote copyOfId with the generated id, which
			// is ONLY possible if the id trigger fired first.
			expect(row.copyOfId).to.equal(row.id);
			expect(row.id).to.match(/^[0-9a-f-]{36}$/i);
		} finally {
			await conn.end();
		}
	});

	// The dangerous case: force the id trigger to be recreated. Under a naive
	// DROP+CREATE it now lands at the END of the BEFORE INSERT chain, silently
	// re-ordering it AFTER the user's copy_id trigger, and the copy stops
	// working. The reconciler must detect the order drift and rebuild the
	// whole group with FOLLOWS chaining to put it back.
	it('re-recreates the id trigger without breaking firing order (group rebuild)', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			// Hand-drop the id trigger. Next sync must detect the missing
			// trigger AND put it back at ACTION_ORDER=1.
			await conn.pquery(
				`DROP TRIGGER IF EXISTS \`before_insert_${tableName}_set_id\``,
			);
		} finally {
			await conn.end();
		}

		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));

		const triggers = await fetchTriggers(tableName);
		const idTrig = triggers.find(
			(t) => t.name === `before_insert_${tableName}_set_id`,
		);
		const copyTrig = triggers.find((t) => t.name === copyIdName);
		expect(idTrig, 'id trigger must be back').to.exist;
		expect(copyTrig, 'copy trigger must still be there').to.exist;
		// The whole point: id trigger BEFORE the copy trigger.
		expect(
			idTrig.order,
			`id trigger must fire first; got id.order=${idTrig.order}, copy.order=${copyTrig.order}`,
		).to.be.lessThan(copyTrig.order);

		// And the copy still works on a fresh insert.
		const conn2 = await dbh({ ignoreCachedConnections: true });
		try {
			await conn2.pquery(
				`INSERT INTO \`${tableName}\` (copyOfId) VALUES ('sentinel-post-recreate')`,
			);
			const [row] = await conn2.pquery(
				`SELECT id, copyOfId FROM \`${tableName}\` ORDER BY id DESC LIMIT 1`,
			);
			expect(row.copyOfId).to.equal(row.id);
		} finally {
			await conn2.end();
		}
	});

	it('is idempotent on the second sync after the group rebuild (no phantom order drift)', async () => {
		// Regression guard: the reconciler must not now think the just-rebuilt
		// group is out of order on the very next sync, or every sync would
		// churn the whole group after any group rebuild.
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(schemaDef)),
		);
		const rebuildLogs = logs.filter((l) =>
			l.includes('(re)Creating trigger group'),
		);
		expect(
			rebuildLogs,
			`second sync after rebuild must emit ZERO group DDL, got:\n${rebuildLogs.join('\n')}`,
		).to.deep.equal([]);
	});
});

// ============================================================================
// Suite 2b: orphan id-trigger cleanup when a def flips t.uuidKey -> t.idKey
// ============================================================================
describe('#schemaSync declared triggers -- orphan id-trigger cleanup', () => {
	const tableName = `yass_trigflp_${shortId()}`;

	// FIRST def uses t.uuidKey, which yass-orm implements with a
	// `before_insert_<table>_set_id` trigger that SETs NEW.id = uuid(). The
	// SECOND def switches to t.idKey (integer auto-increment), so the
	// trigger is now writing UUIDs into an INT column on every insert -- a
	// real data hazard, not just noise. The opt-in drop pass does NOT catch
	// this (the def has no `triggers` key). The reconciler must drop the
	// trigger anyway because it is yass-orm's, not the user's.
	const uuidDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.uuidKey,
			name: t.string,
		},
	});
	const idDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			name: t.string,
		},
	});

	before(async function beforeOrphanSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		await dropTableIfExists(tableName);
	});

	after(async () => {
		if (!isMysql()) return;
		await dropTableIfExists(tableName);
	});

	it('creates the id trigger while the def uses t.uuidKey', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(uuidDef));
		const triggers = await fetchTriggers(tableName);
		expect(triggers.map((t) => t.name)).to.include(
			`before_insert_${tableName}_set_id`,
		);
	});

	it('DROPs the orphan id trigger after the def switches to t.idKey', async () => {
		// The table already exists from the previous test. To flip to
		// t.idKey, MySQL requires the column type to change from char(36)
		// to int, which schema-sync will attempt as a MODIFY COLUMN. That
		// might fail or partially apply -- irrelevant here; what we're
		// testing is that the ORPHAN TRIGGER is dropped even if the column
		// change succeeds. Recreate the table fresh to isolate the trigger
		// behavior.
		await dropTableIfExists(tableName);
		await syncSchemaToDb(YassORM.convertDefinition(uuidDef));
		// Confirm the trigger IS there after the uuidKey sync.
		let triggers = await fetchTriggers(tableName);
		expect(triggers.map((t) => t.name)).to.include(
			`before_insert_${tableName}_set_id`,
		);

		// Now switch the def to t.idKey and re-sync. The orphan id trigger
		// must be gone; MODIFY COLUMN may or may not succeed against a
		// pre-populated table, but this table is empty so it should be
		// clean.
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(idDef)),
		);

		triggers = await fetchTriggers(tableName);
		expect(
			triggers.map((t) => t.name),
			`orphan id trigger must be gone after the def switched to t.idKey`,
		).to.not.include(`before_insert_${tableName}_set_id`);

		// And the reconciler logged the removal with the orphan-specific
		// reason (distinct from opt-in undeclared drop for grep-ability).
		expect(
			logs.some(
				(l) =>
					l.includes('orphaned') &&
					l.includes(`before_insert_${tableName}_set_id`),
			),
			`expected an "orphaned" log line; got:\n${logs.join('\n')}`,
		).to.equal(true);
	});

	it('is idempotent: a second sync of the t.idKey def emits no trigger DDL', async () => {
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(idDef)),
		);
		expect(
			logs.filter(
				(l) =>
					l.includes('(re)Creating trigger group') ||
					(l.includes('Trigger') && l.includes('removed')),
			),
			`orphan-drop must not recur once the trigger is gone`,
		).to.deep.equal([]);
	});
});

// ============================================================================
// Suite 3: opt-in drop authority for undeclared triggers
// ============================================================================
describe('#schemaSync declared triggers -- opt-in drop authority', () => {
	// One table where the def OPTS IN (has a `triggers` key), one where it
	// does not. On the opted-in table, hand-created strays are dropped; on
	// the opted-out one they survive.
	const optedInTable = `yass_trigi_${shortId()}`;
	const optedOutTable = `yass_trigo_${shortId()}`;
	const strayName = 'hand_created_stray';

	const optedInDef = ({ types: t }) => ({
		table: optedInTable,
		schema: { id: t.uuidKey, name: t.string },
		triggers: {}, // OPT-IN via an EMPTY triggers block ("declared triggers: none")
	});

	const optedOutDef = ({ types: t }) => ({
		table: optedOutTable,
		schema: { id: t.uuidKey, name: t.string },
		// NO `triggers` key -> not opted in
	});

	async function createStrayTrigger(tableName) {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`DROP TRIGGER IF EXISTS \`${strayName}\``,
			);
			await conn.pquery(
				`CREATE TRIGGER \`${strayName}\` AFTER UPDATE ON \`${tableName}\` FOR EACH ROW BEGIN SET @yass_stray_ran = 1; END`,
			);
		} finally {
			await conn.end();
		}
	}

	before(async function beforeOptInSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		await dropTableIfExists(optedInTable);
		await dropTableIfExists(optedOutTable);
		await syncSchemaToDb(YassORM.convertDefinition(optedInDef));
		await syncSchemaToDb(YassORM.convertDefinition(optedOutDef));
	});

	after(async () => {
		if (!isMysql()) return;
		await dropTableIfExists(optedInTable);
		await dropTableIfExists(optedOutTable);
	});

	it('drops a hand-created stray on an OPTED-IN table (rename convergence)', async () => {
		await createStrayTrigger(optedInTable);
		// Confirm the stray is really there.
		let triggers = await fetchTriggers(optedInTable);
		expect(triggers.map((t) => t.name)).to.include(strayName);

		// Re-sync: the opt-in gate should drop the stray. The built-in id
		// trigger must NOT be touched -- it is exempt.
		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(optedInDef)),
		);
		const removedLogs = logs.filter(
			(l) => l.includes('Trigger') && l.includes('removed'),
		);
		expect(removedLogs.some((l) => l.includes(strayName))).to.equal(true);
		expect(
			removedLogs.some((l) => l.includes(`before_insert_${optedInTable}_set_id`)),
			'id trigger must not be listed as removed',
		).to.equal(false);

		triggers = await fetchTriggers(optedInTable);
		expect(triggers.map((t) => t.name)).to.not.include(strayName);
		expect(triggers.map((t) => t.name)).to.include(
			`before_insert_${optedInTable}_set_id`,
		);
	});

	it('LEAVES a hand-created stray on an OPTED-OUT table (upgrade safety)', async () => {
		await createStrayTrigger(optedOutTable);
		let triggers = await fetchTriggers(optedOutTable);
		expect(triggers.map((t) => t.name)).to.include(strayName);

		const logs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(optedOutDef)),
		);
		const removedLogs = logs.filter(
			(l) => l.includes('Trigger') && l.includes('removed'),
		);
		expect(
			removedLogs.some((l) => l.includes(strayName)),
			`opted-out sync must not drop strays, but got:\n${removedLogs.join('\n')}`,
		).to.equal(false);

		triggers = await fetchTriggers(optedOutTable);
		expect(triggers.map((t) => t.name)).to.include(strayName);
	});
});

// ============================================================================
// Suite 3b: `getTableTriggers` scopes correctly to a specific TRIGGER_SCHEMA
// ============================================================================
//
// yass-orm's `.` form in a def's `table:` means `<table>.<idField>` (see
// `parseIdField`), NOT `<db>.<table>` -- the `enableAlternateSchemaInTableName`
// config option changes that heuristic but is off by default. So the true
// invariant we need to guard against a broken cross-schema code path is
// dialect-level: `getTableTriggers(handle, database, tableName)` MUST scope
// its WHERE clause to the `database` param. If it silently ignored `database`
// (e.g. via `SHOW TRIGGERS`, which is current-DB only), a schema-sync run
// against a DB with same-named tables in two schemas would false-positive on
// the wrong one and either report drift for the right table or miss real drift
// on it. Live-DB test rather than a mock so we catch a wrong SQL literal.
describe('#schemaSync getTableTriggers scopes to TRIGGER_SCHEMA', () => {
	// Reuse the always-provisioned second schema from test/fakeSchemaDb2.js
	// so this test does not carry its own `CREATE DATABASE` prerequisite.
	const otherSchema = 'yass_test2';
	// Two tables with the SAME name but in different schemas. If
	// getTableTriggers's WHERE clause is not scoping to the passed
	// database, it will return the WRONG trigger's row (or both).
	const tableName = `yass_trigscp_${shortId()}`;
	const triggerName = `${tableName}_marker`;

	before(async function beforeScopeSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const rows = await conn.pquery(`SHOW DATABASES LIKE ?`, [otherSchema]);
			if (!rows.length) {
				this.skip();
				return;
			}
			// Provision both tables with distinguishable trigger bodies so
			// reading back the WRONG one would compare unequal to the
			// expected body -- a positive control that the assertion is
			// checking scoping, not just presence.
			await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
			await conn.pquery(
				`DROP TABLE IF EXISTS \`${otherSchema}\`.\`${tableName}\``,
			);
			await conn.pquery(
				`CREATE TABLE \`${tableName}\` (id char(36) PRIMARY KEY)`,
			);
			await conn.pquery(
				`CREATE TABLE \`${otherSchema}\`.\`${tableName}\` (id char(36) PRIMARY KEY)`,
			);
			// The trigger name MUST be in the same schema as the table
			// (MySQL error 1435). Qualify both sides for the yass_test2
			// case; the default-schema case can leave the name unqualified.
			await conn.pquery(
				`CREATE TRIGGER \`${triggerName}\` BEFORE INSERT ON \`${tableName}\` FOR EACH ROW BEGIN SET @yass_scope = 'in_default'; END`,
			);
			await conn.pquery(
				`CREATE TRIGGER \`${otherSchema}\`.\`${triggerName}\` BEFORE INSERT ON \`${otherSchema}\`.\`${tableName}\` FOR EACH ROW BEGIN SET @yass_scope = 'in_other'; END`,
			);
		} finally {
			await conn.end();
		}
	});

	after(async () => {
		if (!isMysql()) return;
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
			await conn.pquery(
				`DROP TABLE IF EXISTS \`${otherSchema}\`.\`${tableName}\``,
			);
		} finally {
			await conn.end();
		}
	});

	it('returns the trigger from the passed schema, not the same-named one in another schema', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			const dialect = getDialect('mysql');
			const inDefault = await dialect.getTableTriggers(
				conn,
				config.schema,
				tableName,
			);
			const inOther = await dialect.getTableTriggers(
				conn,
				otherSchema,
				tableName,
			);
			// Both scopes see EXACTLY ONE trigger by that name, and the
			// bodies distinguish them -- if the WHERE clause were missing
			// TRIGGER_SCHEMA, one side would carry two rows OR the wrong
			// body.
			expect(inDefault).to.have.length(1);
			expect(inOther).to.have.length(1);
			expect(inDefault[0].name).to.equal(triggerName);
			expect(inOther[0].name).to.equal(triggerName);
			expect(inDefault[0].body).to.contain('in_default');
			expect(inDefault[0].body).to.not.contain('in_other');
			expect(inOther[0].body).to.contain('in_other');
			expect(inOther[0].body).to.not.contain('in_default');
		} finally {
			await conn.end();
		}
	});
});

// ============================================================================
// Suite 4: cross-dialect skip path (PG has supportsDeclaredTriggers = false)
// ============================================================================
describe('#schemaSync declared triggers -- skipped stably off MySQL', () => {
	const tableName = `yass_trigsk_${shortId()}`;
	const def = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey, name: t.string },
		triggers: {
			t1: { timing: 'before', event: 'insert', body: 'BEGIN END' },
		},
	});

	before(function beforeSkipSuite() {
		// This suite is exercised under `npm run test:postgres`. On MySQL the
		// skip path is not reachable, so skip THIS suite -- it would try to
		// actually create the trigger and pass a different property.
		if (isMysql()) this.skip();
	});

	after(async () => {
		if (isMysql()) return;
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		} finally {
			await conn.end();
		}
	});

	it('syncs the table with no trigger DDL and no errors, twice', async () => {
		// A schema with a `triggers` block must still SYNC on a dialect
		// whose reconciler is not implemented -- the table and its columns
		// are the important part; the trigger is warned-and-skipped so a
		// shared def is portable.
		const first = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(first.errors).to.deep.equal([]);
		const secondLogs = await captureLogs(() =>
			syncSchemaToDb(YassORM.convertDefinition(def)),
		);
		expect(
			secondLogs.filter((l) => l.includes('(re)Creating trigger group')),
			`no trigger DDL should fire on a dialect without a reconciler`,
		).to.deep.equal([]);
	});
});
