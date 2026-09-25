/* eslint-disable no-param-reassign */
/**
 * `set()`'s auto-save. Each schema field `set()` assigns is an unsaved edit on
 * the instance until the save `set()` schedules takes it:
 *
 * - The save writes the values `set()` was given.
 * - Until then, a read of the row onto the instance (a `get()` freshening the
 *   cached instance, another write's read-back, a transaction publishing its
 *   copy) doesn't overwrite them: `reapplyUnsavedSets` puts them back.
 * - A `patch()` (or `patchIf()`) of the same field, called before the save
 *   starts, is the later write, so it wins: once it has written, the edit is
 *   dropped (a failed write keeps it). Not the save's own `patch()`, however an
 *   override reaches it: that runs inside `runAutoSave`.
 */
const { AsyncLocalStorage } = require('async_hooks');

// A hidden property (not enumerable): out of Object.keys, spreads and JSON.
const UNSAVED_SETS = Symbol('yass-orm.unsavedSets');

// The instance whose auto-save is running in this async call chain.
const autoSaveScope = new AsyncLocalStorage();

const unsavedSets = (instance) => {
	if (!instance[UNSAVED_SETS]) {
		Object.defineProperty(instance, UNSAVED_SETS, {
			value: new Map(),
			enumerable: false,
		});
	}
	return instance[UNSAVED_SETS];
};

/**
 * Records `set(field, value)` as an unsaved edit (the latest value wins). Each
 * edit is its own object, so a write can tell the edits it superseded from a
 * `set()` made while it ran, even of the same value.
 */
const recordSet = (instance, field, value) => {
	unsavedSets(instance).set(field, { value });
};

/** The unsaved edits as a patch, now handed to a save (no longer unsaved). */
const takeUnsavedSets = (instance) => {
	const pending = instance[UNSAVED_SETS];
	if (!pending) {
		return {};
	}
	const changes = {};
	pending.forEach(({ value }, field) => {
		changes[field] = value;
	});
	pending.clear();
	return changes;
};

/** After row data is copied onto `instance`: the unsaved edits go back on top. */
const reapplyUnsavedSets = (instance) => {
	const pending = instance[UNSAVED_SETS];
	if (pending) {
		pending.forEach(({ value }, field) => {
			instance[field] = value;
		});
	}
};

/**
 * Before a `patch()` or `patchIf()` of `fields`: the unsaved edits it would
 * supersede, for `dropSupersededSets` once it has written. None inside the
 * instance's own auto-save.
 */
const supersededSets = (instance, fields) => {
	const pending = instance[UNSAVED_SETS];
	const superseded = new Map();
	if (pending && autoSaveScope.getStore() !== instance) {
		fields.forEach((field) => {
			if (pending.has(field)) superseded.set(field, pending.get(field));
		});
	}
	return superseded;
};

/**
 * After the write succeeded, before its read-back: drops the edits it
 * superseded (only those of `written` fields, when given). A `set()` made while
 * it ran is a newer edit and stays.
 */
const dropSupersededSets = (instance, superseded, written) => {
	const pending = instance[UNSAVED_SETS];
	superseded.forEach((edit, field) => {
		if (pending.get(field) === edit && (!written || field in written)) {
			pending.delete(field);
		}
	});
};

/** Forgets every unsaved edit (the row is gone). */
const clearUnsavedSets = (instance) => {
	const pending = instance[UNSAVED_SETS];
	if (pending) pending.clear();
};

/** Runs `save` as `instance`'s auto-save (see dropSupersededSets). */
const runAutoSave = (instance, save) => autoSaveScope.run(instance, save);

module.exports = {
	recordSet,
	takeUnsavedSets,
	reapplyUnsavedSets,
	supersededSets,
	dropSupersededSets,
	clearUnsavedSets,
	runAutoSave,
};
