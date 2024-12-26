/* eslint-disable no-console, import/no-dynamic-require, global-require, no-nested-ternary, no-param-reassign */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const chalk = require('chalk');

const config = require('../lib/config');
const { dbh: factory, parseIdField } = require('../lib/dbh');

const { convertDefinition } = require('../lib/def-to-schema');

const convertFile = (pathname) =>
	convertDefinition(require(path.resolve(process.cwd(), pathname)).default);

// console.log('Debug: config used: ', config);

const ALLOW_DROP = 0;

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

	return dbh.pquery(sql);
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

// Function: mysqlFieldSpec
// PRIVATE
// Translates an 'explain TABLE' output row into a SQL statement fragment that can be used to create or alter that field
function mysqlFieldSpec(fieldData, { ignore: ignoreList = [] } = {}) {
	const ignoreMap = {};
	Array.from(ignoreList || []).forEach((key) => {
		ignoreMap[key] = true;
	});

	if (fieldData.null !== undefined) {
		fieldData.null = `${fieldData.null}`.toUpperCase();
	}

	const { type: rawType } = fieldData;
	const schemaType = `${rawType}`.toLocaleLowerCase();

	let updatedType;
	if (['varchar', 'varchar(-1)', 'nvarchar(-1)'].includes(schemaType)) {
		updatedType = 'varchar(255)';
	}

	if (schemaType === 'money') {
		updatedType = 'real';
	}

	if (schemaType === 'smalldatetime') {
		updatedType = 'datetime';
	}

	if (schemaType === 'uniqueidentifier') {
		updatedType = 'varchar(256)';
	}

	if (schemaType === 'xml(-1)') {
		updatedType = 'longtext';
	}

	if (updatedType) {
		fieldData.type = updatedType;
	}

	const {
		field,
		type,
		null: nullVal,
		key,
		default: defaultVal,
		extra,
		collation,
	} = fieldData;
	const { key: ignoreKey } = ignoreMap;

	const fieldSpec = `\`${field}\` ${type}${
		collation ? ` COLLATE ${collation} ` : ''
	}${nullVal === 'NO' || nullVal === '0' ? ' NOT NULL' : ''}${
		!ignoreKey && key === 'PRI'
			? ` PRIMARY KEY${extra ? ` ${extra}` : ''}`
			: key === 'UNI'
			? ' UNIQUE'
			: '' // TODO: Support other variants of Key if needed
	}${
		defaultVal !== undefined
			? defaultVal === 'CURRENT_TIMESTAMP'
				? ''
				: defaultVal === '' && type.match(/^int/i)
				? ' DEFAULT 0'
				: defaultVal !== 'NULL'
				? ` DEFAULT '${defaultVal}'`
				: ''
			: ''
	}`;

	// console.log(`fieldSpec: `, { fieldSpec, fieldData, ignoreMap });
	return fieldSpec;
}

const PriKeyAttrs = {
	extra: 'auto_increment',
	type: 'int(11)',
	key: 'PRI',
	readonly: 1,
	auto: 1,
};

