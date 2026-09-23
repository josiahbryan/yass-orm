/* global describe, it, afterEach */
const { expect } = require('chai');
const config = require('../lib/config');
const { deflateValue } = require('../lib/dbh');

// Dates become SQL literals differently per dialect: MySQL DATETIME (no fsp)
// ROUNDS fractional seconds, so it gets a whole-second 'YYYY-MM-DD HH:MM:SS'
// UTC string (unchanged). Postgres stores them exactly, so it gets the full ISO
// instant with milliseconds and 'Z' -- right for timestamptz and naive columns.

describe('#deflateValue dates per dialect', () => {
	const saved = config.dialect;
	afterEach(() => {
		config.dialect = saved;
	});
	const at = new Date('2026-01-15T12:34:56.789Z');

	it('MySQL: whole-second UTC wall clock (unchanged)', () => {
		config.dialect = 'mysql';
		expect(deflateValue(at)).to.equal('2026-01-15 12:34:56');
	});

	it('Postgres: the full ISO instant, milliseconds kept', () => {
		config.dialect = 'postgres';
		expect(deflateValue(at)).to.equal('2026-01-15T12:34:56.789Z');
		expect(deflateValue('2026-01-15T12:34:56.789Z')).to.equal(
			'2026-01-15T12:34:56.789Z',
		);
	});
});
