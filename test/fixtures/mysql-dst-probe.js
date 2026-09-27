/* eslint-disable no-console */
/**
 * Run as a CHILD PROCESS by test/dbh.mysql-datetime-dst.test.js, in a process
 * time zone with daylight saving (the mariadb driver reads the process zone
 * once, when a pool or connection is made).
 *
 * Writes the given instants through yass (Model.create) and reads them back
 * through a pooled dbh().pquery, a model read (Model.get), and a single
 * connection from the dialect's createConnection().
 *
 * Env:
 *   PROBE_TABLE     an existing table: (id INT AUTO_INCREMENT, at DATETIME(3),
 *                   ts TIMESTAMP(3) NULL, isDeleted INT)
 *   PROBE_TIMEZONE  the yass `timezone` option to set ('' = leave it unset)
 *   PROBE_LOCAL_TZ  the process time zone to run in (after yass loads, since
 *                   lib/dbh.js sets TZ=UTC when it is required)
 *   PROBE_INSTANTS  JSON array of ISO instants to write
 *
 * Prints one line: PROBE_RESULT=<json>.
 */
const config = require('../../lib/config');

if (process.env.PROBE_TIMEZONE) {
	config.timezone = process.env.PROBE_TIMEZONE;
}

const { loadDefinition, closeAllConnections } = require('../../lib');
const { dbh } = require('../../lib/dbh');
const { MySQLDialect } = require('../../lib/dialects/MySQLDialect');

process.env.TZ = process.env.PROBE_LOCAL_TZ;

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

async function main() {
	const table = process.env.PROBE_TABLE;
	const instants = JSON.parse(process.env.PROBE_INSTANTS);
	const Model = loadDefinition(({ types: t }) => ({
		table,
		schema: { id: t.idKey, at: t.datetime.precision(3) },
	}));
	const conn = await dbh();

	const ids = [];
	// eslint-disable-next-line no-restricted-syntax
	for (const at of instants) {
		// eslint-disable-next-line no-await-in-loop
		const row = await Model.create({ at: new Date(at) });
		ids.push(row.id);
	}
	// The same UTC wall clock in the TIMESTAMP column, set by SQL.
	await conn.pquery(`UPDATE ${table} SET ts = at`);

	const pquery = (
		await conn.pquery(`SELECT id, at, ts FROM ${table} ORDER BY at, id`)
	).map((row) => ({ id: row.id, at: iso(row.at), ts: iso(row.ts) }));

	Model.clearCache();
	const model = [];
	// eslint-disable-next-line no-restricted-syntax
	for (const id of ids) {
		// eslint-disable-next-line no-await-in-loop
		model.push(iso((await Model.get(id)).at));
	}

	const single = await new MySQLDialect().createConnection({
		...config,
		database: config.schema,
	});
	let connection;
	try {
		connection = (
			await single.query(`SELECT id, at FROM ${table} ORDER BY at, id`)
		).map((row) => iso(row.at));
	} finally {
		await single.end();
	}

	const [{ sessionZone }] = await conn.pquery(
		'SELECT @@session.time_zone AS sessionZone',
	);

	console.log(
		`PROBE_RESULT=${JSON.stringify({
			localOffsetMinutes: new Date('2030-07-01T00:00:00Z').getTimezoneOffset(),
			sessionZone,
			ids,
			pquery,
			model,
			connection,
		})}`,
	);
	await closeAllConnections();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
