/* eslint-disable no-console, no-continue, no-restricted-syntax */
/**
 * lib/sync-triggers.js
 *
 * Reconciler for schema-declared database triggers, kept out of sync-to-db.js
 * (already ~2500 lines). This module owns:
 *
 *   - The AUTHOR-FACING SHAPE: what a trigger looks like in a def, and how a
 *     bad one is rejected at convert time so a typo fails LOUDLY instead of
 *     silently producing something that means something else. Mirrors the way
 *     multi-valued indexes reject a bad spec upstream in def-to-schema.
 *
 *   - THE COMPARISON: normalize the body MySQL reports back in
 *     information_schema.TRIGGERS.ACTION_STATEMENT into a form byte-equal to
 *     what we would have written for the same author string. This is the
 *     hinge the whole feature turns on. If desired and introspected can EVER
 *     be permanently unequal (same bug class as the FULLTEXT-prefix churn and
 *     the multi-valued-index churn this repo has fought before), schema-sync
 *     will DROP+CREATE the trigger on every run, holding a metadata lock that
 *     queues every write to the table. The live idempotency test in
 *     test/schemaSync.triggers.test.js is the acceptance gate; this
 *     normalizer is the mechanism.
 *
 *   - THE PLAN: given a desired set (id trigger first, then declaration
 *     order) and an existing set from information_schema, compute per
 *     timing+event GROUP drift. Any body/timing/event/order mismatch inside a
 *     group means the whole group is DROP'd and CREATE'd back in desired
 *     order with FOLLOWS chaining. Recreating siblings inside a group is a
 *     metadata-only operation (milliseconds), and it is the only way to
 *     guarantee firing order on MySQL, where DROP+CREATE otherwise moves a
 *     trigger to the END of its group -- silently reordering a user
 *     BEFORE INSERT trigger BEHIND the built-in before_insert_*_set_id.
 *
 *   - THE ACTOR (syncTableTriggers): runs the plan against a live handle
 *     through dialect-agnostic methods, gated by dialect.supportsDeclaredTriggers.
 *
 * Cross-dialect note: this pass implements MySQL only. Postgres would require
 * generating a CREATE FUNCTION + CREATE OR REPLACE TRIGGER with drift compared
 * against pg_proc.prosrc and pg_get_triggerdef() -- both of which Postgres
 * reformats, so its normalizer has to be built against a live PG server, not
 * guessed. See the plan for the deferred-until-needed rationale.
 */

const VALID_TIMINGS = new Set(['before', 'after']);
const VALID_EVENTS = new Set(['insert', 'update', 'delete']);

/**
 * Warn-once dedupe for the "dialect does not implement declared triggers"
 * message. Without this a Postgres or SQLite run over 20 defs that each
 * declare a `triggers` block emits 20 identical warnings -- noise the user
 * has no way to read past to find the actual sync output.
 *
 * Module-scoped so it dedupes across the whole schema-sync invocation
 * (which lives in one Node process). Fresh process = fresh state, which
 * is what we want -- the warning is informational, not a state machine.
 *
 * Exposed as `_resetUnsupportedDialectWarnings` for test isolation.
 */
const _warnedUnsupportedDialects = new Set();
function _resetUnsupportedDialectWarnings() {
	_warnedUnsupportedDialects.clear();
}

// The `mysql` name here matches dialect.name; `pg` is an accepted alias for
// `postgres` on the AUTHOR side so their body key is short and readable.
const KNOWN_DIALECT_KEYS = new Set(['mysql', 'pg', 'postgres', 'sqlite']);

