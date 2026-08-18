/**
 * Test fixture for BDL-2852: description text that is hostile to naive string
 * emission. The generator must emit these descriptions into the generated
 * `.zod.ts` / `.d.ts` such that the result still PARSES.
 *
 * Every character class in HOSTILE_DESCRIPTION is there to catch a specific
 * partial fix:
 *   - blank line / newline  → the original bug (unterminated single-quoted literal)
 *   - carriage return       → also a JS LineTerminator; \n-only fixes miss it
 *   - apostrophe            → the ONLY thing the original escaping handled
 *   - double quote          → breaks a naive switch to double-quoted literals
 *   - backslash             → breaks any hand-rolled escaping that runs after
 *                             the quote pass (`\` + `'` → `\\'` closes the string)
 *   - backtick + ${...}     → breaks a naive switch to template literals
 *   - unicode               → must round-trip unmangled
 *   - an end-of-comment    → would terminate the JSDoc block comment in the .d.ts
 *     (asterisk-slash)     if the generator did not neutralize it
 */

const HOSTILE_DESCRIPTION = [
	"Line one — it's got an apostrophe.",
	'',
	'Blank line above. Double quote: "quoted". Backslash: C:\\path\\to\\file.',
	// The `${` is DELIBERATE: it must stay inert if the emitter ever reaches for
	// a template literal instead of a quoted string.
	// eslint-disable-next-line no-template-curly-in-string
	'Unicode: ✅ café → 日本語. Backtick: ` and ${notATemplate}.',
	'JSDoc terminator: */ inline.',
	'Carriage return next:\r',
	'end.',
].join('\n');

exports.HOSTILE_DESCRIPTION = HOSTILE_DESCRIPTION;

exports.default = ({ types: t }) => ({
	table: 'hostile_descriptions',
	schema: {
		id: t.uuidKey,

		// Plain string field — hits the generic buildValidationChain() path
		notes: t.string.description(HOSTILE_DESCRIPTION),

		// Enum field — hits the dedicated z.enum() emission path
		mode: t.enum(['auto', 'manual']).description(HOSTILE_DESCRIPTION),

		// Object field — hits the z.object()/z.record() emission path
		mapped: t.object().description(HOSTILE_DESCRIPTION),

		// Any field — hits the z.unknown() emission path
		payload: t.any.description(HOSTILE_DESCRIPTION),
	},
});
