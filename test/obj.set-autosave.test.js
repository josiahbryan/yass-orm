/* global describe, it, beforeEach, afterEach */
const { expect } = require('chai');
const { loadDefinition } = require('../lib/obj');
const { captureConsoleError } = require('./helpers/captureConsoleError');

/**
 * `set()` schedules an `update()` on a timer, so nothing awaits that save. A
 * failed save must not become an unhandled rejection (which crashes Node 15+):
 * it goes to `onAutoSaveError`, which logs by default. No database needed:
 * `update` is stubbed to fail.
 */
describe('#YASS-ORM set() auto-save errors', () => {
	const Model = loadDefinition(({ types: t }) => ({
		table: 'yass_autosave',
		schema: { id: t.idKey, name: t.string },
	}));

	// PATCH_DEFER_DELAY is 300ms.
	const afterAutoSave = () =>
		new Promise((resolve) => setTimeout(resolve, 400));

	let unhandled;
	let originalListeners;
	const onUnhandled = (reason) => unhandled.push(reason);
	let consoleCapture;
	let logged;

	beforeEach(() => {
		Model.clearCache();
		unhandled = [];
		// Take mocha's own handler off so a regression is caught here, as a
		// failed assertion, rather than crashing the run.
		originalListeners = process.listeners('unhandledRejection');
		process.removeAllListeners('unhandledRejection');
		process.on('unhandledRejection', onUnhandled);
		consoleCapture = captureConsoleError.install();
		logged = consoleCapture.captured;
	});

	afterEach(() => {
		process.removeListener('unhandledRejection', onUnhandled);
		originalListeners.forEach((listener) =>
			process.on('unhandledRejection', listener),
		);
		consoleCapture.restore();
	});

	const failingInstance = async (error) => {
		const instance = await Model.inflate({ id: 7, name: 'before' });
		instance.update = () => Promise.reject(error);
		return instance;
	};

	it('routes a failed save to onAutoSaveError instead of an unhandled rejection', async () => {
		const boom = new Error('save failed');
		const instance = await failingInstance(boom);
		const seen = [];
		instance.onAutoSaveError = (error) => seen.push(error);

		instance.set('name', 'after');
		await afterAutoSave();

		expect(unhandled).to.deep.equal([]);
		expect(seen).to.deep.equal([boom]);
	});

	it('logs the error with the model and id by default', async () => {
		const boom = new Error('save failed');
		const instance = await failingInstance(boom);

		instance.set({ name: 'after' });
		await afterAutoSave();

		expect(unhandled).to.deep.equal([]);
		expect(logged).to.have.length(1);
		expect(logged[0].join(' ')).to.include('ModelClass:7');
		expect(logged[0]).to.include(boom);
	});

	it('logs an onAutoSaveError that throws, rather than rethrowing it', async () => {
		const instance = await failingInstance(new Error('save failed'));
		const hookError = new Error('hook failed');
		instance.onAutoSaveError = () => {
			throw hookError;
		};

		instance.set('name', 'after');
		await afterAutoSave();

		expect(unhandled).to.deep.equal([]);
		expect(logged).to.have.length(1);
		expect(logged[0]).to.include(hookError);
	});

	it('several set() calls in a row still save once (control)', async () => {
		const instance = await Model.inflate({ id: 8, name: 'before' });
		let saves = 0;
		instance.update = async () => {
			saves += 1;
			return instance;
		};

		instance.set('name', 'a');
		instance.set('name', 'b');
		await afterAutoSave();

		expect(saves).to.equal(1);
		expect(unhandled).to.deep.equal([]);
		expect(logged).to.deep.equal([]);
	});
});