/**
 * Normalize a trigger body for comparison.
 *
 * MySQL stores the trigger body verbatim in information_schema.TRIGGERS,
 * preserving case (which is why the case of literals matters -- flipping
 * 'Foo' to 'foo' inside a body is a real semantic change we do not want to
 * mask). Formatting drift, however, is not: whitespace and comments in the
 * schema author's source have no effect at runtime, so both sides are
 * reduced to a single-spaced, comment-free, semicolon-trimmed form before
 * being compared byte-for-byte.
 *
 * Implemented as a small lexer rather than a chain of `String.replace`
 * regexes. The regex approach was correct for the common case but had a
 * FALSE NEGATIVE: a `--` or `/*` sequence INSIDE a string literal or a
 * backtick-quoted identifier would be stripped, collapsing two bodies that
 * genuinely differed only inside a string to the same normalized form.
 * That is exactly the bug class this reconciler is built to prevent (the
 * FULLTEXT/multi-valued-index churn came from the OTHER direction --
 * two things equal getting normalized to unequal -- but a false negative
 * is worse: a real behavior change gets silently ignored). The lexer
 * treats `' ... '`, `" ... "`, and `` ` ... ` `` regions as opaque, and
 * only recognises `--` and `/* * /` in code context.
 *
 * @param {string|null|undefined} body
 * @returns {string} normalized body, or '' for empty/nullish input
 */
function normalizeTriggerBody(body) {
	if (body === null || body === undefined) return '';
	const src = String(body);
	// Two-pass: pass 1 rewrites comments to a single space, preserving
	// string/identifier regions BYTE-FOR-BYTE. Pass 2 collapses whitespace
	// outside those regions.
	//
	// One buffer, one index. Emitting into `out` as we go lets us keep the
	// original bytes for string/identifier regions untouched.
	const len = src.length;
	let i = 0;
	let out = '';

	// Helper: consume from `i` until we hit the closing quote of the string
	// that starts at src[i] (which is one of ' " `). Handles both MySQL
	// escape forms inside single- and double-quoted strings: a backslash
	// escape and a doubled-quote escape. Backtick identifiers only allow
	// doubling as an escape (no backslash). Emits the entire literal --
	// opening quote through closing quote -- verbatim.
	function consumeStringLiteral() {
		const quote = src[i];
		out += quote;
		i += 1;
		while (i < len) {
			const ch = src[i];
			if (ch === '\\' && (quote === "'" || quote === '"')) {
				// Backslash escape: emit both bytes and move past them.
				// If we are at end of input the backslash is dangling
				// but we still emit it verbatim.
				out += ch;
				if (i + 1 < len) {
					out += src[i + 1];
					i += 2;
				} else {
					i += 1;
				}
				continue;
			}
			if (ch === quote) {
				// Could be end of literal, or a doubled-quote escape.
				if (src[i + 1] === quote) {
					out += ch;
					out += ch;
					i += 2;
					continue;
				}
				out += ch;
				i += 1;
				return;
			}
			out += ch;
			i += 1;
		}
	}

	while (i < len) {
		const ch = src[i];
		// String literals and backtick-quoted identifiers: pass through
		// byte-for-byte, including any `--` or `/*` inside them.
		if (ch === "'" || ch === '"' || ch === '`') {
			consumeStringLiteral();
			continue;
		}
		// `/* ... */` block comment (only in code context now).
		if (ch === '/' && src[i + 1] === '*') {
			const close = src.indexOf('*/', i + 2);
			if (close === -1) {
				// Unterminated block comment -- treat as extending to EOF
				// so a partial body does not smuggle content into the
				// normalized form.
				i = len;
			} else {
				i = close + 2;
			}
			out += ' ';
			continue;
		}
		// `-- ...` line comment (only in code context now). MySQL's `--`
		// requires whitespace or EOL after the two dashes to actually be a
		// comment start; `a--1` is `a - (-1)`. Check the third character.
		if (ch === '-' && src[i + 1] === '-') {
			const third = src[i + 2];
			const isCommentStart =
				third === undefined ||
				third === '\n' ||
				third === '\r' ||
				third === ' ' ||
				third === '\t';
			if (isCommentStart) {
				// Consume through end of line (or end of input).
				const nl = src.indexOf('\n', i + 2);
				i = nl === -1 ? len : nl;
				out += ' ';
				continue;
			}
		}
		out += ch;
		i += 1;
	}

	// Pass 2: outside-string whitespace collapse. Since string regions were
	// emitted verbatim and everything else is code, a single regex over
	// `out` would over-collapse the intentional spaces inside a literal.
	// Re-lex `out` and only collapse runs of whitespace in code context.
	let normalized = '';
	let j = 0;
	const olen = out.length;
	let lastWasSpace = false;
	while (j < olen) {
		const ch = out[j];
		if (ch === "'" || ch === '"' || ch === '`') {
			// Copy the entire literal verbatim; each of \, doubled-quote,
			// and close-quote is handled to find the boundary correctly.
			const quote = ch;
			normalized += quote;
			j += 1;
			while (j < olen) {
				const c2 = out[j];
				if (c2 === '\\' && (quote === "'" || quote === '"')) {
					normalized += c2;
					if (j + 1 < olen) {
						normalized += out[j + 1];
						j += 2;
					} else {
						j += 1;
					}
					continue;
				}
				if (c2 === quote) {
					if (out[j + 1] === quote) {
						normalized += c2;
						normalized += c2;
						j += 2;
						continue;
					}
					normalized += c2;
					j += 1;
					break;
				}
				normalized += c2;
				j += 1;
			}
			lastWasSpace = false;
			continue;
		}
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
			if (!lastWasSpace) {
				normalized += ' ';
				lastWasSpace = true;
			}
			j += 1;
			continue;
		}
		normalized += ch;
		lastWasSpace = false;
		j += 1;
	}

	// Trim and drop a single trailing semicolon. MySQL sometimes omits and
	// sometimes stores it; either spelling means the same statement here.
	normalized = normalized.trim();
	normalized = normalized.replace(/;\s*$/, '').trim();
	return normalized;
}

