/**
 * captureAlterStatements -- reads back the ALTER statements schema-sync
 * ACTUALLY EXECUTED for a table, from its own debug log.
 *
 * WHY THIS AND NOT A DIALECT PATCH: after BDL-3681, `generateAlterAddColumn`
 * is still called ONCE PER COLUMN to build the heal ledger. So counting
 * generator calls reports the same number before and after the fix and can
 * never detect the change. This helper reads the `Debug: [db] Alter table:`
 * line, which logs `alter.join(';\n')` -- and `promiseMap` iterates that SAME
 * `alter` array, one element per execQuery call. So the count here IS the
 * number of statements executed.
 */

function install() {
	const captured = [];
	// eslint-disable-next-line no-console
	const original = console.log;
	// eslint-disable-next-line no-console
	console.log = (...args) => {
		captured.push(args.map((a) => `${a}`).join(' '));
	};

	const MARKER = 'Alter table:';

	return {
		captured,
		/** Every ALTER statement schema-sync executed, in order. */
		executedAlterStatements() {
			return captured
				.filter((line) => line.includes(MARKER))
				.flatMap((line) =>
					line.slice(line.indexOf(MARKER) + MARKER.length).split(/;\s*\n/),
				)
				.map((s) => s.trim())
				.filter((s) => /^ALTER TABLE/i.test(s));
		},
		/** Just the ones naming `tableName` -- robust against other suites. */
		executedAltersFor(tableName) {
			return this.executedAlterStatements().filter((s) =>
				s.includes(tableName),
			);
		},
		restore() {
			// eslint-disable-next-line no-console
			console.log = original;
		},
	};
}

module.exports = { captureAlterStatements: { install } };
