/* global describe, it, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { getDialect } = require('../lib/dialects');
const { syncSchemaToDb } = require('../lib/sync-to-db');

// The catalog casts PG string defaults, e.g. 'ordinary'::character varying.
// Compare their values without treating SQL expressions as string literals.
describe('#schemaSync casted string literal defaults', () => {
	const dialect = getDialect(config.dialect || 'mysql');
	const table = `yass_literal_${uuid().replace(/-/g, '').slice(0, 16)}`;
	const q = (name) => dialect.quoteIdentifier(name);
	const schema = (value) =>
		YassORM.convertDefinition(({ types: t }) => ({
			table,
			schema: { id: t.uuidKey, purpose: t.string.default(value) },
		}));

	after(async () => {
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(`DROP TABLE IF EXISTS ${q(table)}`);
		} finally {
			await conn.end();
		}
	});

	['ordinary', '', "someone's purpose", 'literal::text'].forEach((value) => {
		it(`an unchanged literal ${JSON.stringify(
			value,
		)} needs no second ALTER`, async function literalDefault() {
			// MySQL's existing ALTER emitter does not escape quotes in string defaults; this PG comparator fix leaves it unchanged.
			if (value.includes("'") && dialect.name !== 'postgres') {
				this.skip();
				return;
			}
			const first = await syncSchemaToDb(schema(value));
			expect(first.errors).to.deep.equal([]);
			const second = await syncSchemaToDb(schema(value));
			expect(second.errors).to.deep.equal([]);
			expect(second.applied).to.equal(0);
			const conn = await dbh({ ignoreCachedConnections: true });
			try {
				const id = uuid();
				await conn.pquery(`INSERT INTO ${q(table)} (${q('id')}) VALUES (:id)`, {
					id,
				});
				const rows = await conn.pquery(
					`SELECT purpose FROM ${q(table)} WHERE id = :id`,
					{ id },
				);
				expect(rows[0].purpose).to.equal(value);
			} finally {
				await conn.end();
			}
		});
	});

	it('a changed default is applied and then converges', async () => {
		await syncSchemaToDb(schema('before'));
		const changed = await syncSchemaToDb(schema('after'));
		expect(changed.applied).to.be.greaterThan(0);
		expect((await syncSchemaToDb(schema('after'))).applied).to.equal(0);
	});

	it('a PostgreSQL length-limited cast is not mistaken for an unbounded literal', async function limitedCast() {
		if (dialect.name !== 'postgres') {
			this.skip();
			return;
		}
		await syncSchemaToDb(schema('ordinary'));
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`ALTER TABLE ${q(
					table,
				)} ALTER COLUMN purpose SET DEFAULT 'ordinary'::varchar(3)`,
			);
		} finally {
			await conn.end();
		}
		expect(
			(await syncSchemaToDb(schema('ordinary'))).applied,
		).to.be.greaterThan(0);
		expect((await syncSchemaToDb(schema('ordinary'))).applied).to.equal(0);
	});

	it('a PostgreSQL expression is not mistaken for its literal result', async function expression() {
		if (dialect.name !== 'postgres') {
			this.skip();
			return;
		}
		await syncSchemaToDb(schema('ordinary'));
		const conn = await dbh({ ignoreCachedConnections: true });
		try {
			await conn.pquery(
				`ALTER TABLE ${q(
					table,
				)} ALTER COLUMN purpose SET DEFAULT lower('ORDINARY'::text)`,
			);
		} finally {
			await conn.end();
		}
		const changed = await syncSchemaToDb(schema('ordinary'));
		expect(changed.applied).to.be.greaterThan(0);
		expect((await syncSchemaToDb(schema('ordinary'))).applied).to.equal(0);
	});
});