/**
 * Resolve a trigger spec's `body` down to a single string for the active
 * dialect, or `null` when the spec is dialect-keyed and this dialect has no
 * entry (the "skip this trigger stably" signal, mirroring how
 * supportsMultiValuedIndexes is treated one layer up).
 *
 * A bare string body means "the active dialect", exactly the way an author
 * would expect from the shorthand form. Dialect keys accepted: `mysql`,
 * `pg`/`postgres`, `sqlite` -- both `pg` and `postgres` map to the dialect
 * whose `.name` is `postgres`, because the short form is easier for authors
 * to type and the long form matches what the dialect calls itself.
 *
 * @param {{body: string|Object}} spec
 * @param {string} dialectName - dialect.name ('mysql'|'postgres'|'sqlite')
 * @returns {string|null}
 */
function resolveTriggerBody(spec, dialectName) {
	if (!spec || spec.body === undefined || spec.body === null) return null;
	const { body } = spec;
	if (typeof body === 'string') return body;
	if (typeof body === 'object') {
		if (dialectName === 'mysql') return body.mysql || null;
		if (dialectName === 'postgres') return body.pg || body.postgres || null;
		if (dialectName === 'sqlite') return body.sqlite || null;
		return null;
	}
	return null;
}

/**
 * Throw at convert time if a trigger spec is malformed. Same voice as the
 * multi-valued index validation: a typo becomes a loud error at load, not a
 * silent no-op that only surfaces one deploy later as a missing trigger.
 *
 * @param {string} name - trigger name (for the error message)
 * @param {*} spec - the raw spec from the schema def
 * @throws {Error} on any invalid spec
 */
