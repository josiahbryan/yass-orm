/* global describe, it */
const { expect } = require('chai');
const { canonicalizeIndexPredicateViaAst } = require('../indexPredicate');

const canon = (sql) => canonicalizeIndexPredicateViaAst(sql, 'postgresql');

// Partial-index predicates are compared through a real SQL AST rather than by
// normalizing text with regexes. The reason is fidelity: the database re-renders
// the predicate, and text normalization could not tell WHOSE parentheses were
// whose, so the only churn-free option was to drop them all -- which lost real
// structure (`a AND (b OR c)` vs `(a AND b) OR c` became identical).
//
// With an AST, grouping lives in the shape of the tree: redundant parentheses
// vanish for free and genuine structure survives exactly.
describe('#indexPredicate (AST canonicalization)', () => {
	describe('grouping fidelity', () => {
		it('distinguishes different groupings of the same terms', () => {
			expect(canon('a AND (b OR c)')).to.not.equal(canon('(a AND b) OR c'));
		});

		it('ignores parentheses that change nothing', () => {
			expect(canon('a AND b')).to.equal(canon('((a) AND (b))'));
			expect(canon('a AND b')).to.equal(canon('(((a AND b)))'));
			expect(canon('a AND b AND c')).to.equal(canon('((a AND b) AND c)'));
		});

		it('preserves nested grouping', () => {
			expect(canon('a AND (b OR (c AND d))')).to.not.equal(
				canon('a AND ((b OR c) AND d)'),
			);
		});
	});

	// node-sql-parser chains AND/OR strictly left-to-right, ignoring SQL
	// precedence: it parses `a OR b AND c` as `(a OR b) AND c`, which is NOT what
	// SQL means. Postgres reports the predicate correctly parenthesized, so without
	// repairing this an author who wrote an unparenthesized mixed predicate would
	// never match the catalog and the index would rebuild on every sync.
	describe('AND/OR precedence repair', () => {
		it('binds AND tighter than OR', () => {
			expect(canon('a OR b AND c')).to.equal(canon('a OR (b AND c)'));
			expect(canon('a AND b OR c')).to.equal(canon('(a AND b) OR c'));
		});

		it('does not equate different groupings after repair', () => {
			expect(canon('a OR b AND c')).to.not.equal(canon('(a OR b) AND c'));
		});

		it('handles longer mixed chains', () => {
			expect(canon('a AND b OR c AND d')).to.equal(
				canon('(a AND b) OR (c AND d)'),
			);
			expect(canon('a OR b OR c AND d')).to.equal(canon('a OR b OR (c AND d)'));
		});

		it('matches what Postgres reports for a mixed predicate', () => {
			// Verified live: PG renders `x = false AND y IS NULL OR id > 5` as below.
			expect(
				canon('"isDeleted" = false AND status IS NULL OR id > 5'),
			).to.equal(
				canon('(((isDeleted = false) AND (status IS NULL)) OR (id > 5))'),
			);
		});
	});

	describe('rendering artifacts Postgres adds', () => {
		it('drops casts, including multi-word and array types', () => {
			expect(canon("status = 'active'")).to.equal(
				canon("(status)::text = 'active'::text"),
			);
			expect(canon("status = 'a'")).to.equal(
				canon("status = 'a'::character varying"),
			);
			expect(canon('id > 5')).to.equal(canon('id > 5::bigint'));
		});

		// The cast stripper must not be greedy across whitespace: an earlier version
		// allowed spaces inside the type name (to cover `character varying`) and so
		// `::text ~~ ` swallowed the OPERATOR that followed, silently breaking the
		// parse and falling back to lossy text comparison.
		it('does not swallow an operator that follows a cast', () => {
			expect(canon("(email)::text ~~ 'a%'::text")).to.not.equal(null);
			expect(canon("(email)::text ~~ 'a%'::text")).to.equal(
				canon("email LIKE 'a%'"),
			);
		});

		it('folds pattern-match operators to their keyword spellings', () => {
			expect(canon("email ~~ 'a%'")).to.equal(canon("email LIKE 'a%'"));
			expect(canon("email !~~ 'a%'")).to.equal(canon("email NOT LIKE 'a%'"));
			expect(canon("email ~~* 'a%'")).to.equal(canon("email ILIKE 'a%'"));
		});

		it('folds != and <>', () => {
			expect(canon("status != 'x'")).to.equal(canon("status <> 'x'"));
		});

		it('folds `= ANY (ARRAY[...])` to IN', () => {
			expect(canon("status IN ('a','b')")).to.equal(
				canon(
					"(status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])",
				),
			);
		});

		it('treats a double-quoted Postgres identifier as an identifier', () => {
			expect(canon('"isDeleted" = false')).to.equal(canon('isdeleted = false'));
		});
	});

	describe('genuine differences are preserved', () => {
		it('distinguishes different literals, columns and operators', () => {
			expect(canon("status = 'a'")).to.not.equal(canon("status = 'b'"));
			expect(canon('a = 1')).to.not.equal(canon('b = 1'));
			expect(canon('id > 5')).to.not.equal(canon('id >= 5'));
			expect(canon('a IS NULL')).to.not.equal(canon('a IS NOT NULL'));
			expect(canon("email LIKE 'a%'")).to.not.equal(
				canon("email NOT LIKE 'a%'"),
			);
			expect(canon("status IN ('a','b')")).to.not.equal(
				canon("status IN ('a','c')"),
			);
		});
	});

	describe('failure handling', () => {
		it('returns null for an unparseable predicate rather than throwing', () => {
			expect(canon('some_weird_op !!! thing')).to.equal(null);
		});

		it('returns null for empty input', () => {
			expect(canon('')).to.equal(null);
			expect(canon(undefined)).to.equal(null);
			expect(canon(null)).to.equal(null);
		});

		it('parses a MySQL-quoted predicate even when asked for Postgres first', () => {
			// Backticks are MySQL-only; the canonicalizer retries the other dialect so
			// a predicate written in either style still yields one canonical form.
			expect(
				canonicalizeIndexPredicateViaAst('`isDeleted` = 0', 'postgresql'),
			).to.not.equal(null);
		});
	});
});
