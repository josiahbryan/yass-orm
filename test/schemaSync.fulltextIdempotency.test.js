/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// Regression test for the "FULLTEXT index rebuilds on every sync" bug.
//
// schema-sync appends MySQL's implicit `(255)` prefix length when a TEXT column
// participates in an index. That is required for BTREE (MySQL refuses to index a
// TEXT column without a prefix), but FULLTEXT indexes the whole column and the
// catalog reports `Sub_part: NULL`. So the computed signature was:
//     {"fulltext":true,"unique":false,"columns":["body(255)"]}
// while the signature read back from the DB was:
//     {"fulltext":true,"unique":false,"columns":["body"]}
// They can never be equal, so every sync did DROP INDEX + CREATE FULLTEXT.
//
// On a large table that rebuild holds a metadata lock for minutes and stalls
// every write to the table (observed: 120s stall on a 421k-row / 1.1 GB table).
//
// Contract: a FULLTEXT index over a TEXT column must be created WITHOUT a prefix
// length, and a second sync of the identical schema must not touch it.

describe('#schemaSync FULLTEXT index idempotency', () => {
	const tableName = `yass_fulltext_idem_${uuid().replace(/-/g, '')}`;
	const objectFormIndex = 'idx_body_fulltext';
	const arrayFormIndex = 'idx_summary_fulltext';
	const explicitPrefixIndex = 'idx_notes_fulltext';
	const btreeIndex = 'idx_slug_btree';

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			body: t.text,
			summary: t.text,
			notes: t.text,
			slug: t.text,
		},
		options: {
			indexes: {
				// object form: { fulltext: true, cols: [...] }
				[objectFormIndex]: { fulltext: true, cols: ['body'] },
				// legacy array form: ['fulltext', ...cols]
				[arrayFormIndex]: ['fulltext', 'summary'],
				// explicit prefix length written by hand: MySQL discards it for
				// FULLTEXT, so we must discard it too or the signature never matches
				[explicitPrefixIndex]: { fulltext: true, cols: ['notes(255)'] },
				// control: a plain BTREE index on a TEXT column still needs (255)
				[btreeIndex]: ['slug'],
			},
		},
	});

	before(async function beforeFulltextSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
			return;
		}
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		if ((config.dialect || 'mysql') !== 'mysql') {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('creates FULLTEXT indexes without a prefix length', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(`SHOW INDEXES FROM \`${tableName}\``);
		await conn.end();

		const byName = {};
		rows.forEach((row) => {
			byName[row.Key_name] = row;
		});

		expect(Object.keys(byName)).to.include(objectFormIndex);
		expect(byName[objectFormIndex].Index_type).to.equal('FULLTEXT');
		expect(byName[objectFormIndex].Sub_part).to.equal(null);

		expect(Object.keys(byName)).to.include(arrayFormIndex);
		expect(byName[arrayFormIndex].Index_type).to.equal('FULLTEXT');
		expect(byName[arrayFormIndex].Sub_part).to.equal(null);

		expect(Object.keys(byName)).to.include(explicitPrefixIndex);
		expect(byName[explicitPrefixIndex].Index_type).to.equal('FULLTEXT');
		expect(byName[explicitPrefixIndex].Sub_part).to.equal(null);

		// Control: BTREE on a TEXT column keeps the implicit (255) prefix
		expect(Object.keys(byName)).to.include(btreeIndex);
		expect(byName[btreeIndex].Sub_part).to.equal(255);
	});

	it('does not drop and recreate FULLTEXT indexes on a second sync', async () => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
			origLog(...args);
		};

		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.log = origLog;
		}

		expect(result.errors).to.deep.equal([]);

		const recreated = logs
			.filter((line) => line.includes('Debug: (re)Creating index'))
			.filter(
				(line) =>
					line.includes(`'${objectFormIndex}'`) ||
					line.includes(`'${arrayFormIndex}'`) ||
					line.includes(`'${explicitPrefixIndex}'`) ||
					line.includes(`'${btreeIndex}'`),
			);
		expect(recreated).to.deep.equal([]);
	});
});