function validateTriggerSpec(name, spec) {
	if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
		throw new Error(`Trigger '${name}' must be an object`);
	}
	const timing = `${spec.timing || ''}`.toLowerCase();
	if (!VALID_TIMINGS.has(timing)) {
		throw new Error(
			`Trigger '${name}' has invalid timing '${
				spec.timing
			}' -- must be one of: ${[...VALID_TIMINGS].join(', ')}`,
		);
	}
	const event = `${spec.event || ''}`.toLowerCase();
	if (!VALID_EVENTS.has(event)) {
		throw new Error(
			`Trigger '${name}' has invalid event '${
				spec.event
			}' -- must be one of: ${[...VALID_EVENTS].join(', ')}`,
		);
	}
	const { body } = spec;
	if (body === undefined || body === null || body === '') {
		throw new Error(`Trigger '${name}' is missing a non-empty body`);
	}
	if (typeof body === 'string') {
		// non-empty string body: already vetted above
	} else if (typeof body === 'object' && !Array.isArray(body)) {
		const knownKeys = Object.keys(body).filter((k) =>
			KNOWN_DIALECT_KEYS.has(k),
		);
		if (knownKeys.length === 0) {
			throw new Error(
				`Trigger '${name}' body object has no known dialect key -- expected at least one of: ${[
					...KNOWN_DIALECT_KEYS,
				].join(', ')}`,
			);
		}
		// Every KNOWN-key value must be a non-empty string. A stray `null`
		// or number here would sail through convert time and only surface
		// later as corrupt DDL text at CREATE TRIGGER, exactly the failure
		// mode this validator exists to prevent (same argument for validate-
		// at-load as the multi-valued-index cast enforcement upstream).
		// Unknown keys are ignored -- they might be documentation the
		// author leaves for a future dialect.
		for (const key of knownKeys) {
			const value = body[key];
			if (typeof value !== 'string' || value.length === 0) {
				throw new Error(
					`Trigger '${name}' body.${key} must be a non-empty string (got ${
						value === null ? 'null' : typeof value
					})`,
				);
			}
		}
	} else {
		throw new Error(
			`Trigger '${name}' body must be a string or a dialect-keyed object`,
		);
	}
	// Reject `${table}` in the body. The engine writes the ON clause
	// itself, so leaving a literal `${table}` in the body means the author
	// expected template-string interpolation that never happened -- the
	// trigger would end up referring to a table LITERALLY named
	// `${table}`, which either fails at CREATE time (best case) or
	// silently succeeds if such a table exists (worst case: a real DML
	// statement pointed at the wrong table). Started life as a WARN, but
	// there is no legitimate reason to leave that string in a body when
	// the engine already knows the real table -- upgrade to an ERROR so
	// the failure is loud at load time. If a body genuinely needs to
	// reference ANOTHER table by name, just write that name literally.
	const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
	// Escaped so this file does not contain a raw `${table}` string
	// literal (eslint no-template-curly-in-string).
	const leftoverTableTemplate = `\${table}`;
	if (bodyStr.includes(leftoverTableTemplate)) {
		throw new Error(
			`Trigger '${name}' body contains a literal \`\${table}\` placeholder -- the engine writes the ON clause itself, so the body is passed through verbatim. If you meant to reference another table, spell its name literally.`,
		);
	}
}

/**
 * True iff two trigger records describe the SAME trigger for reconciler
 * purposes: same timing, same event (both case-insensitive), and byte-equal
 * bodies after normalization.
 *
 * @param {{timing, event, body}} a
 * @param {{timing, event, body}} b
 * @returns {boolean}
 */
function triggersEqual(a, b) {
	if (!a || !b) return false;
	if (`${a.timing || ''}`.toLowerCase() !== `${b.timing || ''}`.toLowerCase())
		return false;
	if (`${a.event || ''}`.toLowerCase() !== `${b.event || ''}`.toLowerCase())
		return false;
	return normalizeTriggerBody(a.body) === normalizeTriggerBody(b.body);
}

function groupKey(t) {
	return `${`${t.timing}`.toLowerCase()} ${`${t.event}`.toLowerCase()}`;
}

