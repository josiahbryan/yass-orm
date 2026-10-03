/* eslint-disable no-unused-expressions */
/* global describe, it, before, after, beforeEach, afterEach */
const { expect } = require('chai');
const { loadDefinition } = require('../lib');
const { dbh } = require('../lib/dbh');
const { promiseFilter } = require('../lib/finder');
const {
	recreateTables,
	quoteTable,
	ROLLBACK,
	rollingBack,
} = require('./helpers/characterize');

/**
 * The model read helpers run on the transaction they are given (`{ tx }`):
 * a read inside a transaction sees that transaction's uncommitted rows, and
 * takes no second connection (so at pool size 1 it can't wait on itself).
 * `find()`, `fromSql()` and `queryCallback()` used to ignore `tx` and read
 * on another pooled connection. Live database: MySQL in `npm test`,
 * Postgres in `npm run test:postgres`.
 */
describe('model reads inside a transaction ({ tx })', function readTxSuite() {
	this.timeout(30000);

	const definition = ({ types: t }) => ({
		table: 'yass_read_tx',
		schema: {
			id: t.idKey,
			name: t.string,
			points: t.int,
		},
	});

	// find()'s hooks get a context (ctx.dbh, ctx.retryIfConnectionLost) for
	// their own queries: inside a transaction, those run on it too.
	const hookCounts = [];
	class Model extends loadDefinition(definition) {
		async mutateQuery(query, sqlData, ctx) {
			if (query.name !== 'hooked') return;
			const T = quoteTable('yass_read_tx');
			const viaDbh = await ctx.dbh.pquery(
				`SELECT COUNT(*) AS n FROM ${T} WHERE name = :name`,
				{ name: query.name },
			);
			const viaRetry = await ctx.retryIfConnectionLost((db) =>
				db.pquery(`SELECT COUNT(*) AS n FROM ${T} WHERE name = :name`, {
					name: query.name,
				}),
			);
			const viaValues = await ctx.queryValuesPlain(
				'COUNT(*) AS n',
				'name = :name',
				{ name: query.name },
			);
			// promiseFilter (exported for hooks) takes the context, with the
			// query's sqlData as `data`
			const filtered = await promiseFilter(
				`SELECT id FROM ${T} WHERE name = :name`,
				{ name: query.name },
				{ ...ctx, data: sqlData },
				'same name',
			);
			hookCounts.push([
				Number(viaDbh[0].n),
				Number(viaRetry[0].n),
				Number(viaValues[0].n),
				filtered.length,
			]);
		}
	}

	let conn;
	let small;

	// The same table through a pool of ONE connection
	class SmallModel extends loadDefinition(definition) {
		static async dbh() {
			return small;
		}
	}

	before(async () => {
		await recreateTables([definition]);
		conn = await dbh();
	});

	beforeEach(async () => {
		await conn.pquery(`DELETE FROM ${quoteTable('yass_read_tx')}`);
		hookCounts.length = 0;
	});

	afterEach(async () => {
		if (small) await small.end();
		small = null;
	});

	after(async () => {
		await conn.pquery(`DROP TABLE IF EXISTS ${quoteTable('yass_read_tx')}`);
	});

	const findNames = async (M, query, opts) =>
		(await M.find(query, opts)).data.map((row) => row.name);

	it('find() sees the transaction’s uncommitted row; outside it does not', async () => {
		await rollingBack(
			conn.transaction(async (tx) => {
				await Model.create({ name: 'uncommitted', points: 1 }, { tx });
				expect(
					await findNames(Model, { name: 'uncommitted' }, { tx }),
				).to.deep.equal(['uncommitted']);
				expect(await findNames(Model, { name: 'uncommitted' })).to.deep.equal(
					[],
				);
				throw ROLLBACK;
			}),
		);
		expect(await findNames(Model, { name: 'uncommitted' })).to.deep.equal([]);
	});

	it('find()’s hooks query on the transaction too (ctx.dbh, ctx.retryIfConnectionLost, ctx.queryValuesPlain, promiseFilter)', async () => {
		await rollingBack(
			conn.transaction(async (tx) => {
				await Model.create({ name: 'hooked', points: 1 }, { tx });
				const names = await findNames(Model, { name: 'hooked' }, { tx });
				expect(names).to.deep.equal(['hooked']);
				throw ROLLBACK;
			}),
		);
		expect(hookCounts).to.deep.equal([[1, 1, 1, 1]]);
	});

	it('fromSql() and queryCallback() see it with { tx }', async () => {
		await rollingBack(
			conn.transaction(async (tx) => {
				await Model.create({ name: 'raw', points: 2 }, { tx });
				const rows = await Model.fromSql('name = :name', { name: 'raw', tx });
				expect(rows.map((r) => r.name)).to.deep.equal(['raw']);
				expect(rows[0]).to.be.instanceOf(Model);
				const counted = await Model.queryCallback(
					(table) => [
						`SELECT COUNT(*) AS n FROM ${quoteTable(table)} WHERE name = :name`,
						{ name: 'raw' },
					],
					{ tx },
				);
				expect(Number(counted[0].n)).to.equal(1);
				throw ROLLBACK;
			}),
		);
	});

	it('fromSql() still takes a named parameter called tx that is not a transaction', async () => {
		await Model.create({ name: 'tx', points: 3 });
		const rows = await Model.fromSql('name = :tx', { tx: 'tx' });
		expect(rows.map((r) => r.name)).to.deep.equal(['tx']);
	});

	it('at pool size 1, every read helper inside a transaction completes (no second connection)', async () => {
		small = await dbh({
			ignoreCachedConnections: true,
			connectionLimit: 1,
			minimumIdle: 1,
			acquireTimeout: 2000,
		});
		const seen = await small.transaction(async (tx) => {
			const created = await SmallModel.create(
				{ name: 'one', points: 4 },
				{ tx },
			);
			return {
				find: await findNames(SmallModel, { name: 'one' }, { tx }),
				fromSql: (
					await SmallModel.fromSql('name = :name', { name: 'one', tx })
				).map((r) => r.name),
				queryCallback: Number(
					(
						await SmallModel.queryCallback(
							(table) => [
								`SELECT COUNT(*) AS n FROM ${quoteTable(
									table,
								)} WHERE name = :name`,
								{ name: 'one' },
							],
							{ tx },
						)
					)[0].n,
				),
				search: (await SmallModel.search({ name: 'one' }, false, { tx })).map(
					(r) => r.name,
				),
				searchOne: (await SmallModel.searchOne({ name: 'one' }, { tx })).name,
				get: (await SmallModel.get(created.id, { tx })).name,
			};
		});
		expect(seen).to.deep.equal({
			find: ['one'],
			fromSql: ['one'],
			queryCallback: 1,
			search: ['one'],
			searchOne: 'one',
			get: 'one',
		});
	});
});
