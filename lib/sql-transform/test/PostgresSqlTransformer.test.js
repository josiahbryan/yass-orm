/* eslint-disable func-names */
/* eslint-disable global-require, no-unused-expressions */
/* global it, describe */
const { expect } = require('chai');
const {
	transformSqlForPostgres,
	transformSqlWithScanner,
	transformAstForPostgres,
} = require('../PostgresSqlTransformer');

describe('PostgresSqlTransformer', () => {
	describe('transformSqlWithScanner()', () => {
		it('should convert :name placeholders to $N positional placeholders', () => {
			const result = transformSqlWithScanner(
				'SELECT * FROM users WHERE id = :id AND name = :name',
				{ id: 1, name: 'test' },
			);
			expect(result.sql).to.match(/\$1/);
			expect(result.sql).to.match(/\$2/);
			expect(result.paramOrder).to.include('id');
			expect(result.paramOrder).to.include('name');
		});

		it('should reuse the same $N for repeated :name placeholders', () => {
			const result = transformSqlWithScanner(
				'SELECT * FROM t WHERE a = :x OR b = :x',
				{ x: 1 },
			);
			// Both occurrences of :x should map to the same $N
			const matches = result.sql.match(/\$(\d+)/g);
			expect(matches).to.have.length(2);
			expect(matches[0]).to.equal(matches[1]);
		});

		it('should convert backtick identifiers to double-quote identifiers', () => {
			const result = transformSqlWithScanner('SELECT `name` FROM `users`', {});
			expect(result.sql).to.equal('SELECT "name" FROM "users"');
		});

		it('should convert LIMIT offset,count to LIMIT count OFFSET offset', () => {
			const result = transformSqlWithScanner(
				'SELECT * FROM t LIMIT 10, 20',
				{},
			);
			expect(result.sql).to.equal('SELECT * FROM t LIMIT 20 OFFSET 10');
		});

		it('should convert CURDATE() to CURRENT_DATE', () => {
			const result = transformSqlWithScanner(
				'SELECT * FROM t WHERE d = CURDATE()',
				{},
			);
			expect(result.sql).to.include('CURRENT_DATE');
			expect(result.sql).not.to.include('CURDATE');
		});

		it('should leave NOW() unchanged', () => {
			const result = transformSqlWithScanner('SELECT NOW()', {});
			expect(result.sql).to.include('NOW()');
		});

		it('should convert IFNULL to COALESCE', () => {
			const result = transformSqlWithScanner('SELECT IFNULL(a, b) FROM t', {});
			expect(result.sql).to.include('COALESCE(a, b)');
			expect(result.sql).not.to.include('IFNULL');
		});

		it('should convert JSON ->> with $.path to simple key', () => {
			const result = transformSqlWithScanner(
				"SELECT data->>'$.name' FROM t",
				{},
			);
			expect(result.sql).to.include("->>'name'");
			expect(result.sql).not.to.include('$.');
		});

		it('should convert JSON -> with $.path to simple key', () => {
			const result = transformSqlWithScanner(
				"SELECT data->'$.name' FROM t",
				{},
			);
			expect(result.sql).to.include("->'name'");
			expect(result.sql).not.to.include('$.');
		});

		it('should not modify placeholders inside string literals', () => {
			const result = transformSqlWithScanner(
				"SELECT * FROM t WHERE x = ':notaparam'",
				{ notaparam: 1 },
			);
			expect(result.sql).to.include("':notaparam'");
			expect(result.paramOrder).to.have.length(0);
		});

		it('should not modify placeholders inside comments', () => {
			const result = transformSqlWithScanner(
				'SELECT * FROM t -- WHERE x = :id',
				{ id: 1 },
			);
			expect(result.sql).to.include(':id');
			expect(result.paramOrder).to.have.length(0);
		});

		it('should handle multiple different params in correct order', () => {
			const result = transformSqlWithScanner(
				'INSERT INTO t (a, b, c) VALUES (:alpha, :beta, :gamma)',
				{ alpha: 1, beta: 2, gamma: 3 },
			);
			expect(result.paramOrder[0]).to.equal('alpha');
			expect(result.paramOrder[1]).to.equal('beta');
			expect(result.paramOrder[2]).to.equal('gamma');
			expect(result.sql).to.include('$1');
			expect(result.sql).to.include('$2');
			expect(result.sql).to.include('$3');
		});

		it('should handle longer param names not colliding with shorter ones', () => {
			const result = transformSqlWithScanner(
				'SELECT * FROM t WHERE id = :id AND id_extra = :id_extra',
				{ id: 1, id_extra: 2 },
			);
			// :id_extra should not be partially matched as :id
			expect(result.paramOrder).to.include('id');
			expect(result.paramOrder).to.include('id_extra');
			// They should be different $N values
			const idIdx = result.paramOrder.indexOf('id');
			const idExtraIdx = result.paramOrder.indexOf('id_extra');
			expect(idIdx).to.not.equal(idExtraIdx);
		});
	});

	describe('transformAstForPostgres()', () => {
		it('should be a function', () => {
			expect(transformAstForPostgres).to.be.a('function');
		});
	});

	describe('transformSqlForPostgres()', () => {
		it('should return sql, paramOrder, and mode', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM users WHERE id = :id',
				params: { id: 1 },
			});
			expect(result).to.have.property('sql');
			expect(result).to.have.property('paramOrder');
			expect(result).to.have.property('mode');
		});

		it('should use scanner mode for SQL with comments', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM users -- comment\nWHERE id = :id',
				params: { id: 1 },
			});
			expect(result.mode).to.equal('scanner');
		});

		it('should attempt AST mode for plain SQL', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM users WHERE id = :id',
				params: { id: 1 },
			});
			// Should succeed with ast or fall back to scanner
			expect(['ast', 'scanner']).to.include(result.mode);
			expect(result.sql).to.include('$1');
			expect(result.paramOrder).to.deep.equal(['id']);
		});

		it('should convert CURDATE() via AST path', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT CURDATE() FROM users',
				params: {},
			});
			expect(result.sql).to.include('CURRENT_DATE');
		});

		it('should convert IFNULL via AST path', () => {
			const result = transformSqlForPostgres({
				sql: "SELECT IFNULL(name, 'default') FROM users",
				params: {},
			});
			expect(result.sql).to.include('COALESCE');
		});

		it('should convert backticks to double quotes in full transform', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT `name` FROM `users` WHERE `id` = :id',
				params: { id: 1 },
			});
			expect(result.sql).not.to.include('`');
			expect(result.sql).to.include('"');
		});

		it('should handle LIMIT offset,count in full transform', () => {
			const result = transformSqlForPostgres({
				sql: 'SELECT * FROM users LIMIT 5, 10',
				params: {},
			});
			expect(result.sql).to.include('LIMIT 10 OFFSET 5');
		});

		it('should handle complex INSERT with multiple params', () => {
			const result = transformSqlForPostgres({
				sql: 'INSERT INTO users (name, email) VALUES (:name, :email)',
				params: { name: 'test', email: 'test@test.com' },
			});
			expect(result.sql).to.include('$1');
			expect(result.sql).to.include('$2');
			expect(result.paramOrder).to.have.length(2);
		});

		it('should handle UPDATE with repeated param', () => {
			const result = transformSqlForPostgres({
				sql: 'UPDATE t SET a = :val, b = :val WHERE id = :id',
				params: { val: 'x', id: 1 },
			});
			// :val appears twice but should get same $N
			const valIdx = result.paramOrder.indexOf('val') + 1;
			const regex = new RegExp(`\\$${valIdx}`, 'g');
			const matches = result.sql.match(regex);
			expect(matches.length).to.be.gte(2);
			expect(result.paramOrder).to.include('id');
		});

		it('should handle JSON ->> path conversion in full pipeline', () => {
			const result = transformSqlForPostgres({
				sql: "SELECT data->>'$.name' FROM users",
				params: {},
			});
			expect(result.sql).not.to.include('$.');
		});
	});
});
