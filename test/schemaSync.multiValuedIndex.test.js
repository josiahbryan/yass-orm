/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh, getDialect } = require('../lib/dbh');
const {
	syncSchemaToDb,
	resolveMultiValuedIndexSpec,
	buildIndexSignature,
} = require('../lib/sync-to-db');
const {
	normalizeMySqlIndexExpression,
} = require('../lib/dialects/MySQLDialect');

// Regression test for the "multi-valued index rebuilds on every sync" bug.
//
// MySQL 8.0.17+ can index a JSON ARRAY column so it is searchable with a
// sargable MEMBER OF / JSON_CONTAINS instead of a full-scan LIKE:
//
//     ADD INDEX idx (( CAST(appRoles->'$[*]' AS CHAR(64) ARRAY) ))
//
// Writing that as a RAW index string appeared to work and was actively
// dangerous. MySQL reports the expression back as:
//
//     cast(json_extract(`appRoles`,_utf8mb4\'$[*]\') as char(64) array)
//
// and `normalizeMySqlIndexExpression` keyed on `json_extract(...)` ALONE, so it
// matched this shape and reduced it to `appRoles->>"$[*]"` -- silently dropping
// BOTH the trailing ` array` keyword and the cast type. Desired and introspected
// signatures could then never be equal, so schema-sync issued DROP INDEX +
// CREATE INDEX on EVERY run, and each rebuild holds a metadata lock that blocks
// every write to the table. MySQL accepts the mismatched DDL and discards the
// difference silently, so no error ever surfaces -- it just stalls a hot table
// forever. (Verified against MySQL 8.4.2: both `char(64)` and `decimal(10,2)`
// multi-valued indexes collapsed to the same `->>"$[*]"` string.)
//
// This is the FULLTEXT-prefix-length bug in a new costume; see
// test/schemaSync.fulltextIdempotency.test.js for that one.
//
// Contract: a multi-valued index declared in a schema def must round-trip, and a
// second sync of the identical schema must not touch it.

const isMysql = () => (config.dialect || 'mysql') === 'mysql';

