/* eslint-disable no-unused-expressions */
/* global describe, it, before, beforeEach, afterEach */
const path = require('path');
const { expect } = require('chai');
const YassORM = require('../lib');
const { dbh } = require('../lib/dbh');
const {
	recreateTables,
	quoteTable,
	rejectionOf,
} = require('./helpers/characterize');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const Author = require('./fixtures/link-styles/author');
const Book = require('./fixtures/link-styles/book');
const Publisher = require('./fixtures/link-styles/registered/publisher');
const CharPerson = require('./fixtures/characterize/char-person');
const CharPet = require('./fixtures/characterize/char-pet');
const Visit = require('./fixtures/characterize/char-visit');
const Vet = require('./fixtures/characterize/sub/char-vet');

const { registerModel, registerModels, getRegisteredModel, checkLinks } =
	YassORM;

const fieldLink = (Model, field) => Model.schema().fieldMap[field].linkedModel;

/**
 * The three ways `t.linked(x)` names its target (the plan's "Linking models:
 * the redesign"), dispatched on the argument's type:
 * - a function: a lazy reference, `t.linked(() => Model)`;
 * - a name registered in the model registry: `t.linked('name')`;
 * - anything else: today's path resolution, unchanged (the characterization
 *   tests pin that).
 * Plus checkLinks(), which resolves every link up front and reports them all.
 * Live database for the loading tests: MySQL in `npm test`, Postgres in
 * `npm run test:postgres`.
 */
