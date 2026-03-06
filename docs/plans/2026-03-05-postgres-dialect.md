# PostgreSQL Dialect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add PostgreSQL as a supported database dialect alongside MySQL and SQLite.

**Architecture:** Follow the existing dialect pattern — create `PostgresDialect` extending `BaseDialect`, a `PostgresSqlTransformer` for MySQL-to-PG SQL conversion, and fix hardcoded MySQL assumptions in shared code (`finder.js`, `dbh.js`, `sync-to-db.js`). The SQL transformer uses the same AST-first + regex-scanner-fallback approach as the SQLite transformer.

**Tech Stack:** `pg` (node-postgres) for the driver, `node-sql-parser` (already a dependency) for AST transformation, mocha/chai for tests.

---

## Audit Summary: MySQL-Specific Assumptions Found

These are the hardcoded MySQL assumptions that must be addressed:

| Location | Issue | Impact |
|---|---|---|
| `lib/finder.js:8-14` | `dbQuote()` uses backticks for identifiers | All finder queries use MySQL quoting |
| `lib/finder.js:64` | `IFNULL()` used directly in SQL | PG uses `COALESCE()` — transformer handles conversion |
| `lib/finder.js:81` | `CONCAT(...)` used directly in SQL | PG supports this, but SQLite doesn't — already a latent bug |
| `lib/finder.js:251,253` | Hardcoded backtick-quoted `` `account` `` in SQL | Would be passed through `pquery` → transformer handles it |
| `lib/dbh.js:519,668` | `{ namedPlaceholders: true, sql }` is mariadb-specific API | PG driver uses different query API |
| `lib/dbh.js:397-401` | MariaDB-specific pool options (`timezone`, `skipSetTimezone`, `allowPublicKeyRetrieval`) | PG ignores unknown options but should use PG-specific ones |
| `lib/sync-to-db.js:28` | Default port hardcoded to `3306` | PG default is `5432` |
| `lib/sync-to-db.js:91` | Raw `SHOW FUNCTION STATUS` SQL | Already guarded by `dialect.supportsStoredFunctions` |
| `lib/sync-to-db.js:149,211` | Shells out to `mysql` CLI for functions/triggers | Already guarded by feature flags |
| `lib/sync-to-db.js:170-171` | Backtick quoting in `uploadIdTrigger` | Already guarded by `dialect.supportsTriggers` |
| `lib/sync-to-db.js:548-556` | Type comparison normalizations are MySQL-specific | PG returns different type names from introspection |
| `lib/sync-to-db.js:752-753` | `dialect.name === 'sqlite'` check for index naming | Needs PG handling (PG indexes are also schema-global) |
| `lib/config.js:48,99` | Default port `3306` in default configs | Should be dialect-aware |

**Not blockers** (already handled by dialect layer):
- DDL generation — each dialect has its own methods
- Schema introspection — each dialect queries its own catalog
- `uploadMatchRatioFunction` / `uploadIdTrigger` — guarded by feature flags

---

## Task 1: Add `pg` dependency

**Files:**
- Modify: `package.json`

**Step 1: Install pg**

Run: `npm install pg`

**Step 2: Verify installation**

Run: `node -e "require('pg'); console.log('pg loaded')"`
Expected: `pg loaded`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add pg (node-postgres) for PostgreSQL dialect support"
```

---

## Task 2: Create `PostgresSqlTransformer`

**Files:**
- Create: `lib/sql-transform/PostgresSqlTransformer.js`
- Create: `lib/sql-transform/test/PostgresSqlTransformer.test.js`

This transformer converts MySQL-flavored SQL to PostgreSQL syntax. Key conversions:
- `:name` named placeholders → `$1, $2, ...` positional placeholders (tracking parameter order)
- Backtick identifiers → double-quote identifiers
- `LIMIT offset, count` → `LIMIT count OFFSET offset`
- `NOW()` → `NOW()` (no change needed, PG supports it)
- `CURDATE()` → `CURRENT_DATE`
- `CONCAT(a, b)` → `CONCAT(a, b)` (no change needed, PG supports it)
- `IFNULL(a, b)` → `COALESCE(a, b)` (PG standard equivalent)
- `->>` JSON operator → `->>` (PG supports it natively, but path syntax differs: PG uses `'key'` not `'$.key'`)

**Step 1: Write the failing tests**

```js
// lib/sql-transform/test/PostgresSqlTransformer.test.js
/* eslint-disable func-names */
/* global it, describe */
const { expect } = require('chai');
const {
	transformSqlForPostgres,
	transformSqlWithScanner,
} = require('../PostgresSqlTransformer');

