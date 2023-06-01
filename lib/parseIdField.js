import config from './config.js';

const parseIdField = (table) => {
	// If 'enableAlternateSchemaInTableName' is enabled, then to use the ID-in-table-name,
	// the ID field gets put in the third dot slot, like "schema.table.id".
	// However, by default, with enableAlternateSchemaInTableName disabled,
	// the id field is in the second dot slot, like "table.id".
	const idHeuristicDotLength = config.enableAlternateSchemaInTableName ? 2 : 1;
	const split = table.split('.');
	if (split.length > idHeuristicDotLength) {
		const idField = split.pop();
		const res = { table: split.join('.'), idField };
		// console.log(`parseIdField: [heuristic] ${table} -> ${JSON.stringify(res)}`);
		return res;
	}
	const res = { table, idField: 'id' };
	// console.log(`parseIdField: [default] ${table} -> ${JSON.stringify(res)}`);
	return res;
};

export { parseIdField };
