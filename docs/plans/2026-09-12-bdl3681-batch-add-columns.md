# BDL-3681: Batch a table's ADD COLUMNs into ONE ALTER — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** When one schema-sync run must add more than one column to the same table, emit a single
`ALTER TABLE t ADD a …, ADD b …` instead of N separate `ALTER TABLE` statements — turning N full
table rebuilds into one on any table that cannot take `ALGORITHM=INSTANT`.

**Architecture:** Approach B from the spec. A new capability getter `supportsMultiClauseAlterAdd`
on `BaseDialect` defaults to **false**; MySQL and Postgres opt in and each supplies its own
`generateAlterAddColumns()` (the clause syntax differs — MySQL writes `ADD`, Postgres writes
`ADD COLUMN`). A new pure function `buildAddColumnPlan()` in `lib/sync-to-db.js` decides what gets
**executed** versus what gets **recorded in the heal ledger**, and those two are deliberately
independent. Any dialect that does not opt in keeps today's exact per-column behaviour.

**Tech Stack:** Node.js (CommonJS), Mocha + Chai, MySQL 8.4 / MariaDB, prettier (tabs, single
quotes, trailing commas, semicolons), eslint.

**Spec:** The full spec lives in the BDL-3681 ticket body (`bca get bctask_k7ohylsjx5n1jvn1gc0gznfya`),
immediately above this plan. Read it first — particularly the section "Two couplings that must
survive", which is the subtle half of this change.

**Repo:** `github.com/josiahbryan/yass-orm`, local checkout `/home/josiahbryan/devel/yass-orm`.
**All file paths in this plan are relative to that checkout**, not to the rubber monorepo.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **ADD-only.** Never batch `CHANGE` or `DROP`. `notNullPreflightBySql` is keyed by the exact SQL
  string of a CHANGE statement (`lib/sync-to-db.js:1178` declare, `:1451` write, `:1587` read);
  batching CHANGEs would silently orphan every NOT NULL preflight because the batched string would
  never match a key.
- **`changedColumns[].sql` MUST remain a single-column statement for every added column**, no
  matter what is executed. This is the requirement most likely to be dropped. See Task 2.
- **The default must be today's behaviour.** `supportsMultiClauseAlterAdd` defaults to `false` on
  `BaseDialect`. A dialect opts in deliberately or keeps per-column ADDs.
- **`appliedCount` keeps counting SQL STATEMENTS, not columns.** Batching N adds into one statement
  lowers the reported applied count for that table from N to 1. That is expected. Do not "fix" it.
- **No timing-based assertions anywhere in the tests.** A refused `ALTER` costs ~0s and so does a
  successful `INSTANT` one, so duration cannot separate them. Assert on captured SQL and on error
  codes.
- **Formatting:** tabs for indentation, single quotes, trailing commas, semicolons (`.prettierrc.js`).
  Run `npm run eslint:fix` before each commit.
- **Commit frequently** — one commit per task, at the end of the task.

---

## Environment setup (one-time, before Task 1)

yass-orm ships **no** `.yass-orm.js` — it is gitignored (`.gitignore:12`), so a fresh checkout
resolves `schema` to `undefined` and every DB-backed test fails to connect. Create it once:

```bash
mysql -u root -ptestsys1 -e "CREATE DATABASE IF NOT EXISTS yass_test;"

cat > /home/josiahbryan/devel/yass-orm/.yass-orm.js <<'EOF'
process.env.NODE_ENV = 'development';
module.exports = {
	development: {
		dialect: 'mysql',
		host: 'localhost',
		user: 'root',
		password: 'testsys1',
		schema: 'yass_test',
		port: 3306,
	},
};
EOF
```

Verify it resolved, and that the file stays invisible to git:

```bash
cd /home/josiahbryan/devel/yass-orm
node -e "const c=require('./lib/config'); console.log(c.dialect, c.host, c.schema, c.user)"
# expect: mysql localhost yass_test root
git status --porcelain | grep yass-orm.js || echo "gitignored, good"
```

Confirm the existing DB-backed suite is green before you change anything:

```bash
npx mocha --exit --reporter dot test/schemaSync.missingColumnVerification.test.js
# expect: 6 passing
```

**MEASURED 2026-09-12 on HP-ENVY (MySQL 8.4.11):** that config works and that suite reports
`6 passing`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/dialects/BaseDialect.js` | New `supportsMultiClauseAlterAdd` getter (**false**) + a `generateAlterAddColumns()` that throws, so a dialect opting in without implementing fails loud | 1 |
| `lib/dialects/MySQLDialect.js` | Opt in; emit `ALTER TABLE t ADD s1, ADD s2`; new `generateTableSizeQuery()` | 1, 5 |
| `lib/dialects/PostgresDialect.js` | Opt in; emit `ALTER TABLE t ADD COLUMN s1, ADD COLUMN s2` | 1 |
| `lib/dialects/SQLiteDialect.js` | Explicitly **do not** opt in (SQLite rejects multi-ADD) | 1 |
| `lib/dialects/test/{MySQL,Postgres,SQLite}Dialect.test.js` | Per-dialect syntax + capability assertions (no DB) | 1, 5 |
| `lib/sync-to-db.js` | New pure `buildAddColumnPlan()`; wire it into `mysqlSchemaUpdate`; pre-ALTER size log | 2, 3, 5 |
| `test/schemaSync.batchAddColumns.test.js` | **New.** Pure planner unit tests + DB-backed integration (one ALTER, identical schema, per-table scoping, heal ledger, size log) | 2, 3, 5 |
| `test/schemaSync.batchAddColumns.rebuildForced.test.js` | **New.** AC5 — constructs its own `INSTANT`-refusing table | 4 |
| `test/helpers/captureAlterStatements.js` | **New.** Captures the executed ALTER array from schema-sync's own debug log (no DB privileges needed) | 3 |
| `test/helpers/mysqlGeneralLog.js` | **New.** Independent execution witness via `mysql.general_log` (needs `SUPER`; skips loudly if unavailable) | 3 |
| `CHANGELOG.md`, `package.json` | Release entry + version bump to 2.8.0 | 6 |

Two test helpers exist because **the two witnesses have different failure modes**: the console
capture reads yass-orm's own view of what it executed, the general log reads the server's. Either
alone could agree with a bug; together they cannot both be wrong in the same direction.

---

## 🔴 Read before Task 1: the instrument trap in this ticket

The obvious way to count statements — patch `generateAlterAddColumn` and count calls — **is dead
for this change.** After the fix, `generateAlterAddColumn` is still called **once per column**, to
build the heal ledger (see Task 2). So a call-counting instrument reports **2 before the fix and 2
after it**, and would pass against the unfixed tree forever.

**MEASURED on the unfixed tree at HEAD `8d8e7e8`, using the instrument this plan actually
prescribes** (`mysql.general_log`, filtered to the table under test):

```
>>> RED ARM executed ALTER TABLE count = 2
    [0] ALTER TABLE `yass_bdl3681_redarm` ADD `notice` varchar(255)
    [1] ALTER TABLE `yass_bdl3681_redarm` ADD `noticeDetail` longtext