describe('PostgresSqlTransformer', () => {
	describe('transformSqlForPostgres()', () => {
		it('should convert :name placeholders to positional $N', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM users WHERE id = :id AND name = :name',
				params: { id: 1, name: 'test' },
			});
			expect(result.sql).to.equal(
				'SELECT * FROM users WHERE id = $1 AND name = $2',
			);
			expect(result.paramOrder).to.deep.equal(['id', 'name']);
		});

		it('should handle repeated placeholders', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM t WHERE a = :val OR b = :val',
				params: { val: 1 },
			});
			// Both occurrences map to the same positional parameter
			expect(result.sql).to.equal(
				'SELECT * FROM t WHERE a = $1 OR b = $1',
			);
			expect(result.paramOrder).to.deep.equal(['val']);
		});

		it('should convert backtick identifiers to double quotes', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT `name` FROM `users`',
				params: {},
			});
			expect(result.sql).to.equal('SELECT "name" FROM "users"');
		});

		it('should convert LIMIT offset,count to LIMIT count OFFSET offset', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM users LIMIT 10, 20',
				params: {},
			});
			expect(result.sql).to.equal(
				'SELECT * FROM users LIMIT 20 OFFSET 10',
			);
		});

		it('should convert CURDATE() to CURRENT_DATE', () => {
			const result = transformSqlForPostgres({
				sql: "SELECT * FROM events WHERE date = CURDATE()",
				params: {},
			});
			expect(result.sql).to.include('CURRENT_DATE');
		});

		it('should leave NOW() as-is', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT NOW()',
				params: {},
			});
			expect(result.sql).to.include('NOW()');
		});

		it('should preserve strings containing colons', () => {
			const result = transformSqlForPostgres({
				sql: "SELECT * FROM t WHERE time > '10:30:00' AND id = :id",
				params: { id: 1 },
			});
			expect(result.sql).to.include("'10:30:00'");
			expect(result.sql).to.include('$1');
		});

		it('should preserve comments containing placeholders', () => {
			const result = transformSqlForPostgres({
				sql: '-- query for :user\nSELECT * FROM t WHERE id = :id',
				params: { id: 1 },
			});
			expect(result.sql).to.include('-- query for :user');
			expect(result.sql).to.include('$1');
		});

		it('should convert IFNULL() to COALESCE()', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT IFNULL(name, \'unknown\') FROM users',
				params: {},
			});
			expect(result.sql).to.include('COALESCE');
			expect(result.sql).not.to.include('IFNULL');
		});

		it('should handle JSON ->> operator', () => {
			const result = transformSqlForPostgres({
				sql: `SELECT data->>"$.name" FROM users WHERE id = :id`,
				params: { id: 1 },
			});
			// PG uses ->> with simple key names, not $.path
			expect(result.sql).to.include("->>'name'");
		});
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npx mocha --exit lib/sql-transform/test/PostgresSqlTransformer.test.js`
Expected: FAIL — module not found

**Step 3: Implement the transformer**

```js
// lib/sql-transform/PostgresSqlTransformer.js
/* eslint-disable no-continue */
const { Parser } = require('node-sql-parser');

const parser = new Parser();

// Reuse the AST visitor pattern from SQLiteSqlTransformer
function visitAst(node, visitor) {
	if (!node || typeof node !== 'object') return node;
	const replaced = visitor(node) || node;
	if (Array.isArray(replaced)) {
		return replaced.map((item) => visitAst(item, visitor));
	}
	Object.keys(replaced).forEach((key) => {
		replaced[key] = visitAst(replaced[key], visitor);
	});
	return replaced;
}

function createFunctionNode(name, args) {
	return {
		type: 'function',
		name: { name: [{ type: 'default', value: name }] },
		args: { type: 'expr_list', value: args },
		over: null,
	};
}

function createStringNode(value) {
	return { type: 'single_quote_string', value };
}

