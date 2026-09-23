/* global describe, it, beforeEach, afterEach */
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');
const { DEBUG_AREAS, isDebugEnabled } = require('../lib/debug');

const FLAGS = [
	'YASS_DEBUG',
	'DEBUG_MODEL_CACHE_HITS',
	'YASS_DEBUG_PATH_RESOLVER',
	'YASS_DEBUG_MODEL_INDEX',
	'YASS_DEBUG_DEFINITION_INDEX',
];

describe('YASS_DEBUG (lib/debug.js)', () => {
	let saved;
	beforeEach(() => {
		saved = {};
		FLAGS.forEach((flag) => {
			saved[flag] = process.env[flag];
			delete process.env[flag];
		});
	});
	afterEach(() => {
		FLAGS.forEach((flag) => {
			if (saved[flag] === undefined) delete process.env[flag];
			else process.env[flag] = saved[flag];
		});
	});

	it('is off for every area when no flag is set', () => {
		DEBUG_AREAS.forEach((area) => {
			expect(isDebugEnabled(area), area).to.equal(false);
		});
	});

	it('turns on exactly the areas listed, trimmed and case-insensitive', () => {
		process.env.YASS_DEBUG = ' Cache , finder';
		expect(isDebugEnabled('cache')).to.equal(true);
		expect(isDebugEnabled('finder')).to.equal(true);
		expect(isDebugEnabled('path-resolver')).to.equal(false);
		expect(isDebugEnabled('model-index')).to.equal(false);
	});

	it('turns on every area with *', () => {
		process.env.YASS_DEBUG = '*';
		DEBUG_AREAS.forEach((area) => {
			expect(isDebugEnabled(area), area).to.equal(true);
		});
	});

	it('accepts several areas and is on when any of them is', () => {
		process.env.YASS_DEBUG = 'model-index';
		expect(isDebugEnabled('cache', 'model-index')).to.equal(true);
		expect(isDebugEnabled('cache', 'finder')).to.equal(false);
	});

	it('reads YASS_DEBUG on every call', () => {
		expect(isDebugEnabled('finder')).to.equal(false);
		process.env.YASS_DEBUG = 'finder';
		expect(isDebugEnabled('finder')).to.equal(true);
	});

	describe('the old flags still work as aliases', () => {
		it("DEBUG_MODEL_CACHE_HITS=true turns on 'cache' (read at load, exactly 'true')", () => {
			const probe = (value) =>
				spawnSync(
					process.execPath,
					[
						'-e',
						"process.stdout.write(String(require('./lib/debug').isDebugEnabled('cache')))",
					],
					{
						cwd: path.join(__dirname, '..'),
						env: {
							...process.env,
							YASS_DEBUG: '',
							DEBUG_MODEL_CACHE_HITS: value,
						},
						encoding: 'utf8',
					},
				).stdout;
			expect(probe('true')).to.equal('true');
			expect(probe('1')).to.equal('false');
		});

		[
			['YASS_DEBUG_PATH_RESOLVER', 'path-resolver'],
			['YASS_DEBUG_MODEL_INDEX', 'model-index'],
			['YASS_DEBUG_DEFINITION_INDEX', 'definition-index'],
		].forEach(([flag, area]) => {
			it(`${flag} (any non-empty value) turns on '${area}' only`, () => {
				process.env[flag] = '1';
				expect(isDebugEnabled(area)).to.equal(true);
				DEBUG_AREAS.filter((other) => other !== area).forEach((other) => {
					expect(isDebugEnabled(other), other).to.equal(false);
				});
			});
		});
	});
});
