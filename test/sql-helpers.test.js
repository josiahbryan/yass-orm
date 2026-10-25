/* eslint-disable no-unused-expressions */
/* global describe, it, before, beforeEach, after */
const { expect } = require('chai');
const YassORM = require('../lib');
const sql = require('../lib/sql-helpers');
const { dbh } = require('../lib/dbh');
const {
	isPostgres,
	recreateTables,
	quoteTable,
	rejectionOf,
} = require('./helpers/characterize');

/**
 * The dialect helpers (lib/sql-helpers.js): the SQL patterns that differ
 * between MySQL and Postgres, written once. Live database: MySQL in
 * `npm test`, Postgres in `npm run test:postgres`. Every helper is checked
 * by running what it builds, so each runs on both.
 */
describe('#sql helpers (lib/sql-helpers.js)', function helpersSuite() {
	this.timeout(30000);

	const definition = ({ types: t }) => ({
		table: 'yass_sql_helpers',
		schema: {
			id: t.stringKey,
			name: t.string,
			points: t.int,
			note: t.string,
			until: t.datetime,
		},
	});
	const { table } = YassORM.convertDefinition(definition);

	let conn;
	let T;
	// Quote a column: Postgres folds unquoted names to lower case.
	const c = (name) => conn.escapeId(name);

	const insert = (row) =>
		conn.pquery(
			`INSERT INTO ${T} (${Object.keys(row)
				.map(c)
				.join(', ')}) VALUES (${Object.keys(row)
				.map((k) => `:${k}`)
				.join(', ')})`,
			row,
		);

	const rows = (where = '1=1', params = {}) =>
		conn.pquery(
			`SELECT ${c('id')}, ${c('name')}, ${c('points')}, ${c(
				'note',
			)} FROM ${T} WHERE ${where} ORDER BY ${c('id')}`,
			params,
		);

	before(async () => {
		await recreateTables([definition]);
		conn = await dbh();
		T = quoteTable(table);
	});

	beforeEach(async () => {
		await conn.pquery(`DELETE FROM ${T}`);
		await insert({ id: 'a', name: 'alpha', points: 1, note: null });
		await insert({ id: 'b', name: 'beta', points: 5, note: 'x' });
		await insert({ id: 'c', name: 'gamma', points: null, note: 'x' });
	});

	describe('inList(): IN a list of ids', () => {
		it('matches the listed values, as bound parameters', async () => {
			const { sql: inSql, params } = sql.inList('ids', ['a', 'c', 'zz']);
			expect(inSql).to.equal('IN (:ids_0, :ids_1, :ids_2)');
			expect(params).to.deep.equal({ ids_0: 'a', ids_1: 'c', ids_2: 'zz' });
			const found = await rows(`${c('id')} ${inSql}`, params);
			expect(found.map((r) => r.id)).to.deep.equal(['a', 'c']);
		});

		it('an empty list matches nothing (and is valid SQL)', async () => {
			const { sql: inSql, params } = sql.inList('ids', []);
			expect(await rows(`${c('id')} ${inSql}`, params)).to.deep.equal([]);
			expect(
				await rows(`NOT (${c('id')} ${inSql})`, params),
				'NOT IN an empty list is NULL on both, not true',
			).to.deep.equal([]);
		});

		it('refuses a name that is not a plain identifier', () => {
			expect(() => sql.inList('a b', [1])).to.throw(TypeError);
		});
	});

	describe('count(): count as a number', () => {
		it('is a JS number on both dialects', async () => {
			const [row] = await conn.pquery(
				`SELECT ${sql.count(conn)} AS n FROM ${T}`,
			);
			expect(row.n).to.equal(3);
			const [notes] = await conn.pquery(
				`SELECT ${sql.count(conn, c('note'))} AS n FROM ${T}`,
			);
			expect(notes.n).to.equal(2);
		});
	});

	describe('nullSafeEqual() / nullSafeNotEqual()', () => {
		it('NULL equals NULL; a value never equals NULL', async () => {
			const eq = await rows(sql.nullSafeEqual(conn, c('note'), ':note'), {
				note: null,
			});
			expect(eq.map((r) => r.id)).to.deep.equal(['a']);
			const eqX = await rows(sql.nullSafeEqual(conn, c('note'), ':note'), {
				note: 'x',
			});
			expect(eqX.map((r) => r.id)).to.deep.equal(['b', 'c']);
			const ne = await rows(sql.nullSafeNotEqual(conn, c('note'), ':note'), {
				note: 'x',
			});
			expect(ne.map((r) => r.id)).to.deep.equal(['a']);
		});
	});

	describe('nullsLast()', () => {
		it('puts NULLs last, ascending or descending', async () => {
			const order = async (direction) =>
				(
					await conn.pquery(
						`SELECT ${c('id')} FROM ${T} ORDER BY ${sql.nullsLast(
							conn,
							c('points'),
							direction,
						)}`,
					)
				).map((r) => r.id);
			expect(await order('ASC')).to.deep.equal(['a', 'b', 'c']);
			expect(await order('desc')).to.deep.equal(['b', 'a', 'c']);
			expect(() => sql.nullsLast(conn, c('points'), 'sideways')).to.throw(
				/direction/,
			);
		});
	});

	describe('now() and interval math', () => {
		it("now() is the database's clock, in UTC", async () => {
			const [row] = await conn.pquery(`SELECT ${sql.now(conn)} AS t`);
			expect(row.t).to.be.an.instanceOf(Date);
			expect(Math.abs(row.t.getTime() - Date.now())).to.be.below(60 * 1000);
		});

		it('addInterval / subtractInterval with a bound amount, and comparisons against a stored time', async () => {
			const later = sql.addInterval(conn, sql.now(conn), ':minutes', 'minute');
			const earlier = sql.subtractInterval(conn, sql.now(conn), '2', 'hour');
			const [row] = await conn.pquery(
				`SELECT ${later} AS later, ${earlier} AS earlier`,
				{ minutes: 15 },
			);
			const minutes = (row.later.getTime() - Date.now()) / 60000;
			expect(minutes).to.be.within(14, 16);
			const hours = (Date.now() - row.earlier.getTime()) / 3600000;
			expect(hours).to.be.within(1.9, 2.1);

			// A time yass wrote compares correctly with the database clock.
			await conn.pquery(
				`UPDATE ${T} SET ${c('until')} = :until WHERE ${c('id')} = 'a'`,
				{
					until: new Date(Date.now() + 30 * 60 * 1000),
				},
			);
			await conn.pquery(
				`UPDATE ${T} SET ${c('until')} = :until WHERE ${c('id')} = 'b'`,
				{
					until: new Date(Date.now() - 30 * 60 * 1000),
				},
			);
			const live = await rows(`${c('until')} > ${sql.now(conn)}`);
			expect(live.map((r) => r.id)).to.deep.equal(['a']);
			const soon = await rows(
				`${c('until')} < ${sql.addInterval(
					conn,
					sql.now(conn),
					1,
					'hour',
				)} AND ${c('until')} > ${sql.now(conn)}`,
			);
			expect(soon.map((r) => r.id)).to.deep.equal(['a']);
		});

		it('refuses an unknown unit', () => {
			expect(() =>
				sql.addInterval(conn, sql.now(conn), 1, 'fortnight'),
			).to.throw(/unit/);
		});
	});

	describe('forUpdate(): row locks', () => {
		it('locks the rows it reads until the transaction ends', async () => {
			let secondSaw;
			let releaseFirst;
			const firstHolds = new Promise((resolve) => {
				releaseFirst = resolve;
			});
			let firstLocked;
			const locked = new Promise((resolve) => {
				firstLocked = resolve;
			});
			const order = [];

			const first = conn.transaction(async (tx) => {
				await tx.pquery(
					`SELECT ${c('id')} FROM ${T} WHERE ${c('id')} = 'a' ${sql.forUpdate(
						tx,
					)}`,
				);
				firstLocked();
				await firstHolds;
				await tx.pquery(
					`UPDATE ${T} SET ${c('points')} = 10 WHERE ${c('id')} = 'a'`,
				);
				order.push('first');
			});
			await locked;
			const second = conn.transaction(async (tx) => {
				const [row] = await tx.pquery(
					`SELECT ${c('points')} FROM ${T} WHERE ${c(
						'id',
					)} = 'a' ${sql.forUpdate(tx)}`,
				);
				secondSaw = row.points;
				order.push('second');
			});
			// Give the second a moment to block on the lock.
			await new Promise((resolve) => {
				setTimeout(resolve, 200);
			});
			expect(order).to.deep.equal([]);
			releaseFirst();
			await Promise.all([first, second]);
			expect(order).to.deep.equal(['first', 'second']);
			expect(secondSaw).to.equal(10);
		});

		it('skipLocked: skips rows another transaction holds', async () => {
			let releaseFirst;
			const firstHolds = new Promise((resolve) => {
				releaseFirst = resolve;
			});
			let firstLocked;
			const locked = new Promise((resolve) => {
				firstLocked = resolve;
			});
			const first = conn.transaction(async (tx) => {
				await tx.pquery(
					`SELECT ${c('id')} FROM ${T} WHERE ${c('id')} = 'a' ${sql.forUpdate(
						tx,
					)}`,
				);
				firstLocked();
				await firstHolds;
			});
			await locked;
			try {
				const seen = await conn.transaction(async (tx) =>
					tx.pquery(
						`SELECT ${c('id')} FROM ${T} ORDER BY ${c('id')} ${sql.forUpdate(
							tx,
							{
								skipLocked: true,
							},
						)}`,
					),
				);
				expect(seen.map((r) => r.id)).to.deep.equal(['b', 'c']);
			} finally {
				releaseFirst();
				await first;
			}
		});

		it('refuses skipLocked and noWait together', () => {
			expect(() =>
				sql.forUpdate(conn, { skipLocked: true, noWait: true }),
			).to.throw(/skipLocked/);
		});
	});

	describe('lockKey(): a transaction-scoped lock on a name (the advisory-lock replacement)', () => {
		after(async () => {
			await conn.pquery(`DELETE FROM ${quoteTable('yass_locks')}`);
		});

		it('serializes transactions that lock the same key; other keys do not wait', async () => {
			const events = [];
			let releaseFirst;
			const firstHolds = new Promise((resolve) => {
				releaseFirst = resolve;
			});
			let firstLocked;
			const locked = new Promise((resolve) => {
				firstLocked = resolve;
			});
			const first = conn.transaction(async (tx) => {
				await sql.lockKey(tx, 'contact:1');
				firstLocked();
				await firstHolds;
				events.push('first done');
			});
			await locked;
			const other = conn.transaction(async (tx) => {
				await sql.lockKey(tx, 'contact:2');
				events.push('other key');
			});
			await other;
			const second = conn.transaction(async (tx) => {
				await sql.lockKey(tx, 'contact:1');
				events.push('second');
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 200);
			});
			expect(events).to.deep.equal(['other key']);
			releaseFirst();
			await Promise.all([first, second]);
			expect(events).to.deep.equal(['other key', 'first done', 'second']);
		});

		it('is released on rollback too', async () => {
			const boom = new Error('boom');
			const error = await rejectionOf(
				conn.transaction(async (tx) => {
					await sql.lockKey(tx, 'contact:3');
					throw boom;
				}),
			);
			expect(error).to.equal(boom);
			await conn.transaction(async (tx) => sql.lockKey(tx, 'contact:3'));
		});

		it('takes a key longer than the column (hashed)', async () => {
			await conn.transaction(async (tx) => sql.lockKey(tx, 'k'.repeat(500)));
		});

		it('refuses to run outside a transaction', async () => {
			const error = await rejectionOf(sql.lockKey(conn, 'contact:1'));
			expect(error.message).to.include('inside a transaction');
		});
	});

	describe('upsertWhere(): upsert with a condition', () => {
		it('inserts a new row', async () => {
			const result = await sql.upsertWhere(conn, table, {
				values: { id: 'd', name: 'delta', points: 1 },
				conflictColumns: ['id'],
				update: ['name'],
				where: `${c('points')} < :max`,
				params: { max: 3 },
			});
			expect(result).to.deep.equal({ inserted: true, updated: false });
			expect((await rows(`${c('id')} = 'd'`))[0]).to.include({
				name: 'delta',
				points: 1,
			});
		});

		it('updates an existing row only where the condition holds', async () => {
			const upsert = (id) =>
				sql.upsertWhere(conn, table, {
					values: { id, name: 'changed', points: 99 },
					conflictColumns: ['id'],
					update: { name: ':name', points: `${c('points')} + 1` },
					where: `${c('points')} < :max`,
					params: { max: 3 },
				});
			expect(await upsert('a')).to.deep.equal({
				inserted: false,
				updated: true,
			});
			expect(await upsert('b')).to.deep.equal({
				inserted: false,
				updated: false,
			});
			const after = await rows(`${c('id')} IN ('a', 'b')`);
			expect(after.map((r) => [r.id, r.name, r.points])).to.deep.equal([
				['a', 'changed', 2],
				['b', 'beta', 5],
			]);
		});

		it('with no condition, always updates; counts an unchanged row as updated', async () => {
			const result = await sql.upsertWhere(conn, table, {
				values: { id: 'b', name: 'beta' },
				conflictColumns: ['id'],
				update: ['name'],
			});
			expect(result).to.deep.equal({ inserted: false, updated: true });
		});

		it('works inside a transaction', async () => {
			await conn.transaction(async (tx) => {
				expect(
					await sql.upsertWhere(tx, table, {
						values: { id: 'e', name: 'epsilon' },
						conflictColumns: ['id'],
						update: ['name'],
					}),
				).to.deep.equal({ inserted: true, updated: false });
			});
			expect(await rows(`${c('id')} = 'e'`)).to.have.length(1);
		});

		it('refuses no conflictColumns, and a param that shadows a value', async () => {
			expect(
				(
					await rejectionOf(
						sql.upsertWhere(conn, table, {
							values: { id: 'f' },
							update: ['id'],
						}),
					)
				).message,
			).to.include('conflictColumns');
			expect(
				(
					await rejectionOf(
						sql.upsertWhere(conn, table, {
							values: { id: 'f', name: 'x' },
							conflictColumns: ['id'],
							update: ['name'],
							where: '1=1',
							params: { name: 'y' },
						}),
					)
				).message,
			).to.include("'name'");
		});
	});

	describe('upsertAdd(): add to a counter row in one statement', () => {
		const add = (db, args) =>
			sql.upsertAdd(db, table, { conflictColumns: ['id'], ...args });
		const pointsOf = async (id) =>
			(await rows(`${c('id')} = :id`, { id }))[0];

		it('inserts a missing row with the given values', async () => {
			await add(conn, {
				values: { id: 'n', name: 'new', points: 3 },
				add: ['points'],
			});
			expect(await pointsOf('n')).to.include({ name: 'new', points: 3 });
		});

		it('adds to an existing row, raises a maximum, sets a column, and leaves the rest', async () => {
			await add(conn, {
				values: { id: 'b', name: 'renamed', points: 4, note: 'y' },
				add: ['points'],
				set: ['name'],
			});
			expect(await pointsOf('b')).to.include({
				name: 'renamed',
				points: 9,
				note: 'x',
			});
			await add(conn, {
				values: { id: 'b', points: 7 },
				max: ['points'],
			});
			expect((await pointsOf('b')).points, 'raised to the larger').to.equal(9);
			await add(conn, {
				values: { id: 'b', points: 20 },
				max: ['points'],
			});
			expect((await pointsOf('b')).points, 'never lowered').to.equal(20);
		});

		it('adds zero and negatives exactly; keeps the stored id', async () => {
			await add(conn, { values: { id: 'a', points: 0 }, add: ['points'] });
			expect((await pointsOf('a')).points).to.equal(1);
			await add(conn, { values: { id: 'a', points: -1 }, add: ['points'] });
			expect((await pointsOf('a')).points).to.equal(0);
		});

		it('twenty concurrent first writes of one new key end as one row with the exact sum', async () => {
			const writes = Array.from({ length: 20 }, (_, i) =>
				add(conn, {
					values: { id: 'race', points: i + 1 },
					add: ['points'],
				}),
			);
			await Promise.all(writes);
			const found = await rows(`${c('id')} = 'race'`);
			expect(found).to.have.length(1);
			expect(found[0].points).to.equal(210);
		});

		it('twenty rounds of sixteen concurrent first writers never fail, and every key ends with the exact sum', async () => {
			const ROUNDS = 20;
			const WRITERS = 16;
			const errors = [];
			for (let round = 0; round < ROUNDS; round += 1) {
				const key = `loop-${round}`;
				// Each writer is its own transaction, as a storage ready step is.
				// eslint-disable-next-line no-await-in-loop
				await Promise.all(
					Array.from({ length: WRITERS }, (_, i) =>
						conn
							.transaction((tx) =>
								add(tx, { values: { id: key, points: i + 1 }, add: ['points'] }),
							)
							.catch((error) => errors.push(error.message)),
					),
				);
				// eslint-disable-next-line no-await-in-loop
				const found = await rows(`${c('id')} = :id`, { id: key });
				expect(found).to.have.length(1);
				expect(found[0].points).to.equal((WRITERS * (WRITERS + 1)) / 2);
			}
			expect(errors).to.deep.equal([]);
		});

		it('works inside a transaction; a rollback leaves nothing counted', async () => {
			await conn.transaction(async (tx) => {
				await add(tx, { values: { id: 'a', points: 10 }, add: ['points'] });
				await add(tx, { values: { id: 'r', points: 2 }, add: ['points'] });
			});
			expect((await pointsOf('a')).points).to.equal(11);
			const rolledBack = await rejectionOf(
				conn.transaction(async (tx) => {
					await add(tx, { values: { id: 'a', points: 100 }, add: ['points'] });
					await add(tx, { values: { id: 'q', points: 1 }, add: ['points'] });
					throw new Error('stop');
				}),
			);
			expect(rolledBack.message).to.equal('stop');
			expect((await pointsOf('a')).points).to.equal(11);
			expect(await rows(`${c('id')} = 'q'`)).to.have.length(0);
		});

		it('with nothing to add, raise or set, inserts a missing row and leaves an existing one', async () => {
			await add(conn, { values: { id: 'z', name: 'zeta', points: 8 } });
			expect(await pointsOf('z')).to.include({ name: 'zeta', points: 8 });
			await add(conn, { values: { id: 'z', name: 'other', points: 99 } });
			expect(await pointsOf('z')).to.include({ name: 'zeta', points: 8 });
		});

		it('refuses a column named twice, a key column to change, and a column that is not in values', async () => {
			const refused = async (args) =>
				(await rejectionOf(add(conn, args))).message;
			expect(
				await refused({
					values: { id: 'a', points: 1 },
					add: ['points'],
					max: ['points'],
				}),
			).to.include('points');
			expect(
				await refused({
					values: { id: 'a', points: 1 },
					add: ['points'],
					set: ['points'],
				}),
			).to.include('points');
			expect(
				await refused({ values: { id: 'a', points: 1 }, set: ['id'] }),
			).to.include('id');
			expect(
				await refused({ values: { id: 'a', points: 1 }, add: ['id'] }),
			).to.include('id');
			expect(
				await refused({ values: { id: 'a' }, add: ['points'] }),
			).to.include('points');
		});

		it('refuses an unsafe column name, a non-number in add or max, and missing conflictColumns', async () => {
			const refused = async (args, key = ['id']) =>
				(
					await rejectionOf(
						sql.upsertAdd(conn, table, { conflictColumns: key, ...args }),
					)
				).message;
			expect(
				await refused({
					values: { id: 'a', 'points; DROP TABLE x': 1 },
					add: ['points; DROP TABLE x'],
				}),
			).to.include('plain');
			for (const bad of [null, undefined, NaN, Infinity, '5', {}]) {
				expect(
					await refused({ values: { id: 'a', points: bad }, add: ['points'] }),
					`add ${String(bad)}`,
				).to.include('points');
				expect(
					await refused({ values: { id: 'a', points: bad }, max: ['points'] }),
					`max ${String(bad)}`,
				).to.include('points');
			}
			expect(
				await refused({ values: { id: 'a', points: 1 }, add: ['points'] }, []),
			).to.include('conflictColumns');
		});

		it('upsertWhere is untouched: still two statements with its condition', async () => {
			expect(
				await sql.upsertWhere(conn, table, {
					values: { id: 'a', name: 'k', points: 2 },
					conflictColumns: ['id'],
					update: { points: `${c('points')} + :points` },
					where: `${c('points')} < :max`,
					params: { max: 3 },
				}),
			).to.deep.equal({ inserted: false, updated: true });
		});
	});

	describe('readBack(): read back after a write (the RETURNING replacement)', () => {
		it('runs the write, then the read, in one transaction', async () => {
			const { affectedRows, rows: back } = await sql.readBack(conn, {
				write: [
					`UPDATE ${T} SET ${c('points')} = ${c('points')} + 1 WHERE ${c(
						'note',
					)} = :note`,
					{ note: 'x' },
				],
				read: [
					`SELECT ${c('id')}, ${c('points')} FROM ${T} WHERE ${c(
						'note',
					)} = :note ORDER BY ${c('id')}`,
					{ note: 'x' },
				],
			});
			expect(affectedRows).to.equal(2);
			expect(back.map((r) => [r.id, r.points])).to.deep.equal([
				['b', 6],
				['c', null],
			]);
		});

		it('readFirst: reads (and locks) the rows, then writes (a DELETE ... RETURNING)', async () => {
			const { affectedRows, rows: gone } = await sql.readBack(conn, {
				readFirst: true,
				read: [
					`SELECT ${c('name')} FROM ${T} WHERE ${c('id')} = :id`,
					{ id: 'a' },
				],
				write: [`DELETE FROM ${T} WHERE ${c('id')} = :id`, { id: 'a' }],
			});
			expect(affectedRows).to.equal(1);
			expect(gone.map((r) => r.name)).to.deep.equal(['alpha']);
			expect(await rows(`${c('id')} = 'a'`)).to.deep.equal([]);
		});

		it('rolls the write back if the read fails', async () => {
			const error = await rejectionOf(
				sql.readBack(conn, {
					write: [`UPDATE ${T} SET ${c('points')} = 42 WHERE ${c('id')} = 'a'`],
					read: [`SELECT nope FROM ${T}`],
				}),
			);
			expect(error).to.be.an('error');
			expect((await rows(`${c('id')} = 'a'`))[0].points).to.equal(1);
		});

		it('joins a transaction it is given', async () => {
			await conn.transaction(async (tx) => {
				const { rows: back } = await sql.readBack(tx, {
					write: [`UPDATE ${T} SET ${c('points')} = 7 WHERE ${c('id')} = 'a'`],
					read: [`SELECT ${c('points')} FROM ${T} WHERE ${c('id')} = 'a'`],
				});
				expect(back[0].points).to.equal(7);
			});
			expect((await rows(`${c('id')} = 'a'`))[0].points).to.equal(7);
		});
	});

	it('the helpers take a dialect as well as a handle', () => {
		expect(sql.now(conn.dialect)).to.equal(sql.now(conn));
		expect(sql.forUpdate(conn.dialect)).to.equal('FOR UPDATE');
		expect(isPostgres() ? sql.now(conn) : 'x').to.equal(
			isPostgres() ? 'now()' : 'x',
		);
	});
});
