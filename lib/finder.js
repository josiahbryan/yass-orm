/* eslint-disable no-param-reassign, global-require, no-console, import/no-dynamic-require, no-nested-ternary */

const { handle, retryIfConnectionLost, CodeTimingHelper } = require('./utils');

function dbQuote(identifier) {
	// return '`' + (`${identifier}`.replace(/`/g,'')) + '`';
	return `\`${identifier}\``;
}

function prefixedField(table, field) {
	return `${dbQuote(table)}.${dbQuote(field)}`;
}

function getStringifyColumns(def, opts) {
	opts = opts || (opts = {});
	if (opts.lower === undefined) {
		opts.lower = true;
	}
	opts.onlyCols = opts.onlyCols || 0;

	// console.dir(def, { depth: 10 });

	const sqlList = [];
	const rawFields = def.stringifyAs ? def.stringifyAs : [];

	if (!rawFields.length) {
		Object.values(def.fieldMap)
			.filter(
				(row) =>
					row.type === 'varchar' || row.type === 'longtext' || row.objectSchema,
			)
			.forEach((row) => {
				if (row.objectSchema) {
					Object.values(row.objectSchema).forEach((subrow) => {
						if (subrow.type === 'varchar' || subrow.type === 'longtext') {
							rawFields.push(subrow.field);
						}
					});
				} else {
					rawFields.push(row.field);
				}
			});
	}

	rawFields.forEach((origFieldName) => {
		if (!origFieldName) {
			return;
		}

		const fieldName = origFieldName.replace(/^#/, '');
		if (origFieldName.startsWith('#')) {
			if (!fieldName || !def.fieldMap[fieldName]) {
				// Protect against possible invalid field names from the user
				throw new Error(`Unknown stringifyAs field: ${fieldName}`);
			}

			const sql = opts.lower
				? `LOWER(${prefixedField(def.table, fieldName)})`
				: prefixedField(def.table, fieldName);

			sqlList.push(`IFNULL(${sql},'')`);
		} else if (!opts.onlyCols) {
			const str = prefixedField(def.table, origFieldName.replace("'", "\\'"));

			sqlList.push(opts.lower ? `LOWER(${str})` : str);
		}
	});

	return sqlList;
}

function getStringifySql(def, opts) {
	opts = opts || (opts = {});
	const sqlList = getStringifyColumns(def, opts);

	const sql =
		sqlList.length > 1
			? `CONCAT(${sqlList.join(', ')})`
			: sqlList.length === 1
			? sqlList[0]
			: "''";

	// console.log("[getStringifySql]", sql);
	return sql;
}

function getOrder(sort = {}) {
	let order = [];

	Object.keys(sort).forEach((name) =>
		order.push([name, parseInt(sort[name], 10) === 1 ? 'ASC' : 'DESC']),
	);

	return order;
}

function getWhere(query) {
	let where = Object.assign({}, query);

	if (where.$select) {
		delete where.$select;
	}

	Object.keys(where).forEach((prop) => {
		let value = where[prop];
		if (value && value.$nin) {
			value = Object.assign({}, value);

			value.$notIn = value.$nin;
			delete value.$nin;

			where[prop] = value;
		}
	});

	return where;
}

function debugSql(sql, args) {
	// return sql.replace(/\?/g, () => args.shift());
	return sql.replace(/\?/g, () => {
		const v = args.shift();
		if (v !== 'null' && Number.isNaN(parseFloat(v))) {
			return `"${v}"`;
		}
		return v;
	});
}

async function finder(params, incomingOpts) {
	const model = this;

	const className = (model.constructor && model.constructor.name) || '';

	const timeHelp = new CodeTimingHelper(`finder[${className}]`);
	timeHelp.mark('start');

	const opts = Object.assign({
		// queryParams is a pass-thru list of fields, where, if not undefined
		// Will be given as args  - if null, any valid model field from the schema can be directly filtered as a simple "==" filter
		queryParams: null, // ['email'], //null,
		mutateQuery: (/* query, sqlData, ctx */) => {
			return Promise.resolve();
		},
		mutateSort: (sort /* , sqlData, ctx */) => {
			return Promise.resolve(sort);
		},
		mutateResult: (result /* , query, ctx */) => {
			return Promise.resolve(result);
		},
		mutateMeta: (meta /* , sqlData, ctx */) => {
			return Promise.resolve(meta);
		},
		mutateJoins: (/* query, sqlData, ctx */) => {
			return Promise.resolve();
		},
	});

	Object.keys(opts).forEach((key) => {
		if (model.prototype[key]) {
			opts[key] = model.prototype[key].bind(model);
		}
	});

	if (model.allowedFindParams) opts.queryParams = model.allowedFindParams();

	Object.assign(opts, incomingOpts || {});

	let idColumn = 'id';
	let idColumnSafe = 'id';

	const def = model.schema();

	const preprocess = (data) => {
		if (data.query)
			// from feathersjs
			data = data.query;

		const filters = {};
		const query = {};
		Object.keys(data || {}).forEach((key) => {
			if (key.startsWith('$')) {
				filters[key] = data[key];
			} else {
				query[key] = data[key];
			}
		});

		return { filters, query };
	};

	const { filters, query } = preprocess(params || {});
	// console.log("[finder] debug: ", { filters, query, params });

	// // Allow client to bypass our modification and just directly
	// // query via sequelize
	// if(query.$raw) {
	// 	delete params.query.$raw;
	// 	return _origFind.call(serviceImpl, params);
	// }

	const where = getWhere(query);
	const order = getOrder(filters.$sort);

	// console.log("*********** Service find intercept, faux reimpl:", q, def);

	// (JB) NOTE: Special chars (\t and \n) added to generated SQL below
	// are simply to make debugging easier

	// Note: two sets of args so we can only use whereArgs when doing counting
	const sqlData = {
		fieldArgs: [],
		fieldList: [],
		whereArgs: [],
		whereList: [],
		tableName: dbQuote(def.table),
	};

	// First, compose a simple list of the fields to select
	// Object.keys(def.schema).forEach( fieldName => {
	// 	const fieldDef = def.schema[fieldName];
	// 	if (fieldDef.isRelation &&
	// 		fieldDef.relationship == 'hasMany')
	// 		return;
	//
	// 	sqlData.fieldList.push(dbQuote(fieldName));
	// });

	// Just for debugging
	sqlData.fieldList.push(`${dbQuote(def.table)}.*`);

	// Initalize where clause
	sqlData.whereList = [
		def.legacyExternalSchema
			? 'deleted=0'
			: `${prefixedField(def.table, 'isDeleted')} = 0`,
	];

	// Basic implicit filters - match account if given
	if (where.account !== undefined) {
		if (where.account === null) {
			sqlData.whereList.push('`account` = null');
		} else {
			sqlData.whereList.push('`account` = ?');
			sqlData.whereArgs.push(where.account);
		}
	}

	// Special-case the 'q' query param as a search query
	if (query.q) {
		let filterNonWild = `${query.q}`.toLowerCase();
		let filterWild = filterNonWild;

		filterWild = `%${filterWild
			.replace(/[^\da-z]/g, ' ') // remove anything not a digit or a letter
			.replace(/(.)/g, '$1%') // insert '%' between every character
			.replace(/%\s*%/g, '%')}`; // collapse '% %' into '%'

		// sqlData.args.push(filterNonWild, filterWild);

		// (1) Add Ranking Column using the match_ratio() function from AppCore
		{
			// # Get the list of columns to use in our ratio
			const columns = getStringifyColumns(def, { onlyCols: true });

			// # Call match_ratio() to match the filter against each column in the stringify_fmt()
			const ratioList = [];
			columns.forEach((identifier) => {
				ratioList.push(`match_ratio(${identifier}, ?, ?)`);
				sqlData.fieldArgs.push(filterNonWild, filterWild);
			});

			// console.warn(`got ratioList:`, ratioList, `, from columns:`, columns);

			// If columns.length==1 then the stringifySql will be the same as the ratio for the single
			// column, so no need to add additional complexity
			if (columns.length > 1) {
				// # Add another 'column' for the ratio against the entire unified stringify_fmt() value
				const textSql = getStringifySql(def, { lower: true }); // lower: lower case the fields
				ratioList.push(`match_ratio(${textSql}, ?, ?)`);
				sqlData.fieldArgs.push(filterNonWild, filterWild);

				// # Combine them into an average match ratio as a single SQL statement,
				// # suitable for use like "select $rankSql as `ranking` from ... where ...""
				const rankSql = `((\n\t${ratioList.join(' + \n\t')}) / ${
					ratioList.length
				})`;

				// fields is the list of fields to select
				sqlData.fieldList.push(`${rankSql} as _search_rank`);
			} else {
				// Just select the single ratio for the rank since only one stringification value
				sqlData.fieldList.push(`${ratioList[0]} as _search_rank`);
			}

			// For returning to the user
			sqlData.fieldList.push(
				`${getStringifySql(def, { lower: false })} as _search_text`,
			);
		}

		// (2) Add filter values
		{
			const textSql = getStringifySql(def, { lower: true }); // lower: lower case the fields

			sqlData.whereList.push(
				`(\n\t\t(${textSql} like ?) AND \n\t\t(${textSql} <> ''))`,
			);
			sqlData.whereArgs.push(filterWild);
		}
	}

	function queryValues(fieldList, whereClause, whereArgs) {
		if (!whereClause) whereClause = '1=1 -- Empty whereClause on queryValues';

		return retryIfConnectionLost((dbh) =>
			dbh.pquery(
				`SELECT ${fieldList}
			 FROM   ${sqlData.tableName}
			 ${sqlData.joinSql || ''}
			 WHERE  ${sqlData.whereClause}
			   AND  ${whereClause}`,
				sqlData.whereArgs.concat(whereArgs || []),
			),
		);
	}

	function queryValuesPlain(fieldList, whereClause, whereArgs) {
		if (!whereClause) whereClause = '1=1 -- Empty whereClause on queryValues';

		return retryIfConnectionLost((dbh) =>
			dbh.pquery(
				`SELECT ${fieldList}
			 FROM   ${sqlData.tableName}
			 ${sqlData.joinSql || ''}
			 WHERE  ${whereClause}`,
				whereArgs || [],
			),
		);
	}

	function addSortingField(datum) {
		let fieldName;
		let direction;

		// console.log("[custom-query-filter.(parse orderSourceList)] datum=", datum);
		if (typeof datum !== 'string' && datum.length === 2) {
			const [fieldStr, dirStr] = datum;
			fieldName = fieldStr;
			direction = `${dirStr}`.toUpperCase();

			if (['ASC', 'DESC'].indexOf(direction) < 0) {
				throw new Error(
					`Unknown direction '${direction}' on field '${fieldName}'`,
				);
			}
		} else {
			fieldName = datum;
			direction = 'ASC';
		}

		const fieldDef = def.fieldMap[fieldName];
		if (!fieldDef) {
			// Protect against possible invalid field names from the user
			throw new Error(`Unknown sorting field: ${fieldName}`);
		}

		// TODO: Sort by stringified value of foreign keys?? A la AppCore::DBI in perl?
		// if (fieldDef.isRelation &&
		// 	fieldDef.relationship == 'hasMany')
		// 	return;

		// TODO: Factor in sort direction options from definition (asc vs desc)
		sqlData.orderFieldList.push(
			`${prefixedField(def.table, fieldName)} ${direction}`,
		);
	}

	const hookCtx = {
		addSortingField,
		query,
		dbh: await handle(),
		retryIfConnectionLost,
		dbQuote,
		def,
		getStringifySql,
		getStringifyColumns,
		debugSql,
		queryValues,
		queryValuesPlain,
		filters,
	};

	timeHelp.mark('context prep');

	// Allow users of our custom-query-filter to add filters specific to the model via
	// processing query args and adding clauses to whereList/whereArgs, etc
	return opts
		.mutateQuery(query, sqlData, hookCtx)
		.then(() => {
			timeHelp.mark('mutateQuery');
			// Pass-thru the allowed query params
			// Execute the pass-thru logic AFTER mutateQuery() executes,
			// so that mutateQuery() can modify the query data if desired
			if (opts.queryParams) {
				opts.queryParams.forEach((fieldName) => {
					const fieldDef = def.fieldMap[fieldName];
					if (!fieldDef) {
						// Protect against possible invalid field names from the user
						throw new Error(`Unknown queryParam field: ${fieldName}`);
					}

					const value = query[fieldName];
					const quoted = dbQuote(fieldName);

					if (value !== undefined && value !== null) {
						// if(value === null) {
						// 	sqlData.whereList.push(`${quoted} is null`);
						// } else {
						sqlData.whereList.push(`${prefixedField(def.table, quoted)} = ?`);
						sqlData.whereArgs.push(value);
						// }
					}
				});
			} else {
				// Check for any valid model field on the query if no explicit query params defined
				Object.keys(def.fieldMap).forEach((fieldName) => {
					const value = query[fieldName];
					const quoted = dbQuote(fieldName);

					if (value !== undefined && value !== null) {
						sqlData.whereList.push(`${prefixedField(def.table, quoted)} = ?`);
						sqlData.whereArgs.push(value);
					}
				});
			}

			// Setup sorting for the list
			const orderFieldList = [];
			const orderSourceList = JSON.parse(
				JSON.stringify(
					order && order.length > 0 ? order : def.sortBy ? def.sortBy : [],
				),
			);

			// Add our search ranking to the sort list
			if (query.q) orderFieldList.push('_search_rank DESC');

			sqlData.orderFieldList = orderFieldList;

			// Give our mutateQuery hook a chance to change the orderSourceList before we validate it.
			// For example, in contacts.service, we intercep the column 'nearFilterResult.distance', remove it from orderSourceList,
			// and add an appropriate SQL statement to sqlData.orderFieldList to effect the sort needed
			return opts.mutateSort(orderSourceList, sqlData, hookCtx);
		})
		.then((orderSourceList) => {
			timeHelp.mark('mutateSort');
			orderSourceList.forEach(addSortingField);

			return opts.mutateJoins(sqlData, hookCtx);
		})
		.then(async ([joinSql, joinArgs] = []) => {
			timeHelp.mark('mutateJoins');
			// Finally, compose our SQL
			sqlData.whereClause = sqlData.whereList.join('\n\t AND ');
			sqlData.orderClause = sqlData.orderFieldList.length
				? sqlData.orderFieldList.join(', ')
				: 'id';

			let sql = [
				`SELECT   ${sqlData.fieldList.join(',\n\t')}`,
				`FROM     ${sqlData.tableName}`,
			];

			// Insert raw joins if present
			let { whereArgs } = sqlData;
			if (joinSql) {
				// console.log(` ** Adding join data:`, { joinSql, joinArgs });
				sql.push(joinSql);
				if (joinArgs) {
					whereArgs = [...joinArgs, whereArgs];
				}

				sqlData.joinSql = joinSql;
				sqlData.whereArgs = whereArgs;
			}

			sql = [
				...sql,
				`WHERE    ${sqlData.whereClause}`,
				`ORDER BY ${sqlData.orderClause}`,
			].join('\n');

			// Add limits to the SQL if needed
			if (filters.$limit)
				sql += `\nLIMIT ${parseInt(filters.$skip || 0, 10)}, ${parseInt(
					filters.$limit,
					10,
				)}`;

			// console.log("****** generated: ", sql, sqlData.fieldArgs, whereArgs);

			const t1 = Date.now();
			const res = await retryIfConnectionLost((dbh) =>
				dbh.pquery(sql, sqlData.fieldArgs.concat(whereArgs)),
			);
			const t2 = Date.now();
			const delta = t2 - t1;

			console.log(
				'******** generated:\n\n',
				debugSql(sql, sqlData.fieldArgs.concat(whereArgs)),
				'\n',
				{ query, filters, delta },
			);

			return res;
		})
		.then(async (result) => {
			timeHelp.mark('query exec');
			if (def.legacyExternalSchema) {
				result.forEach((row) => {
					row.id = row[idColumn];
				});
			}

			// const t1 = new Date();

			result = await Promise.all(
				result.map(async (row) => {
					if (row._search_rank) {
						row._search_rank = parseFloat(row._search_rank);
					}

					const inflated = await model.inflateValues(row);
					return Object.assign(row, inflated);
				}),
			);

			timeHelp.mark('inflateValues');
			// const t2 = new Date(), delta = t2 - t1;
			// console.log(" *** inflate took:", delta);

			// Give our mutateResult hook a chance to decorate the results with additional attributes.
			// For example, contacts.service adds data to each row in the 'nearFilterResult' attribute (if needed)
			return opts.mutateResult(result, query, hookCtx);
		})
		.then((result) => {
			timeHelp.mark('mutateResult');

			const packet = {
				total: result.length,
				limit: filters.$limit,
				skip: filters.$skip || 0,
				data: result,
				extra: {},
			};

			// Allow users to add additional meta data to the result,
			// such as scope of values (for visulization)
			return opts.mutateMeta(packet, sqlData, hookCtx);
		})
		.then((packet) => {
			timeHelp.mark('mutateMeta');

			// console.log("[custom-query-filter] packet after mutate:", packet);

			if (!packet.extra) {
				packet.extra = {};
			}

			// Used client-side in {{linked-field}} to automatically enable server-filtering when
			// extra.$q is detected in live-query's serverMeta
			packet.extra.$serverFiltered = true;

			// mutateMeta() hooks can set $infiniteTotal to a true value
			// so they can spoof the .total to whatever they want
			if (
				filters.$limit &&
				!filters.$infiniteTotal &&
				!packet.extra.$infiniteTotal &&
				!packet.totalSetManually
			) {
				return queryValues(
					`COUNT(${prefixedField(def.table, idColumnSafe)}) AS totalRows`,
				).then((result) => {
					timeHelp.mark('packet.total');

					packet.total = parseFloat(result[0].totalRows);

					// timeHelp.dump();
					this.latestCodeTiming = timeHelp.stringify();

					return packet;
				});
			}

			timeHelp.mark('packet(no total)');
			// timeHelp.dump();
			this.latestCodeTiming = timeHelp.stringify();

			return packet;
		});
}

function filterData(results, parentCtx, sql, params, debugName) {
	const idList = [];
	results.forEach((r) => idList.push(r.id));

	// console.log("[custom-query-filter.filterData] ("+debugName+"): SQL:\n\n" + parentCtx.ctx.debugSql(sql,params)+"\n# Resulting ID list: ", idList, " (", idList.length ," vs ", results.length, ")");

	console.log(
		`[custom-query-filter.filterData] (${debugName}): SQL:\n\n${parentCtx.ctx.debugSql(
			sql,
			params,
		)}\n# Resulting ID list: `,
		idList.slice(0, 5),
		'# only up to first 5 ids ',
	);

	if (idList.length > 0) {
		parentCtx.data.whereList.push(
			`id in ('${idList.join("','")}') -- Matches ${debugName} filter`,
		);
	} else {
		parentCtx.data.whereList.push(`0=1 -- No ${debugName} found `);
	}

	return results;
}

function promiseFilter(sql, params, parentCtx, debugName) {
	return retryIfConnectionLost((dbh) =>
		dbh
			.pquery(sql, params)
			.then((results) =>
				filterData(results, parentCtx, sql, params, debugName),
			),
	);
}

module.exports = {
	finder,
	filterData,
	promiseFilter,
};
