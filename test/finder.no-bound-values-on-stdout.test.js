/* global describe, it, before */
/**
 * BDL-3886 — lib/finder.js must not print bound parameter values on the
 * SUCCESS path, to either stream.
 *
 * The probe runs in a child process so stdout and stderr are captured
 * SEPARATELY (a leak names its stream), and so its lib/utils stubs cannot
 * leak into other suites' module cache.
 *
 * The diagnostic value of those log lines (query shape, timing, id counts)
 * must still print when asked for: redact, do not silence. Since they are debug
 * output, they print only with YASS_DEBUG=finder (see lib/debug.js).
 */
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { expect } = require('chai');

const PROBE = path.join(__dirname, 'fixtures', 'finder-stdout-probe.js');

// Lowercase alphanumeric on purpose: finder's q path lower-cases and strips
// non-alnum, so the nonce survives verbatim into both the literal and the
// "wild" (%-between-every-char) form.
const nonce = () => `zzq${crypto.randomBytes(6).toString('hex')}`;

describe('finder.js does not print bound parameter values (BDL-3886)', () => {
	const nonces = {
		Q: nonce(),
		FIELD: nonce(),
		HOOK: nonce(),
		FILTER: nonce(),
	};
	const unusedNonce = nonce();
	let run;
	let quietRun;

	const runProbe = (extraEnv) =>
		spawnSync(process.execPath, [PROBE], {
			env: {
				...process.env,
				YASS_DEBUG: '',
				NONCE_Q: nonces.Q,
				NONCE_FIELD: nonces.FIELD,
				NONCE_HOOK: nonces.HOOK,
				NONCE_FILTER: nonces.FILTER,
				...extraEnv,
			},
			encoding: 'utf8',
			timeout: 30000,
		});

	before(() => {
		run = runProbe({ YASS_DEBUG: 'finder' });
		quietRun = runProbe({});
	});

	it('probe ran to completion and every nonce was really bound (positive control)', () => {
		expect(run.status, `probe stderr:\n${run.stderr}`).to.equal(0);
		const marker = /PROBE_BOUND_HITS=(\{.*\})/.exec(run.stderr);
		expect(marker, 'probe result marker missing on stderr').to.not.equal(null);
		const hits = JSON.parse(marker[1]);
		Object.keys(nonces).forEach((route) => {
			expect(
				hits[route],
				`nonce ${route} never reached the driver`,
			).to.be.at.least(1);
		});
	});

	it('the matcher can see stdout and a never-used nonce is absent (controls)', () => {
		expect(run.stdout).to.include('`widgets`');
		expect(run.stdout).to.not.include(unusedNonce);
		expect(run.stderr).to.not.include(unusedNonce);
	});

	['stdout', 'stderr'].forEach((stream) => {
		Object.keys(nonces).forEach((route) => {
			it(`${stream} carries no ${route} bound value, literal or wild form`, () => {
				const text = run[stream];
				const value = nonces[route];
				expect(
					text.includes(value),
					`${route} value printed LITERALLY on ${stream}`,
				).to.equal(false);
				// The LIKE pattern '%z%z%q%...%' is losslessly reversible, so a
				// redactor keyed on the literal value would miss it.
				expect(
					text.replace(/%/g, '').includes(value),
					`${route} value printed in WILD (%-interleaved) form on ${stream}`,
				).to.equal(false);
			});
		});
	});

	it('still prints the diagnostic shape: SQL with placeholders, timing, id counts', () => {
		const out = run.stdout;
		expect(out).to.include('finder.js: After processing query.q');
		expect(out).to.include('******** generated:');
		expect(out).to.include('match_ratio(');
		expect(out).to.match(/delta: \d+/);
		expect(out).to.include('[custom-query-filter.filterData] (probe)');
		expect(out).to.include('select id from widgets where secretNote = ?');
		expect(out).to.match(/Resulting ID count: 2/);
	});

	it('prints none of that diagnostic output without YASS_DEBUG=finder', () => {
		expect(quietRun.status, `probe stderr:\n${quietRun.stderr}`).to.equal(0);
		const out = quietRun.stdout;
		expect(out).to.not.include('finder.js: After processing query.q');
		expect(out).to.not.include('******** generated:');
		expect(out).to.not.include('[custom-query-filter.filterData]');
	});
});
