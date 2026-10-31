/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

// BDL-4421 live-engine proof. Schema-sync states the online level on every
// CREATE INDEX it emits, so MySQL fails fast instead of silently picking a
// table-copy / blocking path:
//
//   plain, UNIQUE, prefix, DESC     -> ALGORITHM=INPLACE LOCK=NONE
//   FULLTEXT                        -> ALGORITHM=INPLACE LOCK=SHARED
//   JSON functional / multi-valued  -> LOCK=SHARED (no ALGORITHM: MySQL rejects
//                                      INPLACE with ERROR 1846 when recreating
//                                      a functional index on a table that
//                                      already holds one)
//
// This suite runs every shape through the real engine. The red arm forces
// LOCK=NONE onto a FULLTEXT index and asserts the engine's rejection reaches
// the returned errors. The large-table arm proves the size warning never
// blocks the create.

const isMysql = () => (config.dialect || 'mysql') === 'mysql';

const CREATE_MARKER = '(re)Creating index';

function captureConsole(method) {
	const captured = [];
	const original = console[method];
	console[method] = (...args) => {
		captured.push(args.map((a) => `${a}`).join(' '));
	};
	return {
		captured,
		restore() {
			console[method] = original;
		},
	};
}

async function showIndexNames(tableName) {
	const conn = await dbh({ ignoreCachedConnections: true });
	try {
		const rows = await conn.pquery(`SHOW INDEXES FROM \`${tableName}\``);
		return new Set(rows.map((r) => r.Key_name));
	} finally {
		await conn.end();
	}
}

const errorText = (e) =>
	String((e && e.error && (e.error.sqlMessage || e.error.message)) || e.error);

