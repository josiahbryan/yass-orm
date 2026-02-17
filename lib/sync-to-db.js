/* eslint-disable no-console, import/no-dynamic-require, global-require, no-nested-ternary, no-param-reassign */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const chalk = require('chalk');

const config = require('../lib/config');
const { dbh: factory, parseIdField, getDialect } = require('../lib/dbh');
const { jsonSafeStringify } = require('../lib/jsonSafeStringify');

const { convertDefinition } = require('../lib/def-to-schema');

// Get the dialect for this sync session
const dialect = getDialect(config.dialect || 'mysql');

const convertFile = (pathname) =>
	convertDefinition(require(path.resolve(process.cwd(), pathname)).default);

// console.log('Debug: config used: ', config);

// Allow dropping fields from tables, off by default
const ALLOW_DROP = process.env.YASS_ALLOW_DROP || false;

const DB_NAME = config.schema;
const DB_HOST = config.host;
const PASSWORD = config.password;
const USER = config.user || 'root';
const PORT = config.port || 3306;

const DISABLE_FUNCTIONS = config.disableFunctions || false;
// const SSL = config.ssl || 0;
// const CERT = config.ssl_cert_file || undef;

const DRY_RUN = false;

let dbh;
async function execQuery(sql, mutates = false) {
	if (!dbh) {
		dbh = await factory();
	}
	if (mutates && DRY_RUN) {
		return Promise.resolve();
	}

	// Silencing errors since we catch them below
	return dbh.pquery(sql, undefined, { silenceErrors: true });
}

async function promiseMap(
	list = null,
	next = (/* d, idx */) => {},
	debug = null,
) {
	const all = list || [];
	const total = all.length;
	const done = [];

	let p = Promise.resolve();
	all.forEach((d, idx) => {
		p = p
			.then(() => next(d, idx))
			.then((result) => {
				done.push(result);
				if (debug) {
					// eslint-disable-next-line no-console
					console.log(`[_batchAll:${debug}] Done ${done.length} / ${total}`);
				}
			});
		// console.log(`[updateAllFeatureData] Started: ${idx} / ${total}`);
	});
	await p;
	return done;
}

async function uploadMatchRatioFunction(host, db, user, pass, port) {
	// Skip if dialect doesn't support stored functions (e.g., SQLite)
	if (!dialect.supportsStoredFunctions) {
		return;
	}

	if (DISABLE_FUNCTIONS) {
		// console.log(
		// 	`Config 'disableFunctions' is enabled, not uploading match_ratio function`,
		// );
		return;
	}

	const functionName = `match_ratio`;

	const functions = await execQuery(
		`show function status where \`Db\`='${db}' and \`Name\`='${functionName}'`,
	);
	if (functions.length) {
		return;
	}

	const tmp = `/tmp/f${process.pid}.sql`;
	fs.writeFileSync(
		tmp,
		`
		DELIMITER //

		DROP FUNCTION  IF EXISTS \`match_ratio\` //

		CREATE FUNCTION \`match_ratio\` ( s1 text, s2 text, s3 text ) RETURNS int(11)
			DETERMINISTIC
		BEGIN
			DECLARE s1_len, s2_len, s3_len, max_len INT;
			DECLARE s3_tmp text;

			SET s1_len = LENGTH(s1),
				s2_len = LENGTH(s2);
			IF s1_len > s2_len THEN
				SET max_len = s1_len;
			ELSE
				SET max_len = s2_len;
			END IF;

			if lower(s1) like concat('%',lower(s2),'%') then
				return round((1 - (abs(s1_len - s2_len) / max_len)) * 100);
			else
				set s3_tmp = replace(s3, '%', '');
				set s3_len = length(s3_tmp);


				IF s1_len > s3_len THEN
					SET max_len = s1_len;
				ELSE
					SET max_len = s3_len;
				END IF;

				if lower(s1) like concat('%',lower(s3),'%') then
					/*round(abs(s1_len - s3len) / max_len * .5 * 100);*/
					return round((1 - (abs(s1_len - s3_len) / max_len)) * .5 * 100);
				else

					return 0;
				end if;
			end if;

		END //
		DELIMITER ;
	`,
	);

	// Cannot insert a function via the socket connection in $dbh,
	// so we have to resort to the command line
	// The fancy $(which mysql) is needed on mac for some weird path resolution reason
	const cmd = `$(which mysql) -u ${user} --password=${pass} -h ${host} -D ${db} -P ${port} < ${tmp}`;
	console.log(`Uploading match_ratio() function: ${cmd}`);
	cp.execSync(cmd);

	fs.unlinkSync(tmp);
}

