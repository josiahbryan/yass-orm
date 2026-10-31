const config = require('./config');

/**
 * Split `schema.table` into `{ database, tableName }`.
 *
 * Mirrors the same handling `mysqlSchemaUpdate` uses: a `db.table` form
 * pins the schema explicitly; a bare `table` uses the configured DB. Kept
 * out of `parseIdField` because that helper is for the DIFFERENT dot-form
 * that carries the ID field name.
 */
function splitDbAndTable(tableInput) {
	if (typeof tableInput === 'string' && tableInput.includes('.')) {
		const [dbParsed, tableName] = tableInput.split('.');
		return { database: dbParsed, tableName };
	}
	return { database: config.schema, tableName: tableInput };
}

module.exports = { splitDbAndTable };