/**
 * Compute the reconciler plan for a table.
 *
 * INPUTS
 *   desired  - triggers we WANT on this table, in the firing order we want
 *              them to appear. For a `uuidKey` table, the caller should put
 *              the synthetic id trigger FIRST, then the author's declared
 *              triggers in declaration order (JS object insertion order).
 *   existing - triggers currently ON this table, as reported by
 *              dialect.getTableTriggers. Each carries an `order` (1-based
 *              ACTION_ORDER within its timing+event group).
 *   alwaysKeep (optional) - names to exempt from `undeclaredToDrop` even
 *              when they are not in `desired`. The synthetic id trigger goes
 *              here so the opt-in drop pass never removes it, in EITHER opt-in
 *              state.
 *
 * OUTPUT
 *   groupsToRecreate - one entry PER (timing+event) group where any desired
 *              trigger in that group had drifted body/timing/event OR the
 *              existing order of the desired members disagrees with the
 *              desired order. Each entry names the triggers in the ORDER they
 *              must be recreated (id trigger first, then declaration order).
 *              Recreation is a group-wide DROP+CREATE because MySQL cannot
 *              rewrite a trigger in place and CREATE alone appends to the end
 *              of the chain -- the ONLY way to guarantee firing order is to
 *              rebuild the whole group.
 *   undeclaredToDrop - names of triggers on the table that are neither in
 *              `desired` nor in `alwaysKeep`. The caller decides whether to
 *              act on this list based on the opt-in gate (def has a
 *              `triggers` key -> authoritative for the table).
 *
 * Undeclared triggers are IGNORED when computing order drift inside a group:
 * an unmanaged sibling sitting between two of ours must not force a churn on
 * either. If the def is opted in the unmanaged one is about to be dropped
 * anyway; if it is not opted in, its position is not ours to manage.
 */
function planTriggerReconciliation({
	desired = [],
	existing = [],
	alwaysKeep = [],
} = {}) {
	const desiredByName = new Map(desired.map((t) => [t.name, t]));
	const alwaysKeepSet = new Set(alwaysKeep);

	// Bucket both sides by timing+event group.
	const desiredByGroup = new Map();
	desired.forEach((t) => {
		const key = groupKey(t);
		if (!desiredByGroup.has(key)) desiredByGroup.set(key, []);
		desiredByGroup.get(key).push(t);
	});

	const existingByGroup = new Map();
	existing.forEach((t) => {
		const key = groupKey(t);
		if (!existingByGroup.has(key)) existingByGroup.set(key, []);
		existingByGroup.get(key).push(t);
	});

	const groupsToRecreate = [];

	for (const [key, desiredGroup] of desiredByGroup) {
		const existingGroup = (existingByGroup.get(key) || [])
			.slice()
			.sort((a, b) => (a.order || 0) - (b.order || 0));
		const existingByName = new Map(existingGroup.map((t) => [t.name, t]));

		const reasons = [];
		// Body / timing / event / presence drift per desired trigger.
		for (const desiredT of desiredGroup) {
			const existingT = existingByName.get(desiredT.name);
			if (!existingT) {
				reasons.push(`missing trigger '${desiredT.name}'`);
				continue;
			}
			if (!triggersEqual(existingT, desiredT)) {
				reasons.push(`body drift on '${desiredT.name}'`);
			}
		}

		// Order drift: filter the existing group down to just the desired
		// members' names (ignore undeclared siblings), and compare their
		// ordered names against the desired order.
		const existingOrderOfDesired = existingGroup
			.filter((t) => desiredByName.has(t.name))
			.map((t) => t.name);
		const desiredOrder = desiredGroup.map((t) => t.name);
		if (
			existingOrderOfDesired.length === desiredOrder.length &&
			existingOrderOfDesired.some((n, i) => n !== desiredOrder[i])
		) {
			reasons.push(
				`order drift (existing: ${existingOrderOfDesired.join(
					', ',
				)} -> desired: ${desiredOrder.join(', ')})`,
			);
		}

		if (reasons.length > 0) {
			const [timing, event] = key.split(' ');
			groupsToRecreate.push({
				timing,
				event,
				names: desiredOrder,
				reasons,
			});
		}
	}

	// Undeclared: on the table but neither in desired nor exempt.
	const undeclaredToDrop = existing
		.filter((t) => !desiredByName.has(t.name) && !alwaysKeepSet.has(t.name))
		.map((t) => t.name);

	return { groupsToRecreate, undeclaredToDrop };
}

