/* eslint-disable func-names */
/* eslint-disable global-require, no-unused-expressions */
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
			it('should format positional placeholders with $N', () => {
				expect(dialect.formatPlaceholder('name', 0)).to.equal('$1');
				expect(dialect.formatPlaceholder('userId', 1)).to.equal('$2');
				expect(dialect.formatPlaceholder('age', 5)).to.equal('$6');
			});
		});

		describe('prepareParams()', () => {
			it('should convert named params to ordered array using paramOrder', () => {
				const params = { name: 'Alice', age: 30, active: true };
				const paramOrder = ['age', 'name', 'active'];
				const result = dialect.prepareParams(params, paramOrder);
				expect(result).to.be.an('array');
				expect(result[0]).to.equal(30);
				expect(result[1]).to.equal('Alice');
				expect(result[2]).to.equal(1); // boolean deflated
			});

			it('should deflate Date objects to ISO strings', () => {
				const date = new Date('2024-01-15T10:30:00.000Z');
				const params = { created: date };
				const paramOrder = ['created'];
				const result = dialect.prepareParams(params, paramOrder);
				expect(result[0]).to.equal('2024-01-15 10:30:00');
			});

			it('should deflate boolean values to integers', () => {
				const params = { active: true, deleted: false };
				const paramOrder = ['active', 'deleted'];
				const result = dialect.prepareParams(params, paramOrder);
				expect(result[0]).to.equal(1);
				expect(result[1]).to.equal(0);
			});

			it('should stringify arrays', () => {
				const params = { tags: ['a', 'b'] };
				const paramOrder = ['tags'];
				const result = dialect.prepareParams(params, paramOrder);
				expect(result[0]).to.equal('["a","b"]');
			});

			it('should extract id from objects with id property', () => {
				const params = { user: { id: 123, name: 'Bob' } };
				const paramOrder = ['user'];
				const result = dialect.prepareParams(params, paramOrder);
				expect(result[0]).to.equal(123);
			});

			it('should return empty array for null/undefined params', () => {
				expect(dialect.prepareParams(null, [])).to.deep.equal([]);
				expect(dialect.prepareParams(undefined, [])).to.deep.equal([]);
			});

			it('should handle array params by deflating each element', () => {
				const params = [new Date('2024-01-15T10:30:00.000Z'), true, 'text'];
				const result = dialect.prepareParams(params);
				expect(result[0]).to.equal('2024-01-15 10:30:00');
				expect(result[1]).to.equal(1);
				expect(result[2]).to.equal('text');
			});
		});
	});

	describe('Type Mapping', () => {
		describe('mapType()', () => {
			it('should map idKey to SERIAL', () => {
				expect(dialect.mapType('idKey')).to.equal('SERIAL');
			});

			it('should map uuidKey to UUID', () => {
				expect(dialect.mapType('uuidKey')).to.equal('UUID');
			});

			it('should map string to VARCHAR(255)', () => {
				expect(dialect.mapType('string')).to.equal('VARCHAR(255)');
			});

			it('should map text types', () => {
				expect(dialect.mapType('text')).to.equal('TEXT');
				expect(dialect.mapType('longtext')).to.equal('TEXT');
			});

			it('should map integer types to INTEGER', () => {
				expect(dialect.mapType('int')).to.equal('INTEGER');
				expect(dialect.mapType('integer')).to.equal('INTEGER');
				expect(dialect.mapType('int(11)')).to.equal('INTEGER');
			});

			it('should map bigint to BIGINT', () => {
				expect(dialect.mapType('bigint')).to.equal('BIGINT');
			});

			it('should map int(1) to BOOLEAN', () => {
				expect(dialect.mapType('int(1)')).to.equal('BOOLEAN');
			});

			it('should map boolean types to BOOLEAN', () => {
				expect(dialect.mapType('bool')).to.equal('BOOLEAN');
				expect(dialect.mapType('boolean')).to.equal('BOOLEAN');
			});

			it('should map floating point types', () => {
				expect(dialect.mapType('real')).to.equal('DOUBLE PRECISION');
				expect(dialect.mapType('double')).to.equal('DOUBLE PRECISION');
				expect(dialect.mapType('float')).to.equal('REAL');
			});

			it('should map date/time types', () => {
				expect(dialect.mapType('date')).to.equal('DATE');
				expect(dialect.mapType('datetime')).to.equal('TIMESTAMP');
				expect(dialect.mapType('time')).to.equal('TIME');
				expect(dialect.mapType('timestamp')).to.equal('TIMESTAMP');
			});

			it('should map JSON to JSONB', () => {
				expect(dialect.mapType('json')).to.equal('JSONB');
			});

			it('should map blob types to BYTEA', () => {
				expect(dialect.mapType('blob')).to.equal('BYTEA');
				expect(dialect.mapType('longblob')).to.equal('BYTEA');
			});

			it('should map varchar(255) to VARCHAR(255)', () => {
				expect(dialect.mapType('varchar(255)')).to.equal('VARCHAR(255)');
			});

			it('should map char(36) to CHAR(36)', () => {
				expect(dialect.mapType('char(36)')).to.equal('CHAR(36)');
			});

			it('should return TEXT for unknown types', () => {
				expect(dialect.mapType('unknownType')).to.equal('TEXT');
			});

			// schema-sync resolves a primary key through
			// getIntegerPrimaryKeyAttrs()/getUuidPrimaryKeyAttrs(), which return
			// ALREADY-NATIVE types ('SERIAL', 'UUID'), and generateFieldSpec then runs
			// mapType() over that resolved type a second time. Without identity
			// entries, the `|| 'TEXT'` fallback silently rewrote every native type to
			// TEXT -- `id SERIAL PRIMARY KEY` became `id TEXT PRIMARY KEY`, so no
			// Postgres table ever got a working auto-increment key. SQLiteDialect
			// already carries these identity entries ("Map SQL types to themselves");
			// Postgres was missing them.
			it('should map already-resolved native PG types to themselves', () => {
				const identities = [
					'SERIAL',
					'BIGSERIAL',
					'UUID',
					'TEXT',
					'VARCHAR(255)',
					'CHAR(36)',
					'INTEGER',
					'BIGINT',
					'BOOLEAN',
					'REAL',
					'DOUBLE PRECISION',
					'DATE',
					'TIMESTAMP',
					'TIME',
					'JSONB',
					'BYTEA',
				];
				identities.forEach((type) => {
					expect(dialect.mapType(type), `mapType(${type})`).to.equal(type);
				});
			});
		});

		describe('getIntegerPrimaryKeyAttrs()', () => {
			it('should return correct attrs for SERIAL PRIMARY KEY', () => {
				const attrs = dialect.getIntegerPrimaryKeyAttrs();
				expect(attrs.type).to.equal('SERIAL');
				expect(attrs.key).to.equal('PRI');
				expect(attrs.readonly).to.equal(1);
				expect(attrs.auto).to.equal(1);
			});
		});

		describe('getUuidPrimaryKeyAttrs()', () => {
			it('should return correct attrs for UUID PRIMARY KEY', () => {
				const attrs = dialect.getUuidPrimaryKeyAttrs();
				expect(attrs.type).to.equal('UUID');
				expect(attrs.key).to.equal('PRI');
				expect(attrs.null).to.equal(0);
				expect(attrs.default).to.equal('gen_random_uuid()');
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
					'CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "name" VARCHAR(255), "age" INTEGER)',
				);
			});

			it('should not include CHARACTER SET', () => {
				const fields = [{ field: 'id', type: 'idKey', key: 'PRI' }];
				const result = dialect.generateCreateTable('users', fields);
				expect(result).to.not.include('CHARACTER SET');
			});

			it('should handle NOT NULL constraint', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ field: 'email', type: 'string', null: 'NO' },
				];
				const result = dialect.generateCreateTable('users', fields);
				expect(result).to.include('"email" VARCHAR(255) NOT NULL');
			});

			it('should handle DEFAULT values', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ field: 'status', type: 'string', default: 'active' },
					{ field: 'count', type: 'int', default: 0 },
				];
				const result = dialect.generateCreateTable('items', fields);
				expect(result).to.include("DEFAULT 'active'");
				expect(result).to.include('DEFAULT 0');
			});

			// Postgres is strictly typed about DEFAULT expressions: a boolean column
			// rejects an integer default outright ("column is of type boolean but
			// default expression is of type integer"). yass-orm's `t.bool` converts to
			// `{ type: 'int(1)', default: 0 }` -- a JS NUMBER -- which was interpolated
			// bare as `DEFAULT 0`. MySQL accepts that, so it never surfaced; on Postgres
			// it made CREATE TABLE fail outright for any schema carrying the standard
			// `isDeleted` commonField, i.e. essentially every table.
			describe('boolean DEFAULT coercion', () => {
				const specFor = (defaultVal) =>
					dialect.generateFieldSpec({
						field: 'isDeleted',
						type: 'int(1)',
						null: 0,
						default: defaultVal,
					});

				it('coerces numeric 0/1 defaults to real boolean literals', () => {
					expect(specFor(0)).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT false',
					);
					expect(specFor(1)).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT true',
					);
				});

				it("coerces string '0'/'1' defaults to real boolean literals", () => {
					expect(specFor('0')).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT false',
					);
					expect(specFor('1')).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT true',
					);
				});

				it('passes through actual booleans and true/false spellings', () => {
					expect(specFor(false)).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT false',
					);
					expect(specFor(true)).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT true',
					);
					expect(specFor('false')).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT false',
					);
					expect(specFor('true')).to.equal(
						'"isDeleted" BOOLEAN NOT NULL DEFAULT true',
					);
				});

				it('leaves numeric defaults on non-boolean columns numeric', () => {
					expect(
						dialect.generateFieldSpec({
							field: 'count',
							type: 'int',
							default: 0,
						}),
					).to.equal('"count" INTEGER DEFAULT 0');
				});
			});

			// Regression: the primary key must survive the second mapType() pass that
			// generateFieldSpec performs on schema-sync's already-resolved attrs.
			it('emits SERIAL (not TEXT) for a resolved integer primary key', () => {
				const attrs = dialect.getIntegerPrimaryKeyAttrs();
				const spec = dialect.generateFieldSpec({ field: 'id', ...attrs });
				expect(spec).to.include('SERIAL');
				expect(spec).to.include('PRIMARY KEY');
				expect(spec).to.not.include('TEXT');
			});

			it('emits UUID (not TEXT) for a resolved uuid primary key', () => {
				const attrs = dialect.getUuidPrimaryKeyAttrs();
				const spec = dialect.generateFieldSpec({ field: 'id', ...attrs });
				expect(spec).to.include('UUID');
				expect(spec).to.include('gen_random_uuid()');
				expect(spec).to.not.include('TEXT');
			});

			it('should handle CURRENT_TIMESTAMP default', () => {
				const fields = [
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{
						field: 'created',
						type: 'datetime',
						default: 'CURRENT_TIMESTAMP',
					},
				];
				const result = dialect.generateCreateTable('logs', fields);
				expect(result).to.include('DEFAULT CURRENT_TIMESTAMP');
			});

			it('should handle UUID primary key with gen_random_uuid() default', () => {
				const fields = [
					{
						field: 'id',
						type: 'uuidKey',
						key: 'PRI',
						null: 0,
						default: 'gen_random_uuid()',
					},
					{ field: 'name', type: 'string' },
				];
				const result = dialect.generateCreateTable('items', fields);
				expect(result).to.include(
					'"id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()',
				);
			});
		});

		describe('generateFieldSpec()', () => {
			it('should generate basic field spec', () => {
				const result = dialect.generateFieldSpec({
					field: 'name',
					type: 'string',
				});
				expect(result).to.equal('"name" VARCHAR(255)');
			});

			it('should add PRIMARY KEY for PRI fields', () => {
				const result = dialect.generateFieldSpec({
					field: 'id',
					type: 'idKey',
					key: 'PRI',
				});
				expect(result).to.equal('"id" SERIAL PRIMARY KEY');
			});

			it('should add NOT NULL constraint', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'string',
					null: 'NO',
				});
				expect(result).to.equal('"email" VARCHAR(255) NOT NULL');
			});

			it('should handle null: 0 as NOT NULL', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'string',
					null: 0,
				});
				expect(result).to.equal('"email" VARCHAR(255) NOT NULL');
			});

			it('should add UNIQUE constraint', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'string',
					key: 'UNI',
				});
				expect(result).to.equal('"email" VARCHAR(255) UNIQUE');
			});

			it('should ignore key when specified in options', () => {
				const result = dialect.generateFieldSpec(
					{ field: 'id', type: 'idKey', key: 'PRI' },
					{ ignore: ['key'] },
				);
				expect(result).to.equal('"id" SERIAL');
			});

			it('should use BOOLEAN type correctly', () => {
				const result = dialect.generateFieldSpec({
					field: 'active',
					type: 'boolean',
				});
				expect(result).to.equal('"active" BOOLEAN');
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

			it('should handle FULLTEXT indexes using GIN with to_tsvector', () => {
				const result = dialect.generateCreateIndex(
					'articles',
					'idx_ft_body',
					['body'],
					{ fulltext: true },
				);
				expect(result).to.include('USING GIN');
				expect(result).to.include('to_tsvector(\'english\', "body")');
			});

			it('should handle multi-column FULLTEXT indexes with concatenated tsvectors', () => {
				const result = dialect.generateCreateIndex(
					'articles',
					'idx_ft_title_body',
					['title', 'body'],
					{ fulltext: true },
				);
				expect(result).to.include('USING GIN');
				expect(result).to.include('to_tsvector(\'english\', "title")');
				expect(result).to.include('to_tsvector(\'english\', "body")');
				expect(result).to.include(' || ');
			});

			it('should handle JSON functional indexes as expression indexes', () => {
				const result = dialect.generateCreateIndex('users', 'idx_json', [
					'data->>"$.email"',
				]);
				expect(result).to.include('(');
				expect(result).to.include('->>');
			});
		});

		// Every ALTER below ran on the SECOND sync of an unchanged schema, because
		// the column diff reported every Postgres column as changed (see
		// test/schemaSync.postgres.idempotency.test.js). Two of them were also
		// outright invalid SQL, so the sync failed rather than merely churning.
		describe('generateAlterModifyColumn()', () => {
			it('never emits ALTER COLUMN TYPE SERIAL (not a real PG type)', () => {
				const sql = dialect.generateAlterModifyColumn('items', {
					field: 'id',
					...dialect.getIntegerPrimaryKeyAttrs(),
				});
				// `type "serial" does not exist` -- SERIAL is CREATE-time shorthand only
				expect(sql).to.not.match(/TYPE\s+SERIAL/i);
				expect(sql).to.match(/TYPE\s+INTEGER/i);
			});

			it('maps BIGSERIAL to BIGINT for an ALTER', () => {
				expect(dialect.alterableType('BIGSERIAL')).to.equal('BIGINT');
				expect(dialect.alterableType('SERIAL')).to.equal('INTEGER');
				// Ordinary types pass through untouched
				expect(dialect.alterableType('TIMESTAMP')).to.equal('TIMESTAMP');
			});

			it('coerces a boolean default instead of emitting SET DEFAULT 0', () => {
				const sql = dialect.generateAlterModifyColumn('items', {
					field: 'isDeleted',
					type: 'int(1)',
					null: 0,
					default: 0,
				});
				expect(sql).to.include('SET DEFAULT false');
				expect(sql).to.not.match(/SET DEFAULT 0/);
			});

			it('never tries to DROP NOT NULL on a primary key', () => {
				// A PG primary key is implicitly NOT NULL and refuses to drop it. The
				// integer key attrs carry no `null: 0`, so the else-branch fired.
				const sql = dialect.generateAlterModifyColumn('items', {
					field: 'id',
					...dialect.getIntegerPrimaryKeyAttrs(),
				});
				expect(sql).to.not.include('DROP NOT NULL');
			});

			it('still drops NOT NULL for an ordinary nullable column', () => {
				const sql = dialect.generateAlterModifyColumn('items', {
					field: 'nickname',
					type: 'string',
				});
				expect(sql).to.include('DROP NOT NULL');
			});
		});

		describe('generateDropIndex()', () => {
			it('should generate DROP INDEX IF EXISTS without table name', () => {
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
			it('should generate ALTER TABLE ALTER COLUMN TYPE', () => {
				const result = dialect.generateAlterModifyColumn('users', {
					field: 'name',
					type: 'text',
				});
				expect(result).to.include('ALTER TABLE "users"');
				expect(result).to.include('ALTER COLUMN "name" TYPE TEXT');
			});

			it('should generate separate statements for TYPE, NOT NULL, and DEFAULT', () => {
				const result = dialect.generateAlterModifyColumn('users', {
					field: 'email',
					type: 'string',
					null: 'NO',
					default: 'unknown',
				});
				expect(result).to.include('ALTER COLUMN "email" TYPE VARCHAR(255)');
				expect(result).to.include('ALTER COLUMN "email" SET NOT NULL');
				expect(result).to.include(
					'ALTER COLUMN "email" SET DEFAULT \'unknown\'',
				);
				// Should have semicolons separating statements
				expect(result.split(';').length).to.be.at.least(3);
			});

			it('should generate DROP NOT NULL when field is nullable', () => {
				const result = dialect.generateAlterModifyColumn('users', {
					field: 'bio',
					type: 'text',
					null: 'YES',
				});
				expect(result).to.include('ALTER COLUMN "bio" DROP NOT NULL');
			});

			it('should handle CURRENT_TIMESTAMP default without quoting', () => {
				const result = dialect.generateAlterModifyColumn('logs', {
					field: 'created',
					type: 'datetime',
					null: 'NO',
					default: 'CURRENT_TIMESTAMP',
				});
				expect(result).to.include('SET DEFAULT CURRENT_TIMESTAMP');
			});

			it('should handle function call defaults without quoting', () => {
				const result = dialect.generateAlterModifyColumn('items', {
					field: 'id',
					type: 'uuidKey',
					null: 'NO',
					default: 'gen_random_uuid()',
				});
				expect(result).to.include('SET DEFAULT gen_random_uuid()');
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
		it('should support FULLTEXT search', () => {
			expect(dialect.supportsFullTextSearch).to.be.true;
		});

		it('should support JSON operators', () => {
			expect(dialect.supportsJsonOperators).to.be.true;
		});

		it('should not support stored functions (MySQL-specific syntax)', () => {
			expect(dialect.supportsStoredFunctions).to.be.false;
		});

		it('should support ALTER COLUMN', () => {
			expect(dialect.supportsAlterColumn).to.be.true;
		});

		it('should not support named placeholders (uses positional)', () => {
			expect(dialect.supportsNamedPlaceholders).to.be.false;
		});

		it('should support connection pooling', () => {
			expect(dialect.supportsConnectionPooling).to.be.true;
		});

		it('should not support triggers (different syntax)', () => {
			expect(dialect.supportsTriggers).to.be.false;
		});

		it('should support read replicas', () => {
			expect(dialect.supportsReadReplicas).to.be.true;
		});
	});

	describe('Transactions', () => {
		it('leases one pool client and emits the full BEGIN clause', async () => {
			const calls = [];
			const client = {
				query: async (sql) => {
					calls.push(sql);
					return { rows: [], rowCount: 0 };
				},
				release: () => calls.push('driver release'),
			};
			const pool = {
				totalCount: 1,
				connect: async () => client,
			};

			const lease = await dialect.acquireTransactionConnection({ _conn: pool });
			const options = dialect.normalizeTransactionOptions({
				isolationLevel: 'serializable',
				readOnly: true,
				deferrable: true,
			});
			await dialect.beginTransaction(lease.connection, options);
			await lease.release();

			expect(calls).to.deep.equal([
				'BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE',
				'driver release',
			]);
		});

		it('rejects invalid deferrable combinations', () => {
			expect(() =>
				dialect.normalizeTransactionOptions({
					isolationLevel: 'read committed',
					readOnly: true,
					deferrable: true,
				}),
			).to.throw('require readOnly: true and isolationLevel: serializable');
		});

		it('uses serializable isolation for findOrCreate by default', () => {
			expect(dialect.defaultFindOrCreateTransactionOptions).to.deep.equal({
				isolationLevel: 'serializable',
				maxRetries: 2,
			});
		});
	});

	// Schema-sync compares a signature built from { fulltext, unique, columns }
	// against the same signature computed from the schema definition. Postgres
	// expresses a FULLTEXT index as a GIN index over to_tsvector(...), and this
	// method never reported `type` -- so an existing FULLTEXT index always
	// compared as `fulltext: false` while the desired signature said `true`, and
	// the index was dropped and recreated on every single sync. It also parsed
	// the tsvector expression as if it were a comma-separated column list,
	// yielding garbage columns like `to_tsvector('english'::regconfig`.
	//
	// The index_def strings below are what `pg_get_indexdef()` returns: the
	// regconfig literal is rendered as `'english'::regconfig`, unquoted
	// identifiers come back lowercase and bare, camelCase ones stay quoted, a
	// varchar argument picks up an explicit `(col)::text` cast, and a non-function
	// index expression is wrapped in an extra set of parentheses.
	// schema-sync compares the schema against these normalized columns. `primaryKey`
	// was hardcoded false, and `type` omitted the declared length, so the diff could
	// not recognize a primary key or match `character varying(255)`.
	describe('getTableColumns() normalization', () => {
		const colHandle = (rows) => ({
			async query() {
				return { rows };
			},
		});

		it('reports primary-key membership instead of always false', async () => {
			const [id, body] = await dialect.getTableColumns(
				colHandle([
					{
						column_name: 'id',
						data_type: 'integer',
						is_nullable: 'NO',
						column_default: "nextval('t_id_seq'::regclass)",
						character_maximum_length: null,
						is_primary_key: true,
					},
					{
						column_name: 'body',
						data_type: 'text',
						is_nullable: 'YES',
						column_default: null,
						character_maximum_length: null,
						is_primary_key: false,
					},
				]),
				'articles',
			);
			expect(id.primaryKey).to.equal(true);
			expect(id.autoIncrement).to.equal(true);
			expect(body.primaryKey).to.equal(false);
		});

		it('includes the declared length in the reported type', async () => {
			const [notes] = await dialect.getTableColumns(
				colHandle([
					{
						column_name: 'notes',
						data_type: 'character varying',
						is_nullable: 'YES',
						column_default: null,
						character_maximum_length: 255,
						is_primary_key: false,
					},
				]),
				'articles',
			);
			expect(notes.type).to.equal('character varying(255)');
		});

		it('leaves unparameterized types bare', async () => {
			const [when] = await dialect.getTableColumns(
				colHandle([
					{
						column_name: 'when',
						data_type: 'timestamp without time zone',
						is_nullable: 'YES',
						column_default: null,
						character_maximum_length: null,
						is_primary_key: false,
					},
				]),
				'articles',
			);
			expect(when.type).to.equal('timestamp without time zone');
		});
	});

	describe('getTableIndexes() FULLTEXT/GIN introspection', () => {
		const mockHandle = (rows) => ({
			calls: [],
			async query(sql, params) {
				this.calls.push({ sql, params });
				return { rows };
			},
		});

		const indexRow = (name, def, extra = {}) => ({
			index_name: name,
			is_unique: false,
			is_primary: false,
			index_def: def,
			...extra,
		});

		it('reports a GIN to_tsvector index as FULLTEXT over its source column', async () => {
			const handle = mockHandle([
				indexRow(
					'idx_ft_body',
					`CREATE INDEX idx_ft_body ON public.articles USING gin (to_tsvector('english'::regconfig, body))`,
				),
			]);
			const [idx] = await dialect.getTableIndexes(handle, 'articles');
			expect(idx.type).to.equal('FULLTEXT');
			expect(idx.columns).to.deep.equal(['body']);
		});

		it('unwraps the (col)::text cast Postgres adds for varchar columns', async () => {
			const handle = mockHandle([
				indexRow(
					'idx_ft_notes',
					`CREATE INDEX idx_ft_notes ON public.articles USING gin (to_tsvector('english'::regconfig, (notes)::text))`,
				),
			]);
			const [idx] = await dialect.getTableIndexes(handle, 'articles');
			expect(idx.type).to.equal('FULLTEXT');
			expect(idx.columns).to.deep.equal(['notes']);
		});

		it('preserves the case of quoted camelCase columns', async () => {
			const handle = mockHandle([
				indexRow(
					'idx_ft_bodyText',
					`CREATE INDEX "idx_ft_bodyText" ON public.articles USING gin (to_tsvector('english'::regconfig, "bodyText"))`,
				),
			]);
			const [idx] = await dialect.getTableIndexes(handle, 'articles');
			expect(idx.columns).to.deep.equal(['bodyText']);
		});

		it('extracts every column of a concatenated multi-column tsvector, in order', async () => {
			const handle = mockHandle([
				indexRow(
					'idx_ft_title_body',
					`CREATE INDEX idx_ft_title_body ON public.articles USING gin (((to_tsvector('english'::regconfig, title) || to_tsvector('english'::regconfig, body))))`,
				),
			]);
			const [idx] = await dialect.getTableIndexes(handle, 'articles');
			expect(idx.type).to.equal('FULLTEXT');
			expect(idx.columns).to.deep.equal(['title', 'body']);
		});

		it('does NOT flag a plain GIN index (e.g. on jsonb) as FULLTEXT', async () => {
			const handle = mockHandle([
				indexRow(
					'idx_data',
					`CREATE INDEX idx_data ON public.articles USING gin (data)`,
				),
			]);
			const [idx] = await dialect.getTableIndexes(handle, 'articles');
			expect(idx.type).to.equal('GIN');
			expect(idx.columns).to.deep.equal(['data']);
		});

		it('reports ordinary btree indexes as BTREE and still parses their columns', async () => {
			const handle = mockHandle([
				indexRow(
					'idx_slug_created',
					`CREATE INDEX idx_slug_created ON public.articles USING btree (slug, "createdAt")`,
				),
				indexRow(
					'idx_email_unique',
					`CREATE UNIQUE INDEX idx_email_unique ON public.articles USING btree (email)`,
					{ is_unique: true },
				),
			]);
			const [multi, unique] = await dialect.getTableIndexes(handle, 'articles');
			expect(multi.type).to.equal('BTREE');
			expect(multi.columns).to.deep.equal(['slug', 'createdAt']);
			expect(unique.type).to.equal('BTREE');
			expect(unique.unique).to.equal(true);
			expect(unique.columns).to.deep.equal(['email']);
		});

		it('still filters out the primary key', async () => {
			const handle = mockHandle([
				indexRow(
					'articles_pkey',
					`CREATE UNIQUE INDEX articles_pkey ON public.articles USING btree (id)`,
					{ is_primary: true, is_unique: true },
				),
			]);
			expect(await dialect.getTableIndexes(handle, 'articles')).to.deep.equal(
				[],
			);
		});
	});

	// Postgres' index_elem grammar accepts a bare column name or a bare function
	// call, but ANY other expression must be parenthesized. A concatenation of
	// tsvectors is an operator expression, so the multi-column FULLTEXT DDL was a
	// syntax error as emitted. Extra parens are always legal, so wrap
	// unconditionally.
	describe('generateCreateIndex() FULLTEXT expression parenthesization', () => {
		it('parenthesizes a concatenated multi-column tsvector expression', () => {
			const sql = dialect.generateCreateIndex(
				'articles',
				'idx_ft_title_body',
				['title', 'body'],
				{ fulltext: true },
			);
			expect(sql).to.match(/USING GIN \(\(.*\|\|.*\)\)/);
		});

		it('leaves a single-column tsvector index valid', () => {
			const sql = dialect.generateCreateIndex(
				'articles',
				'idx_ft_body',
				['body'],
				{ fulltext: true },
			);
			expect(sql).to.include(`to_tsvector('english', "body")`);
			expect(sql).to.match(/USING GIN \(/);
		});
	});
});