// The errno-1170 guard (see test/schemaSync.textColumnReindex.test.js) drops any
// PREFIX-LESS index on a column that is about to become TEXT, because MySQL will
// not allow a prefix-less key on a TEXT column. A FULLTEXT index is always
// prefix-less, so it matched that guard -- but FULLTEXT never triggers 1170 in the
// first place, since it indexes the whole column. Dropping it bought nothing and
// cost exactly the metadata-locked FULLTEXT rebuild this changeset exists to stop.
describe('#schemaSync errno-1170 guard leaves FULLTEXT indexes alone', () => {
	const tableName = `yass_fulltext_1170_${uuid().replace(/-/g, '')}`;
	const fulltextIndex = 'idx_notes_fulltext';

	// v1: FULLTEXT on a varchar column (legal, and prefix-less)
	const varcharSchema = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey, notes: t.string },
		options: {
			indexes: { [fulltextIndex]: { fulltext: true, cols: ['notes'] } },
		},
	});

	// v2: same FULLTEXT index, but the column becomes longtext
	const textSchema = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey, notes: t.text },
		options: {
			indexes: { [fulltextIndex]: { fulltext: true, cols: ['notes'] } },
		},
	});

	before(function beforeGuardSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	after(async () => {
		if ((config.dialect || 'mysql') !== 'mysql') {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('does not drop a FULLTEXT index when its column changes to TEXT', async () => {
		await syncSchemaToDb(YassORM.convertDefinition(varcharSchema));

		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
			origLog(...args);
		};

		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(textSchema));
		} finally {
			console.log = origLog;
		}

		// The column change itself must still succeed (no errno 1170).
		expect(result.errors).to.deep.equal([]);

		const guardDrops = logs.filter((line) =>
			line.includes('Dropping prefix-less index'),
		);
		expect(
			guardDrops.filter((line) => line.includes(fulltextIndex)),
		).to.deep.equal([]);

		const conn = await dbh({ ignoreCachedConnections: true });
		const [col] = await conn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = 'notes'`,
		);
		const rows = await conn.pquery(`SHOW INDEXES FROM \`${tableName}\``);
		await conn.end();

		// Column really did flip to longtext, and the FULLTEXT index survived intact.
		expect(col.Type.toLowerCase()).to.match(/text/);
		const ftRow = rows.find((row) => row.Key_name === fulltextIndex);
		expect(ftRow, `${fulltextIndex} should still exist`).to.not.equal(
			undefined,
		);
		expect(ftRow.Index_type).to.equal('FULLTEXT');
		expect(ftRow.Sub_part).to.equal(null);
	});
});

// `textSearchConfig` is a POSTGRES concept (it selects stemming/stopword rules for
// to_tsvector). It is a natural thing to leave in a schema def shared across
// dialects -- and gating it on `isFullText` alone put the key into the DESIRED
// signature on MySQL too, where introspection can never report one. Result: every
// MySQL FULLTEXT index carrying that key was dropped and rebuilt on EVERY sync,
// under the same metadata lock this file exists to prevent. Confirmed red before the
// fix: this index rebuilt once per sync.
describe('#schemaSync MySQL ignores Postgres-only textSearchConfig', () => {
	const tableName = `yass_ts_ignore_${uuid().replace(/-/g, '')}`;
	const indexName = 'idx_body_ft';

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey, body: t.text },
		options: {
			indexes: {
				[indexName]: {
					fulltext: true,
					cols: ['body'],
					// Meaningless on MySQL -- and must stay harmless.
					textSearchConfig: 'english',
				},
			},
		},
	});

	before(async function beforeTsIgnoreSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
			return;
		}
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		if ((config.dialect || 'mysql') !== 'mysql') {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('does not rebuild the index on a second sync', async () => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => logs.push(args.join(' '));
		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.log = origLog;
		}

		expect(result.errors).to.deep.equal([]);
		expect(
			logs.filter(
				(l) => l.includes('(re)Creating index') && l.includes(indexName),
			),
		).to.deep.equal([]);
	});
});
