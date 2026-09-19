/* eslint-disable no-console */
/* global describe, it, before, after */
/**
 * BDL-3893 — Model.find({ someField: value }) must emit a SINGLY-quoted,
 * table-qualified column, and dbQuote() must be IDEMPOTENT.
 *
 * Both field-equality branches of lib/finder.js hoisted the field name into a
 * local `quoted = dbQuote(fieldName)` and then handed that already-quoted
 * value to prefixedField(), which quotes BOTH of its arguments again. The
 * emitted clause was `table`.``field`` — a doubled pair — which MySQL rejects
 * with errno 1064 every single time, so the plainest find() call shape could
 * never succeed at all.
 *
 * Why it is shaped this way:
 *  - It runs against a REAL MySQL table, so the red arm is the actual 1064
 *    rather than a proxy for it.
 *  - It covers BOTH field-equality branches, and PROVES which branch each
 *    model takes. The two branches emit a byte-identical clause, so the SQL
 *    alone cannot tell a complete fix from a half one.
 *  - It pins dbQuote's idempotency contract directly. The doubled pair is the
 *    symptom; non-idempotent quoting is the defect, and it is reachable by
 *    third-party code because finder hands dbQuote out on its hook context.
 *  - Every test runs its own find(), so none depends on another having run
 *    first and a `--grep` of one test still means something.
 */
const crypto = require('crypto');
const { expect } = require('chai');
const YassORM = require('../lib');
const config = require('../lib/config');

const TABLE = 'yass_bdl3893_widgets';

// A fresh value per run. Never a shared literal: a control string that has
// been written into the corpus has stopped being a control.
const nonce = () => `zzq${crypto.randomBytes(6).toString('hex')}`;

const isMysql = !config.dialect || config.dialect === 'mysql';

const makeDef =
	(table) =>
	({ types: t }) => ({
		table,
		schema: { name: t.string },
	});

