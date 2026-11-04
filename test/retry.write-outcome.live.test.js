/* global describe, it, before, after, beforeEach */
const { expect } = require('chai');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const { retryIfConnectionLost, isConnectionLost } = require('../lib/utils');
const { isPostgres, recreateTables } = require('./helpers/characterize');
const { startLoseReplyProxy } = require('./helpers/lose-reply-proxy');

/**
 * BDL-4470: retryIfConnectionLost re-ran a write whose connection died after
 * the server had applied it but before the reply arrived. The write ran twice.
 *
 * These tests use a real server and the real driver. A TCP proxy
 * (helpers/lose-reply-proxy.js) passes one statement through, lets the server
 * run and commit it, then drops the reply and closes the socket.
 *
 * - The control: a write that lost its reply is NOT run again. It fails with
 *   ERR_WRITE_OUTCOME_UNKNOWN, and the table holds the row once.
 * - The positive arms: a read that lost its reply is retried, and so is a
 *   write the caller marked idempotent.
 * - create() on a uuidKey table and patch() are replay-safe: the replay finds
 *   (or rewrites) the row the first attempt wrote. create() on an
 *   auto-increment table, reallyDelete() and raw withDbh() writes are not.
 *
 * MySQL only (`npm test`). The proxy matches the SQL text the mariadb driver
 * sends.
 */
