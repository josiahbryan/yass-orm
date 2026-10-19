/* eslint-disable no-console */
// MySQL's legacy comparator ignored every varchar width difference. Reconcile
// widening only; a narrower declaration must never truncate accumulated data.
const LEGACY_INDEX_BYTES = 767;
const LARGE_INDEX_BYTES = 3072;
const DEFAULT_PAGE_BYTES = 16384;
const MIN_PAGE_BYTES = 4096;
const PAGE_INDEX_RATIO = 3 / 16;

function varcharWidth(type) {
	const match = /^varchar\((\d+)\)$/i.exec(`${type}`);
	return match ? Number(match[1]) : null;
}

async function preserveUnsafeVarcharWidths(
	handle,
	database,
	table,
	fields,
	columns,
) {
	const widening = fields.filter((field) => {
		const old = varcharWidth(columns[field.field]?.type);
		const next = varcharWidth(field.type);
		return old !== null && next !== null && next > old;
	});
	let indexes = [];
	let budget = LEGACY_INDEX_BYTES;
	if (widening.length) {
		indexes = await handle.pquery(
			`SELECT s.INDEX_NAME AS indexName, s.COLUMN_NAME AS columnName,
			 s.SUB_PART AS prefixLength, c.CHARACTER_MAXIMUM_LENGTH AS charLength,
			 c.CHARACTER_OCTET_LENGTH AS octetLength
			 FROM information_schema.STATISTICS s
			 LEFT JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=s.TABLE_SCHEMA
			 AND c.TABLE_NAME=s.TABLE_NAME AND c.COLUMN_NAME=s.COLUMN_NAME
			 WHERE s.TABLE_SCHEMA=:database AND s.TABLE_NAME=:table AND s.INDEX_TYPE='BTREE'`,
			{ database, table },
		);
		const rows = await handle.pquery(
			`SELECT ROW_FORMAT AS rowFormat FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA=:database AND TABLE_NAME=:table`,
			{ database, table },
		);
		const pages = await handle.pquery('SELECT @@innodb_page_size AS pageBytes');
		const page = Number(pages[0]?.pageBytes);
		if (
			['DYNAMIC', 'COMPRESSED'].includes(
				`${rows[0]?.rowFormat}`.toUpperCase(),
			) &&
			page >= MIN_PAGE_BYTES
		) {
			budget = Math.min(
				LARGE_INDEX_BYTES,
				Math.min(page, DEFAULT_PAGE_BYTES) * PAGE_INDEX_RATIO,
			);
		}
	}
	fields.forEach((input) => {
		const field = input;
		const oldType = columns[field.field]?.type;
		const old = varcharWidth(oldType);
		const next = varcharWidth(field.type);
		if (old === null || next === null || old === next) return;
		let reason = next < old ? 'narrowing_preserved' : null;
		if (!reason) {
			const names = new Set(
				indexes
					.filter((row) => row.columnName === field.field)
					.map((row) => row.indexName),
			);
			names.forEach((name) => {
				const bytes = indexes
					.filter((row) => row.indexName === name)
					.reduce((sum, row) => {
						const chars = Number(row.charLength);
						const octets = Number(row.octetLength);
						// Unknown/non-character/expression members cannot prove safe widening.
						if (!(chars > 0) || !(octets > 0)) return Infinity;
						const declared = fields.find(
							(candidate) => candidate.field === row.columnName,
						);
						const width = Math.max(
							chars,
							varcharWidth(declared?.type) || chars,
						);
						const length = row.prefixLength
							? Math.min(Number(row.prefixLength), width)
							: width;
						return sum + length * (octets / chars);
					}, 0);
				if (bytes > budget) reason = 'index_limit_preserved';
			});
		}
		if (reason) {
			// Once per column in this sync, metadata only; no row values.
			console.warn(
				`[varchar-width] ${reason}: ${database}.${table}.${field.field}`,
			);
			// Preserve the old width even if another property triggers a CHANGE.
			field.type = oldType;
		}
	});
}

module.exports = { preserveUnsafeVarcharWidths };
