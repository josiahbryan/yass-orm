/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// MySQL/MariaDB have NO partial-index syntax -- verified against MySQL 8.4.2:
//   CREATE INDEX i ON t (status) WHERE isDeleted = 0
//   -> "You have an error in your SQL syntax ... near 'WHERE'"
//
// So a schema that declares `where` has to be handled, and the right handling
// differs by whether the index is UNIQUE:
//
//   * NON-UNIQUE: degrade to a FULL index. It covers a superset of the requested
//     rows, so every query the partial index would have served still returns
//     CORRECT results -- it just costs more space. Dropping the index outright
//     would be the bigger regression (a silent performance cliff).
//
//   * UNIQUE: must NEVER degrade. `unique: true` + `where: 'isDeleted = 0'` is the
//     standard "unique among live rows" pattern. As a FULL unique index it would
//     REJECT rows the predicate was meant to exclude -- e.g. a second soft-deleted
//     row with the same email would fail to insert. That is silent data rejection,
//     so the index is skipped and the operator told why.

describe('#schemaSync partial indexes on MySQL (degradation rules)', () => {
	const tableName = `yass_partial_${uuid().replace(/-/g, '')}`;

	before(function beforeMysqlPartialSuite() {
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

	const capture = async (schemaDef) => {
		const warnings = [];
		const errors = [];
		const origWarn = console.warn;
		const origError = console.error;
		console.warn = (...args) => warnings.push(args.join(' '));
		console.error = (...args) => errors.push(args.join(' '));
		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.warn = origWarn;
			console.error = origError;
		}
		return { result, warnings, errors };
	};

	it('degrades a NON-UNIQUE partial index to a full index, with a warning', async () => {
		const schemaDef = ({ types: t }) => ({
			table: tableName,
			schema: { id: t.idKey, status: t.string, email: t.string },
			options: {
				indexes: {
					idx_live: { cols: ['status'], where: 'isDeleted = 0' },
				},
			},
		});

		const { result, warnings } = await capture(schemaDef);
		expect(result.errors).to.deep.equal([]);

		expect(
			warnings.filter(
				(w) =>
					w.includes("Index 'idx_live'") &&
					w.includes('does not support') &&
					w.includes('FULL index'),
			),
		).to.have.lengthOf(1);

		// The index must actually exist, and carry no predicate.
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SHOW INDEXES FROM \`${tableName}\` WHERE Key_name = 'idx_live'`,
		);
		await conn.end();
		expect(rows.length).to.equal(1);
		expect(rows[0].Column_name).to.equal('status');
	});

	it('is idempotent after degrading (the predicate must not cause churn)', async () => {
		const schemaDef = ({ types: t }) => ({
			table: tableName,
			schema: { id: t.idKey, status: t.string, email: t.string },
			options: {
				indexes: {
					idx_live: { cols: ['status'], where: 'isDeleted = 0' },
				},
			},
		});

		const logs = [];
		const origLog = console.log;
		const origWarn = console.warn;
		console.log = (...args) => logs.push(args.join(' '));
		console.warn = () => {};
		try {
			await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		} finally {
			console.log = origLog;
			console.warn = origWarn;
		}

		// The desired signature must drop the predicate too, or this index would be
		// dropped and recreated forever -- the bug class this work exists to kill.
		expect(
			logs.filter(
				(l) => l.includes('(re)Creating index') && l.includes('idx_live'),
			),
		).to.deep.equal([]);
	});

	// The RAW-SQL index-spec path (`cols` given as a parenthesized SQL string)
	// silently dropped `where` on the floor: no predicate in the DDL, and no warning,
	// so the author believed they had a partial index and did not. On MySQL, which
	// cannot express one at all, the least-surprising behavior is to say so.
	it('warns instead of silently dropping `where` on a raw-SQL index spec', async () => {
		const rawTable = `${tableName}_raw`;
		const schemaDef = ({ types: t }) => ({
			table: rawTable,
			schema: { id: t.idKey, status: t.string },
			options: {
				indexes: {
					idx_raw: { cols: '(status)', where: 'isDeleted = 0' },
				},
			},
		});

		const { result, warnings } = await capture(schemaDef);
		expect(result.errors).to.deep.equal([]);
		expect(
			warnings.filter(
				(w) =>
					w.includes("Raw-SQL index 'idx_raw'") &&
					w.includes('does not') &&
					w.includes('FULL index'),
			),
		).to.have.lengthOf(1);

		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SHOW INDEXES FROM \`${rawTable}\` WHERE Key_name = 'idx_raw'`,
		);
		await conn.pquery(`DROP TABLE IF EXISTS \`${rawTable}\``);
		await conn.end();
		// Still created (as a full index) -- the warning is the signal, not silence.
		expect(rows.length).to.equal(1);
	});

	it('SKIPS a UNIQUE partial index rather than wrongly rejecting rows', async () => {
		const uniqueTable = `${tableName}_u`;
		const schemaDef = ({ types: t }) => ({
			table: uniqueTable,
			schema: { id: t.idKey, email: t.string },
			options: {
				indexes: {
					idx_email_live: {
						cols: ['email'],
						unique: true,
						where: 'isDeleted = 0',
					},
				},
			},
		});

		const { errors } = await capture(schemaDef);

		expect(
			errors.filter(
				(e) =>
					e.includes("Skipping UNIQUE partial index 'idx_email_live'") &&
					e.includes('wrongly reject rows'),
			),
		).to.have.lengthOf(1);

		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(
			`SHOW INDEXES FROM \`${uniqueTable}\` WHERE Key_name = 'idx_email_live'`,
		);
		await conn.pquery(`DROP TABLE IF EXISTS \`${uniqueTable}\``);
		await conn.end();

		// Critically: NOT created. A full UNIQUE index here would reject a second
		// soft-deleted row with the same email.
		expect(rows.length).to.equal(0);
	});
});
