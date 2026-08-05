/* global describe, it, before, after */
const { expect } = require('chai');
const { v4: uuid } = require('uuid');
const YassORM = require('../lib');
const { syncSchemaToDb, resolveIndexColumns } = require('../lib/sync-to-db');

/**
 * Closes the cols-vs-columns/fields silent-no-op footgun: an index spec object
 * previously had to use the exact key `cols` — any other spelling (`columns`,
 * `fields`, etc.) was silently ignored (sync-to-db only ever read `.cols`, and
 * a missing/undefined `cols` value hit the "ignore empty indexes" branch meant
 * for manually-created indexes, so the typo produced no error and no index).
 *
 * `cols` remains the canonical/current key. `columns` is now an accepted
 * ALIAS with identical behavior — purely additive, zero change for any schema
 * def that already uses `cols`.
 */
describe('#Index column-key alias (cols / columns)', () => {
	describe('resolveIndexColumns()', () => {
		it('returns the array/string as-is for the shorthand (non-object) form', () => {
			expect(resolveIndexColumns(['a', 'b'])).to.deep.equal(['a', 'b']);
			expect(resolveIndexColumns('a')).to.equal('a');
		});

		it('reads the canonical `cols` key', () => {
			expect(resolveIndexColumns({ cols: ['email'] })).to.deep.equal([
				'email',
			]);
		});

		it('reads the `columns` alias identically to `cols`', () => {
			expect(resolveIndexColumns({ columns: ['email'] })).to.deep.equal([
				'email',
			]);
		});

		it('produces identical results for both spellings on the same spec shape', () => {
			const viaCols = resolveIndexColumns({
				unique: true,
				fulltext: true,
				cols: ['a', 'b'],
			});
			const viaColumns = resolveIndexColumns({
				unique: true,
				fulltext: true,
				columns: ['a', 'b'],
			});
			expect(viaColumns).to.deep.equal(viaCols);
		});

		it('prefers `cols` when both keys are present on the same spec', () => {
			expect(
				resolveIndexColumns({ cols: ['a'], columns: ['b'] }),
			).to.deep.equal(['a']);
		});

		it('still returns undefined when neither key is present (preserves the manual-index no-op)', () => {
			expect(resolveIndexColumns({ unique: true })).to.equal(undefined);
		});

		it('does NOT accept `fields` as an alias (still a silent no-op, not in scope for this fix)', () => {
			expect(resolveIndexColumns({ fields: ['email'] })).to.equal(undefined);
		});
	});

	describe('end-to-end schema-sync using the `columns` alias', () => {
		const tableName = `yass_idx_alias_${uuid().replace(/-/g, '')}`;
		const indexName = 'idx_email_via_columns_alias';
		const schemaDef = ({ types: t }) => ({
			table: tableName,
			schema: {
				id: t.idKey,
				email: t.string,
			},
			options: {
				indexes: {
					// Uses `columns` instead of the canonical `cols` -- previously a
					// silent no-op; now must create the index identically to `cols`.
					[indexName]: {
						unique: true,
						columns: ['email'],
					},
				},
			},
		});

		before(async () => {
			const schema = YassORM.convertDefinition(schemaDef);
			await syncSchemaToDb(schema);
		});

		it('creates the index from a `columns:`-spelled spec (not silently skipped)', async () => {
			const { dbh } = require('../lib/dbh');
			const conn = await dbh();
			const rows = await conn.pquery(`SHOW INDEX FROM \`${tableName}\``);
			const created = rows.some((row) => row.Key_name === indexName);
			expect(created).to.equal(true);
		});
	});
});