describe('#YASS-ORM link styles and the model registry', function linkStylesSuite() {
	this.timeout(30000);

	// Every test leaves the registry as it found it.
	let unregisterAll = [];
	afterEach(() => {
		unregisterAll.forEach((unregister) => unregister());
		unregisterAll = [];
	});
	const register = (models) => {
		unregisterAll.push(registerModels(models));
	};

	describe('t.linked(() => Model): a lazy reference', () => {
		it('records the function as the link, on the same column type as a named link', () => {
			const schema = YassORM.convertDefinition(({ types: t }) => ({
				table: 'yass_link_lazy_types',
				schema: {
					byName: t.linked('char-person'),
					byRef: t.linked(() => CharPerson),
					described: t.linked(() => CharPerson).description('the person'),
				},
			}));
			const { byName, byRef, described } = schema.fieldMap;
			expect(byRef.linkedModel).to.be.a('function');
			expect(byRef.type).to.equal(byName.type);
			// Chaining keeps the reference.
			expect(described.linkedModel).to.be.a('function');
			expect(described._description).to.equal('the person');
		});

		it('resolves through a require cycle, and a self-link, with no path lookup', async () => {
			const pathCache = globalThis.__YASS_ORM_PATH_CACHE__;
			const sizeBefore = pathCache.size;

			expect(await Book._resolveModelClass(fieldLink(Book, 'author'))).to.equal(
				Author,
			);
			expect(
				await Author._resolveModelClass(fieldLink(Author, 'favoriteBook')),
			).to.equal(Book);
			expect(
				await Author._resolveModelClass(fieldLink(Author, 'mentor')),
			).to.equal(Author);

			expect(pathCache.size).to.equal(sizeBefore);
		});

		it('resolves an ES module cycle through live bindings', async () => {
			const { default: EsmA } = await import(
				'./fixtures/link-styles/esm-a.mjs'
			);
			const { default: EsmB } = await import(
				'./fixtures/link-styles/esm-b.mjs'
			);
			expect(await EsmA._resolveModelClass(fieldLink(EsmA, 'b'))).to.equal(
				EsmB,
			);
			expect(await EsmB._resolveModelClass(fieldLink(EsmB, 'a'))).to.equal(
				EsmA,
			);
		});

		it('unwraps a module namespace and awaits a dynamic import()', async () => {
			expect(
				await Book._resolveModelClass(() => ({ default: Author })),
			).to.equal(Author);
			const { default: EsmA } = await import(
				'./fixtures/link-styles/esm-a.mjs'
			);
			expect(
				await Book._resolveModelClass(() =>
					import('./fixtures/link-styles/esm-a.mjs'),
				),
			).to.equal(EsmA);
		});

		it('runs a reference once it resolves, not on every read; a failed one runs again', async () => {
			let calls = 0;
			let ready = false;
			const reference = () => {
				calls += 1;
				return ready ? Author : undefined;
			};
			await rejectionOf(Book._resolveModelClass(reference));
			ready = true;
			expect(await Book._resolveModelClass(reference)).to.equal(Author);
			expect(await Book._resolveModelClass(reference)).to.equal(Author);
			expect(calls).to.equal(2);
		});

		it('also takes the model class itself', async () => {
			expect(await Book._resolveModelClass(Author)).to.equal(Author);
		});

		it('a reference that gives no model fails at first read, naming the table', async () => {
			const Broken = YassORM.loadDefinition(({ types: t }) => ({
				table: 'yass_link_broken_lazy',
				schema: { id: t.idKey, gone: t.linked(() => undefined) },
			}));

			// A null link never calls the reference.
			const values = await Broken.inflateValues({ id: 1, gone: null });
			expect(values.gone).to.equal(null);

			let error;
			await captureConsoleError.during(async () => {
				error = await rejectionOf(Broken.inflateValues({ id: 1, gone: 5 }));
			});
			expect(error).to.be.an('error');
			expect(error.message).to.include('Cannot resolve linked model');
			expect(error.message).to.include("on table 'yass_link_broken_lazy'");
			expect(error.message).to.include('undefined');
		});
	});

	describe("t.linked('name'): a registered name", () => {
		it('resolves through the registry, and only while registered', async () => {
			const link = fieldLink(Book, 'publisher');
			expect(link).to.equal('link-publisher');

			// No file has that name: the path fallback fails.
			const before = await rejectionOf(Book._resolveModelClass(link));
			expect(before.message).to.include(
				"Cannot resolve linked model 'link-publisher'",
			);

			const unregister = registerModels({ 'link-publisher': Publisher });
			try {
				expect(getRegisteredModel('link-publisher')).to.equal(Publisher);
				expect(await Book._resolveModelClass(link)).to.equal(Publisher);
			} finally {
				unregister();
			}

			expect(getRegisteredModel('link-publisher')).to.equal(undefined);
			const after = await rejectionOf(Book._resolveModelClass(link));
			expect(after).to.be.an('error');
		});

		it('a registered name wins over a model file of the same name; unregistered, the path is back', async () => {
			expect(await CharPet._resolveModelClass('char-person')).to.equal(
				CharPerson,
			);
			register({ 'char-person': Publisher });
			expect(await CharPet._resolveModelClass('char-person')).to.equal(
				Publisher,
			);
			unregisterAll.pop()();
			expect(await CharPet._resolveModelClass('char-person')).to.equal(
				CharPerson,
			);
		});

		it('registerModel() takes one name; the registry is on globalThis', () => {
			const unregister = registerModel('link-publisher', Publisher);
			try {
				expect(globalThis.__YASS_ORM_MODEL_REGISTRY__).to.be.an.instanceOf(Map);
				expect(
					globalThis.__YASS_ORM_MODEL_REGISTRY__.get('link-publisher'),
				).to.equal(Publisher);
			} finally {
				unregister();
			}
		});

		it('refuses a value that is not a model, and a name taken by another model', () => {
			expect(() => registerModel('link-bad', 42)).to.throw(TypeError);
			expect(() => registerModel('', Publisher)).to.throw(TypeError);

			register({ 'link-publisher': Publisher });
			// The same model again is fine (a second copy of a package registering).
			expect(() => registerModel('link-publisher', Publisher)).to.not.throw();
			expect(() => registerModel('link-publisher', Author)).to.throw(
				/already registered/,
			);
		});

		it("a repeat registration's unregister leaves the first one in place", () => {
			register({ 'link-publisher': Publisher });
			const repeat = registerModel('link-publisher', Publisher);
			repeat();
			expect(getRegisteredModel('link-publisher')).to.equal(Publisher);
		});
	});

	describe('loading rows through both styles', () => {
		let conn;
		const models = [Author, Book, Publisher];
		before(async () => {
			await recreateTables(models.map((Model) => Model.definition));
			conn = await dbh();
		});

		beforeEach(async () => {
			register({ 'link-publisher': Publisher });
			await Promise.all(
				models.map((Model) =>
					conn.pquery(`DELETE FROM ${quoteTable(Model.table())}`),
				),
			);
			models.forEach((Model) => Model.clearCache());
		});

		it('get() inflates lazy and registered links, one instance per row', async () => {
			const acme = await Publisher.create({ name: 'Acme' });
			const ann = await Author.create({ name: 'Ann' });
			const book = await Book.create({
				title: 'Links',
				author: ann,
				publisher: acme.id,
			});
			await ann.patch({ favoriteBook: book.id, mentor: ann.id });
			expect(ann.favoriteBook).to.equal(book);
			expect(book.author).to.equal(ann);
			expect(book.publisher).to.equal(acme);

			models.forEach((Model) => Model.clearCache());
			const loaded = await Book.get(book.id);
			expect(loaded.author).to.be.an.instanceOf(Author);
			expect(loaded.author.name).to.equal('Ann');
			expect(loaded.author.favoriteBook).to.equal(loaded);
			expect(loaded.author.mentor).to.equal(loaded.author);
			expect(loaded.publisher).to.be.an.instanceOf(Publisher);
			expect(loaded.publisher.name).to.equal('Acme');
		});

		it('jsonify({ includeLinked }) follows lazy links', async () => {
			const ann = await Author.create({ name: 'Ann' });
			const book = await Book.create({ title: 'Links', author: ann.id });
			expect(await book.jsonify({ includeLinked: true })).to.deep.equal({
				id: book.id,
				author: { id: ann.id, name: 'Ann' },
			});
		});
	});

	describe('checkLinks()', () => {
		it('with no models registered: nothing to check', async () => {
			expect(await checkLinks()).to.deep.equal({
				ok: true,
				checked: 0,
				problems: [],
			});
		});

		it('checks the registered models by default', async () => {
			register({
				'link-author': Author,
				'link-book': Book,
				'link-publisher': Publisher,
			});
			// Author: favoriteBook, mentor. Book: author, publisher.
			expect(await checkLinks()).to.deep.equal({
				ok: true,
				checked: 4,
				problems: [],
			});
		});

		it('reports every broken link at once, without throwing', async () => {
			const Broken = YassORM.loadDefinition(({ types: t }) => ({
				table: 'yass_link_check_broken',
				schema: {
					id: t.idKey,
					good: t.linked(() => Author),
					missingFile: t.linked('no-such-model'),
					emptyRef: t.linked(() => undefined),
					throwingRef: t.linked(() => {
						throw new Error('boom');
					}),
				},
			}));

			const report = await checkLinks({ models: [Broken, Author] });
			expect(report.ok).to.equal(false);
			expect(report.checked).to.equal(6);
			expect(
				report.problems.map(({ table, field }) => `${table}.${field}`),
			).to.deep.equal([
				'yass_link_check_broken.missingFile',
				'yass_link_check_broken.emptyRef',
				'yass_link_check_broken.throwingRef',
			]);
			const [missingFile, emptyRef, throwingRef] = report.problems;
			expect(missingFile.link).to.equal('no-such-model');
			expect(missingFile.message).to.include(
				"Cannot resolve linked model 'no-such-model'",
			);
			expect(emptyRef.link).to.equal('() => undefined');
			expect(emptyRef.message).to.include('undefined');
			expect(throwingRef.message).to.include('boom');
		});

		it('throwIfBroken: one error listing every broken link', async () => {
			const Broken = YassORM.loadDefinition(({ types: t }) => ({
				table: 'yass_link_check_throw',
				schema: {
					id: t.idKey,
					one: t.linked('no-such-model'),
					two: t.linked('no-such-other-model'),
				},
			}));
			const error = await rejectionOf(
				checkLinks({ models: { Broken }, throwIfBroken: true }),
			);
			expect(error).to.be.an('error');
			expect(error.message).to.include('2 broken links');
			expect(error.message).to.include('yass_link_check_throw.one');
			expect(error.message).to.include('yass_link_check_throw.two');
			expect(error.problems).to.have.length(2);
		});

		it('a path link resolves as it would at first read (withRelativeModelLinks too)', async () => {
			const report = await checkLinks({ models: [CharPet, Visit, Vet] });
			expect(report.problems).to.deep.equal([]);
			expect(report.ok).to.equal(true);
			expect(path.basename(fieldLink(Visit, 'vet'))).to.equal('char-vet.js');
		});
	});
});
