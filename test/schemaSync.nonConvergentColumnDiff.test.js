/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

/**
 * BDL-3746: schema-sync NEVER CONVERGES for two column shapes, so it re-issues
 * the same no-op DDL against the database on EVERY run, forever.
 *
 * Measured on production (via performance_schema digests): 21 DDL statements,
 * each executed 109 times over six days, against live tables. Each needs an
 * exclusive metadata lock, so on a busy tick some raise ER_LOCK_WAIT_TIMEOUT,
 * the bin exits 1, and the deploy pipeline fails at stage 6 and blocks EVERY
 * deploy. The DDL is the reason there is anything to fail at all.
 *
 * CLASS 1 -- a column that is the SOLE column of a UNIQUE index.
 *   MySQL `SHOW COLUMNS` reports `Key=UNI` for it. The schema field carries no
 *   key at all, so the diff sees k=key, a=UNI, b=''. The normalisation list
 *   forgave only `MUL` ("Multiple keys report oddly, so ignore them"), with no
 *   UNI twin -- and `ALTER TABLE ... CHANGE` cannot set Key=UNI, so the very
 *   next sync sees the identical diff. Forever.
 *
 * CLASS 2 -- a NOT NULL column with a NON-ZERO numeric default.
 *   `.default(1)` is stored as the JS NUMBER 1; `SHOW COLUMNS` returns the
 *   STRING '1'. The comparison is strict, so `1 !== '1'` forever. A default of
 *   0 escaped only by accident, via an existing `!bk` arm (0 is falsy).
 *
 * WHY THE DEBUG LINE HID THIS: the diff prints `Debug: k=default, a=1, b=1`
 * -- the two values render IDENTICALLY. Nothing in the log says one is a
 * string and the other a number.
 *
 * THE INSTRUMENT HERE: sync the SAME UNCHANGED schema twice. Anything emitted
 * on the second pass is by definition non-convergent -- no drift was
 * introduced, so a correct sync must emit nothing.
 */
