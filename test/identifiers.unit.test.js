/* global describe, it */
const { expect } = require('chai');
const {
	fitIdentifierToLimit,
	idTriggerName,
	IDENTIFIER_DIGEST_LENGTH,
} = require('../lib/identifiers');
const {
	MySQLDialect,
	MYSQL_MAX_IDENTIFIER_LENGTH,
} = require('../lib/dialects/MySQLDialect');
const {
	PostgresDialect,
	POSTGRES_MAX_IDENTIFIER_LENGTH,
} = require('../lib/dialects/PostgresDialect');
const syncToDb = require('../lib/sync-to-db');

// The built-in MySQL id trigger is named `before_insert_<table>_set_id`: 21
// characters of framing, so a table name over 43 characters used to fail schema
// sync with "Identifier name ... is too long". A name that fits must stay exactly
// as it was (existing databases see no change); only an over-long one is fitted.
describe('identifier names', () => {
	it('each dialect names its identifier limit', () => {
		expect(MYSQL_MAX_IDENTIFIER_LENGTH).to.equal(64);
		expect(POSTGRES_MAX_IDENTIFIER_LENGTH).to.equal(63);
		expect(new MySQLDialect().maxIdentifierLength).to.equal(
			MYSQL_MAX_IDENTIFIER_LENGTH,
		);
		expect(new PostgresDialect().maxIdentifierLength).to.equal(
			POSTGRES_MAX_IDENTIFIER_LENGTH,
		);
	});

	it('sync-to-db still exports the same fitIdentifierToLimit', () => {
		expect(syncToDb.fitIdentifierToLimit).to.equal(fitIdentifierToLimit);
	});

	describe('idTriggerName()', () => {
		const limit = MYSQL_MAX_IDENTIFIER_LENGTH;

		it('is unchanged for a short table', () => {
			expect(idTriggerName('user', limit)).to.equal(
				'before_insert_user_set_id',
			);
		});

		it('is unchanged for a 43-character table (exactly 64 characters)', () => {
			const table = 't'.repeat(43);
			const name = idTriggerName(table, limit);
			expect(name).to.equal(`before_insert_${table}_set_id`);
			expect(name).to.have.lengthOf(64);
		});

		it('is unchanged with no limit', () => {
			const table = 't'.repeat(80);
			expect(idTriggerName(table, undefined)).to.equal(
				`before_insert_${table}_set_id`,
			);
		});

		it('fits a 44-character table into 64 characters: a prefix plus a hash', () => {
			const table = 'u'.repeat(44);
			const name = idTriggerName(table, limit);
			expect(name).to.have.lengthOf(64);
			const prefixLength = limit - IDENTIFIER_DIGEST_LENGTH - 1;
			expect(name.slice(0, prefixLength)).to.equal(
				`before_insert_${table}_set_id`.slice(0, prefixLength),
			);
			expect(name.slice(prefixLength)).to.match(
				new RegExp(`^_[0-9a-f]{${IDENTIFIER_DIGEST_LENGTH}}$`),
			);
		});

		it('is deterministic, and differs for two long tables sharing a prefix', () => {
			const a = `${'v'.repeat(60)}_a`;
			const b = `${'v'.repeat(60)}_b`;
			expect(idTriggerName(a, limit)).to.equal(idTriggerName(a, limit));
			expect(idTriggerName(a, limit)).to.not.equal(idTriggerName(b, limit));
			expect(idTriggerName(a, limit)).to.have.lengthOf(64);
		});
	});
});
