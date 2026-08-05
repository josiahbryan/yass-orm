/* eslint-disable no-console, no-await-in-loop, no-restricted-syntax, no-continue */
/**
 * Link-collation migration tooling.
 *
 * Canonicalizes the collation of EXISTING char(36) UUID-style link/uuid columns to
 * match the uuid PRIMARY KEY collation (utf8mb4_bin) so cross-column JOINs become
 * index-sargable. This is the "existing data" half of the fix -- the source change
 * in def-to-schema handles NEW columns; this handles what is already in the DB.
 *
 * TWO PARTS:
 *   1. GENERATOR (read-only): `generateLinkCollationManifest` queries
 *      information_schema for every char(36) column whose collation != target and
 *      emits an ordered manifest of per-table ALTERs. The ALTER SQL is produced by
 *      the DIALECT (same DDL path schema-sync uses), never hand-authored.
 *   2. RUNNER: `runLinkCollationMigration` executes the manifest ONE TABLE AT A TIME,
 *      RESUMABLE (persists completed items to a state store), idempotent (verify-after
 *      + skip already-canonical), with dry-run, disk precheck, big-table online DDL
 *      (gh-ost / pt-online-schema-change), rate-limiting and a per-run stopAfter cap
 *      so it can run overnight / on a schedule / stop-and-continue.
 *
 * Everything the runner touches externally (SQL exec, verify, disk check, sleep) is
 * dependency-injected so it is fully unit-testable WITHOUT a live database. The CLI
 * (bin/migrate-link-collation) wires the real implementations.
 */
const fs = require('fs');
const { CANONICAL_UUID_COLLATION } = require('../uuid-collation');

const DEFAULT_BIG_TABLE_ROW_THRESHOLD = 1_000_000;
const DEFAULT_BIG_TABLE_BYTE_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2 GiB
// Rough throughput heuristic for a COPY-algorithm rebuild; only used for the
// human-facing time estimate in dry-run, never for correctness.
const REBUILD_BYTES_PER_SEC = 40 * 1024 * 1024; // ~40 MiB/s

function key(item) {
	return `${item.table}.${item.column}`;
}

/**
 * Build the `MODIFY <fieldspec>` clause used both for the direct ALTER and for the
 * online-DDL tools' --alter argument. Sourced from the dialect's own field-spec
 * generator so it stays consistent with schema-sync.
 */
function buildModifyClause(dialect, item, targetCollation) {
	const fieldData = {
		field: item.column,
		type: 'char(36)',
		collation: targetCollation,
		// Preserve nullability; default to NOT NULL only when the DB says NOT NULL.
		null: item.isNullable ? 1 : 0,
	};
	// generateFieldSpec -> "`col` char(36) COLLATE utf8mb4_bin [NOT NULL]"
	return `MODIFY ${dialect.generateFieldSpec(fieldData, { ignore: ['key'] })}`;
}

/**
 * Build the full direct ALTER statement via the dialect (schema-sync's DDL path).
 */
function buildDirectAlter(dialect, item, targetCollation) {
	return dialect.generateAlterModifyColumn(item.table, {
		field: item.column,
		type: 'char(36)',
		collation: targetCollation,
		null: item.isNullable ? 1 : 0,
	});
}

/**
 * Build an online-DDL command string (gh-ost or pt-online-schema-change).
 * Returned as a string for logging/inspection; the runner passes it to the injected
 * `executeOnline`. Never executed here.
 */
function buildOnlineCommand({ tool, database, item, modifyClause }) {
	if (tool === 'pt-osc' || tool === 'pt-online-schema-change') {
		return (
			`pt-online-schema-change ` +
			`--alter=${JSON.stringify(modifyClause.replace(/^MODIFY /, ''))} ` +
			`D=${database},t=${item.table} --execute`
		);
	}
	// default: gh-ost
	return (
		`gh-ost ` +
		`--alter=${JSON.stringify(modifyClause.replace(/^MODIFY /, ''))} ` +
		`--database=${database} --table=${item.table} --execute`
	);
}

