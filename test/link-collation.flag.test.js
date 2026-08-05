/* global describe, it, beforeEach, afterEach */
const { expect } = require('chai');

const config = require('../lib/config');
const {
	convertDefinition,
	resolveLinkColumnCollation,
} = require('../lib/def-to-schema');
const { getDialect } = require('../lib/dbh');
const { CANONICAL_UUID_COLLATION } = require('../lib/uuid-collation');
const { shouldDeferCollationOnlyChange } = require('../lib/sync-to-db');

/**
 * Proves the opt-in link-collation source fix:
 *   - flag OFF (default) => byte-for-byte legacy behavior (no collation emitted)
 *   - flag ON            => char(36) link/uuid columns carry the canonical
 *                            utf8mb4_bin, IDENTICAL to the uuid PK by construction
 *   - the schema-sync deferral guard suppresses only the exact known rebuild case
 */
describe('#Link Column Collation (opt-in source fix)', () => {
	// Snapshot + restore the mutable config singleton so tests are isolated.
	let saved;
	beforeEach(() => {
		saved = {
			linkColumnCollation: config.linkColumnCollation,
			uuidLinkedIds: config.uuidLinkedIds,
			migrateLinkCollation: config.migrateLinkCollation,
		};
	});
	afterEach(() => {
		Object.assign(config, saved);
	});

	describe('resolveLinkColumnCollation()', () => {
		it('returns undefined when flag is OFF (default) for char(36)', () => {
			config.linkColumnCollation = undefined;
			expect(resolveLinkColumnCollation('char(36)')).to.equal(undefined);
		});

		it('returns canonical utf8mb4_bin when flag === true', () => {
			config.linkColumnCollation = true;
			expect(resolveLinkColumnCollation('char(36)')).to.equal(
				CANONICAL_UUID_COLLATION,
			);
		});

		it('returns an explicit string override verbatim', () => {
			config.linkColumnCollation = 'utf8mb4_0900_bin';
			expect(resolveLinkColumnCollation('char(36)')).to.equal(
				'utf8mb4_0900_bin',
			);
		});

		it('never applies to non-char(36) types even when flag ON', () => {
			config.linkColumnCollation = true;
			expect(resolveLinkColumnCollation('int')).to.equal(undefined);
			expect(resolveLinkColumnCollation('longtext')).to.equal(undefined);
		});
	});

	describe('uuid PRIMARY KEY collation is the single source of truth', () => {
		it('getUuidPrimaryKeyAttrs uses CANONICAL_UUID_COLLATION', () => {
			const dialect = getDialect('mysql');
			expect(dialect.getUuidPrimaryKeyAttrs().collation).to.equal(
				CANONICAL_UUID_COLLATION,
			);
		});
	});

	describe('t.linked (char(36) mode, uuidLinkedIds:true)', () => {
		beforeEach(() => {
			config.uuidLinkedIds = true;
		});

		it('emits NO collation when flag OFF (legacy behavior unchanged)', () => {
			config.linkColumnCollation = undefined;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_link_off',
				schema: { user: t.linked('user') },
			}));
			expect(schema.fieldMap.user.type).to.equal('char(36)');
			expect(schema.fieldMap.user.collation).to.equal(undefined);
		});

		it('emits canonical collation when flag ON', () => {
			config.linkColumnCollation = true;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_link_on',
				schema: { user: t.linked('user') },
			}));
			expect(schema.fieldMap.user.type).to.equal('char(36)');
			expect(schema.fieldMap.user.collation).to.equal(CANONICAL_UUID_COLLATION);
		});

		it('link collation === uuid PK collation BY CONSTRUCTION when ON', () => {
			config.linkColumnCollation = true;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_link_matches_pk',
				schema: { id: t.uuidKey, tenant: t.linked('tenant') },
			}));
			const pkCollation =
				getDialect('mysql').getUuidPrimaryKeyAttrs().collation;
			expect(schema.fieldMap.tenant.collation).to.equal(pkCollation);
		});

		it('preserves chainable .description() alongside collation', () => {
			config.linkColumnCollation = true;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_link_chain',
				schema: { user: t.linked('user').description('ref') },
			}));
			expect(schema.fieldMap.user.collation).to.equal(CANONICAL_UUID_COLLATION);
			expect(schema.fieldMap.user._description).to.equal('ref');
			expect(schema.fieldMap.user.linkedModel).to.equal('user');
		});
	});

	describe('t.linked (int mode, uuidLinkedIds:false)', () => {
		it('never emits collation on int links even when flag ON', () => {
			config.uuidLinkedIds = false;
			config.linkColumnCollation = true;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_link_int',
				schema: { user: t.linked('user') },
			}));
			expect(schema.fieldMap.user.type).to.equal('int');
			expect(schema.fieldMap.user.collation).to.equal(undefined);
		});
	});

	describe('t.uuid (non-key char(36))', () => {
		it('emits NO collation when flag OFF', () => {
			config.linkColumnCollation = undefined;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_uuid_off',
				schema: { externalId: t.uuid },
			}));
			expect(schema.fieldMap.externalId.type).to.equal('char(36)');
			expect(schema.fieldMap.externalId.collation).to.equal(undefined);
		});

		it('emits canonical collation when flag ON', () => {
			config.linkColumnCollation = true;
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_uuid_on',
				schema: { externalId: t.uuid },
			}));
			expect(schema.fieldMap.externalId.collation).to.equal(
				CANONICAL_UUID_COLLATION,
			);
		});
	});

	describe('schema-sync deferral guard (shouldDeferCollationOnlyChange)', () => {
		afterEach(() => {
			config.migrateLinkCollation = undefined;
		});

		it('DEFERS bin<-0900_ai_ci when migrateLinkCollation is OFF', () => {
			config.migrateLinkCollation = undefined;
			expect(
				shouldDeferCollationOnlyChange({
					key: 'collation',
					dbValue: 'utf8mb4_0900_ai_ci',
					schemaValue: 'utf8mb4_bin',
				}),
			).to.equal(true);
		});

		it('DEFERS bin<-general_ci when migrateLinkCollation is OFF', () => {
			config.migrateLinkCollation = undefined;
			expect(
				shouldDeferCollationOnlyChange({
					key: 'collation',
					dbValue: 'utf8mb4_general_ci',
					schemaValue: 'utf8mb4_bin',
				}),
			).to.equal(true);
		});

		it('APPLIES (does not defer) when migrateLinkCollation is ON', () => {
			config.migrateLinkCollation = true;
			expect(
				shouldDeferCollationOnlyChange({
					key: 'collation',
					dbValue: 'utf8mb4_0900_ai_ci',
					schemaValue: 'utf8mb4_bin',
				}),
			).to.equal(false);
		});

		it('never defers a non-collation diff', () => {
			expect(
				shouldDeferCollationOnlyChange({
					key: 'type',
					dbValue: 'varchar(255)',
					schemaValue: 'char(36)',
				}),
			).to.equal(false);
		});

		it('never defers an unrelated collation change (not the known pattern)', () => {
			// e.g. someone deliberately moving bin -> ci, or ci -> a different ci
			expect(
				shouldDeferCollationOnlyChange({
					key: 'collation',
					dbValue: 'utf8mb4_bin',
					schemaValue: 'utf8mb4_general_ci',
				}),
			).to.equal(false);
			expect(
				shouldDeferCollationOnlyChange({
					key: 'collation',
					dbValue: 'utf8mb4_0900_ai_ci',
					schemaValue: 'utf8mb4_unicode_ci',
				}),
			).to.equal(false);
		});
	});
});
