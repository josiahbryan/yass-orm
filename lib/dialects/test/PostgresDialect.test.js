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
				expect(result).to.include("to_tsvector('english', \"body\")");
			});

			it('should handle multi-column FULLTEXT indexes with concatenated tsvectors', () => {
				const result = dialect.generateCreateIndex(
					'articles',
					'idx_ft_title_body',
					['title', 'body'],
					{ fulltext: true },
				);
				expect(result).to.include('USING GIN');
				expect(result).to.include("to_tsvector('english', \"title\")");
				expect(result).to.include("to_tsvector('english', \"body\")");
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
				expect(result).to.include("ALTER COLUMN \"email\" SET DEFAULT 'unknown'");
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
});