```

So the acceptance check is capable of failing against the unfixed tree. Count **executed** SQL,
never **generated** SQL.

---

### Task 1: Dialect capability getter + batched generator

Pure string generation. **No database needed** — this whole task is verifiable with
`npm run test:dialects`.

**Files:**
- Modify: `lib/dialects/BaseDialect.js` (insert after `supportsAlterColumn`, currently `:514-516`)
- Modify: `lib/dialects/MySQLDialect.js` (near `generateAlterAddColumn` `:750`; getter near `:1002`)
- Modify: `lib/dialects/PostgresDialect.js` (near `generateAlterAddColumn` `:777`; getter near `:1174`)
- Modify: `lib/dialects/SQLiteDialect.js` (getter near `:907`)
- Test: `lib/dialects/test/MySQLDialect.test.js` (beside the existing `generateAlterAddColumn()` describe at `:377`)
- Test: `lib/dialects/test/PostgresDialect.test.js` (beside `:693`)
- Test: `lib/dialects/test/SQLiteDialect.test.js` (beside `:430`)

**Interfaces:**
- Produces: `dialect.supportsMultiClauseAlterAdd → boolean` and
  `dialect.generateAlterAddColumns(tableName: string, fieldDataList: object[]) → string`.
  Task 2 consumes both.

- [ ] **Step 1: Write the failing tests**

In `lib/dialects/test/MySQLDialect.test.js`, directly after the existing
`describe('generateAlterAddColumn()', …)` block:

```js
		describe('generateAlterAddColumns()', () => {
			it('should generate ONE ALTER with several ADD clauses', () => {
				const result = dialect.generateAlterAddColumns('users', [
					{ field: 'age', type: 'int(11)' },
					{ field: 'score', type: 'int(11)' },
				]);
				expect(result).to.equal(
					'ALTER TABLE `users` ADD `age` int(11), ADD `score` int(11)',
				);
			});

			// Pins the RELATIONSHIP rather than the type mapping, so this test
			// cannot drift if generateFieldSpec changes how a type is rendered.
			it('should equal the single-column clauses joined by ", "', () => {
				const fields = [
					{ field: 'age', type: 'int(11)' },
					{ field: 'score', type: 'int(11)' },
				];
				const expected = `ALTER TABLE \`users\` ${fields
					.map((f) =>
						dialect
							.generateAlterAddColumn('users', f)
							.replace('ALTER TABLE `users` ', ''),
					)
					.join(', ')}`;
				expect(dialect.generateAlterAddColumns('users', fields)).to.equal(
					expected,
				);
			});

			it('should handle a single field', () => {
				expect(
					dialect.generateAlterAddColumns('users', [
						{ field: 'age', type: 'int(11)' },
					]),
				).to.equal('ALTER TABLE `users` ADD `age` int(11)');
			});
		});
```

In the same file's capability section (beside the existing `supportsAlterColumn` assertion at `:458`):

```js
		it('should support multi-clause ALTER ADD', () => {
			expect(dialect.supportsMultiClauseAlterAdd).to.be.true;
		});
```

In `lib/dialects/test/PostgresDialect.test.js`, after its `generateAlterAddColumn()` describe:

```js
		describe('generateAlterAddColumns()', () => {
			it('should generate ONE ALTER with several ADD COLUMN clauses', () => {
				const result = dialect.generateAlterAddColumns('users', [
					{ field: 'age', type: 'int' },
					{ field: 'score', type: 'int' },
				]);
				expect(result).to.equal(
					'ALTER TABLE "users" ADD COLUMN "age" INTEGER, ADD COLUMN "score" INTEGER',
				);
			});
		});

		it('should support multi-clause ALTER ADD', () => {
			expect(dialect.supportsMultiClauseAlterAdd).to.be.true;
		});
```

In `lib/dialects/test/SQLiteDialect.test.js`, beside its `supportsAlterColumn` assertion:

```js
		// MEASURED 2026-09-12 against better-sqlite3 AND node:sqlite: a
		// multi-ADD is rejected with `near ",": syntax error`, while a
		// single-ADD control succeeds. So SQLite must never opt in.
		it('should NOT support multi-clause ALTER ADD', () => {
			expect(dialect.supportsMultiClauseAlterAdd).to.be.false;
		});

		it('should throw if generateAlterAddColumns is called anyway', () => {
			expect(() =>
				dialect.generateAlterAddColumns('users', [
					{ field: 'a', type: 'int' },
					{ field: 'b', type: 'int' },
				]),
			).to.throw(/does not implement generateAlterAddColumns/);
		});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/josiahbryan/devel/yass-orm
npx mocha --exit --reporter spec lib/dialects/test/MySQLDialect.test.js lib/dialects/test/PostgresDialect.test.js lib/dialects/test/SQLiteDialect.test.js
```

Expected: FAIL — `dialect.generateAlterAddColumns is not a function`, and
`expected undefined to be true` for the capability getters.

- [ ] **Step 3: Implement `BaseDialect`**

In `lib/dialects/BaseDialect.js`, immediately after the `supportsAlterColumn` getter:

```js
	/**
	 * Whether this dialect accepts SEVERAL `ADD` clauses in ONE `ALTER TABLE`,
	 * i.e. `ALTER TABLE t ADD a ..., ADD b ...`.
	 *
	 * MySQL and Postgres do. SQLite does NOT -- measured 2026-09-12 against
	 * both better-sqlite3 and node:sqlite: `near ",": syntax error`, with a
	 * passing single-ADD control proving the rejection is real and not a dead
	 * probe.
	 *
	 * Defaults to FALSE so a dialect keeps the safe one-statement-per-column
	 * behaviour until it opts in deliberately.
	 *
	 * @returns {boolean}
	 */
	get supportsMultiClauseAlterAdd() {
		return false;
	}

	/**
	 * Build ONE `ALTER TABLE` that adds several columns at once.
	 *
	 * Only ever called when `supportsMultiClauseAlterAdd` is true, so the base
	 * implementation THROWS rather than guessing a syntax: a dialect that opts
	 * in without implementing this must fail loud, not silently emit something
	 * the server rejects halfway through a migration.
	 *
	 * @param {string} tableName
	 * @param {object[]} fieldDataList - fieldData for each column, in order
	 * @returns {string}
	 */
	// eslint-disable-next-line no-unused-vars
	generateAlterAddColumns(tableName, fieldDataList) {
		throw new Error(
			`${this.constructor.name} does not implement generateAlterAddColumns()`,
		);
	}
```

- [ ] **Step 4: Implement MySQL**

In `lib/dialects/MySQLDialect.js`, directly after `generateAlterAddColumn` (`:750-755`):

```js
	generateAlterAddColumns(tableName, fieldDataList) {
		const quotedTable = this.quoteIdentifier(tableName);
		const clauses = (fieldDataList || [])
			.map((fieldData) => `ADD ${this.generateFieldSpec(fieldData)}`)
			.join(', ');
		return `ALTER TABLE ${quotedTable} ${clauses}`;
	}