function humanBytes(n) {
	if (!Number.isFinite(n)) return 'unknown';
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function estimateSeconds(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return 0;
	return Math.ceil(bytes / REBUILD_BYTES_PER_SEC);
}

/**
 * GENERATOR (read-only). Returns an ordered manifest of per-column ALTERs.
 *
 * @param {object}   opts
 * @param {object}   opts.handle    - db handle with async query(sql, params)
 * @param {string}   opts.database  - schema/database name to scan
 * @param {object}   opts.dialect   - dialect instance (DDL generation)
 * @param {string}  [opts.targetCollation=utf8mb4_bin]
 * @param {number}  [opts.bigTableRowThreshold]
 * @param {number}  [opts.bigTableByteThreshold]
 * @param {'gh-ost'|'pt-osc'} [opts.onlineTool='gh-ost']
 * @returns {Promise<object>} manifest
 */
async function generateLinkCollationManifest({
	handle,
	database,
	dialect,
	targetCollation = CANONICAL_UUID_COLLATION,
	bigTableRowThreshold = DEFAULT_BIG_TABLE_ROW_THRESHOLD,
	bigTableByteThreshold = DEFAULT_BIG_TABLE_BYTE_THRESHOLD,
	onlineTool = 'gh-ost',
} = {}) {
	if (!handle || typeof handle.query !== 'function') {
		throw new Error('generateLinkCollationManifest: handle.query is required');
	}
	if (!database) {
		throw new Error('generateLinkCollationManifest: database is required');
	}
	if (!dialect) {
		throw new Error('generateLinkCollationManifest: dialect is required');
	}

	// Read-only: find char(36) columns whose collation differs from the target,
	// smallest tables first so the batch racks up quick wins and the operator hits
	// the big/online-DDL tables last, knowingly.
	const rows = await handle.query(
		`SELECT c.TABLE_NAME  AS tableName,
		        c.COLUMN_NAME AS columnName,
		        c.COLLATION_NAME AS collationName,
		        c.COLUMN_TYPE AS columnType,
		        c.IS_NULLABLE AS isNullable,
		        t.TABLE_ROWS  AS tableRows,
		        (COALESCE(t.DATA_LENGTH,0) + COALESCE(t.INDEX_LENGTH,0)) AS totalBytes
		   FROM information_schema.COLUMNS c
		   JOIN information_schema.TABLES  t
		     ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
		    AND t.TABLE_NAME   = c.TABLE_NAME
		  WHERE c.TABLE_SCHEMA = ?
		    AND c.DATA_TYPE = 'char'
		    AND c.CHARACTER_MAXIMUM_LENGTH = 36
		    AND c.COLLATION_NAME IS NOT NULL
		    AND c.COLLATION_NAME <> ?
		    AND t.TABLE_TYPE = 'BASE TABLE'
		  ORDER BY totalBytes ASC, c.TABLE_NAME ASC, c.COLUMN_NAME ASC`,
		[database, targetCollation],
	);

	const items = (rows || []).map((r) => {
		const estRows = Number(r.tableRows) || 0;
		const estDataBytes = Number(r.totalBytes) || 0;
		const big =
			estRows >= bigTableRowThreshold || estDataBytes >= bigTableByteThreshold;
		const isNullable = `${r.isNullable}`.toUpperCase() === 'YES';
		const item = {
			table: r.tableName,
			column: r.columnName,
			currentCollation: r.collationName,
			dataType: r.columnType || 'char(36)',
			isNullable,
			estRows,
			estDataBytes,
			big,
			strategy: big ? 'online' : 'direct',
		};
		const modifyClause = buildModifyClause(dialect, item, targetCollation);
		item.alterSql = buildDirectAlter(dialect, item, targetCollation);
		item.onlineCommand = buildOnlineCommand({
			tool: onlineTool,
			database,
			item,
			modifyClause,
		});
		item.estSeconds = estimateSeconds(estDataBytes);
		return item;
	});

	const totalBytes = items.reduce((s, i) => s + i.estDataBytes, 0);
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		database,
		targetCollation,
		onlineTool,
		summary: {
			columns: items.length,
			tables: new Set(items.map((i) => i.table)).size,
			bigTables: new Set(items.filter((i) => i.big).map((i) => i.table)).size,
			totalBytes,
			estSeconds: estimateSeconds(totalBytes),
		},
		items,
	};
}

/**
 * File-backed resumable state store. Records completed items so a stopped/crashed
 * run resumes exactly where it left off.
 */
function createFileStateStore(filePath) {
	return {
		filePath,
		load() {
			try {
				return JSON.parse(fs.readFileSync(filePath, 'utf8'));
			} catch (e) {
				return { completed: [], startedAt: null, updatedAt: null };
			}
		},
		save(state) {
			fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
		},
	};
}

/** In-memory state store (used by tests / dry runs). */
function createMemoryStateStore(initial) {
	let state = initial || { completed: [], startedAt: null, updatedAt: null };
	return {
		load() {
			return JSON.parse(JSON.stringify(state));
		},
		save(next) {
			state = JSON.parse(JSON.stringify(next));
		},
	};
}

/**
 * RUNNER. Executes the manifest one table/column at a time.
 *
 * @param {object}   opts
 * @param {object}   opts.manifest      - from generateLinkCollationManifest
 * @param {object}   opts.stateStore    - { load(), save(state) } (file or memory)
 * @param {function} opts.execute       - async ({item}) => void  (direct ALTER)
 * @param {function} [opts.executeOnline] - async ({item}) => void (big tables)
 * @param {function} opts.verify        - async ({item}) => string (current collation)
 * @param {boolean}  [opts.dryRun=false]
 * @param {function} [opts.checkDiskSpace] - async () => freeBytes (precheck)
 * @param {function} [opts.sleep]       - async (ms) => void (rate limiting)
 * @param {number}   [opts.rateLimitMs=0]
 * @param {number}   [opts.stopAfter=Infinity] - max items to apply THIS run
 * @param {boolean}  [opts.continueOnError=false]
 * @param {object}   [opts.logger=console]
 * @returns {Promise<object>} run report
 */
