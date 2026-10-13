/* eslint-disable no-console */

/**
 * The end-of-run list of every schema-sync error that bin/schema-sync counts.
 *
 * syncSchemaToDb() returns `{ table, applied, failed, errors }` per table, each
 * error an `{ table, description, sql, error }` record (sync-to-db.js and
 * sync-triggers.js both record that shape). The bin sums `failed` to decide
 * its exit code; this prints the records behind that count, so a failed sync
 * says what failed instead of only how many.
 *
 * Only the DB error's code / errno / message are printed, never the error
 * object itself: driver errors can carry the connection config.
 */

const SQL_PREVIEW_MAX = 300;
const MESSAGE_MAX = 500;

function oneLine(text) {
	return String(text).replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}... (truncated, ${text.length} chars)`;
}

// The server's own message. mariadb puts it in `text` (its `message` adds a
// connection prefix and echoes the SQL back); mysql2 in `sqlMessage`.
// dbh.wrapQueryError keeps the driver error as `cause`.
function errorMessage(error) {
	const { cause } = error;
	const fromCause = cause && typeof cause === 'object' ? cause : {};
	return (
		error.sqlMessage ||
		error.text ||
		fromCause.sqlMessage ||
		fromCause.text ||
		error.message ||
		fromCause.message ||
		'(no message)'
	);
}

function describeError(error) {
	if (error == null) return '(no error recorded)';
	if (typeof error !== 'object') return truncate(oneLine(error), MESSAGE_MAX);
	// dbh.wrapQueryError copies code/errno onto the wrapper, so no cause lookup.
	const tags = [];
	if (error.code != null) tags.push(`code=${error.code}`);
	if (error.errno != null) tags.push(`errno=${error.errno}`);
	const message = truncate(oneLine(errorMessage(error)), MESSAGE_MAX);
	return tags.length ? `[${tags.join(' ')}] ${message}` : message;
}

/**
 * @param {Array<{table: string, failed: number, errors: Array}>} results
 * @returns {string|null} the summary, or null when nothing failed
 */
function formatSyncErrorSummary(results) {
	const byTable = new Map();
	let total = 0;
	results.forEach((result) => {
		if (!(result.failed > 0)) return;
		total += result.failed;
		// Group by the result's table: one result is one def, while its records
		// name the table in different forms (mysqlSchemaUpdate's quoted
		// `widgets`, sync-triggers' bare widgets).
		const table = result.table || '(unknown table)';
		if (!byTable.has(table)) byTable.set(table, []);
		byTable.get(table).push(...result.errors);
	});
	if (total === 0) return null;

	const tables = Array.from(byTable.keys()).sort();
	const lines = [
		'',
		`===== schema-sync error summary: ${total} error(s) in ${tables.length} table(s) =====`,
	];
	tables.forEach((table) => {
		const records = byTable.get(table);
		lines.push('', `[${table}] ${records.length} error(s)`);
		records.forEach((record, i) => {
			lines.push(`  ${i + 1}. ${record.description || '(no description)'}`);
			if (record.sql) {
				lines.push(
					`     SQL:   ${truncate(oneLine(record.sql), SQL_PREVIEW_MAX)}`,
				);
			}
			lines.push(`     Error: ${describeError(record.error)}`);
		});
	});
	lines.push('', '===== end of schema-sync error summary =====');
	return lines.join('\n');
}

/**
 * Print the error summary (when anything failed) and the final count line.
 * Returns the exit code bin/schema-sync uses: 1 if anything failed, else 0.
 */
function reportSyncResults(results, { log = console.error } = {}) {
	const summary = formatSyncErrorSummary(results);
	if (!summary) return 0;
	const total = results.reduce((sum, r) => sum + (r.failed || 0), 0);
	log(summary);
	log(
		`\n${total} schema-sync error(s) across ${results.length} table(s). Exiting non-zero.`,
	);
	return 1;
}

module.exports = { formatSyncErrorSummary, reportSyncResults };