describe('#retryIfConnectionLost: a write that lost its reply is never run twice (BDL-4470)', function suite() {
	this.timeout(60000);

	if (isPostgres() || (config.dialect && config.dialect !== 'mysql')) {
		it.skip('runs on MySQL only');
		return;
	}

	const noSleep = async () => {};

	// Every model here: no nonce, so patch() is replay-safe (see obj.js).
	const ledgerDef = ({ types: t }) => ({
		table: 'yass_noreplay_ledger',
		schema: { id: t.idKey, note: t.string },
	});
	const uuidDef = ({ types: t }) => ({
		table: 'yass_noreplay_uuid',
		schema: { id: t.uuidKey, name: t.string, score: t.int },
	});

	let proxy;
	let direct;
	let Ledger;
	let UuidThing;
	let savedCommonFields;

	const viaProxy = (options = {}) =>
		dbh({ host: proxy.host, port: proxy.port, ...options });
	const bind = (Model) => {
		// eslint-disable-next-line no-param-reassign
		Model.dbh = async () => viaProxy();
		return Model;
	};
	const count = async (table, where = '1=1', params = {}) => {
		const [{ n }] = await direct.pquery(
			`select count(*) as n from \`${table}\` where ${where}`,
			params,
		);
		return Number(n);
	};
	const rejectionOf = async (promise) => {
		try {
			await promise;
		} catch (err) {
			return err;
		}
		return undefined;
	};

	before(async () => {
		// A schema without the test config's common fields (nonce among them).
		savedCommonFields = config.commonFields;
		config.commonFields = () => ({});
		await recreateTables([ledgerDef, uuidDef]);
		Ledger = bind(await YassORM.loadDefinition(ledgerDef));
		UuidThing = bind(await YassORM.loadDefinition(uuidDef));
		config.commonFields = savedCommonFields;

		direct = await dbh();
		proxy = await startLoseReplyProxy({
			host: config.host || '127.0.0.1',
			port: config.port || 3306,
		});
	});

	after(async () => {
		config.commonFields = savedCommonFields;
		if (proxy) await proxy.close();
	});

	beforeEach(async () => {
		proxy.disarm();
		Object.assign(proxy.state, { matched: 0, dropped: 0 });
		await direct.pquery('delete from `yass_noreplay_ledger`');
		await direct.pquery('delete from `yass_noreplay_uuid`');
	});

	describe('Layer 1: the retry policy', () => {
		it('CONTROL: an INSERT that committed and lost its reply is not replayed (the kh63 probe)', async () => {
			let attempts = 0;
			proxy.loseReplyTo(/insert into `yass_noreplay_ledger`/i);

			const error = await rejectionOf(
				retryIfConnectionLost(
					async (db) => {
						attempts += 1;
						return db.pquery(
							'insert into `yass_noreplay_ledger` (note) values (:note)',
							{ note: 'probe' },
						);
					},
					{ handleFactory: viaProxy, sleep: noSleep },
				),
			);
			const writes = await count('yass_noreplay_ledger', 'note=:note', {
				note: 'probe',
			});

			expect(proxy.state.dropped, 'the proxy lost the reply').to.equal(1);
			expect(
				{ attempts, writes },
				'commit-then-lose-response must not be replayed',
			).to.deep.equal({ attempts: 1, writes: 1 });
			expect(error, 'the caller is told').to.be.an('error');
			expect(error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
			expect(error.name).to.equal('WriteOutcomeUnknownError');
			expect(error).to.be.instanceOf(YassORM.WriteOutcomeUnknownError);
			expect(
				isConnectionLost(error.cause),
				'cause is the driver error',
			).to.equal(true);
			expect(
				isConnectionLost(error),
				'the typed error is not itself a lost connection (no outer replay)',
			).to.equal(false);
		});

		it('a read that lost its reply is retried', async () => {
			let attempts = 0;
			await direct.pquery(
				"insert into `yass_noreplay_ledger` (note) values ('seen')",
			);
			proxy.loseReplyTo(/select note from `yass_noreplay_ledger`/i);

			const rows = await retryIfConnectionLost(
				async (db) => {
					attempts += 1;
					return db.pquery('select note from `yass_noreplay_ledger`');
				},
				{ handleFactory: viaProxy, sleep: noSleep },
			);

			expect(proxy.state.dropped).to.equal(1);
			expect(attempts).to.equal(2);
			expect(rows.map((r) => r.note)).to.deep.equal(['seen']);
		});

		it('a write after which a read lost its reply is not replayed (the whole callback re-runs)', async () => {
			let attempts = 0;
			proxy.loseReplyTo(/select count\(\*\) as n from `yass_noreplay_ledger`/i);

			const error = await rejectionOf(
				retryIfConnectionLost(
					async (db) => {
						attempts += 1;
						await db.pquery(
							"insert into `yass_noreplay_ledger` (note) values ('then-read')",
						);
						return db.pquery(
							'select count(*) as n from `yass_noreplay_ledger`',
						);
					},
					{ handleFactory: viaProxy, sleep: noSleep },
				),
			);

			expect(proxy.state.dropped).to.equal(1);
			expect(error && error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
			expect(attempts).to.equal(1);
			expect(await count('yass_noreplay_ledger')).to.equal(1);
		});

		it('a write the caller marked { idempotent: true } is retried', async () => {
			let attempts = 0;
			const { insertId } = await direct.pquery(
				"insert into `yass_noreplay_ledger` (note) values ('before')",
			);
			proxy.loseReplyTo(/update `yass_noreplay_ledger`/i);

			await retryIfConnectionLost(
				async (db) => {
					attempts += 1;
					return db.pquery(
						'update `yass_noreplay_ledger` set note=:note where id=:id',
						{ note: 'after', id: insertId },
					);
				},
				{ handleFactory: viaProxy, sleep: noSleep, idempotent: true },
			);

			expect(proxy.state.dropped).to.equal(1);
			expect(attempts).to.equal(2);
			expect(await count('yass_noreplay_ledger', "note='after'")).to.equal(1);
		});

		it('a raw withDbh() write is not replayed by default', async () => {
			proxy.loseReplyTo(/insert into `yass_noreplay_ledger`/i);
			const error = await rejectionOf(
				Ledger.withDbh((db, table) =>
					db.pquery(`insert into \`${table}\` (note) values ('raw')`),
				),
			);
			expect(error && error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
			expect(await count('yass_noreplay_ledger')).to.equal(1);
		});

		it('withDbh(callback, {}, { idempotent: true }) is retried', async () => {
			let attempts = 0;
			proxy.loseReplyTo(/insert ignore into `yass_noreplay_ledger`/i);
			await Ledger.withDbh(
				(db, table) => {
					attempts += 1;
					return db.pquery(
						`insert ignore into \`${table}\` (id, note) values (77, 'ignored-twice')`,
					);
				},
				{},
				{ idempotent: true },
			);
			expect(proxy.state.dropped).to.equal(1);
			expect(attempts).to.equal(2);
			expect(await count('yass_noreplay_ledger')).to.equal(1);
		});
	});

	describe('Layer 2: writes that are safe to replay', () => {
		it('create() on a uuidKey table: the INSERT lost its reply, the replay finds the row the first attempt wrote', async () => {
			proxy.loseReplyTo(/insert into `yass_noreplay_uuid`/i);
			const thing = await UuidThing.create({ name: 'once', score: 1 });

			expect(proxy.state.dropped).to.equal(1);
			expect(thing.id).to.be.a('string');
			expect(thing.name).to.equal('once');
			expect(await count('yass_noreplay_uuid')).to.equal(1);
			expect(
				await count('yass_noreplay_uuid', 'id=:id', { id: thing.id }),
			).to.equal(1);
		});

		it('create() on a uuidKey table: the read-back lost its reply after the INSERT landed', async () => {
			proxy.loseReplyTo(/select \* from `yass_noreplay_uuid`/i);
			const thing = await UuidThing.create({ name: 'read-back', score: 2 });

			expect(proxy.state.dropped).to.equal(1);
			expect(thing.name).to.equal('read-back');
			expect(await count('yass_noreplay_uuid')).to.equal(1);
		});

		it('create() on a uuidKey table with a caller-chosen id is not replayed (the id is not ours)', async () => {
			proxy.loseReplyTo(/insert into `yass_noreplay_uuid`/i);
			const error = await rejectionOf(
				UuidThing.create({
					id: '22222222-2222-4222-8222-222222222222',
					name: 'given',
				}),
			);
			expect(error && error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
			expect(await count('yass_noreplay_uuid')).to.equal(1);
		});

		it('create() on an auto-increment table is not replayed', async () => {
			proxy.loseReplyTo(/insert into `yass_noreplay_ledger`/i);
			const error = await rejectionOf(Ledger.create({ note: 'auto' }));

			expect(proxy.state.dropped).to.equal(1);
			expect(error && error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
			expect(await count('yass_noreplay_ledger')).to.equal(1);
		});

		it('patch() with absolute values is replayed', async () => {
			const thing = await UuidThing.create({ name: 'p', score: 1 });
			proxy.loseReplyTo(/update `yass_noreplay_uuid`/i);
			await thing.patch({ score: 5 });

			expect(proxy.state.dropped).to.equal(1);
			expect(thing.score).to.equal(5);
			expect(await count('yass_noreplay_uuid', 'score=5')).to.equal(1);
		});

		it('reallyDelete() is not replayed', async () => {
			const thing = await UuidThing.create({ name: 'gone', score: 1 });
			proxy.loseReplyTo(/delete from `yass_noreplay_uuid`/i);
			const error = await rejectionOf(thing.reallyDelete());

			expect(proxy.state.dropped).to.equal(1);
			expect(error && error.code).to.equal('ERR_WRITE_OUTCOME_UNKNOWN');
			expect(await count('yass_noreplay_uuid')).to.equal(0);
		});
	});
});
