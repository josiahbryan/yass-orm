/* eslint-env mocha */
/* eslint-disable no-console */
const { expect } = require('chai');
const {
	describeLargeIndexBuild,
	warnIfLargeIndexBuild,
} = require('../lib/largeIndexBuild');

const SQL = 'CREATE INDEX `ix` ON `t` (`a`)';

async function captureWarns(fn) {
	const orig = console.warn;
	const calls = [];
	console.warn = (...a) => calls.push(a.join(' '));
	try {
		await fn();
	} finally {
		console.warn = orig;
	}
	return calls;
}

describe('largeIndexBuild', () => {
	it('flags 1,000,000 rows', () => {
		const m = describeLargeIndexBuild({
			table: 'big',
			rows: 1000000,
			bytes: 1,
			sql: SQL,
		});
		expect(m).to.include('big').and.include('1000000').and.include(SQL);
		expect(m).to.match(/replicas/i);
	});
	it('flags 1 GiB', () => {
		expect(
			describeLargeIndexBuild({
				table: 't',
				rows: 1,
				bytes: 1073741824,
				sql: SQL,
			}),
		).to.be.a('string');
	});
	it('does not flag just below both thresholds', () => {
		expect(
			describeLargeIndexBuild({
				table: 't',
				rows: 999999,
				bytes: 1073741823,
				sql: SQL,
			}),
		).to.equal(null);
	});
	it('null estimates count as 0', () => {
		expect(
			describeLargeIndexBuild({
				table: 't',
				rows: null,
				bytes: null,
				sql: SQL,
			}),
		).to.equal(null);
	});
	it('warns unknown when the size read throws, and resolves', async () => {
		const dialect = {
			estimateTableSize: async () => {
				throw new Error('boom');
			},
		};
		const calls = await captureWarns(() =>
			warnIfLargeIndexBuild({ dialect, handle: {}, tableInput: 't', sql: SQL }),
		);
		expect(calls).to.have.length(1);
		expect(calls[0]).to.include('unknown');
	});
	it('is silent when the dialect has no estimate', async () => {
		const dialect = { estimateTableSize: async () => undefined };
		const calls = await captureWarns(() =>
			warnIfLargeIndexBuild({ dialect, handle: {}, tableInput: 't', sql: SQL }),
		);
		expect(calls).to.have.length(0);
	});
	it('warns once for a large table', async () => {
		const dialect = {
			estimateTableSize: async () => ({ rows: 2000000, bytes: 5 }),
		};
		const calls = await captureWarns(() =>
			warnIfLargeIndexBuild({ dialect, handle: {}, tableInput: 't', sql: SQL }),
		);
		expect(calls).to.have.length(1);
	});
	it('never throws even with a broken dialect', async () => {
		await warnIfLargeIndexBuild({
			dialect: null,
			handle: {},
			tableInput: 't',
			sql: SQL,
		});
	});
});
