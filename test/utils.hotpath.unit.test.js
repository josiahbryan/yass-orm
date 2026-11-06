/* global describe, it, afterEach */
/* eslint-disable no-param-reassign */
const { expect } = require('chai');
const { handle, cachedHandle, retryIfConnectionLost } = require('../lib/utils');
const { closeAllConnections } = require('../lib/dbh');
const { socketClosed } = require('./helpers/driver-errors');

/**
 * The per-query path costs no more than it must (Tessera's query-cpu-budget,
 * kh63-GO-YASS-HOTPATH-1106). A statement that succeeds builds no retry
 * delay generator, and a cached handle is handed back without a deferred
 * access. Every case that must still take the slow path is covered here:
 * ignoreCachedConnections, an access in progress, and closed connections.
 */

describe('retryIfConnectionLost: the success path builds no retry delays', () => {
	it('never calls the delay factory when the callback succeeds', async () => {
		let built = 0;
		const result = await retryIfConnectionLost(async () => 'ok', {
			handleFactory: async () => ({}),
			delayFactory: () => {
				built += 1;
				return () => 0;
			},
		});
		expect(result).to.equal('ok');
		expect(built).to.equal(0);
	});

	it('builds the delays once, on the first retry, and reuses them', async () => {
		let built = 0;
		let calls = 0;
		const result = await retryIfConnectionLost(
			async () => {
				calls += 1;
				if (calls <= 2) throw socketClosed();
				return 'ok';
			},
			{
				handleFactory: async () => ({}),
				sleep: async () => {},
				delayFactory: () => {
					built += 1;
					return () => 1;
				},
			},
		);
		expect(result).to.equal('ok');
		expect(calls).to.equal(3);
		expect(built).to.equal(1);
	});
});

describe('handle(): a cached handle is handed back as it is', () => {
	const saved = {};
	const save = () => {
		saved.dbh = handle.dbh;
		saved.accessInProgress = handle.accessInProgress;
		saved.debug = handle.onHandleAccessDebug;
	};
	afterEach(() => {
		handle.dbh = saved.dbh;
		handle.accessInProgress = saved.accessInProgress;
		handle.onHandleAccessDebug = saved.debug;
	});

	it('returns the cached dbh without starting an access', async () => {
		save();
		const fake = { fake: true };
		handle.dbh = fake;
		handle.accessInProgress = undefined;
		const seen = [];
		handle.onHandleAccessDebug = (dbh, info) => seen.push({ dbh, info });
		const pending = handle();
		// The slow path sets accessInProgress before its first await.
		expect(handle.accessInProgress).to.equal(undefined);
		expect(await pending).to.equal(fake);
		expect(seen).to.have.length(1);
		expect(seen[0].dbh).to.equal(fake);
		expect(seen[0].info.cacheMiss).to.equal(false);
	});

	it('an access in progress is joined, never answered from the cache', async () => {
		save();
		handle.dbh = { stale: true };
		const fresh = { fresh: true };
		handle.accessInProgress = Promise.resolve(fresh);
		expect(cachedHandle(undefined)).to.equal(undefined);
		expect(await handle()).to.equal(fresh);
	});

	it('ignoreCachedConnections never takes the cached dbh', () => {
		save();
		handle.dbh = { cached: true };
		handle.accessInProgress = undefined;
		expect(cachedHandle(true)).to.equal(undefined);
		expect(cachedHandle(false)).to.equal(handle.dbh);
	});

	it('after closeAllConnections the cached dbh is gone, so nothing stale is returned', async () => {
		save();
		handle.dbh = { closing: true };
		handle.accessInProgress = undefined;
		await closeAllConnections();
		expect(handle.dbh).to.equal(undefined);
		expect(cachedHandle(undefined)).to.equal(undefined);
	});
});