function transformAstForPostgres(ast) {
	return visitAst(ast, (node) => {
		if (node.type === 'function') {
			const fnName =
				node.name &&
				node.name.name &&
				node.name.name[0] &&
				`${node.name.name[0].value || ''}`.toUpperCase();
			if (fnName === 'CURDATE') {
				// CURDATE() → CURRENT_DATE (PG built-in)
				return { type: 'column_ref', table: '', column: 'CURRENT_DATE' };
			}
			if (fnName === 'IFNULL') {
				// IFNULL(a, b) → COALESCE(a, b)
				return createFunctionNode('COALESCE', (node.args && node.args.value) || []);
			}
			// NOW() and CONCAT() work in PG as-is
		}

		// JSON ->> with $.path → PG ->> with simple key
		if (
			node.type === 'binary_expr' &&
			(node.operator === '->>' || node.operator === '->')
		) {
			// Convert MySQL $.path syntax to PG key syntax
			if (node.right && node.right.value) {
				const path = `${node.right.value}`;
				// $.key → 'key' for simple single-level access
				const simpleKeyMatch = path.match(/^\$\.([a-zA-Z_][a-zA-Z0-9_]*)$/);
				if (simpleKeyMatch) {
					return {
						...node,
						right: {
							...node.right,
							value: simpleKeyMatch[1],
							type: 'single_quote_string',
						},
					};
				}
				// For nested paths like $.a.b, PG uses #>> '{a,b}' — leave as-is for now
				// and handle via scanner fallback if needed
			}
		}

		return node;
	});
}

/**
 * Walk only non-string, non-comment code segments of SQL.
 * Reuses the same approach as SQLiteSqlTransformer.transformCodeSegments.
 */
function transformCodeSegments(sql, transformCode) {
	let out = '';
	let idx = 0;
	while (idx < sql.length) {
		const ch = sql[idx];
		const next = sql[idx + 1];

		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', idx + 2);
			if (end < 0) { out += sql.slice(idx); break; }
			out += sql.slice(idx, end + 1);
			idx = end + 1;
			continue;
		}

		if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', idx + 2);
			if (end < 0) { out += sql.slice(idx); break; }
			out += sql.slice(idx, end + 2);
			idx = end + 2;
			continue;
		}

		if (ch === "'" || ch === '"' || ch === '`') {
			let end = idx + 1;
			while (end < sql.length) {
				const q = sql[end];
				if (q === '\\') { end += 2; continue; }
				if (q === ch) {
					if (sql[end + 1] === ch && ch !== '`') { end += 2; continue; }
					end += 1;
					break;
				}
				end += 1;
			}
			out += sql.slice(idx, end);
			idx = end;
			continue;
		}

		let end = idx + 1;
		while (end < sql.length) {
			const c = sql[end];
			const n = sql[end + 1];
			if (c === "'" || c === '"' || c === '`' || (c === '-' && n === '-') || (c === '/' && n === '*')) break;
			end += 1;
		}
		out += transformCode(sql.slice(idx, end));
		idx = end;
	}
	return out;
}

