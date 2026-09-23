/* eslint-disable no-console */
/**
 * Run as a CHILD PROCESS by test/dbh.timezone-utc.test.js, so it gets a fresh
 * process time zone (the mariadb driver reads it once, when a pool is made)
 * and a fresh config.
 *
 * Env:
 *   PROBE_TABLE     an existing table: (id INT AUTO_INCREMENT, at DATETIME(3),
 *                   isDeleted INT)
 *   PROBE_TIMEZONE  the yass `timezone` option to set ('' = leave it unset)
 *   PROBE_LOCAL_TZ  the process time zone to run in (after yass loads, since
 *                   lib/dbh.js sets TZ=UTC when it is required)
 *
 * Prints one line: PROBE_RESULT=<json>.
 */
const config = require('../../lib/config');

if (process.env.PROBE_TIMEZONE) {
	config.timezone = process.env.PROBE_TIMEZONE;
}

const { loadDefinition, closeAllConnections } = require('../../lib');
const { dbh } = require('../../lib/dbh');

process.env.TZ = process.env.PROBE_LOCAL_TZ;

const HOUR = 60 * 60 * 1000;

async function main() {
	const Model = loadDefinition(({ types: t }) => ({
		table: process.env.PROBE_TABLE,
		schema: { id: t.idKey, at: t.datetime.precision(3) },
	}));
	const conn = await dbh();

	// Several connections at once, so the pool has to open more than one.
	const sessions = await Promise.all(
		[0, 1, 2, 3].map(() =>
			conn.pquery(
				'SELECT @@session.time_zone AS tz, @@global.time_zone AS globalTz, SLEEP(0.2) AS s',
			),
		),
	);

	const [{ skew }] = await conn.pquery(
		'SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS skew',
	);

	const exact = new Date('2026-01-15T12:34:56.789Z');
	const row = await Model.create({ at: exact });
	Model.clearCache();
	const roundTrip = (await Model.get(row.id)).at.toISOString();

	// A time an hour ago and an hour ahead, written by yass, compared by SQL.
	const past = await Model.create({ at: new Date(Date.now() - HOUR) });
	const future = await Model.create({ at: new Date(Date.now() + HOUR) });
	const [{ expired }] = await conn.pquery(
		`SELECT at < NOW() AS expired FROM ${process.env.PROBE_TABLE} WHERE id = :id`,
		{ id: past.id },
	);
	const [{ live }] = await conn.pquery(
		`SELECT at > NOW() AS live FROM ${process.env.PROBE_TABLE} WHERE id = :id`,
		{ id: future.id },
	);

	console.log(
		`PROBE_RESULT=${JSON.stringify({
			localOffsetMinutes: new Date().getTimezoneOffset(),
			sessionZones: sessions.map(([r]) => r.tz),
			globalZone: sessions[0][0].globalTz,
			skew: Number(skew),
			roundTrip,
			expired: Number(expired),
			live: Number(live),
		})}`,
	);
	await closeAllConnections();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
