/* global describe, it */
const { expect } = require('chai');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');

// Regression test for ER_TOO_LONG_FIELD_COMMENT (errno 1629): MySQL/MariaDB
// caps COLUMN COMMENT at 1024 characters. A model def with a longer
// `.describe()` doc-comment kills the entire CREATE TABLE on any fresh
// database — it isn't caught until schema-sync runs against an empty schema,
// because a box that already has the table never re-issues the CREATE.
//
// Two real fields hit this in the wild: bc_agent_grid_entries.executorKind
// (1404 chars) and bc_agent_messages.deliveredAt. Both are long-form
// architectural doc-comments, not accidental — the fix truncates rather than
// rejects, so schema-sync stays non-interactive and a fresh database still
// gets the table.
describe('MySQLDialect.generateFieldSpec column comment length', () => {
	const dialect = new MySQLDialect();

	it('passes an ordinary short description through untouched', () => {
		const spec = dialect.generateFieldSpec({
			field: 'status',
			type: 'varchar(255)',
			_description: 'Current lifecycle status of the record.',
		});
		expect(spec).to.include(
			"COMMENT 'Current lifecycle status of the record.'",
		);
	});

	it('truncates a description over the MySQL 1024-char COMMENT cap with an ellipsis', () => {
		const longDescription = 'x'.repeat(1500);
		const spec = dialect.generateFieldSpec({
			field: 'executorKind',
			type: 'varchar(255)',
			_description: longDescription,
		});

		const match = spec.match(/COMMENT '([^']*(?:''[^']*)*)'/);
		expect(
			match,
			'expected a COMMENT clause in the generated spec',
		).to.not.equal(null);
		const emittedComment = match[1].replace(/''/g, "'");

		// The single load-bearing invariant: whatever we emit must be <= MySQL's
		// hard cap, or the CREATE TABLE fails outright (the bug this test guards).
		expect(emittedComment.length).to.be.at.most(1024);
		expect(emittedComment.endsWith('...')).to.equal(true);
		expect(emittedComment.startsWith('x'.repeat(50))).to.equal(true);
	});

	it('does not truncate a description exactly at the cap boundary (1020 chars)', () => {
		const boundaryDescription = 'y'.repeat(1020);
		const spec = dialect.generateFieldSpec({
			field: 'deliveredAt',
			type: 'datetime',
			_description: boundaryDescription,
		});
		expect(spec).to.include(`COMMENT '${boundaryDescription}'`);
	});

	it('truncates a description one character over the boundary (1021 chars)', () => {
		const overBoundary = 'z'.repeat(1021);
		const spec = dialect.generateFieldSpec({
			field: 'deliveredAt',
			type: 'datetime',
			_description: overBoundary,
		});
		expect(spec).to.not.include(`COMMENT '${overBoundary}'`);
		const match = spec.match(/COMMENT '([^']*(?:''[^']*)*)'/);
		const emittedComment = match[1].replace(/''/g, "'");
		expect(emittedComment.length).to.be.at.most(1024);
		expect(emittedComment.endsWith('...')).to.equal(true);
	});

	it('truncates BEFORE escaping quotes, so escaped output never exceeds the cap either', () => {
		// A description that is under the raw cap but whose escaped form (each
		// embedded quote becomes '') would blow the cap if escaping happened
		// before truncation ordering was fixed.
		const withManyQuotes = `it's `.repeat(210); // 1050 raw chars, 210 quotes
		const spec = dialect.generateFieldSpec({
			field: 'notes',
			type: 'longtext',
			_description: withManyQuotes,
		});
		const match = spec.match(/COMMENT '([^']*(?:''[^']*)*)'/);
		const rawSqlCommentLiteral = match[1]; // still escaped (with '' pairs)
		// The STORED length (what MySQL actually persists) is the escaped form
		// with '' collapsed back to a single quote each.
		const storedLength = rawSqlCommentLiteral.replace(/''/g, "'").length;
		expect(storedLength).to.be.at.most(1024);
	});
});
