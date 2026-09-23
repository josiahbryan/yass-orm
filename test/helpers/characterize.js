/**
 * Shared setup for the characterization tests (test/obj.characterize.*.test.js).
 * They run on whichever database the active config points at: MySQL in
 * `npm test`, Postgres in `npm run test:postgres`.
 *
 * Their names sort after test/dbh.*: those suites call closeAllConnections(),
 * and a handle a model or schema sync cached before that stays closed (a
 * known bug, pending in test/obj.characterize.contract.test.js).
 */
const YassORM = require('../../lib');
const config = require('../../lib/config');
const { dbh } = require('../../lib/dbh');
const { syncSchemaToDb } = require('../../lib/sync-to-db');

const isPostgres = () =>
	['postgres', 'postgresql'].includes(config.dialect || 'mysql');

const quoteTable = (table) => (isPostgres() ? `"${table}"` : `\`${table}\``);

const dropTable = async (table) => {
	const conn = await dbh();
	await conn.pquery(`DROP TABLE IF EXISTS ${quoteTable(table)}`);
};

/**
 * Drops and re-creates the table for each definition, so every run starts
 * empty. Syncs a fresh convertDefinition() each time (never `Model.schema()`,
 * which the sync mutates) and only once per table per process.
 *
 * @param {Function[]} definitions Definition functions
 */
const recreateTables = async (definitions) => {
	// In order: each one's errors are reported against its own table.
	// eslint-disable-next-line no-restricted-syntax
	for (const definition of definitions) {
		const schema = YassORM.convertDefinition(definition);
		// eslint-disable-next-line no-await-in-loop
		await dropTable(schema.table);
		// eslint-disable-next-line no-await-in-loop
		const { errors } = await syncSchemaToDb(schema);
		if (errors.length) {
			throw new Error(
				`schema sync failed for ${schema.table}: ${errors
					.map((e) => e.message || e)
					.join('; ')}`,
			);
		}
	}
};

const ROLLBACK = new Error('intentional rollback');

/** Awaits a transaction expected to roll back by throwing ROLLBACK. */
const rollingBack = async (promise) => {
	try {
		await promise;
	} catch (err) {
		if (err !== ROLLBACK) throw err;
		return;
	}
	throw new Error('expected the transaction to roll back');
};

/** The error `promise` rejects with, or undefined if it resolves. */
const rejectionOf = async (promise) => {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	return undefined;
};

module.exports = {
	rejectionOf,
	isPostgres,
	quoteTable,
	dropTable,
	recreateTables,
	ROLLBACK,
	rollingBack,
};
