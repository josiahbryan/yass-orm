#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */

/**
 * Pool-leak probe (BC-3587) — MANUAL, needs a real MySQL/MariaDB.
 *
 *   node test/manual/pool-leak-probe.js [concurrency] [rounds]
 *
 * Drives `dbh()` from a COLD CACHE in concurrent bursts and reads server-side
 * `Threads_connected` between rounds, so a leak shows up as a monotonic ramp
 * rather than as a plausible-looking steady state.
 *
 * Why it exists: `dbh()` used to read `connCache`, await pool creation, and
 * write `connCache` with no in-flight guard, so every caller that lost the race
 * orphaned a whole pool — unreachable, unclosable by `closeAllConnections()`,
 * and unreapable (the driver defaults `minimumIdle` to `connectionLimit`).
 * Measured here before the fix: 20 concurrent callers → 20 distinct pools, and
 * three rounds leaked +34 → +103 → +209 connections past teardown. After the
 * fix: 1 pool per round, flat.
 *
 * Credentials come from your `.yass-orm.js` (never hardcoded here), so this is
 * safe to check in. Exits non-zero if the leak is back, so it can gate CI.
 */

const config = require('../../lib/config');
const { dbh, closeAllConnections } = require('../../lib/dbh');

const CONCURRENCY = Number(process.argv[2]) || 20;
const ROUNDS = Number(process.argv[3]) || 3;

// A couple of connections of slop: the probe's own connection and the server's
// bookkeeping lag both show up here and neither is a leak.
const LEAK_TOLERANCE = 2;

async function main() {
	// eslint-disable-next-line global-require, import/no-extraneous-dependencies
	const mariadb = require('mariadb');

	const probe = await mariadb.createConnection({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.schema,
		allowPublicKeyRetrieval: true,
	});

	const threadsConnected = async () => {
		const rows = await probe.query("SHOW STATUS LIKE 'Threads_connected'");
		return Number(rows[0].Value);
	};

	const baseline = await threadsConnected();
	console.log(
		`Pool leak probe: ${CONCURRENCY} concurrent dbh() x ${ROUNDS} cold-cache rounds`,
	);
	console.log(`Baseline Threads_connected: ${baseline}\n`);

	let leaked = 0;
	let poolsPerRound = [];

	for (let round = 1; round <= ROUNDS; round++) {
		const handles = await Promise.all(
			Array.from({ length: CONCURRENCY }, () => dbh()),
		);
		// Force each handle to actually open a connection.
		await Promise.all(handles.map((handle) => handle.pquery('SELECT 1')));

		const distinctPools = new Set(handles).size;
		poolsPerRound.push(distinctPools);
		const peak = await threadsConnected();

		// Cold cache again, exactly like a test-suite cleanup hook between files.
		await closeAllConnections();
		leaked = (await threadsConnected()) - baseline;

		console.log(
			`  Round ${round}: ${distinctPools} distinct pool(s), peak +${
				peak - baseline
			}, leaked after teardown +${leaked}`,
		);
	}

	await probe.end();

	const stampede = poolsPerRound.filter((n) => n !== 1);
	const ok = leaked <= LEAK_TOLERANCE && stampede.length === 0;

	console.log('');
	if (ok) {
		console.log(`✅ Bounded: one shared pool per round, +${leaked} past teardown`);
	} else {
		if (stampede.length) {
			console.log(
				`❌ Cache stampede: rounds produced ${poolsPerRound.join(
					', ',
				)} distinct pools (expected 1 each)`,
			);
		}
		if (leaked > LEAK_TOLERANCE) {
			console.log(`❌ Leak: ${leaked} connections survived teardown`);
		}
	}

	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error('Probe failed:', err);
	process.exit(1);
});
