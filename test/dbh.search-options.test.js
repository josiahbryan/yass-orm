/* eslint-disable no-unused-expressions */
/* global describe, it, before, after */
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { dbh, closeAllConnections } = require('../lib/dbh');

const tempDb = path.join('/tmp', `yass-search-opts-${process.pid}.sqlite`);
const TABLE = 'search_opts';

describe('#YASS-ORM dbh.search() options', function suite() {
	this.timeout(20000);

	let conn;
	/** Every SQL string roQuery was asked to run, in order. */
	let sqlLog;

	before(async () => {
		conn = await dbh({
			dialect: 'sqlite',
			filename: tempDb,
			ignoreCachedConnections: true,
		});
		await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
		await conn.query(`
			CREATE TABLE ${TABLE} (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT,
				sortKey INTEGER,
				isDeleted INTEGER DEFAULT 0
			)
		`);
		// 25 rows so a `limit 20` is a real cut, not a coincidence.
		for (let i = 0; i < 25; i++) {
			// eslint-disable-next-line no-await-in-loop
			await conn.query(
				`INSERT INTO ${TABLE} (name, sortKey, isDeleted) VALUES (:name, :sortKey, 0)`,
				{ name: `row-${i}`, sortKey: i },
			);
		}

		// Spy on roQuery so we can assert the GENERATED SQL. Asserting on the
		// returned ORDER would be unsound: an unordered result can come back
		// looking sorted by accident (insertion order), so it would pass against
		// the unfixed library and measure nothing.
		sqlLog = [];
		const realRoQuery = conn.roQuery.bind(conn);
		conn.roQuery = (sql, args, opts) => {
			sqlLog.push(sql);
			return realRoQuery(sql, args, opts);
		};
	});

	after(async () => {
		await closeAllConnections();
		try {
			fs.unlinkSync(tempDb);
		} catch (err) {
			// ignore
		}
	});

	const lastSql = () => sqlLog[sqlLog.length - 1];

	describe('backward compatibility', () => {
		it('limitOne=true still emits `limit 1` and returns a single row', async () => {
			const row = await conn.search(TABLE, { isDeleted: 0 }, true);
			expect(lastSql()).to.match(/limit 1$/);
			expect(Array.isArray(row)).to.be.false;
			expect(row.name).to.be.a('string');
		});

		it('limitOne=false emits no limit and returns every row', async () => {
			const rows = await conn.search(TABLE, { isDeleted: 0 }, false);
			expect(lastSql()).to.not.match(/limit/i);
			expect(rows).to.have.length(25);
		});

		it('still accepts the { silenceErrors } 4th positional', async () => {
			const rows = await conn.search(TABLE, { isDeleted: 0 }, false, {
				silenceErrors: true,
			});
			expect(rows).to.have.length(25);
		});
	});

	describe('options form', () => {
		it('emits LIMIT n and returns an ARRAY of at most n', async () => {
			const rows = await conn.search(TABLE, { isDeleted: 0 }, { limit: 20 });
			expect(lastSql()).to.match(/limit 20/);
			expect(Array.isArray(rows)).to.be.true;
			expect(rows).to.have.length(20);
		});

		it('emits ORDER BY with an escaped identifier', async () => {
			await conn.search(
				TABLE,
				{ isDeleted: 0 },
				{ orderBy: 'sortKey', orderDir: 'DESC' },
			);
			expect(lastSql()).to.match(/order by\s+.?sortKey.?\s+DESC/i);
		});

		it('emits LIMIT before OFFSET and skips the right rows', async () => {
			const rows = await conn.search(
				TABLE,
				{ isDeleted: 0 },
				{ limit: 5, offset: 10, orderBy: 'sortKey', orderDir: 'ASC' },
			);
			expect(lastSql()).to.match(/limit 5\s+offset 10/i);
			expect(rows.map((r) => r.sortKey)).to.deep.equal([10, 11, 12, 13, 14]);
		});

		it('a limit of 1 still returns an ARRAY, not a bare object', async () => {
			const rows = await conn.search(TABLE, { isDeleted: 0 }, { limit: 1 });
			expect(Array.isArray(rows)).to.be.true;
			expect(rows).to.have.length(1);
		});
	});

	describe('validation reaches this layer too', () => {
		it('rejects an unknown option key', async () => {
			let caught;
			try {
				await conn.search(TABLE, { isDeleted: 0 }, { sortBy: ['-sortKey'] });
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.an('error');
			expect(caught.message).to.match(/'sortBy'/);
		});
	});
});
