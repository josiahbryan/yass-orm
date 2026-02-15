/* eslint-disable func-names */
/* eslint-disable global-require, no-unused-expressions */
/* global it, describe, before, beforeEach, afterEach */
const { expect } = require('chai');
const { SQLiteDialect } = require('../SQLiteDialect');

describe('SQLiteDialect', () => {
	let dialect;

	beforeEach(() => {
		dialect = new SQLiteDialect();
	});

	describe('Basic Properties', () => {
		it('should have name "sqlite"', () => {
			expect(dialect.name).to.equal('sqlite');
		});
	});

	describe('SQL Syntax & Formatting', () => {
		describe('quoteIdentifier()', () => {
			it('should wrap identifiers in double quotes', () => {
				expect(dialect.quoteIdentifier('users')).to.equal('"users"');
				expect(dialect.quoteIdentifier('my_table')).to.equal('"my_table"');
			});

			it('should escape embedded double quotes', () => {
				expect(dialect.quoteIdentifier('table"name')).to.equal('"table""name"');
			});
		});

		describe('formatPlaceholder()', () => {
			it('should format named placeholders with $ prefix', () => {
				expect(dialect.formatPlaceholder('name', 0)).to.equal('$name');
				expect(dialect.formatPlaceholder('userId', 1)).to.equal('$userId');
			});
		});

		describe('prepareParams()', () => {
			it('should deflate Date objects to ISO strings', () => {
				const date = new Date('2024-01-15T10:30:00.000Z');
				const params = { created: date };
				const result = dialect.prepareParams(params);
				expect(result.created).to.equal('2024-01-15 10:30:00');
			});

			it('should deflate boolean values to integers', () => {
				const params = { active: true, deleted: false };
				const result = dialect.prepareParams(params);
				expect(result.active).to.equal(1);
				expect(result.deleted).to.equal(0);
			});

			it('should stringify arrays', () => {
				const params = { tags: ['a', 'b'] };
				const result = dialect.prepareParams(params);
				expect(result.tags).to.equal('["a","b"]');
			});

			it('should extract id from objects with id property', () => {
				const params = { user: { id: 123, name: 'Bob' } };
				const result = dialect.prepareParams(params);
				expect(result.user).to.equal(123);
			});

			it('should pass through plain objects without id', () => {
				const params = { meta: { key: 'value' } };
				const result = dialect.prepareParams(params);
				expect(result.meta).to.deep.equal({ key: 'value' });
			});

			it('should handle array params', () => {
				const date = new Date('2024-01-15T10:30:00.000Z');
				const result = dialect.prepareParams([date, true, 'text']);
				expect(result[0]).to.equal('2024-01-15 10:30:00');
				expect(result[1]).to.equal(1);
				expect(result[2]).to.equal('text');
			});

			it('should return empty object for null/undefined', () => {
				expect(dialect.prepareParams(null)).to.deep.equal({});
				expect(dialect.prepareParams(undefined)).to.deep.equal({});
			});
		});

		describe('transformSql()', () => {
			it('should convert :name to $name placeholders', () => {
				const sql = 'SELECT * FROM users WHERE name = :name AND age = :age';
				const result = dialect.transformSql(sql, { name: 'Bob', age: 30 });
				expect(result).to.include('$name');
				expect(result).to.include('$age');
			});

			it('should handle longer key names before shorter ones', () => {
				const sql =
					'SELECT * FROM users WHERE userName = :userName AND user = :user';
				const result = dialect.transformSql(sql, {
					userName: 'Bob',
					user: 'Alice',
				});
				expect(result).to.include('$userName');
				expect(result).to.include('$user');
			});

			it('should convert backticks to double quotes', () => {
				const sql = 'SELECT `name`, `age` FROM `users`';
				const result = dialect.transformSql(sql, {});
				expect(result).to.equal('SELECT "name", "age" FROM "users"');
			});

			it('should convert JSON ->> operator to json_extract', () => {
				const sql = 'SELECT data->>"$.name" FROM users';
				const result = dialect.transformSql(sql, {});
				expect(result).to.include('json_extract');
				expect(result).to.include("'$.name'");
			});

			it('should convert JSON -> operator to json_extract', () => {
				const sql = 'SELECT data->"$.nested.value" FROM users';
				const result = dialect.transformSql(sql, {});
				expect(result).to.include('json_extract');
				expect(result).to.include("'$.nested.value'");
			});

			it('should convert CONCAT() to || operator', () => {
				const sql = "SELECT CONCAT(first, ' ', last) FROM users";
				const result = dialect.transformSql(sql, {});
				expect(result).to.include('||');
				expect(result).to.include("' '");
			});

			it('should convert NOW() to datetime("now")', () => {
				const sql = 'INSERT INTO logs (created) VALUES (NOW())';
				const result = dialect.transformSql(sql, {});
				expect(result).to.include("datetime('now')");
			});

			it('should convert CURDATE() to date("now")', () => {
				const sql = 'SELECT * FROM events WHERE date = CURDATE()';
				const result = dialect.transformSql(sql, {});
				expect(result).to.include("date('now')");
			});

			it('should convert LIMIT offset, count to LIMIT count OFFSET offset', () => {
				const sql = 'SELECT * FROM users LIMIT 10, 20';
				const result = dialect.transformSql(sql, {});
				expect(result).to.include('LIMIT 20 OFFSET 10');
			});

			it('should handle multiple transformations together', () => {
				const sql =
					'SELECT `name`, data->>"$.email" FROM `users` WHERE id = :id LIMIT 0, 10';
				const result = dialect.transformSql(sql, { id: 1 });
				expect(result).to.include('json_extract');
				expect(result).to.include('$id');
				expect(result).to.include('LIMIT 10 OFFSET 0');
			});

			it('should not rewrite placeholders inside string literals', () => {
				const sql =
					"SELECT ':name' as literalValue, name FROM users WHERE id = :id";
				const result = dialect.transformSql(sql, { id: 1, name: 'Alice' });
				expect(result).to.include("':name'");
				expect(result).to.include('$id');
			});

			it('should not rewrite placeholders inside comments', () => {
				const sql =
					'SELECT name FROM users -- :name must not change\nWHERE id = :id';
				const result = dialect.transformSql(sql, { id: 1, name: 'Alice' });
				expect(result).to.include('-- :name must not change');
				expect(result).to.include('$id');
			});
		});
	});

	describe('Type Mapping', () => {
		describe('mapType()', () => {
			it('should map idKey to INTEGER', () => {
				expect(dialect.mapType('idKey')).to.equal('INTEGER');
			});

			it('should map uuidKey to TEXT', () => {
				expect(dialect.mapType('uuidKey')).to.equal('TEXT');
			});

			it('should map string types to TEXT', () => {
				expect(dialect.mapType('string')).to.equal('TEXT');
				expect(dialect.mapType('text')).to.equal('TEXT');
				expect(dialect.mapType('longtext')).to.equal('TEXT');
				expect(dialect.mapType('varchar')).to.equal('TEXT');
				expect(dialect.mapType('varchar(255)')).to.equal('TEXT');
			});

			it('should map integer types to INTEGER', () => {
				expect(dialect.mapType('int')).to.equal('INTEGER');
				expect(dialect.mapType('integer')).to.equal('INTEGER');
				expect(dialect.mapType('int(11)')).to.equal('INTEGER');
				expect(dialect.mapType('int(1)')).to.equal('INTEGER');
			});

			it('should map boolean types to INTEGER', () => {
				expect(dialect.mapType('bool')).to.equal('INTEGER');
				expect(dialect.mapType('boolean')).to.equal('INTEGER');
			});

			it('should map floating point types to REAL', () => {
				expect(dialect.mapType('real')).to.equal('REAL');
				expect(dialect.mapType('double')).to.equal('REAL');
				expect(dialect.mapType('float')).to.equal('REAL');
			});

			it('should map date/time types to TEXT', () => {
				expect(dialect.mapType('date')).to.equal('TEXT');
				expect(dialect.mapType('datetime')).to.equal('TEXT');
				expect(dialect.mapType('time')).to.equal('TEXT');
				expect(dialect.mapType('timestamp')).to.equal('TEXT');
			});

			it('should map JSON to TEXT', () => {
				expect(dialect.mapType('json')).to.equal('TEXT');
			});

			it('should map blob types to BLOB', () => {
				expect(dialect.mapType('blob')).to.equal('BLOB');
				expect(dialect.mapType('longblob')).to.equal('BLOB');
			});

			it('should return TEXT for unknown types', () => {
				expect(dialect.mapType('unknownType')).to.equal('TEXT');
			});
		});

		describe('getIntegerPrimaryKeyAttrs()', () => {
			it('should return correct attrs for INTEGER PRIMARY KEY', () => {
				const attrs = dialect.getIntegerPrimaryKeyAttrs();
				expect(attrs.type).to.equal('INTEGER');
				expect(attrs.key).to.equal('PRI');
				expect(attrs.readonly).to.equal(1);
				expect(attrs.auto).to.equal(1);
			});
		});

		describe('getUuidPrimaryKeyAttrs()', () => {
			it('should return correct attrs for UUID PRIMARY KEY', () => {
				const attrs = dialect.getUuidPrimaryKeyAttrs();
				expect(attrs.type).to.equal('TEXT');
				expect(attrs.key).to.equal('PRI');
				expect(attrs.null).to.equal(0);
			});
		});
	});

	describe('DDL Generation', () => {
		describe('generateCreateTable()', () => {
			it('should generate CREATE TABLE with column definitions', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ field: 'name', type: 'string' },
					{ field: 'age', type: 'int' },
				];
				const result = dialect.generateCreateTable('users', fields);
				expect(result).to.equal(
					'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT, "age" INTEGER)',
				);
			});

			it('should handle NOT NULL constraint', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ field: 'email', type: 'string', null: 'NO' },
				];
				const result = dialect.generateCreateTable('users', fields);
				expect(result).to.equal(
					'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "email" TEXT NOT NULL)',
				);
			});

			it('should handle DEFAULT values', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ field: 'status', type: 'string', default: 'active' },
					{ field: 'count', type: 'int', default: 0 },
				];
				const result = dialect.generateCreateTable('items', fields);
				expect(result).to.equal(
					'CREATE TABLE "items" ("id" INTEGER PRIMARY KEY, "status" TEXT DEFAULT \'active\', "count" INTEGER DEFAULT 0)',
				);
			});

			it('should handle CURRENT_TIMESTAMP default', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ field: 'created', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
				];
				const result = dialect.generateCreateTable('logs', fields);
				expect(result).to.equal(
					'CREATE TABLE "logs" ("id" INTEGER PRIMARY KEY, "created" TEXT DEFAULT (datetime(\'now\')))',
				);
			});
		});

		describe('generateFieldSpec()', () => {
			it('should generate basic field spec', () => {
				const result = dialect.generateFieldSpec({
					field: 'name',
					type: 'string',
				});
				expect(result).to.equal('"name" TEXT');
			});

			it('should add PRIMARY KEY for PRI fields', () => {
				const result = dialect.generateFieldSpec({
					field: 'id',
					type: 'idKey',
					key: 'PRI',
				});
				expect(result).to.equal('"id" INTEGER PRIMARY KEY');
			});

			it('should add NOT NULL constraint', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'string',
					null: 'NO',
				});
				expect(result).to.equal('"email" TEXT NOT NULL');
			});

			it('should handle null: 0 as NOT NULL', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'string',
					null: 0,
				});
				expect(result).to.equal('"email" TEXT NOT NULL');
			});

			it('should add UNIQUE constraint', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'string',
					key: 'UNI',
				});
				expect(result).to.equal('"email" TEXT UNIQUE');
			});

			it('should ignore key when specified in options', () => {
				const result = dialect.generateFieldSpec(
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ ignore: ['key'] },
				);
				expect(result).to.equal('"id" INTEGER');
			});
		});

		describe('generateCreateIndex()', () => {
			it('should generate CREATE INDEX', () => {
				const result = dialect.generateCreateIndex('users', 'idx_name', [
					'name',
				]);
				expect(result).to.equal('CREATE INDEX "idx_name" ON "users" ("name")');
			});

			it('should generate UNIQUE INDEX', () => {
				const result = dialect.generateCreateIndex(
					'users',
					'idx_email',
					['email'],
					{ unique: true },
				);
				expect(result).to.equal(
					'CREATE UNIQUE INDEX "idx_email" ON "users" ("email")',
				);
			});

			it('should handle multi-column indexes', () => {
				const result = dialect.generateCreateIndex('users', 'idx_name_age', [
					'name',
					'age',
				]);
				expect(result).to.equal(
					'CREATE INDEX "idx_name_age" ON "users" ("name", "age")',
				);
			});

			it('should handle JSON functional indexes', () => {
				const result = dialect.generateCreateIndex('users', 'idx_json', [
					'data->>"$.email"',
				]);
				expect(result).to.equal(
					'CREATE INDEX "idx_json" ON "users" ((json_extract(data, \'$.email\')))',
				);
			});

			it('should handle partial indexes with WHERE clause', () => {
				const result = dialect.generateCreateIndex(
					'users',
					'idx_active',
					['name'],
					{ where: 'isDeleted = 0' },
				);
				expect(result).to.equal(
					'CREATE INDEX "idx_active" ON "users" ("name") WHERE isDeleted = 0',
				);
			});

			it('should return null for FULLTEXT indexes (not supported)', () => {
				const result = dialect.generateCreateIndex(
					'users',
					'idx_fulltext',
					['name'],
					{ fulltext: true },
				);
				expect(result).to.be.null;
			});
		});

		describe('generateDropIndex()', () => {
			it('should generate DROP INDEX IF EXISTS', () => {
				const result = dialect.generateDropIndex('users', 'idx_name');
				expect(result).to.equal('DROP INDEX IF EXISTS "idx_name"');
			});
		});

		describe('generateAlterAddColumn()', () => {
			it('should generate ALTER TABLE ADD COLUMN', () => {
				const result = dialect.generateAlterAddColumn('users', {
					field: 'age',
					type: 'int',
				});
				expect(result).to.equal('ALTER TABLE "users" ADD COLUMN "age" INTEGER');
			});
		});

		describe('generateAlterModifyColumn()', () => {
			it('should throw error (not supported by SQLite)', () => {
				expect(() => {
					dialect.generateAlterModifyColumn('users', {
						field: 'name',
						type: 'text',
					});
				}).to.throw(/SQLite does not support ALTER COLUMN/);
			});
		});

		describe('generateAlterDropColumn()', () => {
			it('should generate ALTER TABLE DROP COLUMN', () => {
				const result = dialect.generateAlterDropColumn('users', 'oldColumn');
				expect(result).to.equal('ALTER TABLE "users" DROP COLUMN "oldColumn"');
			});
		});
	});

	describe('Feature Flags', () => {
		it('should not support FULLTEXT search', () => {
			expect(dialect.supportsFullTextSearch).to.be.false;
		});

		it('should support JSON operators', () => {
			expect(dialect.supportsJsonOperators).to.be.true;
		});

		it('should not support stored functions', () => {
			expect(dialect.supportsStoredFunctions).to.be.false;
		});

		it('should not support ALTER COLUMN', () => {
			expect(dialect.supportsAlterColumn).to.be.false;
		});

		it('should support named placeholders', () => {
			expect(dialect.supportsNamedPlaceholders).to.be.true;
		});

		it('should not support connection pooling', () => {
			expect(dialect.supportsConnectionPooling).to.be.false;
		});

		it('should not support triggers (MySQL-style UUID triggers)', () => {
			// SQLite supports triggers syntax-wise, but the yass-orm UUID trigger
			// implementation is MySQL-specific (uses uuid() function), so we return false
			expect(dialect.supportsTriggers).to.be.false;
		});

		it('should not support read replicas', () => {
			expect(dialect.supportsReadReplicas).to.be.false;
		});
	});
});

