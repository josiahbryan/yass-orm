/* eslint-env mocha */
const { expect } = require('chai');
const { getDialect } = require('../lib/dbh');
const {
	rawIndexHasExpressionKeyPart,
	buildRawCreateIndexSql,
} = require('../lib/sync-to-db');

describe('raw-string index online clause (BDL-4421)', () => {
	describe('rawIndexHasExpressionKeyPart', () => {
		it('is false for plain, prefix and DESC key parts', () => {
			expect(
				rawIndexHasExpressionKeyPart('(linkedType(230), linkedId(230), date)'),
			).to.equal(false);
			expect(rawIndexHasExpressionKeyPart('(user, achievement)')).to.equal(
				false,
			);
			expect(rawIndexHasExpressionKeyPart('(earnedAt DESC)')).to.equal(false);
		});
		it('is true for functional / multi-valued key parts', () => {
			expect(
				rawIndexHasExpressionKeyPart('((CAST(tags as CHAR(255) ARRAY)))'),
			).to.equal(true);
			expect(
				rawIndexHasExpressionKeyPart('(a, (CAST(x->>"$.k" AS CHAR(10))))'),
			).to.equal(true);
		});
	});

	describe('buildRawCreateIndexSql', () => {
		const base = {
			physicalName: 'linked_date',
			table: 't',
			cols: '(linkedType(230), linkedId(230), date)',
			isFullText: false,
			rawWhereClause: '',
		};

		it('mysql: plain index gets LOCK=NONE', () => {
			expect(
				buildRawCreateIndexSql({ dialect: getDialect('mysql'), ...base }),
			).to.equal(
				'create index `linked_date` on t (linkedType(230), linkedId(230), date) ALGORITHM=INPLACE LOCK=NONE',
			);
		});
		it('mysql: multi-valued expression gets LOCK=SHARED', () => {
			const sql = buildRawCreateIndexSql({
				dialect: getDialect('mysql'),
				...base,
				cols: '((CAST(tags as CHAR(255) ARRAY)))',
			});
			expect(sql.endsWith(' ALGORITHM=INPLACE LOCK=SHARED')).to.equal(true);
		});
		it('mysql: fulltext gets LOCK=SHARED', () => {
			expect(
				buildRawCreateIndexSql({
					dialect: getDialect('mysql'),
					...base,
					physicalName: 'ft',
					cols: '(title, body)',
					isFullText: true,
				}),
			).to.equal(
				'create fulltext index `ft` on t (title, body) ALGORITHM=INPLACE LOCK=SHARED',
			);
		});

		['sqlite', 'postgres'].forEach((name) => {
			describe(name, () => {
				it('has no clause', () => {
					expect(
						buildRawCreateIndexSql({ dialect: getDialect(name), ...base }),
					).to.equal(
						'create index "linked_date" on t (linkedType(230), linkedId(230), date)',
					);
				});
				it('puts where last', () => {
					expect(
						buildRawCreateIndexSql({
							dialect: getDialect(name),
							...base,
							rawWhereClause: ' where isDeleted = 0',
						}),
					).to.equal(
						'create index "linked_date" on t (linkedType(230), linkedId(230), date) where isDeleted = 0',
					);
				});
			});
		});
	});
});
