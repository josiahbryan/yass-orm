/* global describe, it */
const { expect } = require('chai');
const {
	jsonPathToPostgres,
	convertJsonAccessorsToPostgres,
} = require('../postgresJsonPath');

// Schemas and queries spell JSON paths MySQL-style: `meta->>'$.a.b'`. Postgres has
// no JSONPath in its `->>` operator -- `->>` takes a single KEY NAME, and a path
// of depth > 1 needs the different operator `#>>` with a text[] path literal.
//
// Before this helper existed, `$.` was simply stripped, so `$.a.b` became the
// single key `'a.b'` -- a key that does not exist, on both the query side and the
// index side. Nothing errored: the SQL was valid, it just always returned NULL.
//
// Both the query transformer and the index DDL generator go through this one
// module, so they cannot drift: if they disagreed, every functional JSON index
// would be dead weight the planner can never match.
describe('#postgresJsonPath', () => {
	describe('jsonPathToPostgres()', () => {
		it('maps a single-level path to the key operator', () => {
			expect(jsonPathToPostgres('$.email', '->>')).to.deep.equal({
				operator: '->>',
				literal: `'email'`,
				keys: ['email'],
			});
		});

		it('maps a nested path to the path operator with a text[] literal', () => {
			expect(jsonPathToPostgres('$.a.b', '->>')).to.deep.equal({
				operator: '#>>',
				literal: `'{a,b}'`,
				keys: ['a', 'b'],
			});
		});

		it('maps a deeply nested path', () => {
			expect(jsonPathToPostgres('$.a.b.c', '->>')).to.deep.equal({
				operator: '#>>',
				literal: `'{a,b,c}'`,
				keys: ['a', 'b', 'c'],
			});
		});

		it('preserves the non-text variant (-> becomes #>)', () => {
			expect(jsonPathToPostgres('$.a.b', '->').operator).to.equal('#>');
			expect(jsonPathToPostgres('$.a', '->').operator).to.equal('->');
		});

		it('accepts a path with no $. prefix', () => {
			expect(jsonPathToPostgres('email', '->>').literal).to.equal(`'email'`);
			expect(jsonPathToPostgres('a.b', '->>').literal).to.equal(`'{a,b}'`);
		});

		it('handles array subscripts as path steps', () => {
			// $.items[0].name -> {items,0,name}; PG treats a numeric step as an index
			expect(jsonPathToPostgres('$.items[0].name', '->>').literal).to.equal(
				`'{items,0,name}'`,
			);
		});
	});

	describe('convertJsonAccessorsToPostgres()', () => {
		it('rewrites a single-level accessor to a plain key', () => {
			expect(convertJsonAccessorsToPostgres(`meta->>'$.valence'`)).to.equal(
				`meta->>'valence'`,
			);
		});

		it('rewrites a nested accessor to #>> with a path literal', () => {
			expect(convertJsonAccessorsToPostgres(`meta->>'$.a.b'`)).to.equal(
				`meta#>>'{a,b}'`,
			);
		});

		it('rewrites double-quoted paths (identifiers in PG) to string literals', () => {
			expect(convertJsonAccessorsToPostgres(`meta->>"$.a.b"`)).to.equal(
				`meta#>>'{a,b}'`,
			);
			expect(convertJsonAccessorsToPostgres(`meta->>"$.one"`)).to.equal(
				`meta->>'one'`,
			);
		});

		it('rewrites multiple accessors in one string', () => {
			expect(
				convertJsonAccessorsToPostgres(
					`meta->>'$.a.b' = 'x' AND other->>'$.k' = 'y'`,
				),
			).to.equal(`meta#>>'{a,b}' = 'x' AND other->>'k' = 'y'`);
		});

		it('tolerates whitespace around the operator', () => {
			expect(convertJsonAccessorsToPostgres(`meta ->> '$.a.b'`)).to.equal(
				`meta #>>'{a,b}'`,
			);
		});

		it('leaves non-JSON SQL untouched', () => {
			const sql = `SELECT * FROM t WHERE a = 'b' AND c >= 3`;
			expect(convertJsonAccessorsToPostgres(sql)).to.equal(sql);
		});
	});
});
