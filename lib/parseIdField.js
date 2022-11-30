const parseIdField = (table) => {
	const split = table.split('.');
	if (split.length > 2) {
		const idField = split.pop();
		return { table: split.join('.'), idField };
	}
	return { table, idField: 'id' };
};

exports.parseIdField = parseIdField;