```

And beside the existing `supportsAlterColumn` getter:

```js
	get supportsMultiClauseAlterAdd() {
		return true;
	}
```

- [ ] **Step 5: Implement Postgres**

In `lib/dialects/PostgresDialect.js`, directly after `generateAlterAddColumn` (`:777-782`):

```js
	generateAlterAddColumns(tableName, fieldDataList) {
		const quotedTable = this.quoteIdentifier(tableName);
		const clauses = (fieldDataList || [])
			.map((fieldData) => `ADD COLUMN ${this.generateFieldSpec(fieldData)}`)
			.join(', ');
		return `ALTER TABLE ${quotedTable} ${clauses}`;
	}
```

And beside its `supportsAlterColumn` getter:

```js
	get supportsMultiClauseAlterAdd() {
		return true; // ALTER TABLE t ADD COLUMN a ..., ADD COLUMN b ...
	}
```

- [ ] **Step 6: Implement SQLite (explicit opt-OUT)**

In `lib/dialects/SQLiteDialect.js`, beside its `supportsAlterColumn` getter. Do NOT add a
`generateAlterAddColumns` — inheriting the throwing base implementation is the point.

```js
	get supportsMultiClauseAlterAdd() {
		// MEASURED 2026-09-12 (better-sqlite3 AND node:sqlite): a multi-ADD is
		// rejected with `near ",": syntax error`; a single-ADD control passes.
		return false;
	}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:dialects
```

Expected: PASS, all three dialect suites.

- [ ] **Step 8: Lint and commit**

```bash
cd /home/josiahbryan/devel/yass-orm
npm run eslint:fix
git add lib/dialects/BaseDialect.js lib/dialects/MySQLDialect.js lib/dialects/PostgresDialect.js lib/dialects/SQLiteDialect.js lib/dialects/test/MySQLDialect.test.js lib/dialects/test/PostgresDialect.test.js lib/dialects/test/SQLiteDialect.test.js
git commit -m "feat(dialects): multi-clause ALTER ADD capability + batched generator (BDL-3681)"
```

---

### Task 2: The pure `buildAddColumnPlan()` planner

The heart of the change, and the task that protects the heal ledger. **No database needed.**

**Files:**
- Modify: `lib/sync-to-db.js` (add the function beside `findMissingSchemaColumns`, and export it in the `module.exports` block at `:2550`)
- Test: `test/schemaSync.batchAddColumns.test.js` (new file — pure section only in this task)

**Interfaces:**
- Consumes: `dialect.supportsMultiClauseAlterAdd` and `dialect.generateAlterAddColumns()` from Task 1.
- Produces:
  `buildAddColumnPlan({ dialect, tableName, addFieldList }) → { statements: string[], ledger: {col: string, type: 'ADD', sql: string}[] }`.
  Task 3 consumes it.

- [ ] **Step 1: Write the failing tests**

Create `test/schemaSync.batchAddColumns.test.js`:

```js
/* eslint-disable no-console */
/* global describe, it */
const { expect } = require('chai');
const { buildAddColumnPlan } = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');

