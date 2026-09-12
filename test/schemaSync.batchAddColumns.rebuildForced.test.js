/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const { captureAlterStatements } = require('./helpers/captureAlterStatements');

// AC5. A table that CANNOT take ALGORITHM=INSTANT pays a full rebuild per
// ALTER, so N separate ADDs cost N rebuilds. This proves the batched path
// issues ONE statement against exactly such a table.
//
// 🔴 DELIBERATELY NOT TIMED. A REFUSED alter costs ~0s and so does a
// successful INSTANT one, so duration cannot separate the outcomes -- two
// desks misdiagnosed exactly that on 2026-09-12 from a 0-second digest row.
// We read the ERROR CODE to establish the fixture, then count STATEMENTS.
describe('#schemaSync batched ADD on a rebuild-forced table', function rebuildForcedSuite() {
	this.timeout(60000);

	const table = `yass_batch_rf_${uuid().replace(/-/g, '')}`;
	let conn;
	let fixtureRefusesInstant = false;

	before(async function beforeRebuildForcedSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
			return;
		}
		conn = await dbh({ ignoreCachedConnections: true });

		// Build a table with fulltext HISTORY: create the index, then drop it.
		// The hidden FTS_DOC_ID column DROP INDEX leaves behind is what makes
		// the table refuse INSTANT afterwards.
		await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
		await conn.pquery(
			`CREATE TABLE \`${table}\` (
				id int NOT NULL PRIMARY KEY,
				body text,
				FULLTEXT KEY ft_body (body)
			) ENGINE=InnoDB ROW_FORMAT=DYNAMIC`,
		);
		await conn.pquery(`DROP INDEX ft_body ON \`${table}\``);

		// PROBE: does it actually refuse INSTANT? Establish from the ERROR CODE.
		// Accept 1845 OR 1846 -- which one you get depends on whether the index
		// is still live, and pinning one is brittle across MySQL versions.
		try {
			await conn.pquery(
				`ALTER TABLE \`${table}\` ADD probe_col int, ALGORITHM=INSTANT`,
				undefined,
				{ silenceErrors: true },
			);
			// It SUCCEEDED -- the fixture did not reproduce on this server.
			await conn.pquery(`ALTER TABLE \`${table}\` DROP COLUMN probe_col`);
		} catch (ex) {
			const code = (ex && (ex.errno || ex.code)) || 0;
			const msg = `${(ex && ex.message) || ex}`;
			fixtureRefusesInstant =
				code === 1845 ||
				code === 1846 ||
				/ALGORITHM=INSTANT is not supported/i.test(msg);
		}
	});

	after(async () => {
		if (conn) {
			await conn.pquery(`DROP TABLE IF EXISTS \`${table}\``);
			await conn.end();
		}
	});

	it('issues ONE batched ALTER (notice + noticeDetail, plus yass-orm-injected columns) on an INSTANT-refusing table', async function instantTest() {
		if (!fixtureRefusesInstant) {
			// Say WHY. A skip that cannot name its reason is indistinguishable
			// from a test that does not exist.
			console.warn(
				`SKIPPING: could not construct an INSTANT-refusing table on this server -- the fulltext-history probe was ACCEPTED, so this environment does not reproduce the rebuild-forced condition.`,
			);
			this.skip();
			return;
		}

		const schema = ({ types: t }) => ({
			table,
			schema: {
				id: t.idKey,
				body: t.text,
				notice: t.string,
				noticeDetail: t.text,
			},
		});

		const cap = captureAlterStatements.install();
		try {
			await syncSchemaToDb(YassORM.convertDefinition(schema));
		} finally {
			cap.restore();
		}

		const executed = cap.executedAltersFor(table);
		const addAlters = executed.filter((s) => /\bADD\b/.test(s));
		expect(
			addAlters,
			`expected ONE batched ADD alter on a rebuild-forced table, got:\n${addAlters.join(
				'\n',
			)}`,
		).to.have.length(1);
		expect(addAlters[0]).to.include('notice');
		expect(addAlters[0]).to.include('noticeDetail');

		// The columns really landed.
		const cols = await conn.pquery(`SHOW COLUMNS FROM \`${table}\``);
		const names = cols.map((c) => c.Field);
		expect(names).to.include('notice');
		expect(names).to.include('noticeDetail');
	});
});
