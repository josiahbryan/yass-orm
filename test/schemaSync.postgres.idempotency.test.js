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

	// Postgres index names live in ONE namespace per schema rather than being
	// scoped to their table, so schema-sync prefixes the declared name with the
	// table name. The schema keeps saying `idx_pg_body_ft`; the catalog reports
	// `<table>_idx_pg_body_ft`.
	const phys = (name) => `${tableName}_${name}`;

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

		expect(byName[phys(ftIndex)]).to.match(/USING gin/i);
		expect(byName[phys(ftIndex)]).to.include('to_tsvector');
		// Multi-column concatenation must have parsed at all (it was a syntax error)
		expect(byName[phys(ftMultiIndex)]).to.include('||');
		// varchar source column picks up the (col)::text cast
		expect(byName[phys(ftVarcharIndex)]).to.include('::text');
		expect(byName[phys(btreeIndex)]).to.match(/USING btree/i);
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
		expect(byName[phys(ftIndex)].type).to.equal('FULLTEXT');
		expect(byName[phys(ftIndex)].columns).to.deep.equal(['body']);
		expect(byName[phys(ftMultiIndex)].type).to.equal('FULLTEXT');
		expect(byName[phys(ftMultiIndex)].columns).to.deep.equal(['title', 'body']);
		expect(byName[phys(ftVarcharIndex)].columns).to.deep.equal(['notes']);
		expect(byName[phys(btreeIndex)].type).to.equal('BTREE');
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
					// Explicit nested grouping, and an UNPARENTHESIZED mixed AND/OR whose
					// precedence Postgres reports back parenthesized. Both are only
					// idempotent because predicates are compared through a real SQL AST:
					// the text-normalizing version could not see grouping at all, and the
					// parser's own left-associative chaining gets the precedence wrong
					// until reassociateBooleans() repairs it.
					[ix('idx_grouped')]: {
						cols: ['email'],
						where: '"isDeleted" = false AND (status IS NULL OR id > 5)',
					},
					[ix('idx_precedence')]: {
						cols: ['id'],
						where: '"isDeleted" = false AND status IS NULL OR id > 5',
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
		// Postgres reports these with its own parenthesization; the AST comparison is
		// what keeps them from rebuilding every sync.
		expect(byName[ix('idx_grouped')]).to.match(/OR/i);
		expect(byName[ix('idx_precedence')]).to.match(/OR/i);
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

// Postgres index names live in ONE namespace per schema, not per table (an index is
// a relation in pg_class). Two tables both declaring `idx_status` therefore
// collided outright -- `relation "idx_status" already exists` -- and since that is
// exactly the name people reuse, a schema that worked on MySQL broke here. These
// run against the live server because the collision is a server behavior.
describe('#schemaSync Postgres index-name scoping (live)', () => {
	const tableA = `pg_scope_a_${uuid().replace(/-/g, '')}`;
	const tableB = `pg_scope_b_${uuid().replace(/-/g, '')}`;

	// BOTH tables declare the SAME index name on purpose.
	const schemaFor =
		(table) =>
		({ types: t }) => ({
			table,
			schema: { id: t.idKey, status: t.string },
			options: { indexes: { idx_status: ['status'] } },
		});

	const syncBoth = async () => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => logs.push(args.join(' '));
		let a;
		let b;
		try {
			a = await syncSchemaToDb(YassORM.convertDefinition(schemaFor(tableA)));
			b = await syncSchemaToDb(YassORM.convertDefinition(schemaFor(tableB)));
		} finally {
			console.log = origLog;
		}
		return {
			errors: [...a.errors, ...b.errors],
			created: logs.filter((l) => l.includes('(re)Creating index')),
			dropped: logs.filter((l) => l.includes('removed:')),
		};
	};

	const indexesOf = async (table) => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SELECT i.relname AS idx FROM pg_index ix
			 JOIN pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_class t ON t.oid = ix.indrelid
			 WHERE t.relname = $1 AND i.relname NOT LIKE '%pkey'`,
			[table],
		);
		await conn.end();
		return rows.map((r) => r.idx);
	};

	before(async function beforeScopeSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableA}"`);
		await conn.pquery(`DROP TABLE IF EXISTS "${tableB}"`);
		await conn.end();
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableA}"`);
		await conn.pquery(`DROP TABLE IF EXISTS "${tableB}"`);
		await conn.end();
	});

	it('lets two tables declare the SAME index name without colliding', async () => {
		const { errors } = await syncBoth();
		// Before prefixing, the second table failed with
		// `relation "idx_status" already exists`.
		expect(errors).to.deep.equal([]);

		expect(await indexesOf(tableA)).to.include(`${tableA}_idx_status`);
		expect(await indexesOf(tableB)).to.include(`${tableB}_idx_status`);
	});

	it('is idempotent -- no churn, and the stale sweep does not eat the prefixed index', async () => {
		// The stale-index sweep drops any index not declared by the schema. It has to
		// compare PHYSICAL names: comparing the raw schema keys would find no match for
		// `<table>_idx_status` and drop every index the same sync had just created.
		const first = await syncBoth();
		expect(first.created).to.deep.equal([]);
		expect(first.dropped).to.deep.equal([]);

		const second = await syncBoth();
		expect(second.created).to.deep.equal([]);
		expect(second.dropped).to.deep.equal([]);

		expect(await indexesOf(tableA)).to.include(`${tableA}_idx_status`);
	});

	it('migrates a pre-existing bare-named index in ONE pass, then settles', async () => {
		// A Postgres database created before prefixing has `idx_bare`. The sweep drops
		// the undeclared bare name while the prefixed one is created -- once.
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`CREATE INDEX "idx_bare" ON "${tableA}" ("status")`);
		await conn.end();

		const schemaWithBare = ({ types: t }) => ({
			table: tableA,
			schema: { id: t.idKey, status: t.string },
			options: { indexes: { idx_status: ['status'], idx_bare: ['status'] } },
		});

		const runOnce = async () => {
			const logs = [];
			const origLog = console.log;
			console.log = (...args) => logs.push(args.join(' '));
			let result;
			try {
				result = await syncSchemaToDb(
					YassORM.convertDefinition(schemaWithBare),
				);
			} finally {
				console.log = origLog;
			}
			return {
				errors: result.errors,
				created: logs.filter((l) => l.includes('(re)Creating index')),
				dropped: logs.filter((l) => l.includes('removed:')),
			};
		};

		const migration = await runOnce();
		expect(migration.errors).to.deep.equal([]);
		// The bare name is dropped and the prefixed one created.
		expect(migration.dropped.join(' ')).to.include('idx_bare');
		expect(migration.created.join(' ')).to.include(`${tableA}_idx_bare`);

		// ...and it settles immediately: no recurring churn.
		const after = await runOnce();
		expect(after.created).to.deep.equal([]);
		expect(after.dropped).to.deep.equal([]);
	});
});