describe('#schemaSync buildAddColumnPlan', () => {
	const mysql = new MySQLDialect();
	const sqlite = new SQLiteDialect();
	const twoFields = [
		{ field: 'notice', type: 'varchar(255)' },
		{ field: 'noticeDetail', type: 'text' },
	];

	it('batches N>1 columns into exactly ONE statement on an opted-in dialect', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.statements).to.have.length(1);
		expect(plan.statements[0]).to.include('notice');
		expect(plan.statements[0]).to.include('noticeDetail');
	});

	// AC7 -- the coupling most likely to be dropped. verifyAndHealColumns
	// replays entry.sql PER COLUMN, so a shared batched string there would
	// replay every ADD to heal one, i.e. a second full table rebuild.
	it('keeps the heal ledger SINGLE-COLUMN even when batching', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.ledger).to.have.length(2);

		const [first, second] = plan.ledger;
		expect(first.col).to.equal('notice');
		expect(first.type).to.equal('ADD');
		expect(first.sql).to.include('notice');
		expect(first.sql).to.not.include('noticeDetail');

		expect(second.col).to.equal('noticeDetail');
		expect(second.sql).to.include('noticeDetail');
		// A single-column ledger entry names exactly ONE column.
		expect(second.sql.match(/ADD /g)).to.have.length(1);
	});

	it('N=1 emits one statement byte-identical to the single-column generator', () => {
		const one = [{ field: 'notice', type: 'varchar(255)' }];
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: one,
		});
		expect(plan.statements).to.have.length(1);
		expect(plan.statements[0]).to.equal(
			mysql.generateAlterAddColumn('widgets', one[0]),
		);
	});

	it('N=0 emits NOTHING (never an empty ALTER TABLE with no clauses)', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: [],
		});
		expect(plan.statements).to.deep.equal([]);
		expect(plan.ledger).to.deep.equal([]);
	});

	// AC6 -- a dialect that has not opted in keeps today's exact behaviour.
	it('falls back to one statement per column on a non-opted-in dialect', () => {
		const plan = buildAddColumnPlan({
			dialect: sqlite,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.statements).to.have.length(2);
		expect(plan.statements[0]).to.equal(
			sqlite.generateAlterAddColumn('widgets', twoFields[0]),
		);
		expect(plan.statements[1]).to.equal(
			sqlite.generateAlterAddColumn('widgets', twoFields[1]),
		);
	});

	it('preserves schema order in both statements and ledger', () => {
		const plan = buildAddColumnPlan({
			dialect: mysql,
			tableName: 'widgets',
			addFieldList: twoFields,
		});
		expect(plan.ledger.map((e) => e.col)).to.deep.equal([
			'notice',
			'noticeDetail',
		]);
		expect(plan.statements[0].indexOf('notice')).to.be.lessThan(
			plan.statements[0].indexOf('noticeDetail'),
		);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/josiahbryan/devel/yass-orm
npx mocha --exit --reporter spec test/schemaSync.batchAddColumns.test.js
```

Expected: FAIL with `buildAddColumnPlan is not a function`.

- [ ] **Step 3: Implement `buildAddColumnPlan`**

In `lib/sync-to-db.js`, immediately before `async function verifyAndHealColumns(` (currently `:932`):

```js
/**
 * Decide HOW one table's missing columns get added.
 *
 * Returns two INDEPENDENT things, and keeping them independent IS the point:
 *
 *   statements - what actually gets EXECUTED. ONE batched
 *                `ALTER TABLE t ADD a ..., ADD b ...` when the dialect opts in
 *                AND there is more than one column; otherwise one statement per
 *                column, exactly as before.
 *
 *   ledger     - what `changedColumns` records. ALWAYS one SINGLE-COLUMN
 *                statement per column, regardless of what `statements` holds.
 *
 * The ledger must stay single-column because `verifyAndHealColumns` re-issues
 * `entry.sql` for EACH column that did not persist (see the `conn.pquery(entry.sql)`
 * call in that function). A shared batched string there would replay EVERY ADD in
 * order to heal ONE -- and on a rebuild-forced table that is a second full table
 * rebuild, i.e. precisely the multi-rebuild stall this batching exists to remove,
 * reintroduced by the fix, in a path that only fires under connection churn and
 * would therefore be invisible in ordinary testing. The duplicate-column errors
 * the replay throws are swallowed by design, so it would even look healthy.
 *
 * @param {object} args
 * @param {object} args.dialect
 * @param {string} args.tableName
 * @param {object[]} args.addFieldList - fieldData per column to ADD, in schema order
 * @returns {{statements: string[], ledger: {col: string, type: string, sql: string}[]}}
 */
function buildAddColumnPlan({ dialect: d, tableName, addFieldList } = {}) {
	const fields = addFieldList || [];

	// Per-column, ALWAYS, independent of what we execute.
	const ledger = fields.map((fieldData) => ({
		col: fieldData.field,
		type: 'ADD',
		sql: d.generateAlterAddColumn(tableName, fieldData),
	}));

	if (!fields.length) {
		return { statements: [], ledger };
	}

	if (fields.length > 1 && d.supportsMultiClauseAlterAdd) {
		return {
			statements: [d.generateAlterAddColumns(tableName, fields)],
			ledger,
		};
	}

	// One column, or a dialect that has not opted in: byte-identical to the
	// pre-batching behaviour.
	return { statements: ledger.map((entry) => entry.sql), ledger };
}
```

> **Note on the parameter name:** `lib/sync-to-db.js` already has a module-scope `dialect`. The
> parameter is named `d` so the function stays **pure and injectable** — the unit tests pass their
> own dialect instances in. Do not read the module-scope `dialect` inside this function.

Add it to the `module.exports` block (`:2550`), beside `findMissingSchemaColumns`:

```js
	buildAddColumnPlan,
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx mocha --exit --reporter spec test/schemaSync.batchAddColumns.test.js
```

Expected: PASS, 6 passing.

- [ ] **Step 5: Lint and commit**

```bash
npm run eslint:fix
git add lib/sync-to-db.js test/schemaSync.batchAddColumns.test.js
git commit -m "feat(schema-sync): pure buildAddColumnPlan; heal ledger stays single-column (BDL-3681)"
```

---

### Task 3: Wire the planner into `mysqlSchemaUpdate`

This is the task that actually changes runtime behaviour.

**Files:**
- Modify: `lib/sync-to-db.js` — the ADD branch of the `fieldList.forEach` (currently `:1183-1193`), and the `alter` declaration (currently `:1177`)
- Create: `test/helpers/captureAlterStatements.js`
- Create: `test/helpers/mysqlGeneralLog.js`
- Test: `test/schemaSync.batchAddColumns.test.js` (append the DB-backed section)

**Interfaces:**
- Consumes: `buildAddColumnPlan()` from Task 2.
- Produces: no new public API. Runtime behaviour change only.

- [ ] **Step 1: Write the two test helpers**

Create `test/helpers/captureAlterStatements.js`:

```js
/**
 * captureAlterStatements -- reads back the ALTER statements schema-sync
 * ACTUALLY EXECUTED for a table, from its own debug log.
 *
 * WHY THIS AND NOT A DIALECT PATCH: after BDL-3681, `generateAlterAddColumn`
 * is still called ONCE PER COLUMN to build the heal ledger. So counting
 * generator calls reports the same number before and after the fix and can
 * never detect the change. This helper reads the `Debug: [db] Alter table:`
 * line, which logs `alter.join(';\n')` -- and `promiseMap` iterates that SAME
 * `alter` array, one element per execQuery call. So the count here IS the
 * number of statements executed.
 */

function install() {
	const captured = [];
	// eslint-disable-next-line no-console
	const original = console.log;
	// eslint-disable-next-line no-console
	console.log = (...args) => {
		captured.push(args.map((a) => `${a}`).join(' '));
	};

	const MARKER = 'Alter table:';

	return {
		captured,
		/** Every ALTER statement schema-sync executed, in order. */
		executedAlterStatements() {
			return captured
				.filter((line) => line.includes(MARKER))
				.flatMap((line) =>
					line.slice(line.indexOf(MARKER) + MARKER.length).split(/;\s*\n/),
				)
				.map((s) => s.trim())
				.filter((s) => /^ALTER TABLE/i.test(s));
		},
		/** Just the ones naming `tableName` -- robust against other suites. */
		executedAltersFor(tableName) {
			return this.executedAlterStatements().filter((s) =>
				s.includes(tableName),
			);
		},
		restore() {
			// eslint-disable-next-line no-console
			console.log = original;
		},
	};
}

module.exports = { captureAlterStatements: { install } };
```

Create `test/helpers/mysqlGeneralLog.js`:

```js
/**
 * mysqlGeneralLog -- an INDEPENDENT witness of what the SERVER actually
 * executed, used alongside captureAlterStatements (which reports yass-orm's
 * own view). Two instruments with different failure modes: either alone could
 * agree with a bug, but not both in the same direction.
 *
 * Needs SUPER / SYSTEM_VARIABLES_ADMIN. When that is unavailable this returns
 * `{ available: false, reason }` and the caller must SAY SO rather than
 * silently reporting a clean result -- a skip that cannot say why it skipped
 * is indistinguishable from a test that does not exist.
 */

async function enable(conn) {
	try {
		await conn.pquery("SET GLOBAL log_output='TABLE'");
		await conn.pquery("SET GLOBAL general_log='ON'");
		await conn.pquery('TRUNCATE TABLE mysql.general_log');
		return { available: true };
	} catch (ex) {
		return { available: false, reason: `${(ex && ex.message) || ex}` };
	}
}

async function disable(conn) {
	try {
		await conn.pquery("SET GLOBAL general_log='OFF'");
	} catch (ex) {
		// best-effort restore
	}
}

/**
 * ALTER statements the server logged for one table. Filtered BY TABLE NAME, so
 * a concurrent suite on the same server cannot inflate the count.
 */
async function altersFor(conn, tableName) {
	const rows = await conn.pquery(
		`SELECT CONVERT(argument USING utf8mb4) AS q
		   FROM mysql.general_log
		  WHERE command_type = 'Query'
		    AND CONVERT(argument USING utf8mb4) LIKE 'ALTER TABLE%${tableName}%'`,
	);
	return (rows || []).map((r) => r.q);
}

module.exports = { mysqlGeneralLog: { enable, disable, altersFor } };
```

- [ ] **Step 2: Write the failing DB-backed tests**

Append to `test/schemaSync.batchAddColumns.test.js`:

```js
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const {
	captureAlterStatements,
} = require('./helpers/captureAlterStatements');
const { mysqlGeneralLog } = require('./helpers/mysqlGeneralLog');

describe('#schemaSync batched ADD COLUMN (db-backed)', function batchedAddSuite() {
	this.timeout(60000);

	const tableA = `yass_batch_a_${uuid().replace(/-/g, '')}`;
	const tableB = `yass_batch_b_${uuid().replace(/-/g, '')}`;

	const base = (table) => ({ types: t }) => ({
		table,
		schema: { id: t.idKey },
	});
	const plusTwo = (table) => ({ types: t }) => ({
		table,
		schema: { id: t.idKey, notice: t.string, noticeDetail: t.text },
	});

	before(function beforeBatchedAddSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableA}\``);
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableB}\``);
		await mysqlGeneralLog.disable(conn);
		await conn.end();
	});

	it('executes exactly ONE ALTER for two columns added to one table', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(base(tableA)));

		const conn = await dbh({ ignoreCachedConnections: true });
		const log = await mysqlGeneralLog.enable(conn);

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(tableA)));
		} finally {
			cap.restore();
		}

		// WITNESS 1 -- yass-orm's own executed-statement array. Always runs.
		const executed = cap.executedAltersFor(tableA);
		expect(
			executed,
			`expected ONE batched ALTER, got:\n${executed.join('\n')}`,
		).to.have.length(1);
		expect(executed[0]).to.include('notice');
		expect(executed[0]).to.include('noticeDetail');

		// WITNESS 2 -- the SERVER's own log. Independent failure mode.
		if (log.available) {
			const serverAlters = await mysqlGeneralLog.altersFor(conn, tableA);
			expect(
				serverAlters,
				`server logged:\n${serverAlters.join('\n')}`,
			).to.have.length(1);
		} else {
			console.warn(
				`SKIPPED the general-log witness: ${log.reason}. Witness 1 still asserted.`,
			);
		}
		await mysqlGeneralLog.disable(conn);
		await conn.end();
	});

	// AC7 end-to-end: the ledger the heal path replays is still per-column.
	it('records a SINGLE-COLUMN heal statement per added column', async () => {
		const dropped = `yass_batch_led_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(dropped)));

		const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
		const seen = [];
		const originalGenerate = MySQLDialect.prototype.generateAlterAddColumn;
		MySQLDialect.prototype.generateAlterAddColumn = function patched(
			table,
			fieldData,
		) {
			const out = originalGenerate.call(this, table, fieldData);
			if (table === dropped) {
				seen.push(out);
			}
			return out;
		};
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(dropped)));
		} finally {
			MySQLDialect.prototype.generateAlterAddColumn = originalGenerate;
		}

		// Two single-column statements were generated for the ledger even though
		// ONE batched statement was executed.
		expect(seen).to.have.length(2);
		seen.forEach((stmt) => {
			expect(stmt.match(/ADD /g)).to.have.length(1);
		});

		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${dropped}\``);
		await conn.end();
	});

	// AC4 -- batching is PER TABLE.
	it('keeps columns on different tables in separate statements', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(base(tableB)));

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(tableB)));
		} finally {
			cap.restore();
		}

		const forB = cap.executedAltersFor(tableB);
		expect(forB).to.have.length(1);
		// No statement may name both tables.
		expect(forB[0]).to.not.include(tableA);
	});

	// AC2 -- the resulting schema must be identical to the per-column path,
	// column ORDER included.
	it('produces a schema identical to the per-column path', async () => {
		const batched = `yass_batch_eq_b_${uuid().replace(/-/g, '')}`;
		const perCol = `yass_batch_eq_p_${uuid().replace(/-/g, '')}`;
		const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

		await syncSchemaToDb(YassORM.convertDefinition(base(batched)));
		await syncSchemaToDb(YassORM.convertDefinition(base(perCol)));

		// Batched run (normal behaviour).
		await syncSchemaToDb(YassORM.convertDefinition(plusTwo(batched)));

		// Per-column run: force the capability OFF for this one sync.
		const descriptor = Object.getOwnPropertyDescriptor(
			MySQLDialect.prototype,
			'supportsMultiClauseAlterAdd',
		);
		Object.defineProperty(
			MySQLDialect.prototype,
			'supportsMultiClauseAlterAdd',
			{ get: () => false, configurable: true },
		);
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(perCol)));
		} finally {
			Object.defineProperty(
				MySQLDialect.prototype,
				'supportsMultiClauseAlterAdd',
				descriptor,
			);
		}

		const conn = await dbh({ ignoreCachedConnections: true });
		const read = async (name) => {
			const rows = await conn.pquery(`SHOW CREATE TABLE \`${name}\``);
			const ddl = rows[0]['Create Table'] || rows[0].Table_Create || '';
			return ddl.replace(new RegExp(name, 'g'), 'T');
		};
		const ddlBatched = await read(batched);
		const ddlPerCol = await read(perCol);
		await conn.pquery(`DROP TABLE IF EXISTS \`${batched}\``);
		await conn.pquery(`DROP TABLE IF EXISTS \`${perCol}\``);
		await conn.end();

		expect(ddlBatched).to.equal(ddlPerCol);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx mocha --exit --reporter spec test/schemaSync.batchAddColumns.test.js