/**
 * Reconcile the triggers on ONE table against a desired set.
 *
 * Called from sync-to-db.js after mysqlSchemaUpdate. Gated on
 * dialect.supportsDeclaredTriggers: when false, warns once per call and
 * returns a stable no-op (so a def shared across dialects still syncs its
 * columns and indexes).
 *
 * The opt-in gate for `undeclaredToDrop` lives HERE (not in the plan): the
 * caller passes `authoritative: true` when the def has a `triggers` key. When
 * false, the plan's `undeclaredToDrop` is ignored and the reconciler ONLY
 * creates/recreates the desired set. This is what makes existing defs
 * (no `triggers` key) unaffected by upgrading, while a def that opts in gets
 * full convergence (renames converge, hand-created strays are cleaned up).
 *
 * Emits DDL through `execQuery`, which is the same shape sync-to-db uses so
 * DRY_RUN and silenceErrors work the same way here as they do for indexes.
 *
 * @param {Object} args
 * @param {Object} args.dialect - active dialect instance
 * @param {Function} args.execQuery - async (sql, mutates) -> ok
 * @param {string} args.database - schema/database name
 * @param {string} args.tableName - table (no db prefix)
 * @param {string} args.tableDisplay - human-readable table (for logs; usually `db.table` or `table`)
 * @param {Array} args.declared - array of { name, timing, event, body } in
 *                                desired firing order, or [] to only manage
 *                                the id trigger. When null/undefined, the def
 *                                has NOT opted in and only the id trigger is
 *                                managed.
 * @param {Object|null} args.idTrigger - the synthetic { name, timing, event, body }
 *                                for the UUID id trigger, or null for
 *                                non-uuidKey tables
 * @param {string[]} [args.orphanTriggerNames] - trigger names that are
 *                                yass-orm's responsibility but must NOT be
 *                                on the table (e.g. the id trigger for a
 *                                table whose def just flipped from
 *                                `t.uuidKey` to `t.idKey`). Dropped
 *                                UNCONDITIONALLY when present, regardless
 *                                of `authoritative` -- the id trigger is
 *                                ours to manage either way, not the user's,
 *                                so leaving it orphaned would silently
 *                                write UUIDs into an INT auto-increment
 *                                column on every insert.
 * @param {boolean} args.authoritative - true when the def has a `triggers`
 *                                key (even empty). Controls whether
 *                                undeclaredToDrop is acted on (does NOT
 *                                gate the orphan drop above).
 * @param {boolean} args.disableFunctions - config.disableFunctions
 * @param {number} args.lockWaitTimeout - seconds; wraps DDL in
 *                                SET SESSION lock_wait_timeout
 * @returns {Promise<{applied: number, errors: Array, ddl: Array<string>}>}
 */
