/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// `t.datetime` on Postgres. It used to be a naive TIMESTAMP written as a UTC
// wall-clock string with the milliseconds cut off, and read back correctly only
// because yass-orm forces `process.env.TZ = 'UTC'` (the pg driver parses a naive
// TIMESTAMP as LOCAL time). Now:
//   * new columns are TIMESTAMPTZ -- an absolute instant, whatever the session or
//     process time zone;
//   * writes keep milliseconds (Postgres stores fractional seconds exactly;
//     MySQL DATETIME would ROUND them, so MySQL is unchanged);
//   * reads keep the driver's Date (no lossy Date -> string -> Date round trip);
//   * naive TIMESTAMP columns from before are left alone (no churn) and are
//     parsed as UTC per pool, so they no longer depend on the global TZ either.
// SKIPPED unless the active dialect is postgres.

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

describe('#Postgres datetime', () => {
	const table = `pg_dt_${uuid().replace(/-/g, '')}`;
	const def = ({ types: t }) => ({
		table,
		schema: { id: t.idKey, at: t.datetime, legacyAt: t.datetime },
	});
	let Model;
	const savedTz = process.env.TZ;

	before(async function beforeSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		expect(
			(await syncSchemaToDb(YassORM.convertDefinition(def))).errors,
		).to.deep.equal([]);
		// Simulate a column created by an older yass-orm: naive TIMESTAMP.
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`ALTER TABLE "${table}" ALTER COLUMN "legacyAt" TYPE TIMESTAMP`,
		);
		await conn.end();
		Model = await YassORM.loadDefinition(def);
	});

	after(async () => {
		process.env.TZ = savedTz;
		if (!isPostgres()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${table}"`);
		await conn.end();
	});

	it('creates t.datetime columns as timestamptz', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const [col] = await conn.pquery(
			`SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = 'at'`,
			[table],
		);
		await conn.end();
		expect(col.data_type).to.equal('timestamp with time zone');
	});

	it('round-trips the exact instant, milliseconds included, in a non-UTC process', async () => {
		const at = new Date('2026-01-15T12:34:56.789Z');
		process.env.TZ = 'Asia/Tokyo';
		try {
			const row = await Model.create({ at, legacyAt: at });
			Model.clearCache();
			const back = await Model.get(row.id);
			expect(back.at.toISOString()).to.equal('2026-01-15T12:34:56.789Z');
			expect(back.legacyAt.toISOString()).to.equal('2026-01-15T12:34:56.789Z');
		} finally {
			process.env.TZ = savedTz;
		}
	});

	it('re-syncing applies no DDL: timestamptz converges, a legacy TIMESTAMP is left alone', async () => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(def));
		expect(result.errors).to.deep.equal([]);
		expect(result.applied).to.equal(0);
	});
});
