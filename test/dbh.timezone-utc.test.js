/* global describe, it, before, after */
/**
 * The opt-in `timezone: 'utc'` connection option on MySQL/MariaDB.
 *
 * yass writes datetimes as UTC wall clocks and reads them back as UTC, but the
 * server's NOW() uses the session time zone (by default the server's own). So
 * raw SQL comparing a yass-written time with NOW() is off by the server's UTC
 * offset: an expired row looks live. `timezone: 'utc'` sets every connection's
 * session to '+00:00'. Off by default: nothing changes for existing consumers.
 *
 * Each case runs in a child process in America/Chicago (see the probe), a
 * non-UTC zone, since UTC-only machines hide these bugs. Live MySQL only.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');

const PROBE = path.join(__dirname, 'fixtures', 'mysql-timezone-probe.js');
const HOUR_SECONDS = 60 * 60;

const isMysql = () => ['mysql', 'mariadb'].includes(config.dialect || 'mysql');

describe('#dbh timezone: utc (MySQL)', function suite() {
	this.timeout(60000);

	const table = `yass_tz_probe_${uuid().replace(/-/g, '').slice(0, 12)}`;

	const probe = (timezone) => {
		const run = spawnSync(process.execPath, [PROBE], {
			env: {
				...process.env,
				PROBE_TABLE: table,
				PROBE_TIMEZONE: timezone,
				PROBE_LOCAL_TZ: 'America/Chicago',
			},
			encoding: 'utf8',
			timeout: 30000,
		});
		const marker = /PROBE_RESULT=(\{.*\})/.exec(run.stdout);
		expect(marker, `probe failed:\n${run.stdout}\n${run.stderr}`).to.not.equal(
			null,
		);
		return JSON.parse(marker[1]);
	};

	before(async function setup() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(`DROP TABLE IF EXISTS ${table}`);
			await conn.pquery(
				`CREATE TABLE ${table} (id INT PRIMARY KEY AUTO_INCREMENT, at DATETIME(3) NULL, isDeleted INT NOT NULL DEFAULT 0)`,
			);
		} finally {
			await conn.end();
		}
	});

	after(async () => {
		if (!isMysql()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(`DROP TABLE IF EXISTS ${table}`);
		} finally {
			await conn.end();
		}
	});

	it('with timezone: utc, every session is UTC and NOW() agrees with what yass writes', () => {
		const result = probe('utc');
		expect(
			result.localOffsetMinutes,
			'the probe must run outside UTC',
		).to.not.equal(0);
		expect(result.sessionZones).to.have.length(4);
		result.sessionZones.forEach((zone) => expect(zone).to.equal('+00:00'));
		expect(result.skew).to.equal(0);
		expect(result.roundTrip).to.equal('2026-01-15T12:34:56.789Z');
		expect(result.expired).to.equal(1);
		expect(result.live).to.equal(1);
	});

	it('without it, sessions keep the server zone; yass round trips are exact as before', () => {
		const result = probe('');
		expect(result.localOffsetMinutes).to.not.equal(0);
		result.sessionZones.forEach((zone) =>
			expect(zone).to.equal(result.globalZone),
		);
		expect(result.roundTrip).to.equal('2026-01-15T12:34:56.789Z');
		// NOW() is the server's local time: when that is an hour or more behind
		// UTC, a yass-written time an hour ago still looks in the future.
		expect(result.expired).to.equal(result.skew <= -HOUR_SECONDS ? 0 : 1);
	});
});