```

Expected: the "exactly ONE ALTER" test FAILS reporting **2** statements. That is the red arm
reproducing. The schema-equality test should already pass (both paths are per-column today) — that
is fine; it is a guard against the change, not a detector of the bug.

- [ ] **Step 4: Implement the wiring**

In `lib/sync-to-db.js`, at the `alter` declaration (currently `:1177`), add the collector:

```js
		const alter = [];
		const addFieldList = [];
```

Replace the three lines in the ADD branch (currently `:1190-1192`):

```js
				const addSql = dialect.generateAlterAddColumn(tableName, fieldData);
				alter.push(addSql);
				changedColumns.push({ col: key, type: 'ADD', sql: addSql });
```

with:

```js
				addFieldList.push(fieldData);
```

Then, immediately AFTER the closing `});` of that `fieldList.forEach(...)` and BEFORE
`if (requiresTableRebuild) {`, add:

```js
		// Batch this table's ADDs into ONE ALTER where the dialect allows it.
		// MySQL performs one full table rebuild per ALTER on a table that cannot
		// take ALGORITHM=INSTANT, so N separate ADDs cost N rebuilds while one
		// batched ALTER costs one. The LEDGER stays per-column -- see
		// buildAddColumnPlan for why that is load-bearing.
		//
		// NOTE: ADD statements now land at the END of `alter`, after any CHANGE
		// statements, instead of interleaved in schema order. A CHANGE to an
		// existing column and an ADD of a new one are independent, so ordering
		// does not affect the result; the "produces a schema identical to the
		// per-column path" test pins that.
		const addPlan = buildAddColumnPlan({
			dialect,
			tableName,
			addFieldList,
		});
		addPlan.statements.forEach((stmt) => alter.push(stmt));
		addPlan.ledger.forEach((entry) => changedColumns.push(entry));
```

> **Why before the `requiresTableRebuild` check:** today the ADD ledger is pushed to
> `changedColumns` inside the forEach, i.e. before that check, and `verifyAndHealColumns` depends on
> it being populated on both branches. Placing the block here preserves that exactly.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx mocha --exit --reporter spec test/schemaSync.batchAddColumns.test.js
```

Expected: PASS. The "exactly ONE ALTER" test now reports 1 from **both** witnesses.

- [ ] **Step 6: Run the neighbouring schema-sync suites for regressions**

```bash
npx mocha --exit --reporter dot \
  test/schemaSync.missingColumnVerification.test.js \
  test/schemaSync.idempotency.test.js \
  test/schemaSync.notNullDiagnostic.test.js \
  test/schemaSync.textColumnReindex.test.js \
  test/schemaSync.errorReporting.test.js
```

Expected: PASS. `missingColumnVerification` is the heal-path suite and is the one that would catch
a broken ledger.

- [ ] **Step 7: Lint and commit**

```bash
npm run eslint:fix
git add lib/sync-to-db.js test/schemaSync.batchAddColumns.test.js test/helpers/captureAlterStatements.js test/helpers/mysqlGeneralLog.js
git commit -m "feat(schema-sync): execute one batched ALTER per table for multi-column ADDs (BDL-3681)"
```

---

### Task 4: AC5 — prove it on a table that genuinely refuses `ALGORITHM=INSTANT`

The test **constructs its own subject**. It must not depend on
`bc_agent_grid_transcript_turns`, whose rebuild-forced status is being actively repaired by a
scheduled `ALTER … FORCE`.

**Files:**
- Test: `test/schemaSync.batchAddColumns.rebuildForced.test.js` (new)

**Interfaces:** consumes the Task 3 helpers only. No production code changes in this task.

**Measured recipe (2026-09-12, MySQL 8.4.11).** The discriminator is fulltext **HISTORY**, not index
**PRESENCE** — a table that merely *had* a FULLTEXT index keeps a hidden `FTS_DOC_ID` column after
the index is dropped, and that is what refuses INSTANT:

| fixture | probe result |
|---|---|
| never had FULLTEXT (**control**) | INSTANT **succeeds** |
| FULLTEXT index still live | `ERROR 1846` — "…one FULLTEXT index creation at a time" |
| FULLTEXT created then dropped | `ERROR 1845` — generic "not supported for this operation" |
| after `ALTER TABLE t FORCE` | INSTANT **succeeds** again |

- [ ] **Step 1: Write the failing test**

```js
/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const {
	captureAlterStatements,
} = require('./helpers/captureAlterStatements');

// AC5. A table that CANNOT take ALGORITHM=INSTANT pays a full rebuild per
// ALTER, so N separate ADDs cost N rebuilds. This proves the batched path
// issues ONE statement against exactly such a table.
//
// 🔴 DELIBERATELY NOT TIMED. A REFUSED alter costs ~0s and so does a
// successful INSTANT one, so duration cannot separate the outcomes -- two
// desks misdiagnosed exactly that on 2026-09-12 from a 0-second digest row.
// We read the ERROR CODE to establish the fixture, then count STATEMENTS.
describe('#schemaSync batched ADD on a rebuild-forced table', function rebuildForcedSuite() {
	this.timeout(60000);

	const table = `yass_batch_rf_${uuid().replace(/-/g, '')}`;
	let conn;
	let fixtureRefusesInstant = false;

	before(async function beforeRebuildForcedSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
			return;
		}
		conn = await dbh({ ignoreCachedConnections: true });

		// Build a table with fulltext HISTORY: create the index, then drop it.
		// The hidden FTS_DOC_ID column DROP INDEX leaves behind is what makes
		// the table refuse INSTANT afterwards.
		await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
		await conn.pquery(
			`CREATE TABLE \`${table}\` (
				id int NOT NULL PRIMARY KEY,
				body text,
				FULLTEXT KEY ft_body (body)
			) ENGINE=InnoDB ROW_FORMAT=DYNAMIC`,
		);
		await conn.pquery(`DROP INDEX ft_body ON \`${table}\``);

		// PROBE: does it actually refuse INSTANT? Establish from the ERROR CODE.
		// Accept 1845 OR 1846 -- which one you get depends on whether the index
		// is still live, and pinning one is brittle across MySQL versions.
		try {
			await conn.pquery(
				`ALTER TABLE \`${table}\` ADD probe_col int, ALGORITHM=INSTANT`,
			);
			// It SUCCEEDED -- the fixture did not reproduce on this server.
			await conn.pquery(`ALTER TABLE \`${table}\` DROP COLUMN probe_col`);
		} catch (ex) {
			const code = (ex && (ex.errno || ex.code)) || 0;
			const msg = `${(ex && ex.message) || ex}`;
			fixtureRefusesInstant =
				code === 1845 ||
				code === 1846 ||
				/ALGORITHM=INSTANT is not supported/i.test(msg);
		}
	});

	after(async () => {
		if (conn) {
			await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
			await conn.end();
		}
	});

	it('issues ONE ALTER for two columns on an INSTANT-refusing table', async function instantTest() {
		if (!fixtureRefusesInstant) {
			// Say WHY. A skip that cannot name its reason is indistinguishable
			// from a test that does not exist.
			console.warn(
				`SKIPPING: could not construct an INSTANT-refusing table on this server -- the fulltext-history probe was ACCEPTED, so this environment does not reproduce the rebuild-forced condition.`,
			);
			this.skip();
			return;
		}

		const schema = ({ types: t }) => ({
			table,
			schema: {
				id: t.idKey,
				body: t.text,
				notice: t.string,
				noticeDetail: t.text,
			},
		});

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(schema));
		} finally {
			cap.restore();
		}

		const executed = cap.executedAltersFor(table);
		const addAlters = executed.filter((s) => /\bADD\b/.test(s));
		expect(
			addAlters,
			`expected ONE batched ADD alter on a rebuild-forced table, got:\n${addAlters.join(
				'\n',
			)}`,
		).to.have.length(1);
		expect(addAlters[0]).to.include('notice');
		expect(addAlters[0]).to.include('noticeDetail');

		// The columns really landed.
		const cols = await conn.pquery(`SHOW COLUMNS FROM \`${table}\``);
		const names = cols.map((c) => c.Field);
		expect(names).to.include('notice');
		expect(names).to.include('noticeDetail');
	});
});
```

- [ ] **Step 2: Run it against the CURRENT tree to confirm the fixture reproduces**

```bash
npx mocha --exit --reporter spec test/schemaSync.batchAddColumns.rebuildForced.test.js
```

Expected **after Task 3**: PASS with 1 statement. If you run this on a stash of the pre-Task-3 code
it must report **2** — that is the red arm for AC5. If instead you see the `SKIPPING` warning, the
server did not reproduce the fixture; report that rather than treating it as a pass.

- [ ] **Step 3: Commit**

```bash
npm run eslint:fix
git add test/schemaSync.batchAddColumns.rebuildForced.test.js
git commit -m "test(schema-sync): prove one ALTER on a self-constructed INSTANT-refusing table (BDL-3681)"
```

---

### Task 5: AC8 — print row count and size before an ADD batch

**Files:**
- Modify: `lib/dialects/BaseDialect.js` (add `generateTableSizeQuery`, returns `null`)
- Modify: `lib/dialects/MySQLDialect.js` (implement it)
- Modify: `lib/sync-to-db.js` (add `logTableSizeBeforeAdds`, call it in the `alter.length` branch)
- Test: `lib/dialects/test/MySQLDialect.test.js` (exact query string)
- Test: `test/schemaSync.batchAddColumns.test.js` (log line appears; a FAILING lookup does not block the ALTER)

**Interfaces:**
- Produces: `dialect.generateTableSizeQuery(tableName, { database } = {}) → string | null`.

> **Scope note:** implemented for **MySQL only**. Postgres and SQLite inherit the base `null` and
> simply print no size line. AC8 is explicitly best-effort, and the rebuild-stall problem this
> ticket exists for is MySQL's — shipping untested Postgres size SQL would be YAGNI.

> **Two facts this code depends on, both verified by reading the source:**
> `execQuery(sql, mutates)` (`lib/sync-to-db.js:186`) takes **no bind parameters** — it calls
> `dbh.pquery(sql, undefined, { silenceErrors: true })` — which is why the query must be fully
> inlined by the dialect. And `BaseDialect.escapeValue()` (`:69`, **not** overridden by
> `MySQLDialect`) returns a **quoted** literal for strings (`'foo'`, with `'` doubled), so it must
> not be wrapped in extra quotes.