describe('#schemaSync multi-valued (JSON array) index idempotency', () => {
	const tableName = `yass_mvidx_${uuid().replace(/-/g, '')}`;
	const charIndex = 'idx_approles';
	const numericIndex = 'idx_scores';
	const controlIndex = 'idx_slug_btree';

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			appRoles: t.text,
			scores: t.text,
			slug: t.text,
		},
		options: {
			indexes: {
				// The headline shape: a string array indexed as CHAR(64).
				[charIndex]: {
					multiValued: true,
					col: 'appRoles',
					path: '$[*]',
					cast: 'char(64)',
				},
				// A non-CHAR cast, which MySQL re-renders differently in the catalog
				// (`DECIMAL(10,2)` comes back as `decimal(10, 2)` -- note the space).
				[numericIndex]: {
					multiValued: true,
					col: 'scores',
					path: '$.values[*]',
					cast: 'decimal(10,2)',
				},
				// Control: an ordinary BTREE index on a TEXT column in the same table
				// still behaves exactly as before (implicit (255) prefix).
				[controlIndex]: ['slug'],
			},
		},
	});

	before(async function beforeMultiValuedSuite() {
		if (!isMysql()) {
			this.skip();
			return;
		}
		await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
	});

	after(async () => {
		if (!isMysql()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('creates real multi-valued indexes carrying the cast type and ARRAY keyword', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const rows = await conn.pquery(`SHOW INDEXES FROM \`${tableName}\``);
		await conn.end();

		const byName = {};
		rows.forEach((row) => {
			byName[row.Key_name] = row;
		});

		expect(Object.keys(byName)).to.include(charIndex);
		// Column_name is NULL for a functional index; the truth is in Expression.
		expect(byName[charIndex].Column_name).to.equal(null);
		expect(`${byName[charIndex].Expression}`.toLowerCase()).to.contain(
			'char(64)',
		);
		// The ` array` keyword is what makes it MULTI-VALUED rather than a plain
		// functional index. If this is absent the feature silently did nothing.
		expect(`${byName[charIndex].Expression}`.toLowerCase()).to.match(
			/\barray\b/,
		);

		expect(Object.keys(byName)).to.include(numericIndex);
		expect(`${byName[numericIndex].Expression}`.toLowerCase()).to.match(
			/decimal\(10,\s*2\).*\barray\b/,
		);

		// Control: the ordinary BTREE index is untouched by any of this.
		expect(Object.keys(byName)).to.include(controlIndex);
		expect(byName[controlIndex].Sub_part).to.equal(255);
	});

	it('round-trips: the introspected signature equals the desired signature', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		const indexes = await getDialect('mysql').getTableIndexes(conn, tableName);
		await conn.end();

		const introspected = {};
		indexes.forEach((idx) => {
			introspected[idx.name] = idx;
		});

		// This is the assertion the whole feature turns on. Before the fix the
		// introspected column read `appRoles->>"$[*]"` while the desired one read
		// `CAST(appRoles->'$[*]' AS CHAR(64) ARRAY)`, and no amount of syncing
		// could ever make them agree.
		const desiredChar = resolveMultiValuedIndexSpec({
			multiValued: true,
			col: 'appRoles',
			path: '$[*]',
			cast: 'char(64)',
		}).expression;

		expect(introspected[charIndex].columns).to.deep.equal([desiredChar]);

		expect(
			buildIndexSignature({
				columns: introspected[charIndex].columns,
				unique: false,
			}),
		).to.equal(buildIndexSignature({ columns: [desiredChar], unique: false }));

		const desiredNumeric = resolveMultiValuedIndexSpec({
			multiValued: true,
			col: 'scores',
			path: '$.values[*]',
			cast: 'decimal(10,2)',
		}).expression;
		expect(introspected[numericIndex].columns).to.deep.equal([desiredNumeric]);
	});

	// THE ACCEPTANCE TEST. Everything above describes the mechanism; this is the
	// property that actually matters, because the bug lives in the DISAGREEMENT
	// between what we generate and what MySQL reports back. A unit test over the
	// normalizer alone is structurally incapable of catching it.
	it('does not drop and recreate multi-valued indexes on a second sync', async () => {
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

		const recreated = logs
			.filter((line) => line.includes('Debug: (re)Creating index'))
			.filter(
				(line) =>
					line.includes(`'${charIndex}'`) ||
					line.includes(`'${numericIndex}'`) ||
					line.includes(`'${controlIndex}'`),
			);
		expect(
			recreated,
			`second sync must emit ZERO index DDL, got:\n${recreated.join('\n')}`,
		).to.deep.equal([]);
	});

	// A test that only ever asserts "nothing changed" can pass because the
	// comparison is broken open in the other direction -- always equal. This is
	// the positive control: a genuinely different index MUST still be detected.
	it('still rebuilds when the cast length actually changes (char(64) -> char(255))', async () => {
		const widened = ({ types: t }) => ({
			table: tableName,
			schema: {
				id: t.idKey,
				appRoles: t.text,
				scores: t.text,
				slug: t.text,
			},
			options: {
				indexes: {
					[charIndex]: {
						multiValued: true,
						col: 'appRoles',
						path: '$[*]',
						cast: 'char(255)',
					},
				},
			},
		});

		const logs = [];
		const origLog = console.log;
		console.log = (...args) => {
			logs.push(args.join(' '));
		};
		let result;
		try {
			result = await syncSchemaToDb(YassORM.convertDefinition(widened));
		} finally {
			console.log = origLog;
		}

		expect(result.errors).to.deep.equal([]);
		// char(64) and char(255) are DIFFERENT indexes -- the cast length is part
		// of the index identity, so this one must rebuild.
		expect(
			logs.filter(
				(l) => l.includes('(re)Creating index') && l.includes(`'${charIndex}'`),
			).length,
			'widening the cast length must be detected as a changed index',
		).to.equal(1);
	});
});