// The text-search configuration selects the language's stemming/stopword rules, so
// it is a real schema decision -- it used to be hardcoded to 'english'. Detecting a
// CHANGE to it matters: the column list and flags stay identical when you switch
// languages, so without reading the config back off the index the old one would sit
// there silently serving the wrong language forever.
describe('#schemaSync Postgres text-search config (live)', () => {
	const tableName = `pg_tscfg_${uuid().replace(/-/g, '')}`;
	const indexName = 'idx_ts';

	const schemaFor =
		(textSearchConfig) =>
		({ types: t }) => ({
			table: tableName,
			schema: { id: t.idKey, body: t.text },
			options: {
				indexes: {
					[indexName]: textSearchConfig
						? { fulltext: true, cols: ['body'], textSearchConfig }
						: { fulltext: true, cols: ['body'] },
				},
			},
		});

	const sync = async (textSearchConfig) => {
		const logs = [];
		const origLog = console.log;
		console.log = (...args) => logs.push(args.join(' '));
		let result;
		try {
			result = await syncSchemaToDb(
				YassORM.convertDefinition(schemaFor(textSearchConfig)),
			);
		} finally {
			console.log = origLog;
		}
		return {
			errors: result.errors,
			built: logs.filter(
				(l) => l.includes('(re)Creating index') && l.includes(indexName),
			),
		};
	};

	const configOf = async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SELECT pg_get_indexdef(ix.indexrelid) AS def FROM pg_index ix
			 JOIN pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_class t ON t.oid = ix.indrelid
			 WHERE t.relname = $1 AND i.relname LIKE $2`,
			[tableName, `%${indexName}`],
		);
		await conn.end();
		const match = `${(rows[0] || {}).def || ''}`.match(
			/to_tsvector\(\s*'([^']+)'/,
		);
		return match ? match[1] : undefined;
	};

	before(async function beforeTsCfgSuite() {
		if (!isPostgres()) {
			this.skip();
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
	});

	after(async () => {
		if (!isPostgres()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
	});

	it("defaults to 'english' and does not churn", async () => {
		const created = await sync(undefined);
		expect(created.errors).to.deep.equal([]);
		expect(created.built).to.have.lengthOf(1);
		expect(await configOf()).to.equal('english');

		const again = await sync(undefined);
		expect(again.built).to.deep.equal([]);
	});

	it('rebuilds the index when the config CHANGES, then settles', async () => {
		const switched = await sync('spanish');
		expect(switched.errors).to.deep.equal([]);
		expect(switched.built).to.have.lengthOf(1);
		expect(await configOf()).to.equal('spanish');

		// Settles immediately -- a changed config must not mean perpetual churn.
		const again = await sync('spanish');
		expect(again.built).to.deep.equal([]);
		expect(await configOf()).to.equal('spanish');
	});

	it('switches back, proving detection works in both directions', async () => {
		const back = await sync('english');
		expect(back.built).to.have.lengthOf(1);
		expect(await configOf()).to.equal('english');
		expect((await sync('english')).built).to.deep.equal([]);
	});
});
