/* eslint-disable global-require, no-unused-expressions */
/* global it, describe, beforeEach */
const { expect } = require('chai');
const { MySQLDialect } = require('../MySQLDialect');

describe('MySQLDialect', () => {
	let dialect;

	beforeEach(() => {
		dialect = new MySQLDialect();
	});

	describe('Basic Properties', () => {
		it('should have name "mysql"', () => {
			expect(dialect.name).to.equal('mysql');
		});
	});

	describe('SQL Syntax & Formatting', () => {
		describe('quoteIdentifier()', () => {
			it('should wrap identifiers in backticks', () => {
				expect(dialect.quoteIdentifier('users')).to.equal('`users`');
				expect(dialect.quoteIdentifier('my_table')).to.equal('`my_table`');
			});

			it('should escape embedded backticks', () => {
				expect(dialect.quoteIdentifier('table`name')).to.equal('`table``name`');
			});
		});

		describe('formatPlaceholder()', () => {
			it('should format named placeholders with : prefix', () => {
				expect(dialect.formatPlaceholder('name', 0)).to.equal(':name');
				expect(dialect.formatPlaceholder('userId', 1)).to.equal(':userId');
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

			it('should return null for null/undefined', () => {
				expect(dialect.prepareParams(null)).to.be.null;
				expect(dialect.prepareParams(undefined)).to.be.null;
			});
		});

		describe('transformSql()', () => {
			it('should return SQL unchanged (MySQL native format)', () => {
				const sql = 'SELECT * FROM users WHERE name = :name AND age = :age';
				const result = dialect.transformSql(sql, { name: 'Bob', age: 30 });
				expect(result).to.equal(sql);
			});
		});
	});

	describe('Type Mapping', () => {
		describe('mapType()', () => {
			it('should map idKey to int(11)', () => {
				expect(dialect.mapType('idKey')).to.equal('int(11)');
			});

			it('should map uuidKey to char(36)', () => {
				expect(dialect.mapType('uuidKey')).to.equal('char(36)');
			});

			it('should map string to varchar(255)', () => {
				expect(dialect.mapType('string')).to.equal('varchar(255)');
			});

			it('should map text to longtext', () => {
				expect(dialect.mapType('text')).to.equal('longtext');
			});

			it('should map integer types to int(11)', () => {
				expect(dialect.mapType('int')).to.equal('int(11)');
				expect(dialect.mapType('integer')).to.equal('int(11)');
			});

			it('should map boolean types to int(1)', () => {
				expect(dialect.mapType('bool')).to.equal('int(1)');
				expect(dialect.mapType('boolean')).to.equal('int(1)');
			});

			it('should map floating point types correctly', () => {
				expect(dialect.mapType('real')).to.equal('double');
				expect(dialect.mapType('double')).to.equal('double');
				expect(dialect.mapType('float')).to.equal('float');
			});

			it('should map date/time types correctly', () => {
				expect(dialect.mapType('date')).to.equal('date');
				expect(dialect.mapType('datetime')).to.equal('datetime');
				expect(dialect.mapType('time')).to.equal('time');
				expect(dialect.mapType('timestamp')).to.equal('timestamp');
			});

			it('should map JSON to longtext', () => {
				expect(dialect.mapType('json')).to.equal('longtext');
			});

			it('should return original type for unmapped types', () => {
				expect(dialect.mapType('custom_type')).to.equal('custom_type');
			});
		});

		describe('getIntegerPrimaryKeyAttrs()', () => {
			it('should return correct attrs for AUTO_INCREMENT PRIMARY KEY', () => {
				const attrs = dialect.getIntegerPrimaryKeyAttrs();
				expect(attrs.type).to.equal('int(11)');
				expect(attrs.key).to.equal('PRI');
				expect(attrs.extra).to.equal('auto_increment');
				expect(attrs.readonly).to.equal(1);
				expect(attrs.auto).to.equal(1);
			});
		});

		describe('getUuidPrimaryKeyAttrs()', () => {
			it('should return correct attrs for UUID PRIMARY KEY', () => {
				const attrs = dialect.getUuidPrimaryKeyAttrs();
				expect(attrs.type).to.equal('char(36)');
				expect(attrs.key).to.equal('PRI');
				expect(attrs.null).to.equal(0);
				expect(attrs.collation).to.equal('utf8mb4_bin');
			});
		});
	});

	describe('DDL Generation', () => {
		describe('generateCreateTable()', () => {
			it('should generate CREATE TABLE with UTF8MB4 charset', () => {
				const fields = [
					{ field: 'id', type: 'int(11)', key: 'PRI', extra: 'auto_increment' },
					{ field: 'name', type: 'varchar(255)' },
				];
				const result = dialect.generateCreateTable('users', fields);
				expect(result).to.include('CREATE TABLE `users`');
				expect(result).to.include('CHARACTER SET utf8mb4');
			});
		});

		describe('generateFieldSpec()', () => {
			it('should generate basic field spec', () => {
				const result = dialect.generateFieldSpec({
					field: 'name',
					type: 'varchar(255)',
				});
				expect(result).to.equal('`name` varchar(255)');
			});

			it('should add PRIMARY KEY and AUTO_INCREMENT', () => {
				const result = dialect.generateFieldSpec({
					field: 'id',
					type: 'int(11)',
					key: 'PRI',
					extra: 'auto_increment',
				});
				expect(result).to.equal('`id` int(11) PRIMARY KEY AUTO_INCREMENT');
			});

			it('should add AUTO_INCREMENT even when key is ignored', () => {
				const result = dialect.generateFieldSpec(
					{
						field: 'id',
						type: 'int(11)',
						key: 'PRI',
						extra: 'auto_increment',
					},
					{ ignore: ['key'] },
				);
				expect(result).to.equal('`id` int(11) AUTO_INCREMENT');
			});

			it('should add NOT NULL constraint', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'varchar(255)',
					null: 'NO',
				});
				expect(result).to.equal('`email` varchar(255) NOT NULL');
			});

			it('should add UNIQUE constraint', () => {
				const result = dialect.generateFieldSpec({
					field: 'email',
					type: 'varchar(255)',
					key: 'UNI',
				});
				expect(result).to.equal('`email` varchar(255) UNIQUE');
			});

			it('should add COLLATE clause', () => {
				const result = dialect.generateFieldSpec({
					field: 'uuid',
					type: 'char(36)',
					collation: 'utf8mb4_bin',
				});
				expect(result).to.equal('`uuid` char(36) COLLATE utf8mb4_bin');
			});

			it('should add DEFAULT clause', () => {
				const result = dialect.generateFieldSpec({
					field: 'status',
					type: 'varchar(255)',
					default: 'active',
				});
				expect(result).to.equal("`status` varchar(255) DEFAULT 'active'");
			});

			it('should add COMMENT clause', () => {
				const result = dialect.generateFieldSpec({
					field: 'age',
					type: 'int(11)',
					_description: 'User age in years',
				});
				expect(result).to.equal("`age` int(11) COMMENT 'User age in years'");
			});

			it('should escape single quotes in COMMENT', () => {
				const result = dialect.generateFieldSpec({
					field: 'note',
					type: 'text',
					_description: "User's note",
				});
				expect(result).to.include("COMMENT 'User''s note'");
			});

			it('should skip DEFAULT for longtext type', () => {
				const result = dialect.generateFieldSpec({
					field: 'content',
					type: 'longtext',
					default: '',
				});
				expect(result).to.equal('`content` longtext');
			});

			it('should normalize legacy types', () => {
				expect(
					dialect.generateFieldSpec({ field: 'f', type: 'varchar(-1)' }),
				).to.include('varchar(255)');
				expect(
					dialect.generateFieldSpec({ field: 'f', type: 'money' }),
				).to.include('real');
				expect(
					dialect.generateFieldSpec({ field: 'f', type: 'smalldatetime' }),
				).to.include('datetime');
				expect(
					dialect.generateFieldSpec({ field: 'f', type: 'uniqueidentifier' }),
				).to.include('varchar(256)');
				expect(
					dialect.generateFieldSpec({ field: 'f', type: 'xml(-1)' }),
				).to.include('longtext');
			});
		});

		describe('generateCreateIndex()', () => {
			it('should generate CREATE INDEX', () => {
				const result = dialect.generateCreateIndex('users', 'idx_name', [
					'name',
				]);
				expect(result).to.equal('CREATE INDEX `idx_name` ON `users` (`name`)');
			});

			it('should generate UNIQUE INDEX', () => {
				const result = dialect.generateCreateIndex(
					'users',
					'idx_email',
					['email'],
					{ unique: true },
				);
				expect(result).to.equal(
					'CREATE UNIQUE INDEX `idx_email` ON `users` (`email`)',
				);
			});

			it('should generate FULLTEXT INDEX', () => {
				const result = dialect.generateCreateIndex(
					'posts',
					'idx_content',
					['title', 'body'],
					{ fulltext: true },
				);
				expect(result).to.equal(
					'CREATE FULLTEXT INDEX `idx_content` ON `posts` (`title`, `body`)',
				);
			});

			it('should handle multi-column indexes', () => {
				const result = dialect.generateCreateIndex('users', 'idx_name_age', [
					'name',
					'age',
				]);
				expect(result).to.equal(
					'CREATE INDEX `idx_name_age` ON `users` (`name`, `age`)',
				);
			});

			it('should handle column with DESC modifier', () => {
				const result = dialect.generateCreateIndex('users', 'idx_nonce', [
					'nonce DESC',
				]);
				expect(result).to.equal(
					'CREATE INDEX `idx_nonce` ON `users` (`nonce` DESC)',
				);
			});

			it('should handle column with length specification', () => {
				const result = dialect.generateCreateIndex(
					'users',
					'idx_text',
					['content'],
					{ textLengths: { content: 255 } },
				);
				expect(result).to.equal(
					'CREATE INDEX `idx_text` ON `users` (`content`(255))',
				);
			});

			it('should handle JSON functional indexes', () => {
				const result = dialect.generateCreateIndex('users', 'idx_json', [
					'data->>"$.email"',
				]);
				expect(result).to.equal(
					'CREATE INDEX `idx_json` ON `users` ((CAST(data->>"$.email" as CHAR(255)) COLLATE utf8mb4_bin))',
				);
			});
		});

		describe('generateDropIndex()', () => {
			it('should generate DROP INDEX ON table', () => {
				const result = dialect.generateDropIndex('users', 'idx_name');
				expect(result).to.equal('DROP INDEX `idx_name` ON `users`');
			});
		});

		describe('generateAlterAddColumn()', () => {
			it('should generate ALTER TABLE ADD', () => {
				const result = dialect.generateAlterAddColumn('users', {
					field: 'age',
					type: 'int(11)',
				});
				expect(result).to.equal('ALTER TABLE `users` ADD `age` int(11)');
			});
		});

		describe('generateAlterModifyColumn()', () => {
			it('should generate ALTER TABLE CHANGE (ignoring key)', () => {
				const result = dialect.generateAlterModifyColumn('users', {
					field: 'name',
					type: 'varchar(500)',
				});
				expect(result).to.equal(
					'ALTER TABLE `users` CHANGE `name` `name` varchar(500)',
				);
			});

			it('should preserve AUTO_INCREMENT', () => {
				const result = dialect.generateAlterModifyColumn('users', {
					field: 'id',
					type: 'int(11)',
					key: 'PRI',
					extra: 'auto_increment',
				});
				expect(result).to.include('AUTO_INCREMENT');
			});
		});

		describe('generateAlterDropColumn()', () => {
			it('should generate ALTER TABLE DROP', () => {
				const result = dialect.generateAlterDropColumn('users', 'oldColumn');
				expect(result).to.equal('ALTER TABLE `users` DROP `oldColumn`');
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

		it('should support stored functions', () => {
			expect(dialect.supportsStoredFunctions).to.be.true;
		});

		it('should support ALTER COLUMN', () => {
			expect(dialect.supportsAlterColumn).to.be.true;
		});

		it('should support named placeholders', () => {
			expect(dialect.supportsNamedPlaceholders).to.be.true;
		});

		it('should support connection pooling', () => {
			expect(dialect.supportsConnectionPooling).to.be.true;
		});

		it('should support triggers', () => {
			expect(dialect.supportsTriggers).to.be.true;
		});

		it('should support read replicas', () => {
			expect(dialect.supportsReadReplicas).to.be.true;
		});
	});

	describe('Schema Introspection Normalization', () => {
		it('should preserve prefix lengths and DESC in index columns', async () => {
			const handle = {
				query: async () => [
					{
						Key_name: 'idx_metric',
						Column_name: 'metric',
						Expression: null,
						Sub_part: 230,
						Collation: 'A',
						Seq_in_index: 1,
						Non_unique: 1,
						Index_type: 'BTREE',
					},
					{
						Key_name: 'idx_nonce_desc',
						Column_name: 'nonce',
						Expression: null,
						Sub_part: null,
						Collation: 'D',
						Seq_in_index: 1,
						Non_unique: 1,
						Index_type: 'BTREE',
					},
				],
			};

			const indexes = await dialect.getTableIndexes(handle, 'dummy');
			const metricIdx = indexes.find((idx) => idx.name === 'idx_metric');
			const nonceIdx = indexes.find((idx) => idx.name === 'idx_nonce_desc');

			expect(metricIdx.columns).to.deep.equal(['metric(230)']);
			expect(nonceIdx.columns).to.deep.equal(['nonce DESC']);
		});

		it('should normalize JSON expression path to $.path form', async () => {
			const handle = {
				query: async () => [
					{
						Key_name: 'idx_json',
						Column_name: null,
						Expression:
							"(cast(json_unquote(json_extract(`emotionalImpact`,_utf8mb4\\'valence\\')) as char(255) charset utf8mb4) collate utf8mb4_bin)",
						Sub_part: null,
						Collation: null,
						Seq_in_index: 1,
						Non_unique: 1,
						Index_type: 'BTREE',
					},
				],
			};

			const indexes = await dialect.getTableIndexes(handle, 'dummy');
			const jsonIdx = indexes.find((idx) => idx.name === 'idx_json');
			expect(jsonIdx.columns).to.deep.equal(['emotionalImpact->>"$.valence"']);
		});
	});
});