function transformSqlWithScanner(sql, params = {}) {
	// Build ordered parameter mapping: assign $N to each unique param key
	const keys = Object.keys(params || {}).sort((a, b) => b.length - a.length);
	const paramOrder = [];
	const paramIndexMap = {};

	return {
		sql: transformCodeSegments(sql, (code) => {
			let transformed = code;

			// Convert :name placeholders to $N positional placeholders
			keys.forEach((key) => {
				const regex = new RegExp(`:${key}(?![a-zA-Z0-9_])`, 'g');
				if (regex.test(transformed)) {
					if (!(key in paramIndexMap)) {
						paramOrder.push(key);
						paramIndexMap[key] = paramOrder.length; // 1-based
					}
					transformed = transformed.replace(
						new RegExp(`:${key}(?![a-zA-Z0-9_])`, 'g'),
						`$${paramIndexMap[key]}`,
					);
				}
			});

			// Convert backtick identifiers to double-quoted identifiers
			transformed = transformed.replace(/`([^`]+)`/g, '"$1"');

			// Convert LIMIT offset,count to LIMIT count OFFSET offset
			transformed = transformed.replace(
				/LIMIT\s+(\d+)\s*,\s*(\d+)/gi,
				'LIMIT $2 OFFSET $1',
			);

			// CURDATE() → CURRENT_DATE
			transformed = transformed.replace(/\bCURDATE\s*\(\s*\)/gi, 'CURRENT_DATE');

			// IFNULL(a, b) → COALESCE(a, b)
			transformed = transformed.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');

			// JSON ->> with $.path → PG ->> with simple key
			transformed = transformed.replace(
				/(\w+)->>["']\$\.([a-zA-Z_][a-zA-Z0-9_]*)["']/g,
				"$1->>'$2'",
			);
			transformed = transformed.replace(
				/(\w+)->["']\$\.([a-zA-Z_][a-zA-Z0-9_]*)["']/g,
				"$1->'$2'",
			);

			return transformed;
		}),
		paramOrder,
	};
}

function transformSqlForPostgres({ sql, params = {} }) {
	// Comments bypass the parser (it strips them)
	if (sql.includes('--') || sql.includes('/*')) {
		const result = transformSqlWithScanner(sql, params);
		return { ...result, mode: 'scanner' };
	}

	try {
		const ast = parser.astify(sql, { database: 'mysql' });
		const transformedAst = transformAstForPostgres(ast);
		const pgSql = parser.sqlify(transformedAst, { database: 'postgresql' });
		// Still need scanner for placeholder conversion and cleanup
		const result = transformSqlWithScanner(pgSql, params);
		return { ...result, mode: 'ast' };
	} catch (err) {
		const result = transformSqlWithScanner(sql, params);
		return { ...result, mode: 'scanner', error: err };
	}
}

module.exports = {
	transformSqlForPostgres,
	transformSqlWithScanner,
	transformAstForPostgres,
};
```

**Step 4: Run tests to verify they pass**

Run: `npx mocha --exit lib/sql-transform/test/PostgresSqlTransformer.test.js`
Expected: All tests PASS

Note: Some tests may need adjustment based on actual `node-sql-parser` output for PG target. Fix any mismatches between expected and actual output in the tests.

**Step 5: Commit**

```bash
git add lib/sql-transform/PostgresSqlTransformer.js lib/sql-transform/test/PostgresSqlTransformer.test.js
git commit -m "feat(postgres): add PostgresSqlTransformer with AST + scanner fallback"
```

---

## Task 3: Create `PostgresDialect`

**Files:**
- Create: `lib/dialects/PostgresDialect.js`
- Create: `lib/dialects/test/PostgresDialect.test.js`

**Step 1: Write the failing tests**

Model these after `lib/dialects/test/SQLiteDialect.test.js`. Cover:
- `name` returns `'postgres'`
- `quoteIdentifier()` uses double quotes
- `formatPlaceholder()` returns `$1`, `$2`, etc.
- `prepareParams()` returns an ordered array (using `paramOrder` from transformer)
- `transformSql()` converts MySQL SQL to PG SQL
- `mapType()` maps yass-orm types to PG types
- `getIntegerPrimaryKeyAttrs()` returns `SERIAL` type
- `getUuidPrimaryKeyAttrs()` returns `UUID` type
- `generateCreateTable()` produces valid PG DDL
- `generateFieldSpec()` produces valid PG field specs
- `generateCreateIndex()` produces valid PG index DDL
- Feature flags: `supportsAlterColumn=true`, `supportsJsonOperators=true`, `supportsFullTextSearch=true` (GIN indexes), `supportsConnectionPooling=true`, `supportsReadReplicas=true`

```js
// lib/dialects/test/PostgresDialect.test.js
/* eslint-disable func-names */
/* global it, describe, beforeEach */
const { expect } = require('chai');
const { PostgresDialect } = require('../PostgresDialect');

describe('PostgresDialect', () => {
	let dialect;

	beforeEach(() => {
		dialect = new PostgresDialect();
	});

	describe('Basic Properties', () => {
		it('should have name "postgres"', () => {
			expect(dialect.name).to.equal('postgres');
		});
	});

	describe('SQL Syntax & Formatting', () => {
		it('should quote identifiers with double quotes', () => {
			expect(dialect.quoteIdentifier('users')).to.equal('"users"');
		});

		it('should escape embedded double quotes', () => {
			expect(dialect.quoteIdentifier('table"name')).to.equal('"table""name"');
		});

		it('should format positional placeholders', () => {
			expect(dialect.formatPlaceholder('name', 0)).to.equal('$1');
			expect(dialect.formatPlaceholder('userId', 1)).to.equal('$2');
		});

		it('should prepare params as ordered array', () => {
			const result = dialect.prepareParams(
				{ name: 'test', age: 25 },
				['name', 'age'],
			);
			expect(result).to.deep.equal(['test', 25]);
		});

		it('should deflate values in prepareParams', () => {
			const result = dialect.prepareParams(
				{ active: true, count: 0 },
				['active', 'count'],
			);
			expect(result).to.deep.equal([1, 0]);
		});
	});

	describe('Type Mapping', () => {
		it('should map idKey to SERIAL', () => {
			expect(dialect.mapType('idKey')).to.equal('SERIAL');
		});

		it('should map uuidKey to UUID', () => {
			expect(dialect.mapType('uuidKey')).to.equal('UUID');
		});

		it('should map string to VARCHAR(255)', () => {
			expect(dialect.mapType('string')).to.equal('VARCHAR(255)');
		});

		it('should map text to TEXT', () => {
			expect(dialect.mapType('text')).to.equal('TEXT');
		});

		it('should map bool to BOOLEAN', () => {
			expect(dialect.mapType('bool')).to.equal('BOOLEAN');
		});

		it('should map int to INTEGER', () => {
			expect(dialect.mapType('int')).to.equal('INTEGER');
		});

		it('should map json to JSONB', () => {
			expect(dialect.mapType('json')).to.equal('JSONB');
		});

		it('should map datetime to TIMESTAMP', () => {
			expect(dialect.mapType('datetime')).to.equal('TIMESTAMP');
		});
	});

	describe('DDL Generation', () => {
		it('should generate CREATE TABLE with PG syntax', () => {
			const sql = dialect.generateCreateTable('users', [
				{ field: 'id', type: 'SERIAL', key: 'PRI' },
				{ field: 'name', type: 'VARCHAR(255)' },
			]);
			expect(sql).to.include('CREATE TABLE "users"');
			expect(sql).to.include('"id" SERIAL PRIMARY KEY');
			expect(sql).to.include('"name" VARCHAR(255)');
			expect(sql).not.to.include('CHARACTER SET');
		});

		it('should generate CREATE INDEX', () => {
			const sql = dialect.generateCreateIndex('users', 'idx_name', ['name']);
			expect(sql).to.equal('CREATE INDEX "idx_name" ON "users" ("name")');
		});

		it('should generate DROP INDEX without table name', () => {
			const sql = dialect.generateDropIndex('users', 'idx_name');
			expect(sql).to.equal('DROP INDEX IF EXISTS "idx_name"');
		});

		it('should generate ALTER TABLE ADD COLUMN', () => {
			const sql = dialect.generateAlterAddColumn('users', {
				field: 'email',
				type: 'VARCHAR(255)',
			});
			expect(sql).to.include('ALTER TABLE "users" ADD COLUMN');
			expect(sql).to.include('"email" VARCHAR(255)');
		});

		it('should generate ALTER TABLE ALTER COLUMN', () => {
			const sql = dialect.generateAlterModifyColumn('users', {
				field: 'name',
				type: 'TEXT',
			});
			expect(sql).to.include('ALTER TABLE "users"');
			expect(sql).to.include('ALTER COLUMN');
			expect(sql).to.include('"name"');
		});
	});

	describe('Feature Flags', () => {
		it('should support ALTER COLUMN', () => {
			expect(dialect.supportsAlterColumn).to.be.true;
		});

		it('should support JSON operators', () => {
			expect(dialect.supportsJsonOperators).to.be.true;
		});

		it('should support connection pooling', () => {
			expect(dialect.supportsConnectionPooling).to.be.true;
		});

		it('should support read replicas', () => {
			expect(dialect.supportsReadReplicas).to.be.true;
		});
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npx mocha --exit lib/dialects/test/PostgresDialect.test.js`
Expected: FAIL — module not found

**Step 3: Implement PostgresDialect**

Create `lib/dialects/PostgresDialect.js`. Key implementation notes:

- **`quoteIdentifier()`** — Double quotes (same as SQLite, SQL standard)
- **`formatPlaceholder(name, index)`** — Return `$${index + 1}`
- **`prepareParams(namedParams, paramOrder)`** — Convert named params object to ordered array based on `paramOrder` from transformer. Deflate values.
- **`transformSql(sql, params)`** — Call `transformSqlForPostgres({ sql, params })`, stash `paramOrder` on a per-call basis for `prepareParams` to use. Return transformed SQL.
- **`mapType()`** — Map to PG types: `idKey→SERIAL`, `uuidKey→UUID`, `string→VARCHAR(255)`, `text→TEXT`, `int→INTEGER`, `bool→BOOLEAN`, `real→DOUBLE PRECISION`, `json→JSONB`, `datetime→TIMESTAMP`, `date→DATE`, `time→TIME`, `blob→BYTEA`
- **`getIntegerPrimaryKeyAttrs()`** — `{ type: 'SERIAL', key: 'PRI', readonly: 1, auto: 1 }`
- **`getUuidPrimaryKeyAttrs()`** — `{ type: 'UUID', key: 'PRI', null: 0, default: 'gen_random_uuid()' }`
- **`tableExists()`** — Query `information_schema.tables`
- **`getTableColumns()`** — Query `information_schema.columns`
- **`getTableIndexes()`** — Query `pg_indexes` / `pg_index` system catalogs
- **`getTables()`** — Query `information_schema.tables WHERE table_schema = 'public'`
- **`generateCreateTable()`** — Standard SQL, no `CHARACTER SET`
- **`generateFieldSpec()`** — PG syntax (no backticks, `BOOLEAN` instead of `int(1)`, `DEFAULT gen_random_uuid()` for UUID keys)
- **`generateCreateIndex()`** — Handle FULLTEXT → GIN index with `to_tsvector`, JSON functional indexes → PG expression indexes
- **`generateAlterModifyColumn()`** — PG uses `ALTER TABLE t ALTER COLUMN c TYPE newtype` (not CHANGE/MODIFY)
- **`createConnection()`** — Use `new pg.Client(config)`, wrap with `connect()`
- **`createPool()`** — Use `new pg.Pool(config)`
- **`wrapConnection()`** — Wrap pg pool/client to match yass-orm's `pquery`/`query`/`roQuery` interface. The `query()` method should accept both string SQL and the mariadb-style `{ namedPlaceholders, sql }` object (extract `.sql` if object passed). Use positional params.

**Important design note for `transformSql` + `prepareParams` coupling:**

Since PG uses positional placeholders, `transformSql` produces both the transformed SQL AND a `paramOrder` array. The `wrapConnection.pquery` method must:
1. Call `transformSqlForPostgres()` to get `{ sql, paramOrder }`
2. Use `paramOrder` to convert the named params object to an ordered array
3. Pass the ordered array to `pg`'s `query(sql, arrayOfParams)`

This means `prepareParams` needs the `paramOrder` — either pass it as a second arg, or have `wrapConnection.pquery` handle the coordination directly (preferred, matching how SQLite's `wrapConnection.pquery` coordinates `transformSql` + `prepareParams`).

**Step 4: Run tests to verify they pass**

Run: `npx mocha --exit lib/dialects/test/PostgresDialect.test.js`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add lib/dialects/PostgresDialect.js lib/dialects/test/PostgresDialect.test.js
git commit -m "feat(postgres): add PostgresDialect with type mapping, DDL, and connection management"
```

---

## Task 4: Register PostgresDialect in the dialect registry

**Files:**
- Modify: `lib/dialects/index.js`

**Step 1: Add PostgresDialect to the registry**

Add to `lib/dialects/index.js`:
- `require('./PostgresDialect.js')` at top
- Registry entries: `postgres: PostgresDialect`, `postgresql: PostgresDialect`, `pg: PostgresDialect`
- Export `PostgresDialect`

**Step 2: Write a quick test**

```js
// In an existing test file or inline:
const { getDialect, hasDialect } = require('./lib/dialects');
console.log(hasDialect('postgres'));   // true
console.log(hasDialect('postgresql')); // true
console.log(hasDialect('pg'));         // true
console.log(getDialect('postgres').name); // 'postgres'
```

Run: `node -e "const {getDialect,hasDialect}=require('./lib/dialects'); console.log(hasDialect('postgres'), hasDialect('pg'), getDialect('postgres').name)"`
Expected: `true true postgres`

**Step 3: Commit**

```bash
git add lib/dialects/index.js
git commit -m "feat(postgres): register PostgresDialect in dialect registry"
```

---

## Task 5: Fix `dbh.js` — MySQL-specific query dispatching

**Files:**
- Modify: `lib/dbh.js`

The `pquery` method in `dbh.js` (lines 662-669) directly calls `this.query({ namedPlaceholders: true, sql }, values)` which is mariadb-specific. This should be delegated to the dialect's `wrapConnection` instead.

**Step 1: Analyze the current flow**

Currently, `dbh.js` creates a pool via `dialect.createPool()` then wraps it via `dialect.wrapConnection()`. The `wrapConnection` already defines `pquery` for both MySQL and SQLite. But then `dbh.js` **overwrites** `conn.pquery` with its own version (for logging, timing, etc.) that contains the mariadb-specific `{ namedPlaceholders: true, sql }` call.

**Fix approach:** The overwritten `pquery` in `dbh.js` should delegate the actual query execution to the dialect. Instead of calling `this.query({ namedPlaceholders: true, sql }, values)` directly, call a dialect-provided method. The simplest approach:

- Add a `executeQuery(connection, sql, params)` method to `BaseDialect` that each dialect implements
- MySQL: `conn.query({ namedPlaceholders: true, sql }, params)`
- SQLite: Already handled by `wrapConnection` (query method accepts both forms)
- PG: `conn.query(sql, paramsArray)`

Alternatively (simpler): Move the `{ namedPlaceholders: true, sql }` wrapping into each dialect's `wrapConnection.query()` method, so `dbh.js` always just calls `this.query(sql, values)`. SQLite already does this. MySQL's `wrapConnection` would need updating too.

**Step 2: Update `dbh.js` pquery to use a uniform call**

Change lines ~664-669 and ~514-523 from:

```js
if (Array.isArray(values)) {
    resolve(this.query(transformedSql, values));
} else {
    resolve(this.query({ namedPlaceholders: true, sql: transformedSql }, values));
}
```

To:

```js
resolve(this.query(transformedSql, values));
```

Then update `MySQLDialect.wrapConnection.query()` to handle the `namedPlaceholders` wrapping internally when it receives an object (non-array) for params.

**Step 3: Run existing tests to verify nothing breaks**

Run: `npm test`
Expected: All existing tests pass

**Step 4: Commit**

```bash
git add lib/dbh.js lib/dialects/MySQLDialect.js
git commit -m "refactor(dbh): delegate query format to dialect wrapConnection"
```

---

## Task 6: Fix `finder.js` — hardcoded backtick quoting

**Files:**
- Modify: `lib/finder.js`

**Step 1: Fix `dbQuote()` function**

The `dbQuote()` function at line 8-11 hardcodes backticks. Since `finder.js` doesn't have access to the dialect instance directly, and all queries go through `pquery` which runs `transformSql`, the backticks will be converted by the transformer for SQLite and PG. **This is already handled by the transformer layer** — backticks in SQL strings are converted to double quotes by both `SQLiteSqlTransformer` and the new `PostgresSqlTransformer`.

Similarly, the hardcoded `` `account` `` at lines 251, 253 will be handled by the transformer.

**No code changes needed in `finder.js`** — the transformer handles backtick conversion.

**Step 2: Verify with a quick test**

```js
const { transformSqlForPostgres } = require('./lib/sql-transform/PostgresSqlTransformer');
const result = transformSqlForPostgres({
    sql: 'SELECT `name` FROM `users` WHERE `account` = :acct',
    params: { acct: 1 }
});
console.log(result.sql);
// Expected: SELECT "name" FROM "users" WHERE "account" = $1
```

Run: `node -e "<above code>"`
Expected: Backticks converted to double quotes, `:acct` → `$1`

**Step 3: Commit (if any changes were needed)**

No commit needed if only verification.

---

## Task 7: Fix `sync-to-db.js` — default port and index naming

**Files:**
- Modify: `lib/sync-to-db.js`

**Step 1: Fix default port**

Line 28: `const PORT = config.port || 3306;`

Change to dialect-aware default:

```js
const PORT = config.port || (dialect.name === 'postgres' ? 5432 : 3306);
```

**Step 2: Fix index naming for PG**

Line 752-753 checks `dialect.name === 'sqlite'` for schema-global index names. PG also has schema-global index names:

```js
const isDeletedIndexName =
    dialect.name === 'mysql' ? 'isDeleted' : `${tableName}_isDeleted`;
```

**Step 3: Add PG type comparison normalizations**

The type comparison block in `mysqlSchemaUpdate` (around lines 545-637) has many MySQL-specific type normalizations. Add PG-specific ones. At minimum:

```js
// PostgreSQL type normalizations
// PG reports 'integer' for INTEGER columns
(k === 'type' && ak === 'integer' && (bk === 'int' || bk === 'int(11)' || bk === 'INTEGER')) ||
// PG reports 'character varying(255)' for VARCHAR(255)
(k === 'type' && ak === 'character varying(255)' && (bk === 'varchar(255)' || bk === 'varchar' || bk === 'string' || bk === 'VARCHAR(255)')) ||
// PG reports 'text' for TEXT columns
(k === 'type' && ak === 'text' && (bk === 'longtext' || bk === 'TEXT')) ||
// PG reports 'boolean' for BOOLEAN columns
(k === 'type' && ak === 'boolean' && (bk === 'int(1)' || bk === 'bool' || bk === 'BOOLEAN')) ||
// PG SERIAL auto-increment
(k === 'extra' && ak === '' && bk === 'auto_increment' && a.type && a.type.includes('int')) ||
// PG reports 'timestamp without time zone' for TIMESTAMP
(k === 'type' && ak === 'timestamp without time zone' && (bk === 'datetime' || bk === 'timestamp' || bk === 'TIMESTAMP')) ||
// PG UUID type
(k === 'type' && ak === 'uuid' && bk === 'UUID') ||
// PG JSONB
(k === 'type' && ak === 'jsonb' && (bk === 'json' || bk === 'longtext' || bk === 'JSONB'))
```

**Step 4: Run tests**

Run: `npm test`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add lib/sync-to-db.js
git commit -m "fix(sync-to-db): add PostgreSQL support for port defaults, index naming, and type normalization"
```

---

## Task 8: Update `config.js` defaults

**Files:**
- Modify: `lib/config.js`

**Step 1: Add PG to dialect comment and adjust defaults**

The config already has `dialect: 'mysql'` as default — just update the comment to mention `'postgres'`:

```js
// Database dialect: 'mysql' (default), 'mariadb', 'sqlite', 'sqlite3', 'postgres', 'postgresql'
```

Default port should remain `3306` since MySQL is the default dialect. The port is already configurable via config.

**Step 2: Commit**

```bash
git add lib/config.js
git commit -m "docs(config): mention postgres in dialect options"
```

---

## Task 9: Integration test with in-memory verification

**Files:**
- Create: `lib/dialects/test/PostgresDialect.integration-notes.md`

Full integration testing requires a running PostgreSQL instance. For CI, document how to test:

```markdown
# PostgreSQL Integration Testing

## Local testing with Docker

docker run --name yass-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=yass_test -p 5433:5432 -d postgres:16

## Config (.yass-orm.js)

module.exports = {
    development: {
        dialect: 'postgres',
        host: 'localhost',
        port: 5433,
        user: 'postgres',
        password: 'test',
        schema: 'yass_test',
    }
};

## Run schema sync

npx yass-schema-sync

## Run tests

npm test
```

**Step 1: Create the integration notes**

Write the file above.

**Step 2: Commit**

```bash
git add lib/dialects/test/PostgresDialect.integration-notes.md
git commit -m "docs(postgres): add integration testing notes"
```

---

## Task 10: Final validation

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass, including new PostgresDialect and PostgresSqlTransformer tests

**Step 2: Run lint**

Run: `npx eslint lib/dialects/PostgresDialect.js lib/sql-transform/PostgresSqlTransformer.js`
Expected: No errors

**Step 3: Verify dialect loads without pg installed (lazy-load)**

The `PostgresDialect` should lazy-load `pg` just like MySQL lazy-loads `mariadb` and SQLite lazy-loads `better-sqlite3`. Verify:

Run: `node -e "const { hasDialect } = require('./lib/dialects'); console.log(hasDialect('postgres'))"`
Expected: `true` (dialect registers without importing pg)

**Step 4: Final commit if needed**

```bash
git add -A
git commit -m "feat(postgres): complete PostgreSQL dialect support"
```

---

## Summary of files changed/created

| Action | File |
|--------|------|
| Create | `lib/dialects/PostgresDialect.js` |
| Create | `lib/dialects/test/PostgresDialect.test.js` |
| Create | `lib/sql-transform/PostgresSqlTransformer.js` |
| Create | `lib/sql-transform/test/PostgresSqlTransformer.test.js` |
| Create | `lib/dialects/test/PostgresDialect.integration-notes.md` |
| Modify | `lib/dialects/index.js` (register dialect) |
| Modify | `lib/dbh.js` (uniform query dispatch) |
| Modify | `lib/dialects/MySQLDialect.js` (move namedPlaceholders into wrapConnection) |
| Modify | `lib/sync-to-db.js` (port default, index naming, type normalization) |
| Modify | `lib/config.js` (update comment) |
| Modify | `package.json` (add pg dependency) |