describe('finder.js find() field quoting + dbQuote idempotency (BDL-3893)', () => {
	const seeded = nonce();

	let Plain; // no allowedFindParams override -> the DEFAULT branch
	let Guarded; // allowedFindParams override  -> the GUARDED branch
	let Misdeclared; // branch-identity control
	let lastCtx; // whatever the most recent find() handed mutateJoins

	// Runs a find() and returns BOTH outcomes plus the clause finder built.
	// It tolerates the throw on purpose: pre-fix every find() dies of 1064,
	// and the SQL assertions still need the whereList from that same run.
	const runFind = async (Model, query) => {
		lastCtx = null;
		let rows = null;
		let error = null;
		try {
			rows = await Model.find(query);
		} catch (err) {
			error = err;
		}
		expect(lastCtx, 'mutateJoins never fired — captured no SQL').to.not.equal(
			null,
		);
		return { rows, error, sql: lastCtx.whereList.join('\n'), ...lastCtx };
	};

	before(async function before$() {
		if (!isMysql) {
			// A skip that cannot say WHY is indistinguishable from a test that
			// does not exist. This one names the reason and the dialect.
			console.warn(
				`SKIP finder.find-field-quoting: needs the mysql dialect for the errno-1064 red arm; config.dialect=${config.dialect}`,
			);
			this.skip();
		}
		this.timeout(30000);

		Plain = YassORM.loadDefinition(makeDef(TABLE));
		Guarded = YassORM.loadDefinition(makeDef(TABLE));
		Misdeclared = YassORM.loadDefinition(makeDef(TABLE));

		Guarded.allowedFindParams = () => ['name'];
		// `notAField` is absent from fieldMap. ONLY the guarded branch
		// (`if (opts.queryParams)`) throws 'Unknown queryParam field'; the
		// default branch iterates def.fieldMap and can never raise it. So a
		// throw here proves the guarded route is the live one.
		Misdeclared.allowedFindParams = () => ['notAField'];

		// mutateJoins runs AFTER the field-equality block and BEFORE the SQL is
		// sent, so it sees the finished whereList even on a run that then dies
		// of 1064. finder takes its hooks off model.prototype (the caller's
		// opts bag never reaches it), hence the prototype assignment.
		[Plain, Guarded, Misdeclared].forEach((Model) => {
			Object.assign(Model.prototype, {
				mutateJoins(sqlData, ctx) {
					lastCtx = {
						whereList: [...sqlData.whereList],
						dbQuote: ctx.dbQuote,
					};
					return Promise.resolve();
				},
			});
		});

		// Provision the table HERE, not by hand. A test that depends on a table
		// somebody created out-of-band passes on one box and fails everywhere
		// else with "Table ... doesn't exist" — which is exactly the shape of
		// the unrelated pre-existing failures in this suite, so it would read
		// as one of those rather than as a broken test.
		const conn = await Plain.dbh();
		await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
		await conn.query(
			`CREATE TABLE ${TABLE} (
				id varchar(64) NOT NULL PRIMARY KEY,
				name varchar(255),
				isDeleted int DEFAULT 0
			)`,
		);
		await conn.query(
			`INSERT INTO ${TABLE} (id, name, isDeleted) VALUES (?, ?, 0)`,
			[nonce(), seeded],
		);
	});

	after(async () => {
		if (!isMysql) return;
		// Drop what we made, and NOTHING ELSE. Deliberately no
		// closeAllConnections() here: this suite borrows the SHARED pool via
		// Model.dbh(), so closing it would leave every suite that runs after
		// this one in the same mocha process failing with 'pool is closed'.
		// Measured: doing so took the suite from 9 failures to 68.
		const conn = await Plain.dbh();
		await conn.query(`DROP TABLE IF EXISTS ${TABLE}`);
	});

	// Both field-equality branches, because the defect is in both and a
	// one-branch test cannot distinguish a complete fix from a partial one.
	const BRANCHES = [
		['DEFAULT branch (no allowedFindParams)', () => Plain],
		['GUARDED branch (allowedFindParams override)', () => Guarded],
	];

	it('the GUARDED model really takes the guarded branch, not a fall-through', async () => {
		// Deliberately NOT via runFind(): this throw happens BEFORE mutateJoins,
		// so there is no SQL to capture and runFind's capture assert would fire
		// first and mask the message this test exists to read.
		let message = 'NO_THROW';
		try {
			await Misdeclared.find({ name: seeded });
		} catch (err) {
			message = (err && err.message) || 'THREW_WITHOUT_MESSAGE';
		}
		expect(
			message,
			'a declared-but-absent param must be rejected by the guarded branch',
		).to.include('Unknown queryParam field');
	});

	BRANCHES.forEach(([label, model]) => {
		describe(label, () => {
			it('find({ name }) returns the seeded row instead of throwing MySQL 1064', async () => {
				const { rows, error, sql } = await runFind(model(), { name: seeded });
				expect(
					error,
					`find() threw instead of returning rows: ${
						error && error.message
					}\nclause was:\n${sql}`,
				).to.equal(null);
				// find() answers with a paged envelope, not a bare array.
				expect(rows.total, `find() envelope: ${JSON.stringify(rows)}`).to.equal(
					1,
				);
				expect(rows.data).to.have.length(1);
				expect(rows.data[0].name).to.equal(seeded);
			});

			it('emits no doubled backtick pair', async () => {
				const { sql } = await runFind(model(), { name: seeded });
				expect(sql.includes('``'), `doubled backticks in:\n${sql}`).to.equal(
					false,
				);
			});

			it('still qualifies the column with its table (positive control)', async () => {
				const { sql } = await runFind(model(), { name: seeded });
				expect(sql).to.include(`\`${TABLE}\`.\`name\` = ?`);
			});
		});
	});

	describe('dbQuote is idempotent (the root defect, not the call site)', () => {
		// dbQuote is module-private but finder publishes it on the hook
		// context, which is both how third-party code reaches it and the seam
		// used here. No production export was added for the test's benefit.
		const dbQuoteFromLiveRun = async () => {
			const { dbQuote } = await runFind(Plain, { name: seeded });
			return dbQuote;
		};

		it('quotes a bare identifier exactly once (positive control)', async () => {
			// Without this arm a "fix" that returned the identifier UNQUOTED
			// would satisfy idempotency below while breaking every caller.
			const dbQuote = await dbQuoteFromLiveRun();
			const bare = nonce();
			expect(dbQuote(bare)).to.equal(`\`${bare}\``);
		});

		it('an already-quoted identifier does not gain a second pair', async () => {
			const dbQuote = await dbQuoteFromLiveRun();
			const once = dbQuote(nonce());
			expect(dbQuote(once)).to.equal(once);
		});

		it('re-quoting never introduces a doubled pair, at any depth', async () => {
			const dbQuote = await dbQuoteFromLiveRun();
			const bare = nonce();
			const thrice = dbQuote(dbQuote(dbQuote(bare)));
			expect(thrice.includes('``'), `got: ${thrice}`).to.equal(false);
			expect(thrice).to.equal(`\`${bare}\``);
		});

		it('leaves every UNQUOTED shape byte-identical to the old behaviour', async () => {
			// NOT a red arm: this passes before AND after the fix, on purpose.
			// It is a behaviour-preservation guard. Making quoting idempotent
			// means touching a function that quotes every table and column in
			// the library, and the repo's own fixtures use a DOTTED table name
			// ('yass_test1.id'), so the risk is silently re-quoting something
			// that was already correct.
			const dbQuote = await dbQuoteFromLiveRun();
			[
				'yass_test1.id',
				'widgets',
				'mydb.mytbl',
				nonce(),
				null,
				undefined,
			].forEach((input) => {
				expect(dbQuote(input), `changed for input ${String(input)}`).to.equal(
					`\`${String(input)}\``,
				);
			});
		});

		it('leaves an already-quoted TABLE-QUALIFIED identifier untouched', async () => {
			// prefixedField() output is the shape a hook is most likely to hand
			// back to dbQuote. Stripping backticks and re-wrapping would turn
			// `t`.`c` into `t.c` — a single, WRONG column name, read silently
			// rather than erroring. That is a regression the fix must not make.
			const dbQuote = await dbQuoteFromLiveRun();
			const qualified = `\`${TABLE}\`.\`name\``;
			expect(dbQuote(qualified)).to.equal(qualified);
		});
	});
});