async function syncTableTriggers({
	dialect,
	execQuery,
	database,
	tableName,
	tableDisplay,
	declared,
	idTrigger = null,
	orphanTriggerNames = [],
	authoritative = false,
	disableFunctions = false,
	lockWaitTimeout,
}) {
	const displayName = tableDisplay || tableName;
	const errors = [];
	const ddl = [];
	let applied = 0;

	if (!dialect.supportsDeclaredTriggers) {
		if (
			(declared && declared.length) ||
			idTrigger ||
			(orphanTriggerNames && orphanTriggerNames.length)
		) {
			// Warn-once per dialect per process: the fact that this dialect
			// does not implement the reconciler is a STATIC property of the
			// dialect, not a per-table one, so repeating it once per synced
			// table is pure noise. First table on this dialect names itself
			// as context; subsequent tables silently skip.
			if (!_warnedUnsupportedDialects.has(dialect.name)) {
				_warnedUnsupportedDialects.add(dialect.name);
				console.warn(
					`[yass-orm] Dialect '${dialect.name}' does not implement declared-trigger reconciliation; skipping trigger reconciliation for all subsequent tables (first offender: ${displayName})`,
				);
			}
		}
		return { applied, errors, ddl };
	}

	if (disableFunctions) {
		if (
			(declared && declared.length) ||
			idTrigger ||
			(orphanTriggerNames && orphanTriggerNames.length)
		) {
			const names = [
				...(idTrigger ? [idTrigger.name] : []),
				...(declared || []).map((t) => t.name),
				...(orphanTriggerNames || []),
			];
			console.warn(
				`[yass-orm] Config 'disableFunctions' is enabled; skipping triggers on ${displayName}: ${names.join(
					', ',
				)}`,
			);
		}
		return { applied, errors, ddl };
	}

	// Build the desired set: id trigger first (when present), then declared.
	// If a user declares a trigger with the same name as the id trigger, the
	// user's wins with a warning -- their intent is explicit, ours is derived.
	const declaredArr = Array.isArray(declared) ? declared : [];
	const declaredNames = new Set(declaredArr.map((t) => t.name));
	let idPart = [];
	if (idTrigger) {
		if (declaredNames.has(idTrigger.name)) {
			console.warn(
				`[yass-orm] Trigger '${idTrigger.name}' on ${displayName} shadows the built-in UUID id trigger; using the user-declared version`,
			);
		} else {
			idPart = [idTrigger];
		}
	}
	const desired = [...idPart, ...declaredArr];

	// Read existing (once).
	let existing;
	try {
		existing = await dialect.getTableTriggers(
			await execQuery.getHandle(),
			database,
			tableName,
		);
	} catch (ex) {
		errors.push({
			table: displayName,
			description: 'Error reading existing triggers from database',
			sql: `dialect.getTableTriggers(${database}, ${tableName})`,
			error: ex,
		});
		return { applied, errors, ddl };
	}

	// The id trigger is always exempt from the drop pass.
	const alwaysKeep = idTrigger ? [idTrigger.name] : [];
	const plan = planTriggerReconciliation({
		desired,
		existing,
		alwaysKeep,
	});

	// Apply lock_wait_timeout for the DDL run so a hot table cannot hang the
	// sync. Restored to prior in a finally. Non-fatal if the SET fails (some
	// managed hosts refuse SESSION-level tweaks); log and continue.
	let priorLockWait = null;
	if (lockWaitTimeout && dialect.name === 'mysql') {
		try {
			const rows = await execQuery(`SELECT @@SESSION.lock_wait_timeout AS v`);
			priorLockWait = rows && rows[0] && rows[0].v;
			const setSql = `SET SESSION lock_wait_timeout = ${Number(
				lockWaitTimeout,
			)}`;
			await execQuery(setSql, true);
			ddl.push(setSql);
		} catch (ex) {
			console.warn(
				`[yass-orm] Could not set SESSION lock_wait_timeout on ${displayName} (continuing):`,
				ex.message || ex,
			);
			priorLockWait = null;
		}
	}

	try {
		// Drop ORPHAN triggers unconditionally, whether or not the def is
		// authoritative. These are triggers yass-orm itself owns but must
		// not be on the table -- specifically, the built-in UUID id trigger
		// for a table whose def just flipped from `t.uuidKey` to `t.idKey`.
		// Left in place, it silently writes UUIDs into the INT auto-
		// increment column on every insert (a real data hazard, not just
		// noise), and it is NOT the user's trigger to opt into managing.
		// Uses IF EXISTS so a table that never had one is a no-op.
		const existingByName = new Set(existing.map((t) => t.name));
		// Sequential await is required: MySQL trigger names are unique
		// per schema and FOLLOWS chaining is creation-order, so each
		// DROP/CREATE must land before the next statement. Promise.all
		// would race them and lose both guarantees.
		/* eslint-disable no-await-in-loop */
		for (const name of orphanTriggerNames || []) {
			if (!existingByName.has(name)) continue;
			console.log(
				`Debug: Trigger '${name}' removed from ${displayName} (orphaned: table no longer has t.uuidKey)`,
			);
			const dropSql = dialect.generateDropTrigger({ name, database });
			ddl.push(dropSql);
			try {
				await execQuery(dropSql, true);
				applied += 1;
			} catch (ex) {
				errors.push({
					table: displayName,
					description: `Error dropping orphan trigger '${name}'`,
					sql: dropSql,
					error: ex,
				});
			}
		}

		// Drop undeclared FIRST when authoritative. Order matters: if a
		// declared trigger has MOVED groups (e.g. before-insert -> after-
		// insert), the old-timing trigger is undeclared and the new-timing
		// one is desired. They collide on NAME (MySQL trigger names are
		// per-schema, not per-timing+event), so CREATE fails with "trigger
		// already exists" unless the DROP runs first. Cheap when nothing to
		// do -- just no-op. Not authoritative -> skipped entirely, so a def
		// that has not opted in cannot lose a hand-created stray this way.
		if (authoritative) {
			for (const name of plan.undeclaredToDrop) {
				console.log(
					`Debug: Trigger '${name}' removed from ${displayName} (not declared in schema)`,
				);
				const dropSql = dialect.generateDropTrigger({ name, database });
				ddl.push(dropSql);
				try {
					await execQuery(dropSql, true);
					applied += 1;
				} catch (ex) {
					errors.push({
						table: displayName,
						description: `Error dropping undeclared trigger '${name}'`,
						sql: dropSql,
						error: ex,
					});
				}
			}
		}

		// Recreate each drifted group in desired order with FOLLOWS chaining.
		for (const group of plan.groupsToRecreate) {
			console.log(
				`Debug: (re)Creating trigger group '${group.timing} ${
					group.event
				}' on ${displayName}: ${group.names.join(
					', ',
				)} (reasons: ${group.reasons.join('; ')})`,
			);
			// DROP IF EXISTS every desired name in this group BEFORE creating
			// them, regardless of which group they currently live in.
			//
			// The subtle case this handles: a trigger that MOVED groups
			// (e.g. its declared timing changed from `before` to `after`
			// insert). Its name still exists in the DB but in a DIFFERENT
			// group. MySQL trigger names are unique PER SCHEMA (not per
			// timing+event), so CREATE would fail with "Trigger already
			// exists" if we did not drop the old-location copy first. DROP
			// IF EXISTS is a no-op when the name is absent, so the "no move"
			// case pays exactly one extra idempotent DROP -- cheap for the
			// safety it buys, and required for the timing-drift red case in
			// test/schemaSync.triggers.test.js.
			for (const name of group.names) {
				const dropSql = dialect.generateDropTrigger({ name, database });
				ddl.push(dropSql);
				try {
					await execQuery(dropSql, true);
					applied += 1;
				} catch (ex) {
					errors.push({
						table: displayName,
						description: `Error dropping trigger '${name}' before recreate`,
						sql: dropSql,
						error: ex,
					});
				}
			}
			// CREATE in desired order with FOLLOWS chaining after the first.
			let previous = null;
			for (const name of group.names) {
				const desiredT = desired.find((d) => d.name === name);
				const createSql = dialect.generateCreateTrigger({
					name: desiredT.name,
					timing: desiredT.timing,
					event: desiredT.event,
					tableName,
					database,
					body: desiredT.body,
					follows: previous,
				});
				ddl.push(createSql);
				try {
					await execQuery(createSql, true);
					applied += 1;
				} catch (ex) {
					errors.push({
						table: displayName,
						description: `Error creating trigger '${desiredT.name}'`,
						sql: createSql,
						error: ex,
					});
				}
				previous = name;
			}
		}
		/* eslint-enable no-await-in-loop */
	} finally {
		// Restore the prior lock_wait_timeout best-effort. A failure here is
		// noisy but not fatal to the sync.
		if (priorLockWait != null && dialect.name === 'mysql') {
			try {
				await execQuery(
					`SET SESSION lock_wait_timeout = ${Number(priorLockWait)}`,
					true,
				);
			} catch (ex) {
				console.warn(
					`[yass-orm] Could not restore SESSION lock_wait_timeout on ${displayName}:`,
					ex.message || ex,
				);
			}
		}
	}

	return { applied, errors, ddl };
}

module.exports = {
	normalizeTriggerBody,
	resolveTriggerBody,
	validateTriggerSpec,
	triggersEqual,
	planTriggerReconciliation,
	syncTableTriggers,
	VALID_TIMINGS,
	VALID_EVENTS,
	KNOWN_DIALECT_KEYS,
	_resetUnsupportedDialectWarnings,
};
