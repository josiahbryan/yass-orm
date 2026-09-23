const { onTransactionEnd, transactionLocal } = require('./transactions');
const { promiseMap } = require('./promiseMap');
const { stampLoadedAt } = require('./model/loaded-at');

/**
 * Instances read or written inside a transaction are kept here, per
 * transaction, instead of in the shared instance cache: until the transaction
 * commits, their data may never exist for anyone else. (It used to go straight
 * into the shared cache, so after a rollback `get(id, { allowCached: true })`
 * handed out rows that were never committed.)
 *
 * When the transaction ends:
 *   - commit: instances are published through the model's own `setCachedId`,
 *     so a consumer's override still decides what caching means. One the
 *     transaction wrote always is; any other (read, or a row it inserted) only
 *     when the shared cache has nothing for its id, since by commit time
 *     its data may be older than what someone else put there meanwhile;
 *     Links then point at the shared instances, not the transaction's copies;
 *   - rollback: nothing is published. An id written through an instance from
 *     outside the transaction (which may be the one in the shared cache, and
 *     the write changed it in place) is evicted through `removeCachedId`;
 *   - a savepoint rollback: the transaction's instances are dropped at once
 *     (what they hold may include the rolled-back part, so the rest of the
 *     transaction reads afresh). If the transaction then commits, nothing is
 *     published and every id it held is evicted.
 *
 * Only real transaction handles (from `dbh.transaction()`) are scoped; any
 * other `tx` value leaves caching as it always was.
 */

const TX_LOCAL_KEY = Symbol('yass-orm tx instance cache');

/**
 * Links resolved inside the transaction point at the transaction's own copies.
 * Once published, repoint them at the instances the shared cache now holds for
 * those ids, so the shared cache has one object per row (as it did when links
 * resolved straight from it). Uses getCachedId, not setCachedId's return value,
 * which overrides need not make the cached one.
 */
function relinkToShared(sharedInstances, sharedFor) {
	if (!sharedFor.size) return;
	sharedInstances.forEach(([Model, shared]) => {
		Model.fields().forEach(({ field, linkedModel }) => {
			if (linkedModel && sharedFor.has(shared[field])) {
				// eslint-disable-next-line no-param-reassign
				shared[field] = sharedFor.get(shared[field]);
			}
		});
	});
}

class TxInstanceCache {
	constructor() {
		// Model class -> Map(id -> { instance, written, pollutedShared })
		this.models = new Map();
		// [Model, id, pollutedShared] dropped by a savepoint rollback, kept for eviction
		this.dropped = [];
		// Instances this transaction created itself (never in the shared cache)
		this.own = new WeakSet();
		this.savepointRolledBack = false;
	}

	get(Model, id) {
		const entries = this.models.get(Model);
		const entry = entries && entries.get(id);
		return entry ? entry.instance : undefined;
	}

	/**
	 * Mirrors DatabaseObject.setCachedId: an instance already held for `id` is
	 * freshened field by field (so references to it stay current), otherwise
	 * `instance` is held. Returns the held instance.
	 *
	 * @param {object} [options]
	 * @param {boolean} [options.created] `instance` was made inside this transaction
	 * @param {boolean} [options.written] `instance` was just written to the database
	 */
	set(Model, id, instance, { created = false, written = false } = {}) {
		if (created) this.own.add(instance);
		// A write through an instance from outside the transaction changed that
		// object in place, and it may be the one in the shared cache.
		const pollutedShared = written && !this.own.has(instance);

		let entries = this.models.get(Model);
		if (!entries) {
			entries = new Map();
			this.models.set(Model, entries);
		}
		const entry = entries.get(id);
		if (!entry) {
			entries.set(id, {
				instance,
				written,
				pollutedShared,
			});
			return instance;
		}
		if (entry.instance !== instance) {
			Model._freshenInstance(entry.instance, instance);
		}
		entry.written = entry.written || written;
		entry.pollutedShared = entry.pollutedShared || pollutedShared;
		return entry.instance;
	}

	/** @returns {Array} [Model, id, entry] for every instance held */
	_entries() {
		return [...this.models].flatMap(([Model, entries]) =>
			[...entries].map(([id, entry]) => [Model, id, entry]),
		);
	}

	savepointRollback() {
		this.savepointRolledBack = true;
		this._entries().forEach(([Model, id, { pollutedShared }]) =>
			this.dropped.push([Model, id, pollutedShared]),
		);
		this.models.clear();
	}

	async publish() {
		if (this.savepointRolledBack) {
			await this.evict(() => true);
			return;
		}
		const sharedFor = new Map(); // transaction's instance -> shared instance
		const sharedInstances = [];
		await promiseMap(this._entries(), async ([Model, id, entry]) => {
			const { instance, written } = entry;
			// A written entry is always published (its data is as of the commit);
			// any other only if nothing is cached.
			if (written) stampLoadedAt(instance);
			let shared = written ? undefined : await Model.getCachedId(id);
			if (!shared) {
				await Model.setCachedId(id, instance);
				shared = await Model.getCachedId(id);
			}
			if (!shared) return;
			sharedInstances.push([Model, shared]);
			if (shared !== instance) sharedFor.set(instance, shared);
		});
		this._clear();
		relinkToShared(sharedInstances, sharedFor);
	}

	/** Evicts, through each model's removeCachedId, the ids `shouldEvict` picks. */
	async evict(shouldEvict = (pollutedShared) => pollutedShared) {
		const candidates = [
			...this.dropped,
			...this._entries().map(([Model, id, { pollutedShared }]) => [
				Model,
				id,
				pollutedShared,
			]),
		];
		this._clear();
		await promiseMap(candidates, async ([Model, id, pollutedShared]) => {
			if (shouldEvict(pollutedShared)) await Model.removeCachedId(id);
		});
	}

	_clear() {
		this.models.clear();
		this.dropped = [];
	}
}

/**
 * @param {object} tx The `tx` option passed to a model method
 * @returns {TxInstanceCache|null} The cache for `tx`'s transaction, or null
 *   when `tx` is not a transaction handle
 */
function txInstanceCache(tx) {
	return transactionLocal(tx, TX_LOCAL_KEY, () => {
		const cache = new TxInstanceCache();
		onTransactionEnd(tx, {
			commit: () => cache.publish(),
			rollback: () => cache.evict(),
			savepointRollback: () => cache.savepointRollback(),
		});
		return cache;
	});
}

module.exports = { txInstanceCache };