// Integration tests that require better-sqlite3 installed
describe('SQLiteDialect Integration', function () {
	// Skip if better-sqlite3 is not available
	let dialect;
	let db;
	let BetterSqlite3Available = true;

	before(function () {
		try {
			require('better-sqlite3');
		} catch (err) {
			BetterSqlite3Available = false;
		}
	});

	beforeEach(function () {
		if (!BetterSqlite3Available) {
			this.skip();
			return;
		}
		dialect = new SQLiteDialect();
	});

	afterEach(async function () {
		if (db) {
			await db.end();
			db = null;
		}
	});

	describe('Connection Management', () => {
		it('should create in-memory database connection', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			db = await dialect.createConnection({ filename: ':memory:' });
			expect(db).to.exist;
			expect(db._db).to.exist;
		});

		it('should create pool (returns same as connection for SQLite)', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			db = await dialect.createPool({ filename: ':memory:' });
			expect(db).to.exist;
		});
	});

	describe('Query Execution', () => {
		beforeEach(async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			db = await dialect.createConnection({ filename: ':memory:' });
			// Create test table
			await db.query(`
				CREATE TABLE test_users (
					id INTEGER PRIMARY KEY,
					name TEXT,
					email TEXT,
					age INTEGER,
					isDeleted INTEGER DEFAULT 0
				)
			`);
		});

		it('should execute INSERT query', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			const result = await db.query(
				'INSERT INTO test_users (name, email, age) VALUES ($name, $email, $age)',
				{ name: 'Alice', email: 'alice@example.com', age: 30 },
			);
			expect(result.insertId).to.be.a('number');
			expect(result.insertId).to.be.above(0);
		});

		it('should execute SELECT query', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			await db.query(
				'INSERT INTO test_users (name, email, age) VALUES ($name, $email, $age)',
				{ name: 'Bob', email: 'bob@example.com', age: 25 },
			);

			const rows = await db.query(
				'SELECT * FROM test_users WHERE name = $name',
				{
					name: 'Bob',
				},
			);
			expect(rows).to.be.an('array');
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('Bob');
			expect(rows[0].age).to.equal(25);
		});

		it('should execute pquery with MySQL-style SQL', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			await db.pquery(
				'INSERT INTO test_users (name, email, age) VALUES (:name, :email, :age)',
				{ name: 'Charlie', email: 'charlie@example.com', age: 35 },
			);

			const rows = await db.pquery(
				'SELECT * FROM `test_users` WHERE name = :name',
				{ name: 'Charlie' },
			);
			expect(rows).to.be.an('array');
			expect(rows.length).to.equal(1);
			expect(rows[0].name).to.equal('Charlie');
		});

		it('should handle UPDATE query', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			await db.pquery(
				'INSERT INTO test_users (name, email, age) VALUES (:name, :email, :age)',
				{ name: 'Dave', email: 'dave@example.com', age: 40 },
			);

			const result = await db.pquery(
				'UPDATE test_users SET age = :age WHERE name = :name',
				{ name: 'Dave', age: 41 },
			);
			expect(result.affectedRows).to.equal(1);

			const rows = await db.pquery(
				'SELECT age FROM test_users WHERE name = :name',
				{ name: 'Dave' },
			);
			expect(rows[0].age).to.equal(41);
		});

		it('should handle DELETE query', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			await db.pquery(
				'INSERT INTO test_users (name, email, age) VALUES (:name, :email, :age)',
				{ name: 'Eve', email: 'eve@example.com', age: 28 },
			);

			const result = await db.pquery(
				'DELETE FROM test_users WHERE name = :name',
				{ name: 'Eve' },
			);
			expect(result.affectedRows).to.equal(1);
		});
	});

	describe('Schema Introspection', () => {
		beforeEach(async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			db = await dialect.createConnection({ filename: ':memory:' });
			// Create test tables
			await db.query(`
				CREATE TABLE schema_test (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL,
					email TEXT UNIQUE,
					age INTEGER DEFAULT 18,
					data TEXT
				)
			`);
			await db.query('CREATE INDEX idx_schema_name ON schema_test (name)');
			await db.query(
				'CREATE UNIQUE INDEX idx_schema_email ON schema_test (email)',
			);
			await db.query(
				'CREATE INDEX idx_schema_expr ON schema_test ((name || email))',
			);
		});

		it('should check if table exists', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			const exists = await dialect.tableExists(db._db, 'main', 'schema_test');
			expect(exists).to.be.true;

			const notExists = await dialect.tableExists(
				db._db,
				'main',
				'nonexistent_table',
			);
			expect(notExists).to.be.false;
		});

		it('should get table columns', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			const columns = await dialect.getTableColumns(db._db, 'schema_test');
			expect(columns).to.be.an('array');
			expect(columns.length).to.equal(5);

			const idCol = columns.find((c) => c.name === 'id');
			expect(idCol.type).to.equal('INTEGER');
			expect(idCol.primaryKey).to.be.true;

			const nameCol = columns.find((c) => c.name === 'name');
			expect(nameCol.type).to.equal('TEXT');
			expect(nameCol.nullable).to.be.false;

			const ageCol = columns.find((c) => c.name === 'age');
			expect(ageCol.type).to.equal('INTEGER');
			expect(ageCol.defaultValue).to.equal('18');
		});

		it('should get table indexes', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			const indexes = await dialect.getTableIndexes(db._db, 'schema_test');
			expect(indexes).to.be.an('array');
			expect(indexes.length).to.equal(3);

			const nameIdx = indexes.find((i) => i.name === 'idx_schema_name');
			expect(nameIdx.columns).to.deep.equal(['name']);
			expect(nameIdx.unique).to.be.false;

			const emailIdx = indexes.find((i) => i.name === 'idx_schema_email');
			expect(emailIdx.columns).to.deep.equal(['email']);
			expect(emailIdx.unique).to.be.true;

			const exprIdx = indexes.find((i) => i.name === 'idx_schema_expr');
			expect(exprIdx.columns[0]).to.include('name || email');
		});

		it('should get list of tables', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			await db.query(`CREATE TABLE another_table (id INTEGER PRIMARY KEY)`);
			const tables = await dialect.getTables(db._db, 'main');
			expect(tables).to.include('schema_test');
			expect(tables).to.include('another_table');
		});
	});

	describe('JSON Support', () => {
		beforeEach(async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			db = await dialect.createConnection({ filename: ':memory:' });
			await db.query(`
				CREATE TABLE json_test (
					id INTEGER PRIMARY KEY,
					data TEXT
				)
			`);
		});

		it('should store and retrieve JSON data', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			// Note: The ORM's field type system handles JSON serialization at a higher level.
			// For direct queries, JSON data must be stringified before insertion.
			const jsonData = JSON.stringify({ name: 'Test', values: [1, 2, 3] });
			await db.pquery('INSERT INTO json_test (data) VALUES (:data)', {
				data: jsonData,
			});

			// Query with json_extract (the SQLite equivalent of JSON ->>)
			const rows = await db.pquery(
				"SELECT json_extract(data, '$.name') as name FROM json_test",
				{},
			);
			expect(rows[0].name).to.equal('Test');
		});

		it('should transform MySQL JSON syntax in queries', async function () {
			if (!BetterSqlite3Available) {
				this.skip();
				return;
			}

			const jsonData = JSON.stringify({ email: 'test@example.com' });
			await db.query('INSERT INTO json_test (data) VALUES ($data)', {
				data: jsonData,
			});

			// Use MySQL-style JSON accessor - should be transformed
			const rows = await db.pquery(
				'SELECT data->>"$.email" as email FROM json_test',
				{},
			);
			expect(rows[0].email).to.equal('test@example.com');
		});
	});
});