async function uploadIdTrigger(host, dbInput, user, pass, port, tableInput) {
	// Skip if dialect doesn't support triggers (e.g., some SQLite configurations)
	if (!dialect.supportsTriggers) {
		return;
	}

	// Allow specifying an arbitrary schema other than configured in .yass-orm
	// by giving a table name of 'schema/table'
	const [dbParsed, tableName] = `${tableInput}`.includes('.')
		? `${tableInput}`.split('.')
		: [null, tableInput];

	const db = dbParsed || dbInput;

	const table = dbParsed
		? `\`${dbParsed}\`.\`${tableName}\``
		: `\`${tableName}\``;

	const triggerName = `before_insert_${tableName}_set_id`;

	if (DISABLE_FUNCTIONS) {
		// console.log(
		// 	`Config 'disableFunctions' is enabled, not uploading ${triggerName} trigger`,
		// );
		return;
	}

	const triggers = await execQuery(
		`show triggers where \`Trigger\`='${triggerName}'`,
	);
	if (triggers.length) {
		return;
	}

	const tmp = `/tmp/f${process.pid}.sql`;
	fs.writeFileSync(
		tmp,
		`
		DROP TRIGGER IF EXISTS ${triggerName};
		DELIMITER ;;
		CREATE TRIGGER ${triggerName}
		BEFORE INSERT ON ${table}
			FOR EACH ROW
			BEGIN
				IF (new.id IS NULL or new.id = '') THEN
					SET new.id = uuid();
				END IF;
			END
		;;
		DELIMITER ;
	`,
	);

	// Cannot insert a function via the socket connection in $dbh,
	// so we have to resort to the command line
	const cmd = `mysql -u ${user} --password=${pass} -h ${host} -D ${db} -P ${port} < ${tmp}`;
	console.log(`Uploading trigger '${triggerName}': ${cmd}`);
	cp.execSync(cmd);

	fs.unlinkSync(tmp);
}

function attachIdTrigger(table) {
	// Creates a UUID for the id field
	return uploadIdTrigger(DB_HOST, DB_NAME, USER, PASSWORD, PORT, table);
}

// Get primary key attributes from dialect (database-specific)
function getPriKeyAttrs() {
	return dialect.getIntegerPrimaryKeyAttrs();
}

function getPriKeyUuidAttrs() {
	return dialect.getUuidPrimaryKeyAttrs();
}

const jsonSupportedRef = { flag: false, checked: false };

