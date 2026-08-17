/* global describe, it */
const { expect } = require('chai');
const {
	normalizeSearchOptions,
	SUPPORTED_SEARCH_OPTION_KEYS,
} = require('../lib/search-options');

describe('#YASS-ORM normalizeSearchOptions', () => {
	describe('backward compatibility (boolean form)', () => {
		it('treats `true` as limitOne', () => {
			expect(normalizeSearchOptions(true)).to.deep.equal({
				limitOne: true,
				limit: undefined,
				offset: undefined,
				orderBy: undefined,
				orderDir: undefined,
			});
		});

		it('treats `false` as no options at all', () => {
			expect(normalizeSearchOptions(false).limitOne).to.equal(false);
		});

		it('treats undefined as `false`', () => {
			expect(normalizeSearchOptions(undefined).limitOne).to.equal(false);
		});
	});

	describe('options form', () => {
		it('accepts the canonical vocabulary', () => {
			expect(
				normalizeSearchOptions({
					limit: 20,
					offset: 5,
					orderBy: 'createdAt',
					orderDir: 'desc',
				}),
			).to.deep.equal({
				limitOne: false,
				limit: 20,
				offset: 5,
				orderBy: 'createdAt',
				orderDir: 'DESC',
			});
		});

		it('defaults orderDir to ASC when orderBy is given alone', () => {
			expect(
				normalizeSearchOptions({ orderBy: 'createdAt' }).orderDir,
			).to.equal('ASC');
		});

		it('is idempotent — normalizing its own output is a no-op', () => {
			const once = normalizeSearchOptions({ limit: 3, orderBy: 'a' });
			expect(normalizeSearchOptions(once)).to.deep.equal(once);
		});

		it('honours an explicit limitOne inside the object', () => {
			expect(normalizeSearchOptions({ limitOne: true }).limitOne).to.equal(
				true,
			);
		});
	});

	describe('unknown / unusable keys THROW and NAME THE KEY', () => {
		// Test the RULE, not the three symptoms we happen to know about.
		[
			{ label: 'pallas-era typo', opts: { zzzNope: 1 }, key: 'zzzNope' },
			{
				label: 'matm sortBy dialect',
				opts: { sortBy: ['-datetime'] },
				key: 'sortBy',
			},
			{ label: 'mongo-style sort', opts: { sort: { score: -1 } }, key: 'sort' },
		].forEach(({ label, opts, key }) => {
			it(`throws naming '${key}' (${label})`, () => {
				expect(() => normalizeSearchOptions(opts))
					.to.throw(Error)
					.that.matches(new RegExp(`'${key}'`));
			});
		});

		it('lists the supported keys in the error message', () => {
			expect(() => normalizeSearchOptions({ nope: 1 })).to.throw(
				/limitOne, limit, offset, orderBy, orderDir/,
			);
		});

		it("throws naming 'sortBy' even when its value is undefined (spread footgun)", () => {
			expect(() => normalizeSearchOptions({ sortBy: undefined }))
				.to.throw(Error)
				.that.matches(/'sortBy'/);
		});

		it("throws naming 'sort' when undefined alongside a valid key (spread footgun)", () => {
			expect(() => normalizeSearchOptions({ sort: undefined, limit: 5 }))
				.to.throw(Error)
				.that.matches(/'sort'/);
		});
	});

	describe('value validation', () => {
		it('rejects a non-integer limit', () => {
			expect(() => normalizeSearchOptions({ limit: 1.5 })).to.throw(/limit/);
			expect(() => normalizeSearchOptions({ limit: '10' })).to.throw(/limit/);
			expect(() => normalizeSearchOptions({ limit: -1 })).to.throw(/limit/);
		});

		it('rejects a bad orderDir', () => {
			expect(() =>
				normalizeSearchOptions({ orderBy: 'a', orderDir: 'sideways' }),
			).to.throw(/orderDir/);
		});

		it('rejects offset without limit (SQL cannot express it)', () => {
			expect(() => normalizeSearchOptions({ offset: 5 })).to.throw(/offset/);
		});

		it('rejects orderDir without orderBy', () => {
			expect(() => normalizeSearchOptions({ orderDir: 'DESC' })).to.throw(
				/orderBy/,
			);
		});

		it('does not throw when orderDir is explicitly undefined (value-level absence)', () => {
			const result = normalizeSearchOptions({
				orderBy: 'a',
				orderDir: undefined,
			});
			expect(result.orderDir).to.equal('ASC');
		});

		it('does not throw when limit is explicitly undefined alongside limitOne', () => {
			expect(() =>
				normalizeSearchOptions({ limitOne: true, limit: undefined }),
			).to.not.throw();
		});

		it('rejects limitOne combined with limit', () => {
			expect(() =>
				normalizeSearchOptions({ limitOne: true, limit: 5 }),
			).to.throw(/limitOne/);
		});
	});

	describe('column validation (model layer only)', () => {
		it('throws when orderBy is not a schema column', () => {
			expect(() =>
				normalizeSearchOptions(
					{ orderBy: 'notAColumn' },
					{ validColumns: ['id', 'createdAt'] },
				),
			).to.throw(/notAColumn/);
		});

		it('accepts a real column', () => {
			expect(
				normalizeSearchOptions(
					{ orderBy: 'createdAt' },
					{ validColumns: ['id', 'createdAt'] },
				).orderBy,
			).to.equal('createdAt');
		});

		it('skips the column check when validColumns is not supplied', () => {
			expect(normalizeSearchOptions({ orderBy: 'anything' }).orderBy).to.equal(
				'anything',
			);
		});
	});

	it('exports the supported key list', () => {
		expect(SUPPORTED_SEARCH_OPTION_KEYS).to.deep.equal([
			'limitOne',
			'limit',
			'offset',
			'orderBy',
			'orderDir',
		]);
	});
});
