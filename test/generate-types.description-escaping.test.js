/* eslint-disable no-unused-expressions */
/* global it, describe */

/**
 * BDL-2852 — `.describe()` / JSDoc emission must survive ARBITRARY description text.
 *
 * The generator used to build the Zod description literal as:
 *     const escaped = description.replace(/'/g, "\\'");
 *     `.describe('${escaped}')`
 * which handles apostrophes and NOTHING else. A description containing a raw
 * newline therefore terminated the single-quoted literal mid-string and the
 * generated `.zod.ts` did not parse (measured downstream: 1,189 errors, 100%
 * TS1xxx PARSE errors — TS1002 unterminated string literal, TS1127, TS1005,
 * TS1434 — and zero type errors).
 *
 * These tests assert on the PARSEABILITY and ROUND-TRIP FIDELITY of the emitted
 * text, not on any particular escaping strategy. They fail against the old
 * hand-rolled quoting and pass against a correct emitter.
 */

const path = require('path');
const { expect } = require('chai');
const ts = require('typescript');
const {
	mapFieldToZodSchema,
	generateZodContent,
	generateTypesContent,
} = require('../lib/generate-types');
const {
	HOSTILE_DESCRIPTION,
} = require('./fixtures/hostile-description-schema');

const FIXTURE = path.join(
	__dirname,
	'fixtures',
	'hostile-description-schema.js',
);

/**
 * Evaluate an emitted Zod expression against a stub `z`, capturing whatever was
 * handed to `.describe()`.
 *
 * This is the honest test of "did the generator emit a correct string literal":
 * if the literal is malformed the `new Function` throws a SyntaxError (exactly
 * what tsc reports as TS1002/TS1127), and if the escaping mangles the text the
 * captured value differs from the input.
 *
 * @param {string} expr - e.g. `z.string().describe('...')`
 * @returns {string[]} every argument passed to `.describe()`
 */
function describeArgsOf(expr) {
	const captured = [];
	const proxy = new Proxy(function stub() {}, {
		get(_target, prop) {
			if (prop === 'then') return undefined;
			return (...args) => {
				if (prop === 'describe') captured.push(args[0]);
				return proxy;
			};
		},
		apply() {
			return proxy;
		},
	});
	// Throws SyntaxError if the generator emitted a broken literal.
	// eslint-disable-next-line no-new-func
	const fn = new Function('z', `return (${expr});`);
	fn(proxy);
	return captured;
}

/**
 * @param {string} source - TypeScript source text
 * @returns {import('typescript').Diagnostic[]} syntactic (TS1xxx) diagnostics
 */
function parseErrorsOf(source) {
	const { diagnostics } = ts.transpileModule(source, {
		reportDiagnostics: true,
		compilerOptions: { target: ts.ScriptTarget.ES2020 },
		fileName: 'generated.ts',
	});
	return diagnostics || [];
}

function formatDiagnostics(diagnostics) {
	return diagnostics
		.slice(0, 10)
		.map(
			(d) =>
				`TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
		)
		.join('\n');
}

describe('#generate-types description escaping (BDL-2852)', () => {
	// Guard the guard: if the fixture stops being hostile, these tests stop
	// proving anything.
	describe('the control input is actually hostile', () => {
		it('contains a blank line, CR, apostrophe, double quote, backslash, backtick, ${, unicode and a JSDoc terminator', () => {
			expect(HOSTILE_DESCRIPTION, 'blank line').to.contain('\n\n');
			expect(HOSTILE_DESCRIPTION, 'carriage return').to.contain('\r');
			expect(HOSTILE_DESCRIPTION, 'apostrophe').to.contain("'");
			expect(HOSTILE_DESCRIPTION, 'double quote').to.contain('"');
			expect(HOSTILE_DESCRIPTION, 'backslash').to.contain('\\');
			expect(HOSTILE_DESCRIPTION, 'backtick').to.contain('`');
			expect(HOSTILE_DESCRIPTION, 'template hole').to.contain('${');
			expect(HOSTILE_DESCRIPTION, 'unicode').to.contain('café');
			expect(HOSTILE_DESCRIPTION, 'JSDoc terminator').to.contain('*/');
		});
	});

	describe('mapFieldToZodSchema() — every .describe() emission path', () => {
		const cases = [
			{
				name: 'plain string field (buildValidationChain)',
				field: { type: 'varchar', _description: HOSTILE_DESCRIPTION },
			},
			{
				name: 'enum field',
				field: {
					_type: 'enum',
					options: ['auto', 'manual'],
					_description: HOSTILE_DESCRIPTION,
				},
			},
			{
				name: 'object field',
				field: {
					_type: 'object',
					isObject: true,
					_description: HOSTILE_DESCRIPTION,
				},
			},
			{
				name: 'any field',
				field: { isAny: true, _description: HOSTILE_DESCRIPTION },
			},
		];

		cases.forEach(({ name, field }) => {
			it(`${name}: emits a parseable literal that round-trips the description exactly`, () => {
				const expr = mapFieldToZodSchema(field);
				expect(expr, 'a .describe() must be emitted at all').to.contain(
					'.describe(',
				);

				let args;
				try {
					args = describeArgsOf(expr);
				} catch (e) {
					throw new Error(
						`emitted Zod expression does not parse (${e.message}):\n${expr}`,
					);
				}

				expect(args, 'exactly one .describe() call').to.have.lengthOf(1);
				expect(args[0]).to.equal(HOSTILE_DESCRIPTION);
			});
		});
	});

	describe('generateZodContent() — whole generated .zod.ts', () => {
		it('produces ZERO TS1xxx parse errors for a hostile description', () => {
			const source = generateZodContent(FIXTURE);
			const diagnostics = parseErrorsOf(source);
			expect(
				diagnostics.length,
				`generated .zod.ts failed to parse:\n${formatDiagnostics(diagnostics)}`,
			).to.equal(0);
		});
	});

	describe('generateTypesContent() — whole generated .d.ts', () => {
		it('produces ZERO TS1xxx parse errors for a hostile description (JSDoc must not be terminated by "*/" in the text)', () => {
			const source = generateTypesContent(FIXTURE);
			const diagnostics = parseErrorsOf(source);
			expect(
				diagnostics.length,
				`generated .d.ts failed to parse:\n${formatDiagnostics(diagnostics)}`,
			).to.equal(0);
		});
	});
});