function normalizeIndexColumnSpec(col) {
	const raw = `${col || ''}`.trim().replace(/\s+/g, ' ');
	if (!raw) {
		return raw;
	}

	// Normalize JSON accessor specs so these compare as equivalent:
	// - field->>"path"   (double quotes)
	// - field->>'$.path' (single quotes)
	// Both forms should normalize to double quotes with canonical $.path form.
	const jsonAccessorMatch = raw.match(
		/^([a-zA-Z_][a-zA-Z0-9_]*)->>(["'])([^"']+)\2$/,
	);
	if (jsonAccessorMatch) {
		const [, fieldName, , pathSpec] = jsonAccessorMatch;
		const normalizedPath = pathSpec.startsWith('$')
			? pathSpec
			: `$.${pathSpec.replace(/^\.+/, '')}`;
		// Always output with double quotes for canonical comparison
		return `${fieldName}->>"${normalizedPath}"`;
	}

	// Normalize simple identifier specs while preserving functional expressions.
	const simpleColMatch = raw.match(
		/^["`]?([a-zA-Z_][a-zA-Z0-9_]*)["`]?(?:\s+(ASC|DESC))?$/i,
	);
	if (simpleColMatch) {
		const [, colName, direction] = simpleColMatch;
		return direction ? `${colName} ${direction.toUpperCase()}` : colName;
	}

	return raw;
}

function buildIndexSignature({
	columns = [],
	fulltext = false,
	unique = false,
}) {
	return JSON.stringify({
		fulltext: !!fulltext,
		unique: !!unique,
		columns: columns.map((col) => normalizeIndexColumnSpec(col)),
	});
}

async function checkJsonSupport() {
	if (jsonSupportedRef.checked) {
		return jsonSupportedRef.flag;
	}

	// Check if the dialect supports JSON operators at all
	if (!dialect.supportsJsonOperators) {
		jsonSupportedRef.checked = true;
		jsonSupportedRef.flag = false;
		return false;
	}

	// For dialects that support JSON, test the actual database
	if (!dbh) {
		dbh = await factory();
	}

	let jsonSupported = false;
	if (typeof dialect.checkJsonSupport === 'function') {
		jsonSupported = await dialect.checkJsonSupport(dbh);
		if (jsonSupported) {
			console.log(
				`JSON test passed, appears to be supported in your database, we will sync JSON indexes`,
			);
		}
	} else {
		// Fallback: assume JSON is supported if dialect says it supports JSON operators
		jsonSupported = dialect.supportsJsonOperators;
	}

	jsonSupportedRef.checked = true;
	jsonSupportedRef.flag = jsonSupported;
	return jsonSupported;
}

async function rebuildTableForDialectDiffs({
	tableName,
	tableSqlName,
	fieldList,
	existingColumns,
	sql,
	sqlErrors,
}) {
	const existingColumnNames = new Set(
		(existingColumns || []).map((col) => col.name),
	);
	const tempTableName = `__yass_rebuild_${tableName}_${Date.now()}_${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	const tempTableSqlName = dialect.quoteIdentifier(tempTableName);

	const requiredMissingColumns = fieldList
		.filter(({ field }) => !existingColumnNames.has(field))
		.filter(
			(fieldData) =>
				(fieldData.null === 'NO' ||
					fieldData.null === 0 ||
					fieldData.null === '0') &&
				fieldData.default === undefined &&
				fieldData.key !== 'PRI',
		)
		.map((fieldData) => fieldData.field);

	if (requiredMissingColumns.length) {
		const err = new Error(
			`Cannot auto-rebuild table '${tableName}'. New required columns without defaults: ${requiredMissingColumns.join(
				', ',
			)}`,
		);
		sqlErrors.push({
			table: tableSqlName,
			description: 'Unsafe auto-rebuild aborted',
			sql: null,
			error: err,
		});
		console.error(err.message);
		return;
	}

	const copyColumns = fieldList
		.map((fieldData) => fieldData.field)
		.filter((field) => existingColumnNames.has(field));
	const copyColumnSql = copyColumns
		.map((field) => dialect.quoteIdentifier(field))
		.join(', ');

	const createTempSql = dialect.generateCreateTable(tempTableName, fieldList);
	const copySql = `INSERT INTO ${tempTableSqlName} (${copyColumnSql}) SELECT ${copyColumnSql} FROM ${tableSqlName}`;
	const dropOldSql = `DROP TABLE ${tableSqlName}`;
	const renameSql = `ALTER TABLE ${tempTableSqlName} RENAME TO ${dialect.quoteIdentifier(
		tableName,
	)}`;

	console.warn(
		chalk.yellow(
			`Rebuilding table '${tableName}' to apply unsupported column changes for ${dialect.name}`,
		),
	);

	sql.push(
		`BEGIN TRANSACTION`,
		createTempSql,
		copySql,
		dropOldSql,
		renameSql,
		`COMMIT`,
	);

	await execQuery('BEGIN TRANSACTION', true);
	try {
		await execQuery(createTempSql, true);
		if (copyColumns.length) {
			await execQuery(copySql, true);
		}
		await execQuery(dropOldSql, true);
		await execQuery(renameSql, true);
		await execQuery('COMMIT', true);
	} catch (ex) {
		await execQuery('ROLLBACK', true).catch(() => {});
		// Best effort cleanup if temp table still exists.
		await execQuery(`DROP TABLE IF EXISTS ${tempTableSqlName}`, true).catch(
			() => {},
		);
		sqlErrors.push({
			table: tableSqlName,
			description: 'Error rebuilding table for unsupported column changes',
			sql: `${createTempSql}; ${copySql}; ${dropOldSql}; ${renameSql}`,
			error: ex,
		});
		console.error(
			`Error rebuilding table '${tableName}' for schema changes:`,
			ex,
		);
	}
}

// #####
// NOTE: 99% of the code for mysqlSchemaUpdate() copied from AppCore::DBI, and just slightly modified to run outside of AppCore

// Function: mysqlSchemaUpdate($dbh,$db,$table,$fields,$opts)
// Static function.
// #
// Parameters:
// $dbh - Database connection handle
// $db - Database name in which to find the table
// $table - Name of the table to either CREATE or ALTER
// $fields - A arrayref, each row is a hashref
//           having the following keys: Field, Type, Null,Key,Default,Extra (see 'explain TABLE' in mysql)
// $opts - A hashref of options. Key/Values recognized:
//   'indexes'      - Hashref of index_name :  [...field names...] to add as indexes to the database

async function mysqlSchemaUpdate(dbInput, tableInput, fieldList, opts) {
	const sql = [];

	const sqlErrors = [];

	const jsonSupported = await checkJsonSupport();

	// Allow specifying an arbitrary schema other than configured in .yass-orm
	// by giving a table name of 'schema/table'
	const [dbParsed, tableName] = `${tableInput}`.includes('.')
		? `${tableInput}`.split('.')
		: [null, tableInput];

	const db = dbParsed || dbInput;

	// Use dialect to quote identifiers properly
	const table = dbParsed
		? `${dialect.quoteIdentifier(dbParsed)}.${dialect.quoteIdentifier(
				tableName,
		  )}`
		: dialect.quoteIdentifier(tableName);

	// NOTE: %fields will be used for comparing table to existing table AND
	// for checking for 'TEXT' columns when creating indexes - hence why this hash
	// was moved out of the first block, below.
	const fields = {};
	fieldList.forEach((fieldData) => {
		fields[fieldData.field] = fieldData;
	});

	// Ensure we have a database handle
	if (!dbh) {
		dbh = await factory();
	}

	// Check for table before introspection because it will error if table doesn't exist
	const tableExists = await dialect.tableExists(dbh, db, tableName);

	// Assuming table exists - compare
	if (tableExists) {
		let error;
		// Use dialect to get table columns in a normalized format
		const existingColumns = await dialect
			.getTableColumns(dbh, tableName)
			.catch((ex) => {
				error = ex;
			});

		if (error) {
			console.warn(`Error inspecting table ${table}:`, error);
			return;
		}

		// Build a map of existing columns for comparison
		// The original code converted MySQL's SHOW COLUMNS result to lowercase keys
		// We need to match that format for the comparison logic
		const explainMap = {};
		existingColumns.forEach((col) => {
			// If we have raw data from MySQL, use it with lowercase keys
			// Otherwise, build the structure from normalized data
			if (col._raw) {
				// Convert raw MySQL row to lowercase keys (matching original behavior)
				explainMap[col.name] = {};
				Object.keys(col._raw).forEach((key) => {
					explainMap[col.name][`${key}`.toLowerCase()] = col._raw[key];
				});
			} else {
				// For dialects without _raw (like SQLite), build from normalized data
				explainMap[col.name] = {
					field: col.name,
					type: col.type,
					null: col.nullable ? 'YES' : 'NO',
					key: col.primaryKey ? 'PRI' : col.unique ? 'UNI' : '',
					default: col.defaultValue,
					extra: col.extra || (col.autoIncrement ? 'auto_increment' : ''),
					collation: col.collation,
				};
			}
		});

		// console.log(`explainMap:`, explainMap);

		const alter = [];
		const changedColumns = [];
		let requiresTableRebuild = false;
		fieldList.forEach((fieldData) => {
			const { field: key } = fieldData;

			// Assume if key does not exist in %explain, it doesnt exist in the table
			if (!explainMap[key]) {
				// Use dialect to generate ADD COLUMN statement
				alter.push(dialect.generateAlterAddColumn(tableName, fieldData));
				changedColumns.push({ col: key, type: 'ADD' });
			}
			// If key exists in %explain, do a simple === diff comparrison
			else if (explainMap[key] !== undefined) {
				const a = explainMap[key];
				const b = fieldData;
				let cnt = 0;

				const { type: aType } = a;

				Object.keys(a).forEach((k) => {
					// Don't mess with these SQL props
					if (['privileges', 'comment'].includes(k)) {
						return;
					}

					const ak = a[k] || '';
					const bk = b[k] || '';

					if (ak !== bk) {
						// Normalize some nitch cases that are known to be different ...

						if (
							// Default collation is fine
							(k === 'collation' &&
								['utf8mb4_general_ci', 'utf8mb4_0900_ai_ci'].includes(ak) &&
								bk === '') ||
							// Seems MySQL translates the string \r\n into the actual chr 10 && chr 13
							(ak === '\r\n' && bk === '\r\n') ||
							// YES Null from DB and an undef value in $fields is OK
							(k === 'null' && ak === 'YES' && (bk === '' || bk === 1)) ||
							// NO Null from DB and a 0 value in $fields is OK
							// access b[k] directly to avoid casting / default '' issues
							(k === 'null' && ak === 'NO' && b[k] === 0) ||
							// Users of the class sometimes don't uppercase textual "not null" values - so here we do
							(k === 'null' && ak === 'NO' && bk.toUpperCase() === 'NO') ||
							// Given the type 'integer' (or 'int') to create/alter gives back int(11) in the 'explain ...' stmt
							(k === 'type' &&
								ak === 'int(11)' &&
								(bk === 'integer' || bk === 'int')) ||
							// Newer MariaDB gives int sometimes for int(11)
							(k === 'type' && ak === 'int' && bk === 'int(11)') ||
							// Given the type 'int(1)' to create/alter gives back 'int' in the 'explain ...' stmt on DO MySQL instance
							(k === 'type' &&
								ak === 'int' &&
								(bk === 'integer' || bk === 'int(1)')) ||
							// Translate shorthand for varchar(255) - varchar without modifier is not reconized by mysql,
							// but I allow it here and in the _fieldspec sub and translate it to varchar(255) before mysql sees it
							(k === 'type' && ak === 'varchar(255)' && bk === 'varchar') ||
							// If type is integer and default is 0 in the db, then here bk is '' -- we'll go ahead and allow it
							(k === 'default' &&
								ak === '0' &&
								!bk &&
								aType.toLowerCase().match(/^int/)) ||
							// Primary Keys that are auto-increment have Null set to NO when seen by 'explain' but the null
							// key is typically undef in the $fields hash - thats okay.
							(k === 'null' &&
								ak === 'NO' &&
								bk === '' &&
								b.key === 'PRI' &&
								b.extra === 'auto_increment') ||
							// Even if user specs NULL on a timestamp column, explain returns NOT NULL - ignore and don't try to alter
							(k === 'null' &&
								ak !== bk &&
								aType.toLowerCase() === 'timestamp') ||
							// timestamp with NULL defaults return CURRENT_TIMESTAMP from mysql - this is valid, just ignore
							// on some systems, it also returns 'on update CURRENT_TIMESTAMP' for key 'extra' - also valid, just ignore
							((k === 'default' || k === 'extra') &&
								ak.toUpperCase() === 'CURRENT_TIMESTAMP' &&
								!bk &&
								aType.toLowerCase() === 'timestamp') ||
							// Multiple keys report oddly, so ignore them...
							(k === 'key' && ak === 'MUL' && !bk) ||
							// Given the type 'bit(\d)' to create/alter gives back bit in the 'explain ...' stmt
							(k === 'type' && ak.match(/bit\(\d+\)/i) && bk === 'bit') ||
							// Given the type 'smallint(\d)' to create/alter gives back smallint in the 'explain ...' stmt
							(k === 'type' &&
								ak.match(/smallint\(\d+\)/i) &&
								bk === 'smallint') ||
							// Given the type 'nvarchar(...)' in the schema gives back varchar(256) in the 'explain ...' stmt
							(k === 'type' &&
								ak.match(/varchar\(\d+\)/i) &&
								bk.match(/varchar\(\d+\)/i)) ||
							// Given the type 'money' in the schema gives back double/real in the 'explain ...' stmt
							(k === 'type' &&
								ak === 'double' &&
								bk.match(/^(real|money)$/i)) ||
							// Given the type 'decimal' in the schema gives back numeric in the 'explain ...' stmt
							(k === 'type' &&
								ak.match(/^decimal\(/i) &&
								bk.match(/^(decimal|numeric)$/i)) ||
							// varchar(256) from database == uniqueidentifier (schema)
							(k === 'type' &&
								ak === 'varchar(256)' &&
								bk === 'uniqueidentifier') ||
							// bigint(...) from database == bigint (schema)
							(k === 'type' && ak.match(/^bigint\(/i) && bk === 'bigint') ||
							// tinyint(...) from database == tinyint (schema)
							(k === 'type' && ak.match(/^tinyint\(/i) && bk === 'tinyint') ||
							// varchar(256) from database == varchar(-1) (schema)
							(k === 'type' && ak === 'varchar(256)' && bk === 'varchar(-1)') ||
							// varchar(255) from database == varchar(-1) (schema)
							(k === 'type' && ak === 'varchar(255)' && bk === 'varchar(-1)') ||
							// varchar(255) from database == nvarchar(-1) (schema)
							(k === 'type' &&
								ak === 'varchar(255)' &&
								bk === 'nvarchar(-1)') ||
							// datetime from database == smalldatetime (schema)
							(k === 'type' && ak === 'datetime' && bk === 'smalldatetime') ||
							// longtext from database == xml(-1) (schema)
							(k === 'type' && ak === 'longtext' && bk === 'xml(-1)') ||
							// blob from database == image(...) (schema)
							(k === 'type' && ak === 'blob' && bk.match(/^image\(\d+/i)) ||
							// char(...) from database == nchar(...) (schema)
							(k === 'type' && ak.match(/^char\(/i) && bk.match(/^nchar\(/i))
						) {
							return;
						}

						// Handle enums that have newlines and spaces in their schema definitions here
						// because MySQL stores them as a single line
						if (k === 'type' && bk.match(/enum/i) && bk.includes('\n')) {
							const tmp = bk.replace(/\s*\n\s*/g, '');
							// #print "tmp:$tmp\n";
							// #print "  a:$a->{$k}\n";
							if (ak === tmp) {
								return;
							}
						}

						console.log(`Debug: k=${k}, a=${ak}, b=${bk}, type=${aType}`);
						cnt++;
					}
				});

				if (cnt > 0) {
					// Check if dialect supports ALTER COLUMN
					if (!dialect.supportsAlterColumn) {
						requiresTableRebuild = true;
						changedColumns.push({ col: key, type: 'REBUILD' });
					} else {
						// Use dialect to generate MODIFY/CHANGE COLUMN statement
						alter.push(dialect.generateAlterModifyColumn(tableName, fieldData));
						changedColumns.push({ col: key, type: 'CHANGE' });
					}
				}
			}
		});

		// foreach const key (keys %explain)
		Object.keys(explainMap).forEach((key) => {
			if (!fields[key]) {
				// Decide if this is safe
				if (ALLOW_DROP) {
					// Use dialect to generate DROP COLUMN statement
					alter.push(dialect.generateAlterDropColumn(tableName, key));
					changedColumns.push({ col: key, type: 'DROP' });
				} else {
					console.log(
						` ***** Possible drop needed, but not dropping to preserve data: ${table}.${key}`,
					);
				}
			}
		});

		if (requiresTableRebuild) {
			await rebuildTableForDialectDiffs({
				tableName,
				tableSqlName: table,
				fieldList,
				existingColumns,
				sql,
				sqlErrors,
			});
		} else if (alter.length) {
			const alterSql = alter.join(';\n');
			console.log(`Debug: [${db}] Alter table: \n${alterSql}\n`);

			sql.push(alterSql);

			await promiseMap(alter, async (stmt) => {
				return execQuery(stmt, true).catch((ex) => {
					console.error(
						`Error syncing SQL: ${stmt}\n----\nError when trying to sync was:`,
						ex,
					);
					sqlErrors.push({
						table,
						description: 'Error syncing field',
						sql: stmt,
						error: ex,
					});
				});
			});
		}
	}
	// Assume table DOES NOT exist - create
	else {
		// Use dialect to generate CREATE TABLE statement
		const createStmt = dialect.generateCreateTable(tableName, fieldList, opts);

		console.log(`Create SQL:`, createStmt);

		sql.push(createStmt);

		await execQuery(createStmt, true).catch((ex) => {
			console.error(
				`Error creating table '${table}' with SQL: ${createStmt}\n----\nError when trying to create was:`,
				ex,
			);
			sqlErrors.push({
				table,
				description: 'Error creating table',
				sql: createStmt,
				error: ex,
			});
		});
	}

	if (!opts.indexes) {
		opts.indexes = {};
	}

	if (opts.indexes) {
		// If we have a isDeleted column, add a default index on it
		if (fieldList.some((d) => d.field === 'isDeleted')) {
			// Add a default index on the isDeleted column.
			// SQLite index names are database-global (not table-scoped), so use a
			// table-prefixed name there to avoid collisions across tables.
			const isDeletedIndexName =
				dialect.name === 'sqlite' ? `${tableName}_isDeleted` : 'isDeleted';
			opts.indexes[isDeletedIndexName] = ['isDeleted'];
		}

		// Load existing indexes from database using dialect
		let indexError;
		const existingIndexes = await dialect
			.getTableIndexes(dbh, tableName)
			.catch((ex) => {
				indexError = ex;
				sqlErrors.push({
					table,
					description: 'Error reading existing indexes from database',
					sql: `dialect.getTableIndexes(${tableName})`,
					error: ex,
				});
			});

		if (indexError) {
			console.warn(`Error reading existing indexes from ${table}:`, indexError);
			return;
		}

		// Build lookup map from normalized index data.
		// Signature-based comparison avoids brittle field-by-field comparisons for
		// functional indexes (including JSON expressions).
		const existingIndexByName = {};
		(existingIndexes || []).forEach((idx) => {
			existingIndexByName[idx.name] = {
				...idx,
				signature: buildIndexSignature({
					columns: idx.columns || [],
					fulltext: `${idx.type || ''}`.toUpperCase() === 'FULLTEXT',
					unique: !!idx.unique,
				}),
			};
		});

		// Compare indexes in opts with the database indexes
		await promiseMap(Object.keys(opts.indexes), async (keyName) => {
			const existingIndex = existingIndexByName[keyName];
			const indexSpec = opts.indexes[keyName];

			let cols;
			let isFullText = false;
			let isUnique = false;
			if (typeof indexSpec === 'string' || Array.isArray(indexSpec)) {
				cols = indexSpec;
			} else if (typeof indexSpec === 'object') {
				// Since 'fulltext' is a modifier that comes before the "index" keyword,
				// we can't use the same syntax for both fulltext and non-fulltext indexes.
				// So we need to check for the presence of the 'fulltext' modifier in the indexSpec
				// and use a different syntax for the index name.

				// eslint-disable-next-line prefer-destructuring
				cols = indexSpec.cols;

				if (!isFullText) {
					isFullText = !!indexSpec.fulltext;
				}
				isUnique = !!indexSpec.unique;
			}

			// Support an alternate syntax for fulltext indexes
			// where the first column is 'fulltext' - in which case we'll
			// set the flag so we modify the create syntax and just remove the first column
			if (!isFullText && Array.isArray(cols)) {
				isFullText = `${cols[0]}`.toLowerCase() === 'fulltext';

				if (isFullText) {
					cols = cols.slice(1);
				}
			}

			if (!cols) {
				// Ignore empty indexes which still have a key name - e.g. to allow manually created indexes completely outside of this schema
				return;
			}

			if (
				!existingIndex && // only create if index doesn't exist (see notes below)
				typeof cols === 'string'
			) {
				if (!cols.startsWith('(')) {
					console.error(
						`Invalid index spec for '${keyName}': '${cols}' - we received a string, but it must start with '(' to be considered a raw SQL index`,
					);
					return;
				}

				if (!cols.endsWith(')')) {
					console.error(
						`Invalid index spec for '${keyName}': '${cols}' - we received a string, but it must end with ')' to be considered a raw SQL index`,
					);
					return;
				}

				// Assume this is a raw SQL string for the index,
				// and only create it if not existing already.
				// E.g. allow someone to spec an index like '(user, logType desc)' (with parens included)
				// Then we can just pass that through to the DB via 'create index {name} on {table} {cols}'
				// The only way to CHANGE the index after that is to update the index name, like "idx_foo_v2" etc,
				// which would force the code below to drop the old and we'd create a new one here
				const createIndexSql = isFullText
					? /* sql */ `create fulltext index`
					: /* sql */ `create index`;
				const createSql = `${createIndexSql} ${dialect.quoteIdentifier(
					keyName,
				)} on ${table} ${cols}`;
				sql.push(createSql);

				console.log(`Debug: (re)Creating index '${keyName}': `, createSql);

				// Create the index
				await execQuery(createSql, true).catch((ex) => {
					console.error(
						`Error creating index '${keyName}' with SQL: ${createSql}\n----\nError when trying to create was:`,
						ex,
					);
					sqlErrors.push({
						table,
						description: 'Error creating index',
						sql: createSql,
						error: ex,
					});
				});

				// Go to next index, skip code below
				return;
			}

			if (!Array.isArray(cols) || !cols.length) {
				// Ignore empty indexes which still have a key name - e.g. to allow manually created indexes completely outside of this schema
				return;
			}

			// allow people to add things like  "foo DESC" or "foo(255)" but just get "foo" here"
			const colNameExtractRegex = /^([a-zA-Z][a-zA-Z0-9_]*?)([\s()].*)?$/;

			// Check for fulltext support
			if (isFullText && !dialect.supportsFullTextSearch) {
				console.warn(
					chalk.yellow(
						`Skipping FULLTEXT index '${keyName}' - ${dialect.name} does not support FULLTEXT indexes`,
					),
				);
				return;
			}

			// Validate columns and check for JSON indexes
			const validatedCols = [];
			const textLengths = {};
			let hasInvalidCols = false;

			// Process each column in the index definition
			cols.some((col) => {
				// JSON access operator ->> inside an index column
				// indicates the user wants to use a functional index.
				if (`${col || ''}`.includes('->>')) {
					if (!jsonSupported) {
						console.warn(
							`JSON not supported, not syncing index '${keyName}' because it contains a JSON accessor:`,
							col,
						);
						hasInvalidCols = true;
						return true; // break out of some()
					}
					const [ourField] = col.split('->>') || [];
					if (!fields[ourField]) {
						console.error(
							`Cannot find definition for JSON column '${ourField}' (shown as "${col}" in the schema) given in index '${keyName}' - check your definition and try again`,
						);
						hasInvalidCols = true;
						return true; // break out of some()
					}
					// Pass JSON columns through - dialect.generateCreateIndex will handle syntax
					validatedCols.push(col);
					return false; // continue to next
				}

				const nameAndArgsMatch = col.match(colNameExtractRegex);
				// eslint-disable-next-line no-unused-vars
				const [unused, colName, argString] = nameAndArgsMatch || [col];

				if (!fields[colName]) {
					console.error(
						`Cannot find definition for column '${col}' given in index '${keyName}' - check your definition and try again`,
					);
					hasInvalidCols = true;
					return true; // break out of some()
				}

				// Track text columns that need length specification
				if (fields[colName].type.match(/text/)) {
					textLengths[colName] = 255;
				}

				// Add column (with any modifiers like DESC)
				validatedCols.push(argString ? `${colName}${argString}` : colName);
				return false; // continue to next
			});

			if (hasInvalidCols || !validatedCols.length) {
				if (!hasInvalidCols) {
					console.warn(
						`No valid columns found for index '${keyName}' - skipping`,
					);
				}
				return;
			}

			const desiredSignature = buildIndexSignature({
				columns: validatedCols.map((col) => {
					// Keep signature generation aligned with CREATE INDEX generation:
					// for text columns without explicit length, MySQL index DDL adds
					// an implicit `(255)` prefix length.
					const match = `${col || ''}`.match(colNameExtractRegex);
					if (!match) {
						return col;
					}
					const [, colName, argString] = match;
					if (argString && argString.trim().startsWith('(')) {
						return col; // explicit length already present
					}
					if (textLengths[colName]) {
						const directionSuffix =
							argString && /^\s*(ASC|DESC)/i.test(argString) ? argString : '';
						return `${colName}(${textLengths[colName]})${directionSuffix}`;
					}
					return col;
				}),
				fulltext: isFullText,
				unique: isUnique,
			});
			const existingSignature = existingIndex ? existingIndex.signature : null;
			const diff = !existingSignature || desiredSignature !== existingSignature;
			if (!diff) {
				return;
			}

			// Drop existing index if DB differs from schema
			if (existingIndex) {
				const dropSql = dialect.generateDropIndex(tableName, keyName);
				// print "Debug: Index '$keyName' changed, deleting and recreating. Delete SQL: $sql\n";
				sql.push(dropSql);

				await execQuery(dropSql, true).catch((ex) => {
					console.error(
						`Error dropping index '${keyName}' with SQL: ${dropSql}\n----\nError when trying to drop was:`,
						ex,
					);
					sqlErrors.push({
						table,
						description: 'Error dropping index',
						sql: dropSql,
						error: ex,
					});
				});
			}

			// Use dialect to generate the CREATE INDEX statement
			const createSql = dialect.generateCreateIndex(
				tableName,
				keyName,
				validatedCols,
				{
					fulltext: isFullText,
					unique: isUnique,
					textLengths,
				},
			);
			if (!createSql) {
				return;
			}

			console.log(`Debug: (re)Creating index '${keyName}': `, createSql);
			sql.push(createSql);
			await execQuery(createSql, true).catch((ex) => {
				console.error(
					`Error creating index '${keyName}' with SQL: ${createSql}\n----\nError when trying to create was:`,
					ex,
				);
				sqlErrors.push({
					table,
					description: 'Error creating index',
					sql: createSql,
					error: ex,
				});
			});
		});

		// Remove any indexes on the table that aren't explicitly listed in the schema (other than PRIMARY)
		await promiseMap(Object.keys(existingIndexByName), async (keyName) => {
			if (keyName === 'PRIMARY') {
				return;
			}

			// Remove indexes that are not in the schema
			if (!Object.prototype.hasOwnProperty.call(opts.indexes, keyName)) {
				const dropSql = dialect.generateDropIndex(tableName, keyName);
				console.log(`Debug: Index '${keyName}' removed: `, dropSql);
				sql.push(dropSql);

				await execQuery(dropSql, true).catch((ex) => {
					console.error(
						`Error dropping index '${keyName}' with SQL: ${dropSql}\n----\nError when trying to drop was:`,
						ex,
					);
					sqlErrors.push({
						table,
						description: 'Error dropping index',
						sql: dropSql,
						error: ex,
					});
				});
			}
		});
	}

	if (sqlErrors.length) {
		console.error(
			`Enountered errors syncing table '${table}', but finished syncing anyway. ${sqlErrors.length} errors follow:`,
			jsonSafeStringify(sqlErrors, 4),
			`\n\n<End of ${sqlErrors.length} Errors>`,
		);
	}
}

async function syncSchemaToDb(schema) {
	const { fields, table, options } = schema;

	const { table: tableNameParsed, idFieldFromTable } = parseIdField(table);

	// Add an 'id' field to the field list because Sequelize and Ember both expect an 'id' field,
	// but our definitions (intentionally) don't contain an id field
	const idField = fields.find(({ type }) =>
		['idKey', 'uuidKey'].includes(type),
	);

	let hasUuidKey = false;
	if (idField) {
		const { type } = idField;
		hasUuidKey = type === 'uuidKey';
		Object.assign(
			idField,
			hasUuidKey ? getPriKeyUuidAttrs() : getPriKeyAttrs(),
		);
	} else {
		fields.push({ ...getPriKeyAttrs(), field: idFieldFromTable || 'id' });
	}

	// Apply the actual update to the database (does nothing if the definiton and database match)
	await mysqlSchemaUpdate(DB_NAME, tableNameParsed, fields, options);

	// Attach our UUID trigger
	if (hasUuidKey && !idFieldFromTable) {
		await attachIdTrigger(table);
	} else {
		// print STDERR "Table does not need ID trigger: $schema->{table}\n";
	}
}

function writeModel({ table, model, defsPath, modelsPath }) {
	const defFile = path.resolve(defsPath, `${table}.js`);
	const modelFile = path.resolve(modelsPath, `${table}.js`);

	const defJs = `
exports.default = (ctx) => {
	const t = ctx.types;
	return {
		table: '${model.table}',
		legacyExternalSchema: ${model.legacyExternalSchema || false},
		schema: {
			${Object.keys(model.schema)
				.map((field, idx) => {
					const type = model.schema[field];
					return `${idx === 0 ? '' : '			'}${field}: ${type},`;
				})
				.join('\n')}
		}
	}	
}`;

	const className = `${table}`
		.replace(/^(\w)/, (unused, letter) => `${letter}`.toUpperCase())
		.replace(/_(\w)/g, (unused, letter) => `${letter}`.toUpperCase());

	const modelJs = `
import { loadDefinition } from 'yass-orm';

export default class ${className} extends loadDefinition('../defs/${table}') {
	// Just an example of customizing jsonify
	async jsonify() {
		const json = await super.jsonify({ excludeLinked: true });
		// json.someOtherField = customValue;
		return json;
	}
}
`;

	fs.writeFileSync(defFile, defJs);
	console.log(`Wrote ${chalk.green(defFile)}`);

	fs.writeFileSync(modelFile, modelJs);
	console.log(`Wrote ${chalk.green(modelFile)}`);
}

async function dumpSchema(table) {
	// Ensure we have a database handle
	if (!dbh) {
		dbh = await factory();
	}

	let error;
	const existingColumns = await dialect
		.getTableColumns(dbh, table)
		.catch((ex) => {
			error = ex;
		});

	if (error) {
		console.warn(`Error inspecting table ${table}:`, error);
		return { table, schema: {} };
	}

	// const explainMap = {};

	const model = {
		table,
	};

	const schema = {};

	existingColumns.forEach((col) => {
		const field = col.name;
		const rawType = col.type;
		const key = col.primaryKey ? 'PRI' : '';
		const type = rawType.toLowerCase();

		let schemaType =
			key === 'PRI'
				? type.includes('int')
					? 't.idKey'
					: 't.uuidKey'
				: type === 'int(1)' || type === 'bit(1)'
				? 't.bool'
				: type.startsWith('int') ||
				  type.startsWith('tinyint') ||
				  type.startsWith('smallint') ||
				  type.startsWith('bigint')
				? 't.int'
				: type.startsWith('varchar')
				? 't.string'
				: type.startsWith('double') || type.startsWith('decimal')
				? 't.real'
				: type.startsWith('longtext')
				? 't.text'
				: type.startsWith('double')
				? 't.real'
				: type.startsWith('date')
				? 't.datetime'
				: type.startsWith('time')
				? 't.time'
				: null;
		if (schemaType === null) {
			console.warn(
				chalk.yellow(
					`Unknown raw type for '${field}': "${rawType}", assuming t.string`,
				),
			);
			schemaType = 't.string';
		}

		// Wrap in brackets like HBS for replacement later
		schema[field] = schemaType;

		if (
			field !== 'id' &&
			(schemaType === 't.idKey' || schemaType === 't.uuidKey')
		) {
			model.legacyExternalSchema = true;
			model.table = `${table}.${field}`;
		}
	});

	model.schema = schema;

	// console.log(`explainMap:`, explainMap);
	// console.log(`model:`, model);

	return model;
}

async function dumpDatabaseSchemas({ defsPath, modelsPath }) {
	// Ensure we have a database handle
	if (!dbh) {
		dbh = await factory();
	}

	// Use dialect to get list of tables
	const tables = await dialect.getTables(dbh, DB_NAME);

	await promiseMap(tables, async (table) => {
		const model = await dumpSchema(table);

		writeModel({ table, model, defsPath, modelsPath });
	});
}

module.exports = {
	checkJsonSupport,
	promiseMap,
	syncSchemaToDb,
	convertFile,
	dumpDatabaseSchemas,
	uploadMatchRatioFunctionFactory: uploadMatchRatioFunction,
	uploadMatchRatioFunction: () => {
		uploadMatchRatioFunction(DB_HOST, DB_NAME, USER, PASSWORD, PORT);
	},
};
