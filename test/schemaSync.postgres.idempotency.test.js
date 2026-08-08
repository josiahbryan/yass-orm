/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh, getDialect } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// End-to-end Postgres schema-sync coverage. SKIPPED unless the active dialect is
// postgres, so it is inert during the normal MySQL run:
//
//   YASS_CONFIG=$PWD/.yass-orm.postgres.js npm run test:postgres
//
// This is the test that could not be written when the FULLTEXT signature fix
// landed (2.1.2) -- there was no Postgres server to run it against, so that fix
// shipped verified only against canned `pg_get_indexdef()` strings. Running it
// for the first time surfaced a stack of latent Postgres bugs, every one of them
// a case of schema-sync emitting DDL on a schema that had not changed:
//
//   * `mapType()` had no identity entries for its own native types, so the
//     `|| 'TEXT'` fallback rewrote the resolved `SERIAL`/`UUID` key type to TEXT
//     -- no Postgres table ever got a working primary key.
//   * `t.bool` carries `default: 0` (a JS number); Postgres rejects an integer
//     default on a boolean column, so CREATE TABLE failed outright for any schema
//     with the standard `isDeleted` commonField.
//   * `t.string` converts to a bare `varchar`, which fell through to TEXT.
//   * `ALTER COLUMN ... TYPE SERIAL` is invalid (SERIAL is CREATE-time shorthand).
//   * `getTableColumns` hardcoded `primaryKey: false` and omitted column lengths.
//   * The column diff read Postgres' information_schema row as though it were a
//     MySQL `SHOW COLUMNS` row, so every column compared unequal against
//     `undefined` and was reported CHANGED on every sync.
//
// Contract: syncing an unchanged schema a second time must emit NO DDL at all --
// no column ALTER, no index drop, no index create -- and no errors.

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

