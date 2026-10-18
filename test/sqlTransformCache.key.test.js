/* global describe, it */
const { expect } = require('chai');
const { createTransformCache } = require('../lib/sql-transform/transformCache');

describe('translation cache structured keys and bounds', () => {
	const make = (options = {}) => {
		let calls = 0;
		const cache = createTransformCache({
			dialect: 'postgres',
			transform: ({ sql, params }) => {
				calls += 1;
				return { sql, paramOrder: Object.keys(params || {}) };
			},
			...options,
		});
		return { cache, calls: () => calls };
	};

	it('does not collide a delimiter in a name with two names', () => {
		const { cache, calls } = make();
		cache({ sql: 'SELECT :a', params: { 'a\u0000b': 1 } });
		const second = cache({ sql: 'SELECT :a', params: { a: 2, b: 3 } });
		expect(second.paramOrder).to.deep.equal(['a', 'b']);
		expect(calls()).to.equal(2);
	});

	it('separates SQL from the shape, even when either contains delimiters', () => {
		const { cache, calls } = make();
		cache({ sql: '\u0000SELECT', params: { a: 1 } });
		expect(cache({ sql: 'SELECT', params: { 'a\u0000': 2 } }).sql).to.equal(
			'SELECT',
		);
		expect(calls()).to.equal(2);
	});

	it('reuses one entry for different values and separates different statements', () => {
		const { cache, calls } = make();
		cache({ sql: 'SELECT :a', params: { a: 'company-one' } });
		cache({ sql: 'SELECT :a', params: { a: 'company-two' } });
		expect(calls()).to.equal(1);
		cache({ sql: 'SELECT :b', params: { a: 'company-two' } });
		expect(calls()).to.equal(2);
	});

	it('requires an explicit dialect namespace', () => {
		expect(() => make({ dialect: undefined })).to.throw(TypeError);
		const pg = make();
		const mysql = make({ dialect: 'mysql' });
		pg.cache({ sql: 'SELECT :a' });
		mysql.cache({ sql: 'SELECT :a' });
		expect(pg.calls()).to.equal(1);
		expect(mysql.calls()).to.equal(1);
	});

	it('rejects invalid bounds at construction', () => {
		[NaN, Infinity, -1, 1.5, '10'].forEach((max) => {
			expect(() => make({ getMaxEntries: () => max })).to.throw(TypeError);
		});
	});

	it('applies a smaller bound on a hit and clears entries when disabled', () => {
		let max = 3;
		const { cache } = make({ getMaxEntries: () => max });
		['a', 'b', 'c'].forEach((sql) => cache({ sql }));
		max = 1;
		cache({ sql: 'c' });
		expect(cache.size()).to.equal(max);
		max = 0;
		cache({ sql: 'c' });
		expect(cache.size()).to.equal(max);
	});

	it('rejects invalid runtime bound changes before translating', () => {
		let max = 3;
		const { cache, calls } = make({ getMaxEntries: () => max });
		cache({ sql: 'a' });
		max = Infinity;
		expect(() => cache({ sql: 'b' })).to.throw(TypeError);
		expect(calls()).to.equal(1);
	});
});