- [ ] **Step 1: Write the failing tests**

In `lib/dialects/test/MySQLDialect.test.js`:

```js
		describe('generateTableSizeQuery()', () => {
			it('should scope to the current database by default', () => {
				const sql = dialect.generateTableSizeQuery('widgets');
				expect(sql).to.include('information_schema.TABLES');
				expect(sql).to.include('TABLE_SCHEMA = DATABASE()');
				expect(sql).to.include("TABLE_NAME = 'widgets'");
			});

			it('should accept an explicit database', () => {
				const sql = dialect.generateTableSizeQuery('widgets', {
					database: 'otherdb',
				});
				expect(sql).to.include("TABLE_SCHEMA = 'otherdb'");
			});
		});
```

In `lib/dialects/test/SQLiteDialect.test.js`:

```js
		it('should not provide a table size query', () => {
			expect(dialect.generateTableSizeQuery('widgets')).to.equal(null);
		});
```

Append to the db-backed describe in `test/schemaSync.batchAddColumns.test.js`:

```js
	it('logs the table size before adding columns', async () => {
		const sized = `yass_batch_size_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(sized)));

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(sized)));
		} finally {
			cap.restore();
		}

		const sizeLines = cap.captured.filter(
			(l) => l.includes(sized) && l.includes('column(s) to'),
		);
		expect(
			sizeLines,
			`expected a pre-ALTER size line, captured:\n${cap.captured.join('\n')}`,
		).to.have.length.greaterThan(0);
		expect(sizeLines[0]).to.match(/rows/);

		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${sized}\``);
		await conn.end();
	});

	// The important half of AC8: a failed size lookup must NEVER block a
	// schema change.
	it('still applies the ALTER when the size lookup throws', async () => {
		const broken = `yass_batch_brk_${uuid().replace(/-/g, '')}`;
		await syncSchemaToDb(YassORM.convertDefinition(base(broken)));

		const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
		const original = MySQLDialect.prototype.generateTableSizeQuery;
		MySQLDialect.prototype.generateTableSizeQuery = function boom() {
			throw new Error('size lookup exploded on purpose');
		};
		try {
			await syncSchemaToDb(YassORM.convertDefinition(plusTwo(broken)));
		} finally {
			MySQLDialect.prototype.generateTableSizeQuery = original;
		}

		const conn = await dbh({ ignoreCachedConnections: true });
		const cols = await conn.pquery(`SHOW COLUMNS FROM \`${broken}\``);
		const names = cols.map((c) => c.Field);
		await conn.pquery(`DROP TABLE IF EXISTS \`${broken}\``);
		await conn.end();

		expect(names).to.include('notice');
		expect(names).to.include('noticeDetail');
	});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx mocha --exit --reporter spec lib/dialects/test/MySQLDialect.test.js test/schemaSync.batchAddColumns.test.js
