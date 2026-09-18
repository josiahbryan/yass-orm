/* eslint-disable no-console */
/**
 * BDL-3886 probe — run as a CHILD PROCESS by test/finder.no-bound-values-on-stdout.test.js
 * so the parent can capture stdout and stderr SEPARATELY and byte-for-byte.
 *
 * It drives lib/finder.js down its SUCCESS path with distinctive bound parameter
 * values (nonces, passed in via env) and a fake dbh, so no database is needed.
 * This file itself must never print a nonce: the parent asserts that none of
 * them appear on either stream, so anything printed here would be a false red.
 *
 * Shapes exercised (each carries its own nonce so a leak names its route):
 *   Q      Model.find({ q })                  -> finder.js query.q block + generated-SQL log
 *   FIELD  Model.find({ name })               -> field-equality whereArgs
 *   HOOK   mutateQuery pushes a whereArg       -> hookCtx / custom-filter shape
 *   FILTER filterData(..., [nonce]) directly   -> exported custom-query-filter path,
 *          with a POSITIONAL ctx.debugSql (the worst case: it would interpolate)
 */
const utils = require('../../lib/utils');

const { NONCE_Q, NONCE_FIELD, NONCE_HOOK, NONCE_FILTER } = process.env;

// Count how many times each nonce actually reached the driver as a bound value.
// This is the proof that the value FLOWED through finder — without it, "absent
// from the output" could just mean "never bound".
const boundHits = { Q: 0, FIELD: 0, HOOK: 0, FILTER: 0 };
const noteBound = (args) => {
	const flat = JSON.stringify(args);
	if (flat.includes(NONCE_Q)) boundHits.Q += 1;
	if (flat.includes(NONCE_FIELD)) boundHits.FIELD += 1;
	if (flat.includes(NONCE_HOOK)) boundHits.HOOK += 1;
	if (flat.includes(NONCE_FILTER)) boundHits.FILTER += 1;
};

const fakeDbh = {
	async pquery(sql, args) {
		noteBound(args);
		if (/COUNT\(/.test(sql)) return [{ totalRows: 1 }];
		return [{ id: 'row-1', name: 'alpha' }];
	},
};

// finder.js destructures these at require time, so stub BEFORE requiring it.
utils.handle = async () => fakeDbh;
utils.retryIfConnectionLost = (cb) => cb(fakeDbh);

const { finder, filterData } = require('../../lib/finder');

class Widget {
	static schema() {
		return {
			table: 'widgets',
			stringifyAs: ['#name'],
			fieldMap: {
				id: { field: 'id', type: 'char' },
				name: { field: 'name', type: 'varchar' },
				isDeleted: { field: 'isDeleted', type: 'int' },
			},
		};
	}

	static async inflateValues() {
		return {};
	}
}

(async () => {
	await finder.call(Widget, { q: NONCE_Q, $limit: 10 });
	await finder.call(Widget, { name: NONCE_FIELD });
	await finder.call(
		Widget,
		{},
		{
			mutateQuery: async (query, sqlData) => {
				sqlData.whereList.push('`widgets`.`name` <> ?');
				sqlData.whereArgs.push(NONCE_HOOK);
			},
		},
	);

	const parentCtx = {
		ctx: {
			debugSql: (sql, args) =>
				sql.replace(/\?/g, () => `'${[...args].shift()}'`),
		},
		data: { whereList: [] },
	};
	const filterArgs = [NONCE_FILTER];
	noteBound(filterArgs);
	filterData(
		[{ id: 'row-1' }, { id: 'row-2' }],
		parentCtx,
		'select id from widgets where secretNote = ?',
		filterArgs,
		'probe',
	);

	// Result marker on stderr — carries counts only, never a nonce.
	process.stderr.write(`PROBE_BOUND_HITS=${JSON.stringify(boundHits)}\n`);
	process.exit(0);
})().catch((err) => {
	process.stderr.write(`PROBE_THREW=${err && err.message}\n`);
	process.exit(1);
});