async function runLinkCollationMigration({
	manifest,
	stateStore,
	execute,
	executeOnline,
	verify,
	dryRun = false,
	checkDiskSpace,
	sleep,
	rateLimitMs = 0,
	stopAfter = Infinity,
	continueOnError = false,
	logger = console,
} = {}) {
	if (!manifest || !Array.isArray(manifest.items)) {
		throw new Error('runLinkCollationMigration: manifest.items is required');
	}
	if (!stateStore) {
		throw new Error('runLinkCollationMigration: stateStore is required');
	}
	if (!dryRun && typeof verify !== 'function') {
		throw new Error(
			'runLinkCollationMigration: verify is required (non-dry-run)',
		);
	}

	const targetCollation = manifest.targetCollation || CANONICAL_UUID_COLLATION;
	const state = stateStore.load();
	state.completed = state.completed || [];
	state.startedAt = state.startedAt || new Date().toISOString();
	const done = new Set(state.completed);

	const report = {
		dryRun,
		targetCollation,
		total: manifest.items.length,
		applied: [],
		skipped: [],
		errors: [],
		plan: [],
		stoppedEarly: false,
	};

	// Disk precheck: a COPY/online rebuild needs roughly the largest table's size
	// free. Refuse up front rather than fail mid-rebuild.
	if (typeof checkDiskSpace === 'function') {
		const free = await checkDiskSpace();
		const largest = manifest.items.reduce(
			(m, i) => Math.max(m, i.estDataBytes || 0),
			0,
		);
		report.diskFreeBytes = free;
		report.largestTableBytes = largest;
		if (Number.isFinite(free) && free < largest) {
			throw new Error(
				`Insufficient disk: need ~${humanBytes(
					largest,
				)} free for the largest ` +
					`table rebuild, only ${humanBytes(
						free,
					)} available. Free space or lower ` +
					`the big-table threshold and use online DDL.`,
			);
		}
	}

	let appliedThisRun = 0;
	for (const item of manifest.items) {
		const id = key(item);

		// Resumable: already completed in a prior run.
		if (done.has(id)) {
			report.skipped.push({ id, reason: 'already-completed' });
			continue;
		}

		// Dry-run: just record the plan; no DB touch, no state mutation.
		if (dryRun) {
			report.plan.push({
				id,
				strategy: item.strategy,
				estRows: item.estRows,
				estBytes: item.estDataBytes,
				estHuman: humanBytes(item.estDataBytes),
				estSeconds: item.estSeconds,
				sql: item.strategy === 'online' ? item.onlineCommand : item.alterSql,
			});
			continue;
		}

		if (appliedThisRun >= stopAfter) {
			report.stoppedEarly = true;
			break;
		}

		// Idempotent: verify BEFORE doing work -- if already canonical (e.g. a prior
		// run applied it but crashed before recording state), just mark done.
		try {
			const before = await verify({ item });
			if (`${before || ''}`.toLowerCase() === targetCollation.toLowerCase()) {
				done.add(id);
				state.completed = [...done];
				state.updatedAt = new Date().toISOString();
				stateStore.save(state);
				report.skipped.push({ id, reason: 'already-canonical' });
				continue;
			}

			// Apply: online DDL for big tables (if provided), else direct ALTER.
			if (item.strategy === 'online' && typeof executeOnline === 'function') {
				await executeOnline({ item });
			} else {
				await execute({ item });
			}

			// Verify-after: confirm the new collation actually landed.
			const after = await verify({ item });
			if (`${after || ''}`.toLowerCase() !== targetCollation.toLowerCase()) {
				const err = {
					id,
					error: `verify-after mismatch: expected ${targetCollation}, got ${after}`,
				};
				report.errors.push(err);
				if (!continueOnError) {
					report.stoppedEarly = true;
					logger.error(`[link-collation] ${err.error} -- halting run`);
					break;
				}
				continue;
			}

			done.add(id);
			state.completed = [...done];
			state.updatedAt = new Date().toISOString();
			stateStore.save(state);
			report.applied.push({ id, strategy: item.strategy });
			appliedThisRun += 1;

			if (rateLimitMs > 0 && typeof sleep === 'function') {
				await sleep(rateLimitMs);
			}
		} catch (ex) {
			const err = { id, error: ex.message };
			report.errors.push(err);
			logger.error(`[link-collation] failed ${id}: ${ex.message}`);
			if (!continueOnError) {
				report.stoppedEarly = true;
				break;
			}
		}
	}

	report.remaining = manifest.items.filter((i) => !done.has(key(i))).length;
	return report;
}

module.exports = {
	CANONICAL_UUID_COLLATION,
	DEFAULT_BIG_TABLE_ROW_THRESHOLD,
	DEFAULT_BIG_TABLE_BYTE_THRESHOLD,
	generateLinkCollationManifest,
	runLinkCollationMigration,
	createFileStateStore,
	createMemoryStateStore,
	buildModifyClause,
	buildDirectAlter,
	buildOnlineCommand,
	humanBytes,
	estimateSeconds,
};