```

Expected: FAIL — `generateTableSizeQuery is not a function`, and no size line captured.

- [ ] **Step 3: Implement the dialect methods**

In `lib/dialects/BaseDialect.js`, beside `generateAlterAddColumns`:

```js
	/**
	 * SQL that reports a table's approximate row count and data/index size, or
	 * `null` when this dialect has no cheap way to answer.
	 *
	 * Returns a COMPLETE, fully-inlined statement because schema-sync's
	 * `execQuery` takes no bind parameters.
	 *
	 * @param {string} tableName
	 * @param {object} [opts]
	 * @param {string} [opts.database]
	 * @returns {string|null}
	 */
	// eslint-disable-next-line no-unused-vars
	generateTableSizeQuery(tableName, opts = {}) {
		return null;
	}
```

In `lib/dialects/MySQLDialect.js`:

```js
	generateTableSizeQuery(tableName, { database } = {}) {
		// escapeValue returns an ALREADY-QUOTED literal -- do not add quotes.
		const schemaExpr = database ? this.escapeValue(database) : 'DATABASE()';
		return (
			`SELECT TABLE_ROWS AS tableRows, ` +
			`COALESCE(DATA_LENGTH, 0) AS dataBytes, ` +
			`COALESCE(INDEX_LENGTH, 0) AS indexBytes ` +
			`FROM information_schema.TABLES ` +
			`WHERE TABLE_SCHEMA = ${schemaExpr} ` +
			`AND TABLE_NAME = ${this.escapeValue(tableName)}`
		);
	}
```

- [ ] **Step 4: Implement the logger and call it**

In `lib/sync-to-db.js`, beside `getNotNullBackfillDiagnostic` (currently `:718`):

```js
/**
 * Best-effort size report printed BEFORE an ADD batch, so an operator can see
 * they are about to stall a large table.
 *
 * Every failure path degrades to "size unknown" and returns normally: a failed
 * size lookup must NEVER block a schema change.
 */
