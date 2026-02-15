/* eslint-disable no-continue */
const { Parser } = require('node-sql-parser');

const parser = new Parser();

function visitAst(node, visitor) {
	if (!node || typeof node !== 'object') {
		return node;
	}
	const replaced = visitor(node) || node;
	if (Array.isArray(replaced)) {
		return replaced.map((item) => visitAst(item, visitor));
	}
	Object.keys(replaced).forEach((key) => {
		replaced[key] = visitAst(replaced[key], visitor);
	});
	return replaced;
}

function createFunctionNode(name, args) {
	return {
		type: 'function',
		name: {
			name: [{ type: 'default', value: name }],
		},
		args: {
			type: 'expr_list',
			value: args,
		},
		over: null,
	};
}

function createStringNode(value) {
	return { type: 'single_quote_string', value };
}

function transformConcatNode(node) {
	const args = (node.args && node.args.value) || [];
	if (!args.length) {
		return createStringNode('');
	}
	return args.slice(1).reduce(
		(left, right) => ({
			type: 'binary_expr',
			operator: '||',
			left,
			right,
		}),
		args[0],
	);
}

function transformAstForSqlite(ast) {
	return visitAst(ast, (node) => {
		if (node.type === 'function') {
			const fnName =
				node.name &&
				node.name.name &&
				node.name.name[0] &&
				`${node.name.name[0].value || ''}`.toUpperCase();
			if (fnName === 'NOW') {
				return createFunctionNode('datetime', [createStringNode('now')]);
			}
			if (fnName === 'CURDATE') {
				return createFunctionNode('date', [createStringNode('now')]);
			}
			if (fnName === 'CONCAT') {
				return transformConcatNode(node);
			}
		}

		if (
			node.type === 'binary_expr' &&
			(node.operator === '->>' || node.operator === '->')
		) {
			const jsonPath = node.right
				? {
						...node.right,
						// SQLite json_extract examples typically use single-quoted paths.
						type:
							node.right.type === 'double_quote_string'
								? 'single_quote_string'
								: node.right.type,
				  }
				: createStringNode('$');
			return createFunctionNode('json_extract', [node.left, jsonPath]);
		}

		return node;
	});
}

function transformCodeSegments(sql, transformCode) {
	let out = '';
	let idx = 0;
	while (idx < sql.length) {
		const ch = sql[idx];
		const next = sql[idx + 1];

		// Single-line comments
		if (ch === '-' && next === '-') {
			const end = sql.indexOf('\n', idx + 2);
			if (end < 0) {
				out += sql.slice(idx);
				break;
			}
			out += sql.slice(idx, end + 1);
			idx = end + 1;
			continue;
		}

		// Multi-line comments
		if (ch === '/' && next === '*') {
			const end = sql.indexOf('*/', idx + 2);
			if (end < 0) {
				out += sql.slice(idx);
				break;
			}
			out += sql.slice(idx, end + 2);
			idx = end + 2;
			continue;
		}

		// Quoted literals/identifiers
		if (ch === "'" || ch === '"' || ch === '`') {
			let end = idx + 1;
			while (end < sql.length) {
				const q = sql[end];
				if (q === '\\') {
					end += 2;
					continue;
				}
				if (q === ch) {
					// Handle doubled quote escapes, e.g. '' or ""
					if (sql[end + 1] === ch && ch !== '`') {
						end += 2;
						continue;
					}
					end += 1;
					break;
				}
				end += 1;
			}
			out += sql.slice(idx, end);
			idx = end;
			continue;
		}

		// Collect plain code until special token starts.
		let end = idx + 1;
		while (end < sql.length) {
			const c = sql[end];
			const n = sql[end + 1];
			if (
				c === "'" ||
				c === '"' ||
				c === '`' ||
				(c === '-' && n === '-') ||
				(c === '/' && n === '*')
			) {
				break;
			}
			end += 1;
		}
		out += transformCode(sql.slice(idx, end));
		idx = end;
	}
	return out;
}

function transformSqlWithScanner(sql, params = {}) {
	const keys = Object.keys(params || {}).sort((a, b) => b.length - a.length);
	return transformCodeSegments(sql, (code) => {
		let transformed = code;

		// Convert :name to $name for SQLite placeholders.
		keys.forEach((key) => {
			transformed = transformed.replace(
				new RegExp(`:${key}(?![a-zA-Z0-9_])`, 'g'),
				`$${key}`,
			);
		});

		// Convert MySQL backtick identifiers to SQL-standard double-quoted identifiers.
		transformed = transformed.replace(/`([^`]+)`/g, '"$1"');

		// Convert MySQL LIMIT offset,count to SQLite LIMIT count OFFSET offset.
		transformed = transformed.replace(
			/LIMIT\s+(\d+)\s*,\s*(\d+)/gi,
			'LIMIT $2 OFFSET $1',
		);

		// Safety conversions if parser path cannot be used.
		transformed = transformed.replace(/\bNOW\s*\(\s*\)/gi, "datetime('now')");
		transformed = transformed.replace(/\bCURDATE\s*\(\s*\)/gi, "date('now')");
		transformed = transformed.replace(
			/CONCAT\s*\(([^)]+)\)/gi,
			(match, args) => {
				const parts = args.split(',').map((p) => p.trim());
				return `(${parts.join(' || ')})`;
			},
		);
		transformed = transformed.replace(
			/(\w+)->>["'](\$\.[^"']+)["']/g,
			"json_extract($1, '$2')",
		);
		transformed = transformed.replace(
			/(\w+)->["'](\$\.[^"']+)["']/g,
			"json_extract($1, '$2')",
		);

		return transformed;
	});
}

function unquoteSimpleIdentifiers(sql) {
	return transformCodeSegments(sql, (code) =>
		code.replace(/"([a-zA-Z_][a-zA-Z0-9_]*)"/g, '$1'),
	);
}

function transformSqlForSqlite({ sql, params = {} }) {
	// Preserve comments exactly as written; parser/sqlify drops comments.
	if (sql.includes('--') || sql.includes('/*')) {
		return {
			sql: transformSqlWithScanner(sql, params),
			mode: 'scanner',
		};
	}

	try {
		const ast = parser.astify(sql, { database: 'mysql' });
		const transformedAst = transformAstForSqlite(ast);
		const sqliteSql = parser.sqlify(transformedAst, { database: 'sqlite' });
		// We still run the scanner pass for placeholder/limit normalization.
		return {
			sql: unquoteSimpleIdentifiers(transformSqlWithScanner(sqliteSql, params)),
			mode: 'ast',
		};
	} catch (err) {
		return {
			sql: transformSqlWithScanner(sql, params),
			mode: 'scanner',
			error: err,
		};
	}
}

module.exports = {
	transformSqlForSqlite,
	transformSqlWithScanner,
	transformAstForSqlite,
};