describe('#schemaSync online index DDL on live MySQL (BDL-4421)', () => {
	const suffix = uuid().replace(/-/g, '');
	const shapesTable = `yass_online_${suffix}`;
	const redTable = `yass_online_red_${suffix}`;
	const largeTable = `yass_online_large_${suffix}`;
	const tables = [shapesTable, redTable, largeTable];

	const SHAPES = {
		idx_plain: 'LOCK=NONE',
		idx_unique: 'LOCK=NONE',
		idx_prefix: 'LOCK=NONE',
		idx_desc: 'LOCK=NONE',
		idx_fulltext: 'FULLTEXT',
		idx_json: 'EXPR',
		idx_mv: 'EXPR',
		idx_mv_raw: 'EXPR',
	};

	const shapesDef = ({ types: t }) => ({
		table: shapesTable,
		schema: {
			id: t.idKey,
			slug: t.string,
			email: t.string,
			title: t.string,
			body: t.text,
			createdAt: t.datetime,
			meta: t.text,
			// Mirrors matm-user-profile `tags: t.array(t.string)` + its raw
			// multi-valued index `((CAST(tags as CHAR(255) ARRAY)))`.
			tags: t.array(t.string),
		},
		options: {
			indexes: {
				idx_plain: ['slug'],
				idx_unique: { cols: ['email'], unique: true },
				idx_prefix: '(body(255))',
				idx_desc: ['createdAt DESC'],
				idx_fulltext: { fulltext: true, cols: ['title', 'body'] },
				idx_json: ['meta->>"$.k"'],
				idx_mv: {
					multiValued: true,
					col: 'meta',
					path: '$.tags[*]',
					cast: 'unsigned',
				},
				idx_mv_raw: '((CAST(tags as CHAR(255) ARRAY)))',
			},
		},
	});

	let firstSync;
	let createLines = [];

	before(async function beforeOnlineDdlSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		const cap = captureConsole('log');
		try {
			firstSync = await syncSchemaToDb(YassORM.convertDefinition(shapesDef));
		} finally {
			cap.restore();
		}
		createLines = cap.captured.filter((line) => line.includes(CREATE_MARKER));
	});

	after(async () => {
		if (!isMysql()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await Promise.all(
				tables.map((t) => conn.pquery(`DROP TABLE IF EXISTS \`${t}\``)),
			);
		} finally {
			await conn.end();
		}
	});

	it('creates all 8 index shapes with no errors', async () => {
		expect(
			firstSync.errors,
			JSON.stringify(firstSync.errors.map(errorText)),
		).to.have.length(0);
		const names = await showIndexNames(shapesTable);
		Object.keys(SHAPES).forEach((name) => {
			expect([...names], `missing ${name}`).to.include(name);
		});
	});

	it('emits every CREATE INDEX under its online clause', () => {
		Object.entries(SHAPES).forEach(([name, kind]) => {
			const line = createLines.find((l) => l.includes(`'${name}'`));
			expect(line, `no (re)Creating index line for ${name}`).to.be.a('string');
			const sql = line.trim();
			if (kind === 'LOCK=NONE') {
				expect(sql, name).to.match(/ ALGORITHM=INPLACE LOCK=NONE$/);
			} else if (kind === 'FULLTEXT') {
				expect(sql, name).to.match(/ ALGORITHM=INPLACE LOCK=SHARED$/);
			} else {
				expect(sql, name).to.match(/ LOCK=SHARED$/);
				expect(sql, name).to.not.include('ALGORITHM');
			}
		});
		// Every captured CREATE ends in a LOCK clause; none escaped.
		createLines.forEach((line) => {
			expect(line.trim()).to.match(/LOCK=(NONE|SHARED)$/);
		});
	});

	it('a second sync of the same def is a no-op: 0 errors, no (re)Creating index lines', async () => {
		const cap = captureConsole('log');
		let second;
		try {
			second = await syncSchemaToDb(YassORM.convertDefinition(shapesDef));
		} finally {
			cap.restore();
		}
		expect(
			second.errors,
			JSON.stringify(second.errors.map(errorText)),
		).to.have.length(0);
		expect(
			cap.captured.filter((line) => line.includes(CREATE_MARKER)),
			'index churn on re-sync',
		).to.have.length(0);
	});

	it('the real estimateTableSize runs against the live engine', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		let size;
		try {
			size = await new MySQLDialect().estimateTableSize(conn, shapesTable);
		} finally {
			await conn.end();
		}
		expect(size).to.be.an('object');
		[size.rows, size.bytes].forEach((v) => {
			expect(v === null || typeof v === 'number', String(v)).to.equal(true);
		});
		expect(size.bytes).to.be.a('number');
		expect(size.bytes).to.be.greaterThan(0);
	});

	it('red arm: an engine rejection of the clause surfaces in errors (FULLTEXT under LOCK=NONE)', async () => {
		const redDef = ({ types: t }) => ({
			table: redTable,
			schema: { id: t.idKey, title: t.string, body: t.text },
			options: {
				indexes: { idx_red_ft: { fulltext: true, cols: ['title', 'body'] } },
			},
		});

		const proto = MySQLDialect.prototype;
		const original = proto.onlineIndexClause;
		expect(original, 'onlineIndexClause must exist').to.be.a('function');
		const err = captureConsole('error');
		let forced;
		try {
			proto.onlineIndexClause = () => ' ALGORITHM=INPLACE LOCK=NONE';
			forced = await syncSchemaToDb(YassORM.convertDefinition(redDef));
		} finally {
			proto.onlineIndexClause = original;
			err.restore();
		}
		expect(
			forced.errors.some((e) =>
				/LOCK=NONE is not supported|requires a lock/i.test(errorText(e)),
			),
			JSON.stringify(forced.errors.map(errorText)),
		).to.equal(true);
		expect([...(await showIndexNames(redTable))]).to.not.include('idx_red_ft');

		// Restored: the same index now creates cleanly.
		const healed = await syncSchemaToDb(YassORM.convertDefinition(redDef));
		expect(
			healed.errors,
			JSON.stringify(healed.errors.map(errorText)),
		).to.have.length(0);
		expect([...(await showIndexNames(redTable))]).to.include('idx_red_ft');
	});

	it('large-table warning is emitted and never blocks the create', async () => {
		const baseDef = ({ types: t }) => ({
			table: largeTable,
			schema: { id: t.idKey, slug: t.string },
		});
		const withIndexDef = ({ types: t }) => ({
			table: largeTable,
			schema: { id: t.idKey, slug: t.string },
			options: { indexes: { idx_large_slug: ['slug'] } },
		});
		await syncSchemaToDb(YassORM.convertDefinition(baseDef));

		const proto = MySQLDialect.prototype;
		const original = proto.estimateTableSize;
		expect(original, 'estimateTableSize must exist').to.be.a('function');
		const warn = captureConsole('warn');
		let result;
		try {
			proto.estimateTableSize = async () => ({ rows: 5e6, bytes: 0 });
			result = await syncSchemaToDb(YassORM.convertDefinition(withIndexDef));
		} finally {
			proto.estimateTableSize = original;
			warn.restore();
		}
		expect(
			warn.captured.some(
				(w) => w.includes('LARGE INDEX BUILD') && w.includes(largeTable),
			),
			JSON.stringify(warn.captured),
		).to.equal(true);
		expect(result.errors).to.have.length(0);
		expect([...(await showIndexNames(largeTable))]).to.include(
			'idx_large_slug',
		);
	});
});