async function logTableSizeBeforeAdds({ db, table, tableName, addCount }) {
	let detail = 'size unknown (lookup unavailable)';
	try {
		if (typeof dialect.generateTableSizeQuery === 'function') {
			const query = dialect.generateTableSizeQuery(tableName);
			if (query) {
				const rows = await execQuery(query);
				const row = rows && rows[0];
				if (row) {
					const approxRows = Number(row.tableRows) || 0;
					const bytes =
						(Number(row.dataBytes) || 0) + (Number(row.indexBytes) || 0);
					detail = `approx ${approxRows} rows, ${(
						bytes /
						1024 /
						1024
					).toFixed(1)} MB data+index`;
				}
			}
		}
	} catch (ex) {
		detail = `size unknown (${(ex && ex.message) || ex})`;
	}
	console.log(
		`Debug: [${db}] Adding ${addCount} column(s) to ${table}: ${detail}`,
	);
}
```

Then, inside the `} else if (alter.length) {` branch, immediately BEFORE
`const alterSql = alter.join(';\n');`:

```js
			if (addFieldList.length) {
				await logTableSizeBeforeAdds({
					db,
					table,
					tableName,
					addCount: addFieldList.length,
				});
			}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx mocha --exit --reporter spec lib/dialects/test/MySQLDialect.test.js lib/dialects/test/SQLiteDialect.test.js test/schemaSync.batchAddColumns.test.js
```

Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npm run eslint:fix
git add lib/dialects/BaseDialect.js lib/dialects/MySQLDialect.js lib/dialects/test/MySQLDialect.test.js lib/dialects/test/SQLiteDialect.test.js lib/sync-to-db.js test/schemaSync.batchAddColumns.test.js
git commit -m "feat(schema-sync): report table rows and size before an ADD batch (BDL-3681)"
```

---

### Task 6: Release — full suite, CHANGELOG, version bump

**Files:**
- Modify: `package.json` (`2.7.0` → `2.8.0`)
- Modify: `CHANGELOG.md` (entry under `## [Unreleased]` → `### Added`)
- Add: `docs/plans/2026-09-12-bdl3681-batch-add-columns.md` (this file)

- [ ] **Step 1: Run the full suite**

```bash
cd /home/josiahbryan/devel/yass-orm
npm test 2>&1 | tee /tmp/bdl3681-full-suite.log
tail -30 /tmp/bdl3681-full-suite.log
```

Expected: an explicit `N passing` epilogue. **A contiguous list of numbered failures is a FLOOR,
not a total** — only an epilogue proves the run finished. If there is no `N passing` line, the run
did not reach the end; do not report a count from it.

- [ ] **Step 2: Write the CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`:

```markdown
- **A table's ADD COLUMNs batch into ONE `ALTER` (2.8.0, BDL-3681).** When a single
  schema-sync run added N columns to the same table, `lib/sync-to-db.js` pushed N
  complete standalone `ALTER TABLE` statements and `promiseMap` executed them one
  at a time. MySQL performs a full table rebuild per `ALTER` on any table that
  cannot take `ALGORITHM=INSTANT`, so N columns cost N rebuilds — measured on a
  1.5M-row table, that was tens of minutes of fleet stall per extra column.

  The `join(';\n')` in the debug log was only ever a presentation artifact; the
  statements were always executed separately, so the log read like one batched
  statement and was not.

  `ALTER TABLE t ADD a ..., ADD b ...` is now emitted when the dialect opts in via
  the new `supportsMultiClauseAlterAdd` getter. It defaults to **false** on
  `BaseDialect`; MySQL and Postgres opt in, **SQLite does not** — measured against
  both better-sqlite3 and node:sqlite, a multi-ADD is rejected with
  `near ",": syntax error` while a single-ADD control passes. Any dialect that has
  not opted in keeps the previous per-column behaviour exactly.

  **The heal ledger is deliberately NOT batched.** `verifyAndHealColumns` re-issues
  `changedColumns[].sql` per column, so a shared batched string there would replay
  every ADD to heal one — a second full rebuild, in a path that only fires under
  connection churn, with the duplicate-column errors swallowed by design so it
  would look healthy. `buildAddColumnPlan()` returns the executed statements and
  the per-column ledger as two independent values for exactly this reason.

  Scope is **ADD-only**. `CHANGE` is untouched because `notNullPreflightBySql` is
  keyed by the exact SQL string of a CHANGE statement, and batching those would
  silently orphan every NOT NULL preflight.

  Note: `appliedCount` counts SQL *statements*, so a batched table now reports 1
  applied instead of N. That is intended.

  Schema-sync also now prints a table's approximate row count and data/index size
  before an ADD batch, so an operator can see they are about to stall a large
  table. The lookup is best-effort and can never block a schema change.
```

- [ ] **Step 3: Bump the version**

Edit `package.json`: `"version": "2.7.0"` → `"version": "2.8.0"`.

- [ ] **Step 4: Commit**

```bash
npm run eslint:fix
git add package.json CHANGELOG.md docs/plans/2026-09-12-bdl3681-batch-add-columns.md
git commit -m "docs(release): batch a table's ADD COLUMNs into one ALTER (2.8.0) (BDL-3681)"
```

---

## Landing (follow-on — explicitly OUT OF SCOPE of the code change)

The spec scopes the rubber-side pin bump out of this change. It is a separate release step, and it
is the reason a merge to yass-orm `master` **changes nothing in rubber**:

- yass-orm is pinned **by commit sha in three rubber manifests** — verified at plan time, all three
  on `8d8e7e8bcd606804c211012a3f0bb9d5c58079e2`:
  - `package.json:131`
  - `backend/package.json:497`
  - `shared/package.json:256`
- Landing sequence: merge to yass-orm master → note the new sha → in rubber run
  `npm run update:yass-orm -- <sha>` → commit **both** `package.json` and `package-lock.json`.
- The lockfile is the install contract (prod and CI run `npm ci`), so a manifest-only change does
  not ship.

---

## Self-Review — spec coverage

Every acceptance criterion in the spec, mapped to the task that implements it.

| AC | Requirement | Task |
|---|---|---|
| 1 | N>1 columns on one table → exactly ONE `ALTER`, asserted by **capturing emitted SQL**, never timing | Task 2 (pure unit) + **Task 3** (two independent e2e witnesses) |
| 2 | Resulting schema identical to the per-column path, **column order included** | Task 3, "produces a schema identical to the per-column path" (forces the capability off for the control run, compares normalized `SHOW CREATE TABLE`) |
| 3 | N=1 byte-identical to today; N=0 emits nothing | Task 2, two dedicated unit tests |
| 4 | Different tables stay separate statements | Task 3, "keeps columns on different tables in separate statements" |
| 5 | On a table measured at test time to refuse `INSTANT`, one rebuild not N; constructs its own subject; accepts 1845 **or** 1846; never infers from duration | **Task 4** — see the deviation note below |
| 6 | A dialect that does not declare the capability keeps per-column behaviour (asserted for SQLite) | Task 1 (getter false + base throws) + Task 2 (planner falls back) |
| 7 | `changedColumns[].sql` stays single-column per added column | Task 2 (unit, the headline test) + Task 3 (e2e ledger assertion) |
| 8 | Print row count + size before an ADD batch; best-effort, never blocks | **Task 5**, including the "still applies the ALTER when the size lookup throws" test |
| — | Landing note (version bump, CHANGELOG, pin) | Task 6 + the Landing section |

**Stated deviation on AC5.** The spec words AC5 as "total **wall-clock** for N columns is
approximately one rebuild, not N", while simultaneously instructing "never infer the outcome from
duration" and (AC1) "asserted by capturing the emitted SQL, never by timing". Those cannot both be
satisfied literally. Task 4 resolves it by asserting the **causal chain** instead of the symptom:

1. the subject is **measured at test time** to refuse `INSTANT` (by error code — 1845 or 1846), so
   each `ALTER` against it provably costs a rebuild; **and**
2. exactly **one** `ALTER` is executed.

Together those give "one rebuild, not N" deterministically, on a small table where wall-clock would
be meaningless. No timing is asserted anywhere. If a timed demonstration is wanted for the ticket,
run it as a **reported observation**, never as a pass condition.