const PriKeyUuidAttrs = {
	// Cannot use 'char(36) binary' because it cases a warning 1287: "'BINARY as attribute of a type' is deprecated and will be removed in a future release. Please use a CHARACTER SET clause with _bin collation instead"
	// Instead, do as shown: https://dev.mysql.com/worklog/task/?id=13068
	type: 'char(36)',
	collation: 'utf8mb4_bin',
	key: 'PRI',
	null: 0, // for sync
};

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

	// Allow specifying an arbitrary schema other than configured in .yass-orm
	// by giving a table name of 'schema/table'
	const [dbParsed, tableName] = `${tableInput}`.includes('.')
		? `${tableInput}`.split('.')
		: [null, tableInput];

	const db = dbParsed || dbInput;

	const table = dbParsed
		? `\`${dbParsed}\`.\`${tableName}\``
		: `\`${tableName}\``;

	// NOTE: %fields will be used for comparing table to existing table AND
	// for checking for 'TEXT' columns when creating indexes - hence why this hash
	// was moved out of the first block, below.
	const fields = {};
	fieldList.forEach((fieldData) => {
		fields[fieldData.field] = fieldData;
	});

	// Check for table before `explain` because explain throw error
	// if table doesn't exist
	const tables = await execQuery(
		`show tables in \`${db}\` where \`Tables_in_${db}\`='${tableName}'`,
	);
	const tableExists = !!tables.length;

	// Assuming table exists - compare
	if (tableExists) {
		let error;
		const existingSchema = !tableExists
			? null
			: await execQuery(`SHOW FULL COLUMNS FROM ${table}`).catch((ex) => {
					error = ex;
			  });

		if (error) {
			console.warn(`Error inspecting table ${table}:`, error);
			return;
		}

		const explainMap = {};
		existingSchema.forEach((existingRow) => {
			const { Field: field } = existingRow;
			explainMap[field] = {};
			Object.keys(existingRow).forEach((key) => {
				explainMap[field][`${key}`.toLowerCase()] = existingRow[key];
			});
		});

		// console.log(`explainMap:`, explainMap);

		const alter = [];
		const changedColumns = [];
		fieldList.forEach((fieldData) => {
			const { field: key } = fieldData;

			// Assume if key does not exist in %explain, it doesnt exist in the table
			if (!explainMap[key]) {
				alter.push(`ALTER TABLE ${table} ADD ${mysqlFieldSpec(fieldData)}`);
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
					alter.push(
						`ALTER TABLE ${table} CHANGE \`${key}\` ${mysqlFieldSpec(
							fieldData,
							{ ignore: ['key'] },
						)}`,
					);

					// console.log(`altered because`, { key, data: explainMap[key] });

					changedColumns.push({ col: key, type: 'CHANGE' });
				}
			}
		});

		// foreach const key (keys %explain)
		Object.keys(explainMap).forEach((key) => {
			if (!fields[key]) {
				// Decide if this is safe
				if (ALLOW_DROP) {
					alter.push(`ALTER TABLE ${table} DROP \`${key}\``);
					changedColumns.push({ col: key, type: 'DROP' });
				} else {
					console.log(
						` ***** Possible drop needed, but not dropping to preserve data: ${table}.${key}`,
					);
				}
			}
		});

		if (alter.length) {
			const alterSql = alter.join(';\n');
			console.log(`Debug: [${db}] Alter table: \n${alterSql}\n`);

			sql.push(alterSql);

			await promiseMap(alter, async (stmt) => {
				execQuery(stmt, true).catch((ex) => {
					console.error(`Error executing '${stmt}': `, ex);
				});
			});
		}
	}
	// Assume table DOES NOT exist - create
	else {
		// Compose the SQL statement and send to the server
		const buff = [`CREATE TABLE ${table} (`];
		buff.push(fieldList.map(mysqlFieldSpec).join(', '));
		buff.push(') character set utf8mb4');
		const createStmt = buff.join('');

		console.log(`Create SQL:`, createStmt);

		sql.push(createStmt);

		await execQuery(createStmt, true);
	}

	if (!opts.indexes) {
		opts.indexes = {};
	}

	if (opts.indexes) {
		// If we have a isDeleted column, add a default index on it
		if (fieldList.some((d) => d.field === 'isDeleted')) {
			// Add a default index on the isDeleted column
			opts.indexes.isDeleted = ['isDeleted'];
		}

		// Load existing indexes from database
		const indexSql = `show indexes from ${table}`;

		let indexError;
		const indexRows = await execQuery(indexSql).catch((ex) => {
			indexError = ex;
		});

		if (indexError) {
			console.warn(`Error reading existing indexes from ${table}:`, indexError);
			return;
		}

		const fullTextIndexesInDatabaseLookup = {};
		const indexesInDatabaseLookup = {};
		indexRows.forEach((ref) => {
			const {
				Key_name: keyName,
				Column_name: columnName,
				Expression: expression, // used when we create json indexes, because Column_name is null for those indexes
				Index_type: indexType,
			} = ref;

			if (!indexesInDatabaseLookup[keyName]) {
				indexesInDatabaseLookup[keyName] = {};
			}
			indexesInDatabaseLookup[keyName][columnName || expression] = ref;

			if (indexType === 'FULLTEXT') {
				fullTextIndexesInDatabaseLookup[keyName] = ref;
			}
		});

		// console.log(
		// 	`Found indexes in database:`,
		// 	Object.keys(indexesInDatabaseLookup),
		// );

		// Compare indexes in opts with the database indexes
		await promiseMap(Object.keys(opts.indexes), async (keyName) => {
			const dbData = indexesInDatabaseLookup[keyName];
			const indexSpec = opts.indexes[keyName];

			let cols;
			let isFullText = false;
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

			const indexNameSql = /* sql */ `\`${keyName}\` on ${table}`;
			const createIndexSql = isFullText
				? /* sql */ `create fulltext index`
				: /* sql */ `create index`;

			let diff = false;
			let drop = false;

			if (!cols) {
				// Ignore empty indexes which still have a key name - e.g. to allow manually created indexes completely outside of this schema
				return;
			}

			if (
				!dbData && // only create if index doesn't exist (see notes below)
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
				const createSql = `${createIndexSql} \`${keyName}\` on ${table} ${cols}`;
				sql.push(createSql);

				console.log(`Debug: (re)Creating index '${keyName}': `, createSql);

				// Create the index
				await execQuery(createSql, true);

				// Go to next index, skip code below
				return;
			}

			if (!Array.isArray(cols) || !cols.length) {
				// Ignore empty indexes which still have a key name - e.g. to allow manually created indexes completely outside of this schema
				return;
			}

			// allow people to add things like  "foo DESC" or "foo(255)" but just get "foo" here"
			const colNameExtractRegex = /^([a-zA-Z][a-zA-Z0-9_]*?)([\s()].*)?$/;

			// If index does exists in DB, compare and flag if different
			if (dbData) {
				cols.forEach((col) => {
					if (`${col || ''}`.includes('->>')) {
						// Javascript indexes (specd in schema like `key->>'$.foo.bar'`) are not directly comparable to DB indexes,
						// when we give them to myself using the `X->>'$...'` syntax, mysql stores them in the Expression column (and sets column_name to null.)
						// However, in the expression column, they take on a full realized shape like this:
						// `stripeData->>'$.customer'` turns into:
						// `(cast(json_unquote(json_extract(`stripeData`,_utf8mb4\'$.customer\')) as char(255) charset utf8mb4) collate utf8mb4_bin)`
						// So we split the column name out of the expression and compare it to the DB's expression and match the pathspec as well
						const [ourField, pathSpec] = col.split('->>') || [];
						const foundExpression = Object.values(dbData).find(
							({ Expression }) => {
								if (!Expression) {
									return false;
								}

								if (Expression.includes(ourField)) {
									if (pathSpec) {
										const pathWithoutQuotes = pathSpec.replace(
											/^["'](.*)["']$/,
											'$1',
										);
										return Expression.includes(pathWithoutQuotes);
									}
									return true;
								}

								return false;
							},
						);

						// Only if we don't find the expression in the DB do we flag a diff
						if (!foundExpression) {
							diff = true;
						}
						return;
					}

					const match = col.match(colNameExtractRegex);
					if (!match) {
						// String didn't match regex? No worries, assume the user meant to do that and just check directly
						if (!dbData[col]) {
							diff = true;
						}

						return;
					}

					// Check if the column exists in the DB index using the extracted name
					const colName = match[1];
					if (!dbData[colName]) {
						diff = true;
					}
				});

				if (diff) {
					drop = true;
				} else {
					const isDiskFullText = !!fullTextIndexesInDatabaseLookup[keyName];
					const isSpecFullText = isFullText;

					// If the index exists on disk but the spec doesn't, or vice versa,
					// we need to drop and recreate the index
					if (isDiskFullText !== isSpecFullText) {
						diff = true;
					}
				}
			}
			// Index does NOT exist, flag for creation
			else {
				diff = true;
			}

			// Drop existing index if DB differs from %opts
			if (drop) {
				const dropSql = `drop index ${indexNameSql}`;
				// print "Debug: Index '$keyName' changed, deleting and recreating. Delete SQL: $sql\n";
				sql.push(dropSql);

				await execQuery(dropSql, true);
			}

			// Create index if different or if does not exist
			if (diff) {
				let createSql = `${createIndexSql} ${indexNameSql} (`;
				createSql += cols
					.map((col) => {
						// JSON access operator ->> inside an index column
						// indicates the user wants to use a functional index.
						// Requires mysql 8.0.13 or newer.
						// Up to the user to ensure they are operating in a supported environment.
						if (`${col || ''}`.includes('->>')) {
							const [ourField] = col.split('->>') || [];
							if (!fields[ourField]) {
								console.error(
									`Cannot find definition for JSON column '${ourField}' (shown as "${col}" in the schema) given in index '${keyName}' - check your definition and try again`,
								);
								return undefined;
							}

							// JSON access operator ->> inside an index column
							// indicates the user wants to use a functional index
							// See example documented: https://planetscale.com/blog/indexing-json-in-mysql#functional-indexes
							// In this case, we expect the user to give the column in the schema
							// as the exact accessor to index, example:
							// - `properties->>"$.request.email"` will index the request.email
							//  field in the JSON column named "properties"
							// Should result in a final DDL like:
							// - `alter table user_payment_methods add index stripeData_customer ((cast(stripeData->>"$.customer" as char(255)) collate utf8mb4_bin));`
							return `(CAST(${col} as CHAR(255)) COLLATE utf8mb4_bin)`;
						}

						const nameAndArgsMatch = col.match(colNameExtractRegex);
						// eslint-disable-next-line no-unused-vars
						const [unused, colName, argString] = nameAndArgsMatch || [col];

						if (!fields[colName]) {
							console.error(
								`Cannot find definition for column '${col}' given in index '${keyName}' - check your definition and try again`,
							);
							return undefined;
						}

						if (argString) {
							// Return the column name with the argument string appended, assuming the user spec'dd the proper text length in the schema
							// or possibly did something like "createdAt DESC"  to optimize indexing.
							return `\`${colName}\`${argString}`;
						}

						// Our current (existing, legacy) indexing - just return the column name and optional length if needed
						return `\`${col}\`${fields[col].type.match(/text/) ? '(255)' : ''}`;
					})
					.filter(Boolean)
					.join(', ');

				createSql += ')';

				console.log(`Debug: (re)Creating index '${keyName}': `, createSql);
				sql.push(createSql);
				await execQuery(createSql, true);
			}
		});

		// Remove any indexes on the table that aren't explicitly listed in the schema (other than PRIMARY)
		await promiseMap(Object.keys(indexesInDatabaseLookup), async (keyName) => {
			if (keyName === 'PRIMARY') {
				return;
			}

			// Remove indexes that are not in the schema
			if (!Object.prototype.hasOwnProperty.call(opts.indexes, keyName)) {
				const dropSql = `drop index \`${keyName}\` on ${table}`;
				console.log(`Debug: Index '${keyName}' removed: `, dropSql);
				sql.push(dropSql);

				await execQuery(dropSql, true);
			}
		});
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
		Object.assign(idField, hasUuidKey ? PriKeyUuidAttrs : PriKeyAttrs);
	} else {
		fields.push({ ...PriKeyAttrs, field: idFieldFromTable || 'id' });
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
	let error;
	const existingSchema = await execQuery(
		`SHOW FULL COLUMNS FROM \`${table}\``,
	).catch((ex) => {
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

	existingSchema.forEach((existingRow) => {
		const data = {};
		Object.keys(existingRow).forEach((key) => {
			data[`${key}`.toLowerCase()] = existingRow[key];
		});

		const { field, type: rawType, key } = data;
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
	const tables = await execQuery(`show tables`);

	// const [ table ] = Object.values(tables.shift());
	// await dumpSchema(table);

	await promiseMap(tables, async (row) => {
		const table = Object.values(row)[0];
		const model = await dumpSchema(table);

		writeModel({ table, model, defsPath, modelsPath });
	});
}

module.exports = {
	promiseMap,
	syncSchemaToDb,
	convertFile,
	dumpDatabaseSchemas,
	uploadMatchRatioFunctionFactory: uploadMatchRatioFunction,
	uploadMatchRatioFunction: () => {
		uploadMatchRatioFunction(DB_HOST, DB_NAME, USER, PASSWORD, PORT);
	},
};
