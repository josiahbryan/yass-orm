/* global describe, it, before, beforeEach */
const { expect } = require('chai');
const { loadDefinition } = require('../lib');
const { dbh } = require('../lib/dbh');
const {
	isPostgres,
	recreateTables,
	quoteTable,
	rejectionOf,
} = require('./helpers/characterize');

/**
 * Model.find() (lib/finder.js) builds its SQL through the dialect: quoting,
 * LIMIT / OFFSET and the null fallback. It used to hard-code MySQL's
 * backticks, `IFNULL` and `LIMIT skip, limit`, and pass `?` placeholders
 * Postgres doesn't take, so it failed there. Live database: MySQL in
 * `npm test`, Postgres in `npm run test:postgres`.
 */
describe('#finder find() on every dialect', function finderSuite() {
	this.timeout(30000);

	const definition = ({ types: t }) => ({
		table: 'yass_finder_dialects',
		schema: {
			id: t.idKey,
			name: t.string,
			points: t.int,
			note: t.string,
		},
	});

	// What the hooks saw, from the last find().
	let seen;
	class Model extends loadDefinition(definition) {
		// eslint-disable-next-line class-methods-use-this
		async mutateJoins(sqlData, ctx) {
			seen = { sqlData, ctx };
		}
	}

	let conn;
	const names = (packet) => packet.data.map(({ name }) => name);

	before(async () => {
		await recreateTables([definition]);
		conn = await dbh();
	});

	beforeEach(async () => {
		seen = undefined;
		await conn.pquery(`DELETE FROM ${quoteTable(Model.table())}`);
		Model.clearCache();
		await Model.create({ name: 'a', points: 1 });
		await Model.create({ name: 'b', points: 5, note: 'x' });
		await Model.create({ name: 'c', points: 3, note: 'x' });
	});

	it('with no query: every row, in id order', async () => {
		const packet = await Model.find({});
		expect(names(packet)).to.deep.equal(['a', 'b', 'c']);
		expect(packet.total).to.equal(3);
		expect(packet.skip).to.equal(0);
	});

	it('a field equal to a value', async () => {
		expect(names(await Model.find({ note: 'x' }))).to.deep.equal(['b', 'c']);
		expect(names(await Model.find({ query: { name: 'c' } }))).to.deep.equal([
			'c',
		]);
	});

	it('$sort', async () => {
		expect(names(await Model.find({ $sort: { points: -1 } }))).to.deep.equal([
			'b',
			'c',
			'a',
		]);
		expect(names(await Model.find({ $sort: { points: 1 } }))).to.deep.equal([
			'a',
			'c',
			'b',
		]);
	});

	it('$limit and $skip page the rows; total counts them all, as a number', async () => {
		const packet = await Model.find({
			$sort: { points: 1 },
			$limit: 1,
			$skip: 1,
		});
		expect(names(packet)).to.deep.equal(['c']);
		expect(packet.total).to.equal(3);
		expect(packet.limit).to.equal(1);
		expect(packet.skip).to.equal(1);
	});

	it("the hooks' dbQuote quotes for this dialect, and is idempotent", async () => {
		await Model.find({});
		const { dbQuote } = seen.ctx;
		const quoted = isPostgres() ? '"points"' : '`points`';
		expect(dbQuote('points')).to.equal(quoted);
		expect(dbQuote(dbQuote('points'))).to.equal(quoted);
		const table = isPostgres()
			? '"yass_finder_dialects"'
			: '`yass_finder_dialects`';
		expect(seen.sqlData.tableName).to.equal(table);
	});

	it('a where clause a hook adds with ? placeholders', async () => {
		class Hooked extends Model {
			// eslint-disable-next-line class-methods-use-this
			async mutateQuery(query, sqlData, ctx) {
				sqlData.whereList.push(`${ctx.dbQuote('points')} > ?`);
				sqlData.whereArgs.push(2);
			}
		}
		expect(names(await Hooked.find({ $sort: { points: 1 } }))).to.deep.equal([
			'c',
			'b',
		]);
	});

	it('{ q } needs match_ratio(): a clear error where yass does not install it', async function qSearch() {
		if (!isPostgres()) {
			this.skip();
		}
		const error = await rejectionOf(Model.find({ q: 'a' }));
		expect(error, 'find({ q }) resolved').to.be.an('error');
		expect(error.message).to.include('match_ratio');
	});
});
