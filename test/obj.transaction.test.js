/* eslint-disable no-unused-expressions */
/* global describe, it, before, after, beforeEach */
const { expect } = require('chai');
const { dbh } = require('../lib/dbh');

const TxNode = require('./fixtures/tx-node');
const TxEdge = require('./fixtures/tx-edge');

/**
 * Model-level transaction binding — `Model.create(data, { tx })` and friends.
 *
 * Spec: docs/specs/2026-08-05-model-level-transaction-binding.spec.md
 *
 * Deliberately runs against live MySQL/MariaDB rather than SQLite. SQLite
 * serializes ordinary parent-handle queries behind an active transaction, so a
 * read that FAILED to join the transaction would hang instead of returning the
 * wrong answer — which makes the red phase uninformative. On MySQL an
 * un-joined read simply cannot see the uncommitted row, which is the exact
 * silent failure these tests exist to catch.
 */
describe('#YASS-ORM Model-level transactions ({ tx })', function txSuite() {
	// DDL + live transactions against MySQL comfortably exceed mocha's 2s default.
	this.timeout(30000);

	let conn;

	// Thrown to force a rollback once in-transaction assertions have been captured.
	const ROLLBACK = new Error('intentional rollback');

	const nodeTable = 'test.yass_tx_node';
	const edgeTable = 'test.yass_tx_edge';

	const rows = async (sql, args) =>
		Array.from((await conn.pquery(sql, args)) || []);

	before(async () => {
		conn = await dbh();
		await conn.query(`DROP TABLE IF EXISTS ${edgeTable}`);
		await conn.query(`DROP TABLE IF EXISTS ${nodeTable}`);
		await conn.query(`
			CREATE TABLE ${nodeTable} (
				id INT PRIMARY KEY AUTO_INCREMENT,
				name VARCHAR(255),
				isDeleted TINYINT DEFAULT 0,
				createdBy INT NULL,
				createdAt DATETIME NULL,
				updatedBy INT NULL,
				updatedAt DATETIME NULL
			) ENGINE=InnoDB
		`);
		await conn.query(`
			CREATE TABLE ${edgeTable} (
				id INT PRIMARY KEY AUTO_INCREMENT,
				label VARCHAR(255),
				fromNode INT NULL,
				toNode INT NULL,
				isDeleted TINYINT DEFAULT 0,
				createdBy INT NULL,
				createdAt DATETIME NULL,
				updatedBy INT NULL,
				updatedAt DATETIME NULL
			) ENGINE=InnoDB
		`);
	});

	beforeEach(async () => {
		await conn.query(`DELETE FROM ${edgeTable}`);
		await conn.query(`DELETE FROM ${nodeTable}`);
		TxNode.clearCache();
		TxEdge.clearCache();
	});

	// NOTE: deliberately no closeAllConnections() here — this suite uses the
	// shared pool that later suites (test/test.js) also depend on.
	after(async () => {
		if (conn) {
			await conn.query(`DROP TABLE IF EXISTS ${edgeTable}`);
			await conn.query(`DROP TABLE IF EXISTS ${nodeTable}`);
		}
	});

	it('rolls back model create() writes made with { tx }', async () => {
		let caught;
		let created = [];

		try {
			await conn.transaction(async (tx) => {
				const a = await TxNode.create({ name: 'rollback-a' }, { tx });
				const b = await TxNode.create({ name: 'rollback-b' }, { tx });
				created = [a.id, b.id];
				throw ROLLBACK;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(ROLLBACK);
		expect(created.length).to.equal(2);

		const surviving = await rows(`SELECT id FROM ${nodeTable}`);
		expect(surviving).to.deep.equal([]);
	});

	it('reads its own writes through get(id, { tx }) but not outside the transaction', async () => {
		let insideValue;
		let outsideValue;
		let caught;

		try {
			await conn.transaction(async (tx) => {
				const created = await TxNode.create({ name: 'ryow' }, { tx });

				TxNode.clearCache();
				insideValue = await TxNode.get(created.id, { tx });

				TxNode.clearCache();
				outsideValue = await TxNode.get(created.id);

				throw ROLLBACK;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(ROLLBACK);
		expect(insideValue).to.be.an('object');
		expect(insideValue.name).to.equal('ryow');
		expect(outsideValue).to.equal(null);
	});

	it('searchOne({ tx }) sees uncommitted rows and searchOne() without tx does not', async () => {
		let insideValue;
		let outsideValue;
		let caught;

		try {
			await conn.transaction(async (tx) => {
				await TxNode.create({ name: 'searchable' }, { tx });

				TxNode.clearCache();
				insideValue = await TxNode.searchOne({ name: 'searchable' }, { tx });

				TxNode.clearCache();
				outsideValue = await TxNode.searchOne({ name: 'searchable' });

				throw ROLLBACK;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(ROLLBACK);
		expect(insideValue).to.be.an('object');
		expect(insideValue.name).to.equal('searchable');
		expect(outsideValue).to.equal(null);
	});

	it('resolves linked fields to real objects (not null) inside a transaction', async () => {
		let edgeFrom;
		let edgeTo;
		let expectedFrom;
		let expectedTo;
		let caught;

		try {
			await conn.transaction(async (tx) => {
				const a = await TxNode.create({ name: 'link-a' }, { tx });
				const b = await TxNode.create({ name: 'link-b' }, { tx });
				expectedFrom = a.id;
				expectedTo = b.id;

				// Without this the identity cache satisfies _resolvedLinkedModel from
				// memory and the test would pass for the wrong reason — it must be a
				// real read on the transaction's connection.
				TxNode.clearCache();
				TxEdge.clearCache();

				const edge = await TxEdge.create(
					{ label: 'a->b', fromNode: a, toNode: b },
					{ tx },
				);

				edgeFrom = edge.fromNode;
				edgeTo = edge.toNode;

				throw ROLLBACK;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(ROLLBACK);
		expect(
			edgeFrom,
			'edge.fromNode resolved to null — tx did not reach inflate',
		).to.be.an('object');
		expect(
			edgeTo,
			'edge.toNode resolved to null — tx did not reach inflate',
		).to.be.an('object');
		expect(edgeFrom.id).to.equal(expectedFrom);
		expect(edgeTo.id).to.equal(expectedTo);
		expect(edgeFrom.name).to.equal('link-a');
		expect(edgeTo.name).to.equal('link-b');
	});

	it('applies patch(data, { tx }) inside the transaction and rolls it back', async () => {
		const committed = await TxNode.create({ name: 'before-patch' });
		let insideValue;
		let caught;

		try {
			await conn.transaction(async (tx) => {
				await committed.patch({ name: 'after-patch' }, { tx });

				TxNode.clearCache();
				const reread = await TxNode.get(committed.id, { tx });
				insideValue = reread.name;

				throw ROLLBACK;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(ROLLBACK);
		expect(insideValue).to.equal('after-patch');

		const [row] = await rows(`SELECT name FROM ${nodeTable} WHERE id = :id`, {
			id: committed.id,
		});
		expect(row.name).to.equal('before-patch');
	});

	it('does NOT wrap writes in retryIfConnectionLost when { tx } is supplied', async () => {
		const original = TxNode.retryIfConnectionLost;
		let calls = 0;
		TxNode.retryIfConnectionLost = function spy(callback) {
			calls += 1;
			return original.call(this, callback);
		};

		try {
			await conn.transaction(async (tx) => {
				await TxNode.create({ name: 'no-retry' }, { tx });
				await TxNode.get(
					(
						await TxNode.searchOne({ name: 'no-retry' }, { tx })
					).id,
					{
						tx,
					},
				);
				throw ROLLBACK;
			});
		} catch (err) {
			if (err !== ROLLBACK) throw err;
		} finally {
			TxNode.retryIfConnectionLost = original;
		}

		expect(
			calls,
			'a { tx } write went through retryIfConnectionLost — a lost connection would land it OUTSIDE the transaction',
		).to.equal(0);
	});

	it('still uses retryIfConnectionLost when no { tx } is supplied', async () => {
		const original = TxNode.retryIfConnectionLost;
		let calls = 0;
		TxNode.retryIfConnectionLost = function spy(callback) {
			calls += 1;
			return original.call(this, callback);
		};

		try {
			await TxNode.create({ name: 'legacy-path' });
		} finally {
			TxNode.retryIfConnectionLost = original;
		}

		expect(calls).to.be.greaterThan(0);
	});

	it('findOrCreate(..., { tx }) joins the caller transaction instead of committing its own', async () => {
		let createdId;
		let insideValue;
		let caught;

		try {
			await conn.transaction(async (tx) => {
				const instance = await TxNode.findOrCreate(
					{ name: 'foc-joined' },
					{},
					{},
					{ tx },
				);
				createdId = instance.id;

				TxNode.clearCache();
				insideValue = await TxNode.get(createdId, { tx });

				throw ROLLBACK;
			});
		} catch (err) {
			caught = err;
		}

		expect(caught).to.equal(ROLLBACK);
		expect(createdId).to.be.ok;
		expect(insideValue).to.be.an('object');

		const surviving = await rows(`SELECT id FROM ${nodeTable}`);
		expect(
			surviving,
			'findOrCreate opened its own transaction and committed through the caller rollback',
		).to.deep.equal([]);
	});

	it('passes { tx } to afterCreateHook and afterChangeHook', async () => {
		const received = [];
		const originalCreateHook = TxNode.prototype.afterCreateHook;
		const originalChangeHook = TxNode.prototype.afterChangeHook;

		TxNode.prototype.afterCreateHook = async function hook(opts) {
			received.push({ hook: 'afterCreateHook', opts });
			return this;
		};
		TxNode.prototype.afterChangeHook = async function hook(opts) {
			received.push({ hook: 'afterChangeHook', opts });
			return this;
		};

		let handle;
		try {
			await conn.transaction(async (tx) => {
				handle = tx;
				await TxNode.create({ name: 'hooked' }, { tx });
				throw ROLLBACK;
			});
		} catch (err) {
			if (err !== ROLLBACK) throw err;
		} finally {
			TxNode.prototype.afterCreateHook = originalCreateHook;
			TxNode.prototype.afterChangeHook = originalChangeHook;
		}

		const createHook = received.find((r) => r.hook === 'afterCreateHook');
		const changeHook = received.find((r) => r.hook === 'afterChangeHook');
		expect(createHook, 'afterCreateHook never fired').to.be.ok;
		expect(changeHook, 'afterChangeHook never fired').to.be.ok;
		expect(createHook.opts && createHook.opts.tx).to.equal(handle);
		expect(changeHook.opts && changeHook.opts.tx).to.equal(handle);
	});
});
