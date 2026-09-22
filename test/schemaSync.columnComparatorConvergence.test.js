/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// BDL-3981: the column comparator never converged for two classes of column, so
// schema-sync re-issued the SAME no-op `ALTER TABLE ... CHANGE COLUMN` statements
// on every tick -- each taking an exclusive metadata lock on a hot production
// table, forever, changing nothing. Measured on prod: 19 recurring ALTER digests,
// 219 executions each, and on an ordinary day 100% of production column DDL was
// this defect. It is the root cause under BDL-3956 (prod lock-wait timeouts).
//
//   CLASS A -- a column whose uniqueness is declared in the def's `indexes` block
//     carries NO column-level `key`, while DESCRIBE reports `Key=UNI`. The
//     carve-out chain covered `MUL` and not `UNI`. Structurally non-convergent:
//     `CHANGE COLUMN` cannot add or remove an index (the generator is even passed
//     `{ ignore: ['key'] }`), so `Key` is still `UNI` on the next tick.
//
//   CLASS B -- a def's `.default(n)` is stored verbatim as a NUMBER, while
//     DESCRIBE always returns Default as a STRING, and the two were compared with
//     `!==`. The tell is the comparator's own output: `a=1, b=1` -- equal on
//     screen, counted unequal in code.
//
// The comparator reports every mis-compare it counts as a `Debug: k=...` line
// immediately before incrementing its difference count, so a converged table must
// produce ZERO of them. That is the instrument these tests read, matching the
// house idiom in schemaSync.idempotency.test.js.
describe('#schemaSync column comparator convergence (BDL-3981)', () => {
	const tableName = `yass_bdl3981_${uuid().replace(/-/g, '')}`;

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.uuidKey,
			// CLASS A: uniqueness declared in `indexes`, NOT as a column attribute.
			// Shape-equivalent to the real rubber def bc-side-thread.js:68/:134.
			identityKey: t.string,
			// CLASS B: a non-zero integer default. Shape-equivalent to the real
			// rubber def bc-workflow.js:138 (`concurrencyGlobal: t.int ... .default(1)`).
			concurrencyGlobal: t.int.default(1),
			// CLASS B: a fractional default -- prod's 4th recurring shape
			// (`Debug: k=default, a=0.5, b=0.5, type=double`).
			ratio: t.real.default(0.5),
			// CLASS B: a ZERO default on a NON-int column. The existing carve-out
			// masks `default: 0` only when the type matches /^int/, so a double 0
			// churns where an int 0 does not. Prod's 19 did not happen to contain
			// this shape; it is the same defect and must converge too.
			weight: t.real.default(0),
			// NEGATIVE CONTROL: no index, no default. Silent before and after the
			// fix -- if this ever appears in the Debug lines, the harness is wrong,
			// not the comparator.
			plainCol: t.string,
			// GUARD, not a subject of this bug. `.nullable()` sets `null: 1` -- a
			// NUMBER -- which an existing carve-out matches with `bk === 1`. A fix
			// that coerced ak/bk globally instead of scoping to `default` would
			// break that carve-out and make EVERY nullable column churn forever:
			// a brand-new instance of the exact defect this ticket removes. Without
			// this column the suite cannot fail on that mistake at all -- verified
			// by mutation, see the test below.
			notes: t.string.nullable(),
		},
		indexes: {
			identityKey_unique: { cols: ['identityKey'], unique: true },
		},
	});

	// Re-sync the (already converged) table and return every mis-compare the
	// comparator reported, plus how many DDL statements it actually applied.
	async function resyncAndCapture() {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
		};
		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.log = origLog;
		}
		return {
			debugLines: logs.filter((line) => line.includes('Debug: k=')),
			applied: result ? result.applied : undefined,
			logs,
		};
	}

	async function describeColumn(field) {
		const conn = await dbh({ ignoreCachedConnections: true });
		const [row] = await conn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = '${field}'`,
		);
		await conn.end();
		return row;
	}

	async function exec(sql) {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(sql);
		await conn.end();
	}

	before(async () => {
		// First sync CREATEs the table, so the database is converged by
		// construction: every subsequent sync has genuinely nothing to do.
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		await exec(`DROP TABLE IF EXISTS \`${tableName}\``);
	});

	// ---- positive control: the fixture really is in the state these tests assume ----

	it('control: the created table really does report Key=UNI and string defaults', async () => {
		const identityKey = await describeColumn('identityKey');
		expect(identityKey.Key).to.equal('UNI');

		const concurrencyGlobal = await describeColumn('concurrencyGlobal');
		// MySQL returns Default as a STRING -- this is the other half of CLASS B.
		expect(concurrencyGlobal.Default).to.equal('1');
		expect(typeof concurrencyGlobal.Default).to.equal('string');
	});

	// ---- AC1 / AC2 / AC3: a converged schema must emit nothing ----

	it('AC1: a converged schema emits ZERO ALTER TABLE ... CHANGE COLUMN statements', async () => {
		const { debugLines, applied } = await resyncAndCapture();
		expect(
			debugLines,
			`comparator reported mis-compares:\n${debugLines.join('\n')}`,
		).to.deep.equal([]);
		expect(applied).to.equal(0);
	});

	it('AC2 (CLASS A): a column made unique via the indexes block does not churn on Key=UNI', async () => {
		const { debugLines } = await resyncAndCapture();
		const keyLines = debugLines.filter((line) => line.includes('k=key'));
		expect(
			keyLines,
			`unexpected key mis-compares:\n${keyLines.join('\n')}`,
		).to.deep.equal([]);
	});

	it('AC3 (CLASS B): a NUMBER def default compares equal to a STRING DESCRIBE default', async () => {
		const { debugLines } = await resyncAndCapture();
		const defaultLines = debugLines.filter((line) =>
			line.includes('k=default'),
		);
		expect(
			defaultLines,
			`unexpected default mis-compares:\n${defaultLines.join('\n')}`,
		).to.deep.equal([]);
	});

	// ---- AC4: the RED ARM. Genuine drift MUST still be caught. ----
	// Each of these deliberately breaks the database away from the definition and
	// asserts the comparator still notices. Without them, a fix that simply stops
	// comparing would pass every test above -- under-emission (schema drift never
	// corrected) is strictly worse than the bug being fixed, and is invisible in
	// exactly the same way.

	it('AC4 red arm: a genuinely drifted column TYPE is still caught and corrected', async () => {
		await exec(
			`ALTER TABLE \`${tableName}\` MODIFY \`plainCol\` varchar(100) NULL`,
		);
		expect((await describeColumn('plainCol')).Type).to.equal('varchar(100)');

		const { debugLines } = await resyncAndCapture();
		expect(debugLines.join('\n')).to.include('k=type');

		expect((await describeColumn('plainCol')).Type).to.equal('varchar(255)');
	});

	it('AC4 red arm: a genuinely drifted DEFAULT value is still caught and corrected', async () => {
		await exec(
			`ALTER TABLE \`${tableName}\` MODIFY \`concurrencyGlobal\` int NOT NULL DEFAULT 5`,
		);
		expect((await describeColumn('concurrencyGlobal')).Default).to.equal('5');

		const { debugLines } = await resyncAndCapture();
		expect(debugLines.join('\n')).to.include('k=default');

		expect((await describeColumn('concurrencyGlobal')).Default).to.equal('1');
	});

	it('AC4 red arm: BDL-3142 drift (a DEFAULT 0 removed in the db) is still caught', async () => {
		// The trap this guards: relaxing the compare to loose `==` makes '' == 0
		// true, so a column that should be NOT NULL DEFAULT 0 but has no default
		// in the database compares EQUAL and is never corrected -- silently
		// regressing BDL-3142 while passing every other assertion in this file.
		await exec(
			`ALTER TABLE \`${tableName}\` MODIFY \`weight\` double NOT NULL`,
		);
		expect((await describeColumn('weight')).Default).to.equal(null);

		const { debugLines } = await resyncAndCapture();
		expect(debugLines.join('\n')).to.include('k=default');

		expect((await describeColumn('weight')).Default).to.equal('0');
	});

	it('AC4 red arm: a genuinely drifted NULLability is still caught and corrected', async () => {
		await exec(
			`ALTER TABLE \`${tableName}\` MODIFY \`concurrencyGlobal\` int NULL DEFAULT 1`,
		);
		expect((await describeColumn('concurrencyGlobal')).Null).to.equal('YES');

		const { debugLines } = await resyncAndCapture();
		expect(debugLines.join('\n')).to.include('k=null');

		expect((await describeColumn('concurrencyGlobal')).Null).to.equal('NO');
	});

	it('AC4 red arm: a .nullable() column stays silent (guards against a global coercion)', async () => {
		// This is the arm that fails if someone "fixes" CLASS B by coercing ak/bk
		// for every key rather than only for `default`. Mutation-verified: with a
		// blanket String() on both operands, this test -- and only this test --
		// goes red, reporting `Debug: k=null, a=YES, b=1`.
		const { debugLines } = await resyncAndCapture();
		const nullLines = debugLines.filter((line) => line.includes('k=null'));
		expect(
			nullLines,
			`nullable column churned:\n${nullLines.join('\n')}`,
		).to.deep.equal([]);
	});

	// ---- AC5: the index pass is a separate pass and must keep its coverage ----
	// This is the argument that carving out `key` in the COLUMN pass loses
	// nothing: uniqueness is created and dropped by the INDEX pass, which reads
	// its state from a different instrument (getTableIndexes, not SHOW FULL
	// COLUMNS). Verified here rather than assumed.

	it('AC5: the index pass still DROPS a unique index the def no longer declares', async () => {
		// The other half of AC5, and the one that actually tests the carve-out's
		// premise. Measured identically at the unfixed pin, which is the control
		// that matters: the column pass never contributed to index management, so
		// ignoring `key` there cannot have lost coverage.
		const noUnique = ({ types: t }) => ({
			...schemaDef({ types: t }),
			indexes: {},
		});
		expect((await describeColumn('identityKey')).Key).to.equal('UNI');

		await syncSchemaToDb(YassORM.convertDefinition(noUnique));

		expect((await describeColumn('identityKey')).Key).to.equal('');

		// put it back for any later test / a clean end state
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		expect((await describeColumn('identityKey')).Key).to.equal('UNI');
	});

	it('AC5: the index pass still recreates a dropped UNIQUE index', async () => {
		await exec(
			`ALTER TABLE \`${tableName}\` DROP INDEX \`identityKey_unique\``,
		);
		expect((await describeColumn('identityKey')).Key).to.equal('');

		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));

		expect((await describeColumn('identityKey')).Key).to.equal('UNI');
	});
});
