/* eslint-disable no-console */
/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// BDL-3142: schema-sync never emitted an ALTER for an integer column whose
// nullability or default had drifted from the definition, because the
// comparator's `a[k] || ''` / `b[k] || ''` coercion collapsed a legitimate
// `0` (NOT NULL -> null:0, DEFAULT 0 -> default:0) to the same '' used for
// "field not specified" -- so the diff was silently erased. Exit 0, success
// banner, database unchanged.
describe('#schemaSync integer NOT NULL/DEFAULT drift (BDL-3142)', () => {
	const tableName = `yass_int_drift_${uuid().replace(/-/g, '')}`;

	const schemaDef = ({ types: t }) => ({
		table: tableName,
		schema: {
			id: t.idKey,
			attempt: t.int.nonnegative().default(0),
			seq: t.int.nonnegative().default(0),
			status: t.enum(['pending', 'done']).default('pending'),
		},
	});

	async function describeColumn(field) {
		const conn = await dbh({ ignoreCachedConnections: true });
		const [row] = await conn.pquery(
			`SHOW COLUMNS FROM \`${tableName}\` WHERE Field = '${field}'`,
		);
		await conn.end();
		return row;
	}

	before(async () => {
		const schema = YassORM.convertDefinition(schemaDef);
		await syncSchemaToDb(schema);
	});

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(`DROP TABLE IF EXISTS \`${tableName}\``);
		await conn.end();
	});

	it('creates the table with correct NOT NULL DEFAULT 0 integer columns', async () => {
		const attemptCol = await describeColumn('attempt');
		expect(attemptCol.Null).to.equal('NO');
		expect(attemptCol.Default).to.equal('0');

		const seqCol = await describeColumn('seq');
		expect(seqCol.Null).to.equal('NO');
		expect(seqCol.Default).to.equal('0');
	});

	it('CASE A: restores nullability drift (int made NULL) back to NOT NULL on re-sync', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`ALTER TABLE \`${tableName}\` MODIFY \`attempt\` int NULL DEFAULT 0`,
		);
		await conn.end();

		const before = await describeColumn('attempt');
		expect(before.Null).to.equal('YES'); // drift actually applied

		const schema = YassORM.convertDefinition(schemaDef);
		await syncSchemaToDb(schema);

		const after = await describeColumn('attempt');
		expect(after.Null).to.equal('NO');
		expect(after.Default).to.equal('0');
	});

	it('CASE B: restores default-value drift (default removed) back to DEFAULT 0 on re-sync', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`ALTER TABLE \`${tableName}\` MODIFY \`seq\` int NOT NULL`,
		);
		await conn.end();

		const before = await describeColumn('seq');
		expect(before.Default).to.equal(null); // drift actually applied: default removed

		const schema = YassORM.convertDefinition(schemaDef);
		await syncSchemaToDb(schema);

		const after = await describeColumn('seq');
		expect(after.Null).to.equal('NO');
		expect(after.Default).to.equal('0');
	});

	it('regression guard: varchar/enum nullability drift is still correctly restored (control case that already worked)', async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		await conn.pquery(
			`ALTER TABLE \`${tableName}\` MODIFY \`status\` varchar(255) NULL`,
		);
		await conn.end();

		const before = await describeColumn('status');
		expect(before.Null).to.equal('YES');

		const schema = YassORM.convertDefinition(schemaDef);
		await syncSchemaToDb(schema);

		const after = await describeColumn('status');
		expect(after.Null).to.equal('NO');
		expect(after.Default).to.equal('pending');
	});

	it('AC #5: still reports (does not silently no-op) when an int NOT NULL alter is blocked by existing NULL rows', async () => {
		const blockedTable = `yass_int_drift_blocked_${uuid().replace(/-/g, '')}`;
		const nullableDef = ({ types: t }) => ({
			table: blockedTable,
			schema: {
				id: t.idKey,
				count: t.int.nullable(),
			},
		});
		const requiredDef = ({ types: t }) => ({
			table: blockedTable,
			schema: {
				id: t.idKey,
				count: t.int.default(0),
			},
		});

		try {
			await syncSchemaToDb(YassORM.convertDefinition(nullableDef));

			const conn = await dbh({ ignoreCachedConnections: true });
			await conn.pquery(
				`INSERT INTO \`${blockedTable}\` (\`count\`) VALUES (NULL)`,
			);
			await conn.end();

			const errors = [];
			const origError = console.error;
			console.error = (...args) => {
				errors.push(args.join(' '));
				origError(...args);
			};

			try {
				await syncSchemaToDb(YassORM.convertDefinition(requiredDef));
			} finally {
				console.error = origError;
			}

			expect(errors.join('\n')).to.include(
				`Cannot make \`${blockedTable}\`.\`count\` NOT NULL`,
			);

			const conn2 = await dbh({ ignoreCachedConnections: true });
			const [colRow] = await conn2.pquery(
				`SHOW COLUMNS FROM \`${blockedTable}\` WHERE Field = 'count'`,
			);
			await conn2.end();
			// The unsafe alter must NOT have been silently applied nor silently skipped --
			// it must be blocked and reported, so the column stays nullable.
			expect(colRow.Null).to.equal('YES');
		} finally {
			const conn = await dbh({ ignoreCachedConnections: true });
			await conn.pquery(`DROP TABLE IF EXISTS \`${blockedTable}\``);
			await conn.end();
		}
	});
});
