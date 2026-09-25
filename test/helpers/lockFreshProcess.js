/**
 * A fresh process taking its first lockKey() on the database the active
 * config points at (test/sql-helpers.lock-table.test.js runs it): nothing in
 * this process has made or seen `yass_locks` yet, as in a service that just
 * started. Prints one JSON line, `{ ok: true }` or `{ ok: false, code,
 * message }`, and exits.
 *
 *   node test/helpers/lockFreshProcess.js <mode> <key>
 *
 * Modes (what the process does before its first transaction):
 * - `sync`: syncs a table's schema, as a service's startup (or a deploy)
 *   does;
 * - `ensure`: calls sqlHelpers.ensureLockTable(db) (no schema sync);
 * - `none`: nothing (lockKey() is the first to need the table); the
 *   transaction runs with `maxRetries: 1`;
 * - `rollback`: nothing, and the transaction locks first and then throws
 *   (ok when that throw is what comes out).
 *
 * Then, in one transaction, it reads a row (on MySQL that fixes the
 * transaction's snapshot) and then locks `key`.
 */
const YassORM = require('../../lib');
const sql = require('../../lib/sql-helpers');
const { dbh, closeAllConnections } = require('../../lib/dbh');
const { syncSchemaToDb } = require('../../lib/sync-to-db');

const [mode, key] = process.argv.slice(2);

const definition = ({ types: t }) => ({
	table: 'yass_lock_fresh',
	schema: { id: t.stringKey, name: t.string },
});

const main = async () => {
	const schema = YassORM.convertDefinition(definition);
	if (mode === 'sync') {
		const { errors } = await syncSchemaToDb(schema);
		if (errors.length) {
			throw new Error(errors.map((e) => e.message || e).join('; '));
		}
	}
	const conn = await dbh();
	if (mode === 'ensure') {
		await sql.ensureLockTable(conn);
	}
	const table = conn.escapeId(schema.table);
	if (mode === 'rollback') {
		const boom = new Error('intentional rollback');
		try {
			await conn.transaction(async (tx) => {
				await sql.lockKey(tx, key);
				throw boom;
			});
		} catch (error) {
			if (error !== boom) throw error;
		}
		return;
	}
	await conn.transaction(
		async (tx) => {
			await tx.pquery(`SELECT * FROM ${table}`);
			await sql.lockKey(tx, key);
		},
		mode === 'none' ? { maxRetries: 1 } : {},
	);
};

main()
	.then(
		() => ({ ok: true }),
		(error) => ({
			ok: false,
			code: error.code || (error.cause && error.cause.code) || null,
			message: error.message,
		}),
	)
	.then(async (result) => {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		await closeAllConnections().catch(() => {});
		process.exit(0);
	});
