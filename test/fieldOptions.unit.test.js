/* global describe, it, afterEach */
const { expect } = require('chai');
const config = require('../lib/config');
const { convertDefinition } = require('../lib/def-to-schema');
const { deflateValue } = require('../lib/dbh');
const { MySQLDialect } = require('../lib/dialects/MySQLDialect');
const { PostgresDialect } = require('../lib/dialects/PostgresDialect');
const { SQLiteDialect } = require('../lib/dialects/SQLiteDialect');

// The two portable field options: `precision` (fractional seconds on a
// datetime) and `exact` (case- and accent-exact comparison on a string). The
// def carries the intent; each dialect turns it into its own column shape.
// Live, both-dialect coverage is in test/schemaSync.fieldOptions.test.js.

const field = (def) =>
	convertDefinition(({ types: t }) => ({
		table: 'field_options_unit',
		schema: { value: def(t) },
	})).fieldMap.value;

describe('#field options: precision and exact', () => {
	describe('the def API', () => {
		it('t.datetime.precision(3) and t.datetime({ precision: 3 })', () => {
			expect(field((t) => t.datetime.precision(3))).to.include({
				type: 'datetime',
				precision: 3,
			});
			expect(field((t) => t.datetime({ precision: 3 }))).to.include({
				type: 'datetime',
				precision: 3,
			});
		});

		it('precision chains with the other datetime options', () => {
			expect(
				field((t) => t.datetime.precision(3).nullable().description('when')),
			).to.include({ precision: 3, null: 1, _description: 'when' });
			expect(
				field((t) =>
					t.datetime({ precision: 6, defaultValue: '2026-01-01 00:00:00' }),
				),
			).to.include({ precision: 6, default: '2026-01-01 00:00:00', null: 0 });
		});

		it('rejects a precision MySQL cannot store', () => {
			[-1, 7, 1.5, '3', null].forEach((bad) => {
				expect(() => field((t) => t.datetime.precision(bad))).to.throw(
					/precision/,
				);
			});
			expect(() => field((t) => t.datetime({ precision: 9 }))).to.throw(
				/precision/,
			);
		});

		it('t.string.exact() and t.string({ exact: true })', () => {
			expect(field((t) => t.string.exact())).to.include({
				type: 'varchar',
				exact: true,
			});
			expect(field((t) => t.string({ exact: true }))).to.include({
				exact: true,
			});
			expect(field((t) => t.text.exact())).to.include({
				type: 'longtext',
				exact: true,
			});
			expect(field((t) => t.string.exact().maxLength(10))).to.include({
				exact: true,
				_maxLength: 10,
			});
		});

		it('a plain t.datetime / t.string carries neither option', () => {
			expect(field((t) => t.datetime)).to.not.have.any.keys(
				'precision',
				'exact',
			);
			expect(field((t) => t.string)).to.not.have.any.keys('precision', 'exact');
		});
	});

	describe('what each dialect makes of them (physicalField)', () => {
		const mysql = new MySQLDialect();
		const pg = new PostgresDialect();
		const sqlite = new SQLiteDialect();

		it('MySQL: DATETIME(n), and utf8mb4_bin for exact', () => {
			expect(
				mysql.physicalField(field((t) => t.datetime.precision(3))),
			).to.include({ type: 'datetime(3)' });
			expect(
				mysql.physicalField(field((t) => t.datetime.precision(0))).type,
			).to.equal('datetime');
			expect(mysql.physicalField(field((t) => t.string.exact()))).to.include({
				type: 'varchar',
				collation: 'utf8mb4_bin',
			});
		});

		it('MySQL: leaves fields without the options exactly as they were', () => {
			const plain = { field: 'x', type: 'datetime', nativeType: Date };
			expect(mysql.physicalField(plain)).to.deep.equal(plain);
			const raw = { field: 'y', type: 'varchar', collation: 'latin1_bin' };
			expect(mysql.physicalField(raw)).to.deep.equal(raw);
		});

		it('MySQL: exact plus a different explicit collation is an error', () => {
			expect(() =>
				mysql.physicalField({
					field: 'email',
					type: 'varchar',
					exact: true,
					collation: 'utf8mb4_0900_ai_ci',
				}),
			).to.throw(/exact/);
		});

		it('Postgres and SQLite: no collation at all (their comparison is already exact)', () => {
			[pg, sqlite].forEach((d) => {
				const exact = d.physicalField(field((t) => t.string.exact()));
				expect(exact).to.not.have.property('collation');
				const raw = d.physicalField({
					field: 'email',
					type: 'varchar',
					collation: 'utf8mb4_bin',
				});
				expect(raw).to.not.have.property('collation');
				expect(
					d.physicalField(field((t) => t.datetime.precision(3))).type,
				).to.equal('datetime');
			});
		});

		it('does not change the field it is given', () => {
			const f = field((t) => t.datetime.precision(3));
			const before = { ...f };
			mysql.physicalField(f);
			pg.physicalField({ ...f, collation: 'utf8mb4_bin' });
			expect(f).to.deep.equal(before);
		});
	});

	describe('writes (deflateValue with a precision)', () => {
		const saved = config.dialect;
		afterEach(() => {
			config.dialect = saved;
		});
		const at = new Date('2026-01-15T12:34:56.789Z');

		it('MySQL keeps up to `precision` digits of the fraction', () => {
			config.dialect = 'mysql';
			expect(deflateValue(at, { precision: 3 })).to.equal(
				'2026-01-15 12:34:56.789',
			);
			expect(deflateValue(at, { precision: 6 })).to.equal(
				'2026-01-15 12:34:56.789',
			);
			expect(deflateValue(at, { precision: 1 })).to.equal(
				'2026-01-15 12:34:56.7',
			);
		});

		it('MySQL without a precision: whole seconds, as before', () => {
			config.dialect = 'mysql';
			expect(deflateValue(at)).to.equal('2026-01-15 12:34:56');
			expect(deflateValue(at, { precision: 0 })).to.equal(
				'2026-01-15 12:34:56',
			);
			expect(deflateValue(at, {})).to.equal('2026-01-15 12:34:56');
		});

		it('Postgres: the full instant either way', () => {
			config.dialect = 'postgres';
			expect(deflateValue(at, { precision: 3 })).to.equal(
				'2026-01-15T12:34:56.789Z',
			);
		});
	});
});