describe('#schemaSync Postgres end-to-end idempotency', () => {
	const tableName = `pg_idem_${uuid().replace(/-/g, '')}`;
	const ftIndex = 'idx_pg_body_ft';
	const ftMultiIndex = 'idx_pg_title_body_ft';
	const ftVarcharIndex = 'idx_pg_notes_ft';
	const btreeIndex = 'idx_pg_slug';

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			body: t.text,
			title: t.text,
			notes: t.string,
			slug: t.text,
			count: t.int,
			score: t.real,
			flag: t.bool,
		},
		options: {
			indexes: {
				[ftIndex]: { fulltext: true, cols: ['body'] },
				[ftMultiIndex]: { fulltext: true, cols: ['title', 'body'] },
				[ftVarcharIndex]: { fulltext: true, cols: ['notes'] },
				[btreeIndex]: ['slug'],
			},
		},
	});

	before(async function beforePgSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
	});

	it('creates the table with correct native Postgres types', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const cols = await conn.pquery(
			`SELECT column_name, data_type, column_default, is_nullable
			 FROM information_schema.columns WHERE table_name = $1`,
			[tableName],
		);
		await conn.end();

		const byName = {};
		cols.forEach((c) => {
			byName[c.column_name] = c;
		});

		// SERIAL primary key -- an integer backed by a sequence, NOT text
		expect(byName.id.data_type).to.equal('integer');
		expect(byName.id.column_default).to.match(/^nextval\(/);

		// t.string -> VARCHAR(255), not TEXT
		expect(byName.notes.data_type).to.equal('character varying');

		// t.bool -> boolean with a REAL boolean default
		expect(byName.flag.data_type).to.equal('boolean');
		expect(byName.flag.column_default).to.equal('false');
		expect(byName.isDeleted.data_type).to.equal('boolean');
		expect(byName.isDeleted.column_default).to.equal('false');

		expect(byName.body.data_type).to.equal('text');
		expect(byName.count.data_type).to.equal('integer');
		expect(byName.score.data_type).to.equal('double precision');
	});

	it('creates FULLTEXT indexes as GIN over to_tsvector', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SELECT i.relname AS idx, pg_get_indexdef(ix.indexrelid) AS def
			 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relname = $1`,
			[tableName],
		);
		await conn.end();

		const byName = {};
		rows.forEach((r) => {
			byName[r.idx] = r.def;
		});

		expect(byName[ftIndex]).to.match(/USING gin/i);
		expect(byName[ftIndex]).to.include('to_tsvector');
		// Multi-column concatenation must have parsed at all (it was a syntax error)
		expect(byName[ftMultiIndex]).to.include('||');
		// varchar source column picks up the (col)::text cast
		expect(byName[ftVarcharIndex]).to.include('::text');
		expect(byName[btreeIndex]).to.match(/USING btree/i);
	});

	it('reports its own FULLTEXT indexes back as FULLTEXT', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const dialect = getDialect('postgres');
		const indexes = await dialect.getTableIndexes(conn, tableName);
		await conn.end();

		const byName = {};
		indexes.forEach((i) => {
			byName[i.name] = i;
		});

		// This is the comparison that made every sync rebuild the index: `type` was
		// never set, so an existing FULLTEXT index always read as fulltext:false.
		expect(byName[ftIndex].type).to.equal('FULLTEXT');
		expect(byName[ftIndex].columns).to.deep.equal(['body']);
		expect(byName[ftMultiIndex].type).to.equal('FULLTEXT');
		expect(byName[ftMultiIndex].columns).to.deep.equal(['title', 'body']);
		expect(byName[ftVarcharIndex].columns).to.deep.equal(['notes']);
		expect(byName[btreeIndex].type).to.equal('BTREE');
	});

	it('emits NO DDL on a second sync of the identical schema', async () => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
		};

		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.log = origLog;
		}

		expect(result.errors).to.deep.equal([]);

		const indexChurn = logs.filter(
			(line) =>
				line.includes('(re)Creating index') ||
				line.includes('Dropping prefix-less index'),
		);
		expect(indexChurn).to.deep.equal([]);

		// Any surviving column diff prints `Debug: k=<key>, a=<db>, b=<schema>`.
		const columnDiffs = logs.filter((line) => line.includes('Debug: k='));
		expect(columnDiffs).to.deep.equal([]);
	});
});

// Partial indexes and nested JSON paths against the live server. The unit-level
// coverage lives in test/schemaSync.partialIndex.test.js and
// lib/sql-transform/test/postgresJsonPath.test.js; this proves the round trip
// through a real catalog, which is the only way to know the predicate and
// expression normalizers actually match what Postgres reports back.
describe('#schemaSync Postgres partial indexes + nested JSON paths', () => {
	const tableName = `pg_partnest_${uuid().replace(/-/g, '')}`;

	// Postgres index names are unique per SCHEMA, not per table (unlike MySQL), so
	// scope them to this table or they collide with any other table's `idx_live`.
	const ix = (name) => `${tableName}_${name}`;

	const schemaFor =
		(statusPredicate) =>
		({ types: t }) => ({
			table: tableName,
			schema: {
				id: t.idKey,
				status: t.string,
				email: t.string,
				meta: t.object,
			},
			options: {
				indexes: {
					// Predicates are RAW dialect SQL, so a camelCase column must be quoted
					// by the author -- Postgres folds unquoted identifiers to lowercase.
					[ix('idx_live')]: { cols: ['status'], where: '"isDeleted" = false' },
					[ix('idx_notnull')]: { cols: ['email'], where: 'status IS NOT NULL' },
					[ix('idx_status')]: { cols: ['id'], where: statusPredicate },
					[ix('idx_in')]: { cols: ['email'], where: "status IN ('a','b')" },
					[ix('idx_like')]: { cols: ['id'], where: "email LIKE 'a%'" },
					[ix('idx_compound')]: {
						cols: ['status'],
						where: '"isDeleted" = false AND status IS NOT NULL',
					},
					// Nested JSON path -- needs the #>> operator, not ->>
					[ix('idx_json_deep')]: ["meta->>'$.a.b'"],
					[ix('idx_json_flat')]: ["meta->>'$.valence'"],
				},
			},
		});

	const syncAndCollect = async (statusPredicate) => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => logs.push(args.join(' '));
		let result;
		try {
			result = await syncSchemaToDb(
				YassORM.convertDefinition(schemaFor(statusPredicate)),
			);
		} finally {
			console.log = origLog;
		}
		return {
			result,
			built: logs
				.filter((l) => l.includes('(re)Creating index'))
				.map((l) => (l.match(/'([^']+)'/) || [])[1])
				// Strip the table scoping so assertions stay readable
				.map((n) => `${n}`.replace(`${tableName}_`, '')),
		};
	};

	before(async function beforePgPartialSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
		const { result } = await syncAndCollect("status = 'active'");
		expect(result.errors).to.deep.equal([]);
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
	});

	it('creates partial indexes with their WHERE clause', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SELECT i.relname AS idx, pg_get_indexdef(ix.indexrelid) AS def
			 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relname = $1`,
			[tableName],
		);
		await conn.end();
		const byName = {};
		rows.forEach((r) => {
			byName[r.idx] = r.def;
		});

		expect(byName[ix('idx_live')]).to.match(/WHERE/i);
		expect(byName[ix('idx_live')]).to.include('isDeleted');
		expect(byName[ix('idx_compound')]).to.match(/AND/i);
		// A non-partial index must not acquire a predicate
		expect(byName[ix('idx_json_flat')]).to.not.match(/WHERE/i);
	});

	it('creates nested JSON paths with the #>> path operator', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SELECT i.relname AS idx, pg_get_indexdef(ix.indexrelid) AS def
			 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relname = $1`,
			[tableName],
		);
		await conn.end();
		const byName = {};
		rows.forEach((r) => {
			byName[r.idx] = r.def;
		});

		// Nested: #>> with a text[] path. Previously this was ->> '$.a.b', a key
		// literally named "$.a.b" that no row can have.
		expect(byName[ix('idx_json_deep')]).to.include('#>>');
		expect(byName[ix('idx_json_deep')]).to.include("'{a,b}'");
		// Single-level stays on the plain key operator
		expect(byName[ix('idx_json_flat')]).to.include("->> 'valence'");
	});

	it('reads a nested JSON value back through the ORM', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`INSERT INTO "${tableName}" (meta) VALUES ('{"a":{"b":"deep-value"}}')`,
		);
		// Written MySQL-style; the transformer must turn this into #>>'{a,b}'
		const rows = await conn.pquery(
			`SELECT meta->>'$.a.b' AS v FROM "${tableName}" WHERE meta->>'$.a.b' IS NOT NULL`,
		);
		await conn.end();
		expect(rows.map((r) => r.v)).to.include('deep-value');
	});

	it('emits NO DDL when nothing changed', async () => {
		const { result, built } = await syncAndCollect("status = 'active'");
		expect(result.errors).to.deep.equal([]);
		// Every predicate spelling above must normalize equal to what Postgres
		// reports back, or these rebuild forever under a metadata lock.
		expect(built).to.deep.equal([]);
	});

	it('rebuilds ONLY the index whose predicate actually changed', async () => {
		const { result, built } = await syncAndCollect("status = 'archived'");
		expect(result.errors).to.deep.equal([]);
		expect(built).to.deep.equal(['idx_status']);

		// ...and settles immediately afterwards
		const { built: after } = await syncAndCollect("status = 'archived'");
		expect(after).to.deep.equal([]);
	});
});
