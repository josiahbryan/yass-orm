/* eslint-disable no-console */
const chalk = require('chalk');

const LARGE_INDEX_BUILD_ROWS = 1000000;
const LARGE_INDEX_BUILD_BYTES = 1073741824;

const REPLICA_NOTE =
	'Replicas apply DDL serially, so they will lag for the duration of this build.';

/**
 * Message for an index build on a large table, or null when the table is below both thresholds.
 * A null estimate counts as 0.
 */
function describeLargeIndexBuild({ table, rows, bytes, sql }) {
	const r = rows == null ? 0 : Number(rows);
	const b = bytes == null ? 0 : Number(bytes);
	if (!(r >= LARGE_INDEX_BUILD_ROWS || b >= LARGE_INDEX_BUILD_BYTES)) {
		return null;
	}
	return (
		`LARGE INDEX BUILD on ${table}: ~${r} rows, ${b} bytes (data+index); both are ESTIMATES from information_schema (TABLE_ROWS may be cached up to information_schema_stats_expiry). ` +
		`This CREATE INDEX will take a while: ${sql}. ${REPLICA_NOTE} Proceeding anyway.`
	);
}

function describeUnknownIndexBuildSize({ table, sql, error }) {
	const reason = error && error.message ? error.message : String(error);
	return (
		`Index build on ${table}: table size is unknown (${reason}); it may be large. ` +
		`${sql}. ${REPLICA_NOTE} Proceeding anyway.`
	);
}

/**
 * Warn (never block, never throw) before building an index on a large table.
 */
async function warnIfLargeIndexBuild({ dialect, handle, tableInput, sql }) {
	try {
		let size;
		try {
			size = await dialect.estimateTableSize(handle, tableInput);
		} catch (error) {
			console.warn(
				chalk.yellow(
					describeUnknownIndexBuildSize({ table: tableInput, sql, error }),
				),
			);
			return;
		}
		if (size === undefined) {
			return;
		}
		const message = describeLargeIndexBuild({
			table: tableInput,
			rows: size && size.rows,
			bytes: size && size.bytes,
			sql,
		});
		if (message) {
			console.warn(chalk.yellow(message));
		}
	} catch (e) {
		// A warning helper must never prevent the create.
	}
}

module.exports = {
	LARGE_INDEX_BUILD_ROWS,
	LARGE_INDEX_BUILD_BYTES,
	describeLargeIndexBuild,
	describeUnknownIndexBuildSize,
	warnIfLargeIndexBuild,
};
