/* global describe, it, before, after, beforeEach */
/**
 * MySQL/MariaDB: a DATETIME reads back as the exact UTC instant yass wrote,
 * in a process whose time zone has daylight saving.
 *
 * yass writes UTC wall clocks and asks the mariadb driver to read them as UTC
 * ('Etc/GMT+0'). The driver (2.5) did that by converting the UTC wall clock to
 * a LOCAL wall-clock string and parsing that again, so the hour that happens
 * twice at fall-back collapsed onto its first occurrence: in America/Chicago,
 * '2030-11-03 07:30:00.456' (01:30 CST) read back as 06:30:00.456Z (01:30
 * CDT), an hour early and out of order. yass now parses DATETIME and TIMESTAMP
 * values as UTC itself.
 *
 * Each case runs in a child process in America/Chicago (see the probe), since
 * UTC-only machines hide this. Live MySQL only.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');

const PROBE = path.join(__dirname, 'fixtures', 'mysql-dst-probe.js');
const LOCAL_TZ = 'America/Chicago';
const PROBE_TIMEOUT_MS = 30000;

// America/Chicago, 2030: clocks go back at 2030-11-03 07:00Z (02:00 CDT ->
// 01:00 CST), forward at 2030-03-10 08:00Z (02:00 CST -> 03:00 CDT).
const FIRST_0130 = '2030-11-03T06:30:00.123Z'; // 01:30 CDT
const SECOND_0130 = '2030-11-03T07:30:00.456Z'; // 01:30 CST, an hour later
const AFTER_SPRING_FORWARD = '2030-03-10T08:30:00.789Z'; // 03:30 CDT
// Written out of order, so reading them back sorted proves the order too.
const INSTANTS = [SECOND_0130, AFTER_SPRING_FORWARD, FIRST_0130];
const SORTED = [AFTER_SPRING_FORWARD, FIRST_0130, SECOND_0130];

const isMysql = () => ['mysql', 'mariadb'].includes(config.dialect || 'mysql');

describe('#dbh MySQL DATETIME across daylight saving', function suite() {
	this.timeout(60000);

	const table = `yass_dst_probe_${uuid().replace(/-/g, '').slice(0, 12)}`;

	const withConn = async (fn) => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await fn(conn);
		} finally {
			await conn.end();
		}
	};

	const probe = (timezone) => {
		const run = spawnSync(process.execPath, [PROBE], {
			env: {
				...process.env,
				PROBE_TABLE: table,
				PROBE_TIMEZONE: timezone,
				PROBE_LOCAL_TZ: LOCAL_TZ,
				PROBE_INSTANTS: JSON.stringify(INSTANTS),
			},
			encoding: 'utf8',
			timeout: PROBE_TIMEOUT_MS,
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
		}
	});

	beforeEach(async () => {
		await withConn(async (conn) => {
			await conn.pquery(`DROP TABLE IF EXISTS ${table}`);
			await conn.pquery(
				`CREATE TABLE ${table} (id INT PRIMARY KEY AUTO_INCREMENT, at DATETIME(3) NULL, ts TIMESTAMP(3) NULL, isDeleted INT NOT NULL DEFAULT 0)`,
			);
		});
	});

	after(async () => {
		if (!isMysql()) {
			return;
		}
		await withConn((conn) => conn.pquery(`DROP TABLE IF EXISTS ${table}`));
	});

	const expectExact = (result) => {
		expect(
			result.localOffsetMinutes,
			'the probe must run outside UTC',
		).to.not.equal(0);
		expect(
			result.pquery.map((row) => row.at),
			'pquery',
		).to.deep.equal(SORTED);
		expect(result.connection, 'createConnection').to.deep.equal(SORTED);
		expect(result.model, 'model read').to.deep.equal(INSTANTS);
		// The rows come back in the order they happened, not the write order.
		const idOf = (at) => result.ids[INSTANTS.indexOf(at)];
		expect(result.pquery.map((row) => row.id)).to.deep.equal(SORTED.map(idOf));
	};

	it('reads the repeated fall-back hour and the spring-forward hour exactly (timezone unset)', () => {
		expectExact(probe(''));
	});

	it("reads DATETIME and TIMESTAMP exactly with timezone: 'utc'", () => {
		const result = probe('utc');
		expect(result.sessionZone).to.equal('+00:00');
		expectExact(result);
		// A UTC session reads TIMESTAMP back as the same UTC wall clock.
		expect(
			result.pquery.map((row) => row.ts),
			'TIMESTAMP',
		).to.deep.equal(SORTED);
	});
});