describe('#schemaSync non-convergent column diff (BDL-3746)', () => {
	const tableName = `yass_bdl3746_${uuid().replace(/-/g, '')}`;
	const uniqueIndexName = 'idx_bdl3746_email_unique';

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			// CLASS 1: sole column of a unique index -> SHOW COLUMNS reports Key=UNI
			email: t.string,
			// CLASS 2: NOT NULL numeric default, non-zero
			version: t.int.default(1),
			// CONTROL: numeric default of ZERO. Already forgiven before this fix
			// (by the `ak === '0' && !bk` arm, since 0 is falsy), so it separates
			// "every default churns" from "only non-zero defaults churn".
			zeroDefault: t.int.default(0),
			// CONTROL: an ordinary column with no key and no default. If THIS ever
			// churns, the run is measuring something global and the readings above
			// mean nothing.
			plain: t.string,
		},
		options: {
			indexes: {
				[uniqueIndexName]: { unique: true, cols: ['email'] },
			},
		},
	});

	/** Re-sync the UNCHANGED schema, capturing what the diff decided to emit. */
	async function resyncAndCapture() {
		const debugLines = [];
		const alterLines = [];
		const origLog = console.log;
		console.log = (...args) => {
			const line = args.join(' ');
			if (line.startsWith('Debug: k=')) debugLines.push(line);
			if (/ALTER TABLE/i.test(line)) alterLines.push(line);
			origLog(...args);
		};
		try {
			await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.log = origLog;
		}
		return { debugLines, alterLines };
	}

	async function describeColumn(field) {
		const conn = await dbh({ ignoreCachedConnections: true });
		const [row] = await conn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = '${field}'`,
		);
		await conn.end();
		return row;
	}

	before(async () => {
		// First sync CREATES the table. Churn here is meaningless -- everything is
		// new. Every assertion below is about the SECOND sync.
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('POSITIVE CONTROL: the table really is in the shape the diff will be reading', async () => {
		// If this fails, every assertion below is void -- they would be measuring
		// a table that does not have the shapes under test.
		const email = await describeColumn('email');
		expect(
			email.Key,
			'email must be reported UNI for class 1 to be under test',
		).to.equal('UNI');

		const version = await describeColumn('version');
		expect(version.Null).to.equal('NO');
		expect(
			version.Default,
			'SHOW COLUMNS must return the default as a STRING for class 2 to be under test',
		).to.equal('1');
		expect(typeof version.Default).to.equal('string');
	});

	it('CLASS 1: a sole-column UNIQUE index column does not churn on an unchanged re-sync', async () => {
		const { debugLines, alterLines } = await resyncAndCapture();

		const uniChurn = debugLines.filter((l) => l.includes('k=key, a=UNI'));
		expect(
			uniChurn,
			'Key=UNI was counted as a column difference, so schema-sync emits a no-op ' +
				'ALTER ... CHANGE for this column on every single run, forever',
		).to.deep.equal([]);

		const emailAlter = alterLines.filter((l) => l.includes('`email`'));
		expect(
			emailAlter,
			'no ALTER should be emitted for an unchanged column',
		).to.deep.equal([]);
	});

	it('CLASS 2: a non-zero numeric default does not churn on an unchanged re-sync', async () => {
		const { debugLines, alterLines } = await resyncAndCapture();

		const defaultChurn = debugLines.filter((l) => l.includes('k=default'));
		expect(
			defaultChurn,
			"the schema's numeric default (number 1) was compared strictly against " +
				"SHOW COLUMNS' string '1'; they render identically in this very log line",
		).to.deep.equal([]);

		const versionAlter = alterLines.filter((l) => l.includes('`version`'));
		expect(versionAlter).to.deep.equal([]);
	});

	it('CONTROL: the zero-default and plain columns never churned (so the two above are specific, not global)', async () => {
		const { debugLines } = await resyncAndCapture();
		expect(debugLines.filter((l) => l.includes('zeroDefault'))).to.deep.equal(
			[],
		);
		expect(debugLines.filter((l) => l.includes('plain'))).to.deep.equal([]);
	});

	it('WHOLE-TABLE CONTRACT: a second sync of an unchanged schema emits NO column diff at all', async () => {
		const { debugLines } = await resyncAndCapture();
		expect(
			debugLines,
			'an unchanged schema must produce an empty diff; anything here is non-convergent DDL ' +
				'that will be re-issued against production on every pipeline tick',
		).to.deep.equal([]);
	});

	// ---------------------------------------------------------------- scope guards
	// Forgiving a difference is only safe if it cannot also swallow a REAL one.
	// These two tests are what keep the fix from being "stop noticing things".

	it('SCOPE GUARD: a genuinely DROPPED unique index is still recreated (the UNI arm must not hide it)', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP INDEX \`${uniqueIndexName}\` ON \`${tableName}\``);
		const afterDrop = await conn.pquery(`SHOW INDEX FROM \`${tableName}\``);
		await conn.end();
		expect(
			afterDrop.some((r) => r.Key_name === uniqueIndexName),
			'drift must actually be applied, or this test proves nothing',
		).to.equal(false);

		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));

		const conn2 = await dbh({ ignoreCachedConnections: true });
		const rows = await conn2.pquery(`SHOW INDEX FROM \`${tableName}\``);
		await conn2.end();
		expect(
			rows.some((r) => r.Key_name === uniqueIndexName),
			'unique indexes are reconciled in their own pass -- that is WHY ignoring Key=UNI in the ' +
				'column diff is safe. If this ever fails, the UNI arm is hiding a real regression.',
		).to.equal(true);
	});

	it('SCOPE GUARD: genuine numeric-default drift is still restored (the default arm must not blind the diff)', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`ALTER TABLE \`${tableName}\` MODIFY \`version\` int NOT NULL DEFAULT 2`,
		);
		await conn.end();

		const drifted = await describeColumn('version');
		expect(drifted.Default, 'drift must actually be applied').to.equal('2');

		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));

		const restored = await describeColumn('version');
		expect(
			restored.Default,
			'a default that differs AS A STRING is a real difference and must still be altered',
		).to.equal('1');
	});
});
