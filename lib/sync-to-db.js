/* eslint-disable no-console, import/no-dynamic-require, global-require, no-nested-ternary, no-param-reassign */
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const chalk = require('chalk');

const config = require('../lib/config');
const { dbh: factory } = require('../lib/dbh');

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

async function uploadIdTrigger(host, db, user, pass, port, table) {
	const triggerName = `before_insert_${table}_set_id`;

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
	} = fieldData;
	const { key: ignoreKey } = ignoreMap;

	const fieldSpec = `\`${field}\` ${type}${
		nullVal === 'NO' || nullVal === '0' ? ' NOT NULL' : ''
	}${
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

	// console.log(`fieldSpec: `, { fieldSpec, fieldData });
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
	type: 'char(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
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

async function mysqlSchemaUpdate(db, table, fieldList, opts) {
	const sql = [];

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
		`show tables where \`Tables_in_${db}\`='${table}'`,
	);
	const tableExists = !!tables.length;

	// Assuming table exists - compare
	if (tableExists) {
		let error;
		const existingSchema = !tableExists
			? null
			: await execQuery(`explain \`${table}\``).catch((ex) => {
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
				alter.push(`ALTER TABLE \`${table}\` ADD ${mysqlFieldSpec(fieldData)}`);
				changedColumns.push({ col: key, type: 'ADD' });
			}
			// If key exists in %explain, do a simple === diff comparrison
			else if (explainMap[key] !== undefined) {
				const a = explainMap[key];
				const b = fieldData;
				let cnt = 0;

				const { type: aType } = a;

				Object.keys(a).forEach((k) => {
					const ak = a[k] || '';
					const bk = b[k] || '';

					if (ak !== bk) {
						// Normalize some nitch cases that are known to be different ...

						if (
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
						`ALTER TABLE \`${table}\` CHANGE \`${key}\` ${mysqlFieldSpec(
							fieldData,
							{ ignore: 'key' },
						)}`,
					);
					changedColumns.push({ col: key, type: 'CHANGE' });
				}
			}
		});

		// foreach const key (keys %explain)
		Object.keys(explainMap).forEach((key) => {
			if (!fields[key]) {
				// Decide if this is safe
				if (ALLOW_DROP) {
					alter.push(`ALTER TABLE \`${table}\` DROP \`${key}\``);
					changedColumns.push({ col: key, type: 'DROP' });
				} else {
					console.log(
						` ***** Possible drop needed, but not dropping to preserve data: '${table}.${key}'`,
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
		const buff = [`CREATE TABLE \`${table}\` (`];
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
		// Add a default index on the isDeleted column
		opts.indexes.isDeleted = ['isDeleted'];

		// Load existing indexes from database
		const indexSql = `show indexes from \`${table}\``;

		let indexError;
		const indexRows = await execQuery(indexSql).catch((ex) => {
			indexError = ex;
		});

		if (indexError) {
			console.warn(`Error reading existing indexes from ${table}:`, indexError);
			return;
		}

		const hash = {};
		indexRows.forEach((ref) => {
			// console.log(`indexRows: ref=`, ref);
			const { Key_name: keyName, Column_name: columnName } = ref;
			if (!hash[keyName]) {
				hash[keyName] = {};
			}
			hash[keyName][columnName] = ref;
		});

		// Compare indexes in %opts with the database indexes
		await promiseMap(Object.keys(opts.indexes), async (keyName) => {
			let diff = false;
			let drop = false;
			let dbData = hash[keyName];

			// If index does exists in DB, compare and flag if different
			if (dbData) {
				const cols = opts.indexes[keyName] || [];
				cols.forEach((col) => {
					if (!dbData[col]) {
						diff = true;
					}
				});

				if (diff) {
					drop = true;
				}

				// TODO: Compare diff the other direction: DB has cols that @cols does not have......
			}
			// Index does NOT exist, flag for creation
			else {
				diff = true;
			}

			// Drop existing index if DB differs from %opts
			if (drop) {
				const dropSql = `drop index \`${keyName}\` on \`${table}\``;
				// print "Debug: Index '$keyName' changed, deleting and recreating. Delete SQL: $sql\n";
				// push @sql, $sql;
				sql.push(dropSql);

				// $dbh->do($sql) unless $dryRun;
				await execQuery(dropSql, true);
			}

			// Create index if different or if does not exist
			if (diff) {
				const cols = opts.indexes[keyName] || [];
				let createSql = `create index \`${keyName}\` on \`${table}\` (`;
				// createSql += join(',', map { '`'.$_.'`' . ($fields{$_}->{type} =~ /text/ ? '(255)' : '') } @cols);
				createSql += cols
					.map((col) => {
						if (!fields[col]) {
							console.error(
								`Cannot find definition for column '${col}' given in index '${keyName}' - check your definition and try again`,
							);
							return undefined;
						}
						return `\`${col}\`${fields[col].type.match(/text/) ? '(255)' : ''}`;
					})
					.filter(Boolean)
					.join(', ');
				createSql += ')';

				console.log(`Debug: (re)Creating index '${keyName}': `, createSql);
				sql.push(createSql);
				// $dbh->do($sql) unless $dryRun;
				await execQuery(createSql, true);
			}
		});

		// Compare indexes in %opts with ones in DB and delete from DB any not in %opts
		// foreach const keyName (keys %hash)
		await promiseMap(Object.keys(hash), async (keyName) => {
			if (keyName === 'PRIMARY') {
				return;
			}

			if (!opts.indexes[keyName]) {
				const dropSql = `drop index \`${keyName}\` on \`${table}\``;
				console.log(`Debug: Index '${keyName}' removed: `, dropSql);
				sql.push(dropSql);
				// $dbh->do($sql) unless $dryRun;
				await execQuery(dropSql, true);
			}
		});
	}

	// push @mysql_schema_sql_debug_output, @sql ? ("<h3>Table: $table</h3>", @sql) : ();
}

async function syncSchemaToDb(schema) {
	const { fields, table, options } = schema;

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
		fields.push({ ...PriKeyAttrs, field: 'id' });
	}

	// Apply the actual update to the database (does nothing if the definiton and database match)
	await mysqlSchemaUpdate(DB_NAME, table, fields, options);

	// Attach our UUID trigger
	if (hasUuidKey) {
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
	const existingSchema = await execQuery(`explain \`${table}\``).catch((ex) => {
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
	uploadMatchRatioFunction: () => {
		uploadMatchRatioFunction(DB_HOST, DB_NAME, USER, PASSWORD, PORT);
	},
};