// Scope item 4: a def shared across dialects must still sync everywhere. On a
// dialect with no multi-valued index concept the index is OMITTED, not faked and
// not fatal -- the rest of the table syncs exactly as it would have. Runs live
// under `npm run test:postgres`.
describe('#schemaSync multi-valued index is skipped, not fatal, off MySQL', () => {
	const tableName = `yass_mvskip_${uuid().replace(/-/g, '')}`;

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: { id: t.idKey, appRoles: t.text, slug: t.string },
		options: {
			indexes: {
				idx_approles: {
					multiValued: true,
					col: 'appRoles',
					path: '$[*]',
					cast: 'char(64)',
				},
				// Must still be created: one unsupported index cannot take the table
				// down with it.
				idx_slug: ['slug'],
			},
		},
	});

	before(function beforeSkipSuite() {
		if (isMysql()) {
			this.skip();
		}
	});

	after(async () => {
		if (isMysql()) {
			return;
		}
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS "${tableName}"`);
		await conn.end();
	});

	it('syncs the table and its other indexes, omitting only the unsupported one', async () => {
		const result = await syncSchemaToDb(YassORM.convertDefinition(schemaDef));
		expect(result.errors).to.deep.equal([]);

		const indexes = await getDialect(config.dialect).getTableIndexes(
			await dbh({ ignoreCachedConnections: true }),
			tableName,
		);
		const names = indexes.map((i) => i.name);

		// The supported index is there...
		expect(names.join(',')).to.match(/idx_slug/);
		// ...and the multi-valued one was quietly omitted rather than mangled into
		// something that means something else.
		expect(names.join(',')).to.not.match(/idx_approles/);
	});

	it('emits no DDL on a second sync (the omission is stable, not churning)', async () => {
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
		expect(logs.filter((l) => l.includes('(re)Creating index'))).to.deep.equal(
			[],
		);
	});
});

// These need no database and run on every dialect.
describe('#schemaSync multi-valued index spec resolution', () => {
	it('is not multi-valued unless the flag is set', () => {
		expect(resolveMultiValuedIndexSpec(['email'])).to.equal(null);
		expect(resolveMultiValuedIndexSpec({ cols: ['email'] })).to.equal(null);
		expect(resolveMultiValuedIndexSpec('(a, b)')).to.equal(null);
		expect(resolveMultiValuedIndexSpec(undefined)).to.equal(null);
	});

	it('defaults the path to $[*] and canonicalizes the cast', () => {
		expect(
			resolveMultiValuedIndexSpec({
				multiValued: true,
				col: 'appRoles',
				cast: 'char(64)',
			}).expression,
		).to.equal(`CAST(appRoles->'$[*]' AS CHAR(64) ARRAY)`);

		// MySQL reports DECIMAL(10,2) back as `decimal(10, 2)`; both spellings must
		// canonicalize identically or the index churns forever.
		expect(
			resolveMultiValuedIndexSpec({
				multiValued: true,
				col: 'scores',
				cast: 'DECIMAL(10, 2)',
			}).expression,
		).to.equal(`CAST(scores->'$[*]' AS DECIMAL(10,2) ARRAY)`);
	});

	it('accepts cols/columns as an alias for col', () => {
		expect(
			resolveMultiValuedIndexSpec({
				multiValued: true,
				cols: ['appRoles'],
				cast: 'char(64)',
			}).expression,
		).to.equal(`CAST(appRoles->'$[*]' AS CHAR(64) ARRAY)`);
	});

	// `cast` has no default ON PURPOSE: char(64) and char(255) are different
	// indexes, so a guessed default would either build an index nobody asked for
	// or permanently disagree with a hand-written one.
	it('refuses a spec with no cast, rather than guessing one', () => {
		expect(() =>
			resolveMultiValuedIndexSpec({ multiValued: true, col: 'appRoles' }),
		).to.throw(/missing 'cast'/);
	});

	it('refuses a spec with no column', () => {
		expect(() =>
			resolveMultiValuedIndexSpec({ multiValued: true, cast: 'char(64)' }),
		).to.throw(/missing 'col'/);
	});
});

// The normalizer is where the two sides meet, so its multi-valued branch must
// not be reachable by the single-value branch and vice versa.
describe('#MySQLDialect normalizeMySqlIndexExpression multi-valued handling', () => {
	it('round-trips the multi-valued form MySQL actually reports', () => {
		expect(
			normalizeMySqlIndexExpression(
				"cast(json_extract(`appRoles`,_utf8mb4\\'$[*]\\') as char(64) array)",
			),
		).to.equal(`CAST(appRoles->'$[*]' AS CHAR(64) ARRAY)`);
	});

	it('keeps the cast type, so char(64) and char(255) stay distinguishable', () => {
		const c64 = normalizeMySqlIndexExpression(
			"cast(json_extract(`appRoles`,_utf8mb4\\'$[*]\\') as char(64) array)",
		);
		const c255 = normalizeMySqlIndexExpression(
			"cast(json_extract(`appRoles`,_utf8mb4\\'$[*]\\') as char(255) array)",
		);
		expect(c64).to.not.equal(c255);
	});

	it('is not fooled by the charset introducer, which varies by connection', () => {
		// The introducer reflects the charset of the session that ran the DDL, so
		// the same index reads back differently depending on who created it.
		expect(
			normalizeMySqlIndexExpression(
				"cast(json_extract(`appRoles`,_latin1\\'$[*]\\') as char(64) array)",
			),
		).to.equal(`CAST(appRoles->'$[*]' AS CHAR(64) ARRAY)`);
	});

	it('normalizes MySQL’s re-rendered decimal spacing', () => {
		expect(
			normalizeMySqlIndexExpression(
				"cast(json_extract(`scores`,_utf8mb4\\'$.values[*]\\') as decimal(10, 2) array)",
			),
		).to.equal(`CAST(scores->'$.values[*]' AS DECIMAL(10,2) ARRAY)`);
	});

	it('still handles the single-value functional form unchanged', () => {
		expect(
			normalizeMySqlIndexExpression(
				"(cast(json_unquote(json_extract(`j`,_utf8mb4\\'$.name\\')) as char(255) charset utf8mb4) collate utf8mb4_bin)",
			),
		).to.equal('j->>"$.name"');
	});

	it('leaves an unparseable multi-valued expression alone instead of silently reducing it', () => {
		// Falling through to the single-value branch would quietly conflate this
		// with a completely different index and churn forever with no clue why.
		const weird =
			"cast(json_extract(`a`,_utf8mb4\\'$[*]\\'), json_extract(`b`,_utf8mb4\\'$[*]\\') as char(64) array)";
		expect(normalizeMySqlIndexExpression(weird)).to.equal(weird);
	});
});
