/* eslint-disable no-unused-expressions */
/* global describe, it, before, beforeEach */
const path = require('path');
const { expect } = require('chai');
const YassORM = require('../lib');
const config = require('../lib/config');
const { dbh } = require('../lib/dbh');
const {
	recreateTables,
	quoteTable,
	rejectionOf,
} = require('./helpers/characterize');
const { captureConsoleError } = require('./helpers/captureConsoleError');

const Person = require('./fixtures/characterize/char-person');
const Pet = require('./fixtures/characterize/char-pet');
const Vet = require('./fixtures/characterize/sub/char-vet');
const Visit = require('./fixtures/characterize/char-visit');

const fixtureDir = path.join(__dirname, 'fixtures', 'characterize');

/**
 * Characterization (step 3 of the modernization plan): how links behave
 * today, so the resolver can be rewritten (step 4) without changing them.
 * Live database: MySQL in `npm test`, Postgres in `npm run test:postgres`.
 */
describe('#characterize links (t.linked)', function linksSuite() {
	this.timeout(30000);

	const allModels = [Person, Pet, Vet, Visit];

	describe('in the definition', () => {
		it('t.linked(name) records the name as given, on an int column', () => {
			const { owner, vet } = Pet.schema().fieldMap;
			expect(owner.linkedModel).to.equal('char-person');
			expect(vet.linkedModel).to.equal('./sub/char-vet');
			// Test config sets neither uuidLinkedIds nor stringLinkedIds.
			expect(config.uuidLinkedIds).to.not.be.ok;
			expect(owner.type).to.equal('int');
		});

		it('ignores options other than `array`, such as { inverse: null }', () => {
			const schema = YassORM.convertDefinition(({ types: t }) => ({
				table: 'yass_char_inverse',
				schema: {
					plain: t.linked('user'),
					inverse: t.linked('user', { inverse: null }),
					named: t.linked('user', { inverse: 'pets' }),
				},
			}));
			const { plain, inverse, named } = schema.fieldMap;
			const strip = ({ field, ...rest }) => rest;
			expect(strip(inverse)).to.deep.equal(strip(plain));
			expect(strip(named)).to.deep.equal(strip(plain));
			expect(plain).to.not.have.property('inverse');
		});

		it('t.parent(name) is t.linked(name)', () => {
			const schema = YassORM.convertDefinition(({ types: t }) => ({
				table: 'yass_char_parent',
				schema: { up: t.parent('char-person'), link: t.linked('char-person') },
			}));
			const { up, link } = schema.fieldMap;
			expect(up.linkedModel).to.equal('char-person');
			expect(up.type).to.equal(link.type);
		});

		it('withRelativeModelLinks (Rubber) hands t.linked absolute paths', () => {
			const { pet, vet, owner } = Visit.schema().fieldMap;
			// Found in a search folder: the path of the file, extension included.
			expect(vet.linkedModel).to.equal(
				path.join(fixtureDir, 'sub', 'char-vet.js'),
			);
			// Not in a search folder: the default folder, no extension.
			expect(pet.linkedModel).to.equal(path.join(fixtureDir, 'char-pet'));
			expect(owner.linkedModel).to.equal(path.join(fixtureDir, 'char-person'));
		});

		it('basePath() is the folder of the file that called loadDefinition()', () => {
			expect(Person.basePath()).to.equal(fixtureDir);
			expect(Vet.basePath()).to.equal(path.join(fixtureDir, 'sub'));
			expect(Visit.basePath()).to.equal(fixtureDir);
		});
	});

	describe('resolving the linked model class', () => {
		it('resolves a name, a relative path and an absolute path to the same class', async () => {
			expect(await Pet._resolveModelClass('char-person')).to.equal(Person);
			expect(await Vet._resolveModelClass('../char-person')).to.equal(Person);
			expect(
				await Visit._resolveModelClass(path.join(fixtureDir, 'char-person')),
			).to.equal(Person);
			expect(await Pet._resolveModelClass('./sub/char-vet')).to.equal(Vet);
		});

		it('a link to a missing file fails at first read, not at load', async () => {
			const Broken = YassORM.loadDefinition(({ types: t }) => ({
				table: 'yass_char_broken',
				schema: { id: t.idKey, gone: t.linked('no-such-model') },
			}));

			// A null link never resolves the class.
			const values = await Broken.inflateValues({ id: 1, gone: null });
			expect(values.gone).to.equal(null);

			let error;
			// promisePoolMap logs the item's error before rethrowing it.
			await captureConsoleError.during(async () => {
				error = await rejectionOf(Broken.inflateValues({ id: 1, gone: 5 }));
			});
			expect(error).to.be.an('error');
			expect(error.message).to.include(
				"Cannot resolve linked model 'no-such-model'",
			);
			expect(error.message).to.include("on table 'yass_char_broken'");
		});
	});

	describe('loading linked rows', () => {
		let conn;
		before(async () => {
			await recreateTables(allModels.map((Model) => Model.definition));
			conn = await dbh();
		});

		beforeEach(async () => {
			await Promise.all(
				allModels.map((Model) =>
					conn.pquery(`DELETE FROM ${quoteTable(Model.table())}`),
				),
			);
			allModels.forEach((Model) => Model.clearCache());
		});

		const seed = async () => {
			const alice = await Person.create({ name: 'Alice' });
			// An instance deflates to its id.
			const bob = await Person.create({ name: 'Bob', bestFriend: alice });
			const vet = await Vet.create({ name: 'Dr V', clinicOwner: bob.id });
			const pet = await Pet.create({ name: 'Rex', owner: bob.id, vet: vet.id });
			return { alice, bob, vet, pet };
		};

		it('create() inflates links to the instances already cached', async () => {
			const { alice, bob, vet, pet } = await seed();
			expect(bob.bestFriend).to.equal(alice);
			expect(pet.owner).to.equal(bob);
			expect(pet.vet).to.equal(vet);
			expect(vet.clinicOwner).to.equal(bob);
		});

		it('get() loads links recursively, one instance per row', async () => {
			const { pet } = await seed();
			allModels.forEach((Model) => Model.clearCache());

			const loaded = await Pet.get(pet.id);
			expect(loaded).to.not.equal(pet);
			expect(loaded.owner).to.be.an.instanceOf(Person);
			expect(loaded.owner.name).to.equal('Bob');
			expect(loaded.owner.bestFriend.name).to.equal('Alice');
			expect(loaded.vet).to.be.an.instanceOf(Vet);
			// Bob reached through two paths is one object.
			expect(loaded.vet.clinicOwner).to.equal(loaded.owner);
		});

		it('a link resolves from the shared cache (allowCached), without re-reading', async () => {
			const { bob, pet } = await seed();
			// Change Bob on disk behind the cache's back.
			await conn.pquery(
				`UPDATE ${quoteTable(
					Person.table(),
				)} SET name = 'Robert' WHERE id = :id`,
				{ id: bob.id },
			);

			const loaded = await Pet.get(pet.id);
			expect(loaded.owner).to.equal(bob);
			expect(loaded.owner.name).to.equal('Bob');

			// get() without allowCached reads, and freshens the cached instance.
			const fresh = await Person.get(bob.id);
			expect(fresh).to.equal(bob);
			expect(bob.name).to.equal('Robert');
		});

		it('a row that is its own friend links to itself', async () => {
			const { alice } = await seed();
			await alice.patch({ bestFriend: alice.id });
			expect(alice.bestFriend).to.equal(alice);

			Person.clearCache();
			const again = await Person.get(alice.id);
			expect(again.bestFriend).to.equal(again);
		});

		it('a link to a missing row inflates to null; a null link stays null', async () => {
			const ghost = await Pet.create({ name: 'Ghost', owner: 999999 });
			expect(ghost.owner).to.equal(null);
			expect(ghost.vet).to.equal(null);

			const [row] = await conn.pquery(
				`SELECT owner, vet FROM ${quoteTable(Pet.table())} WHERE id = :id`,
				{ id: ghost.id },
			);
			// The id is kept on disk; only the instance says null.
			expect(Number(row.owner)).to.equal(999999);
			expect(row.vet).to.equal(null);
		});

		it('search(), searchOne() and fromSql() inflate links too', async () => {
			const { bob, pet } = await seed();

			const [bySearch] = await Pet.search({ name: 'Rex' });
			expect(bySearch).to.equal(pet);
			expect(bySearch.owner).to.equal(bob);

			const byOne = await Pet.searchOne({ owner: bob });
			expect(byOne).to.equal(pet);

			const [bySql] = await Pet.fromSql('name = :name', { name: 'Rex' });
			expect(bySql).to.equal(pet);
			expect(bySql.vet.clinicOwner).to.equal(bob);
		});

		it('links written through withRelativeModelLinks load like any other', async () => {
			const { bob, vet, pet } = await seed();
			const visit = await Visit.create({
				pet: pet.id,
				vet: vet.id,
				owner: bob,
			});
			expect(visit.pet).to.equal(pet);
			expect(visit.vet).to.equal(vet);
			expect(visit.owner).to.equal(bob);

			allModels.forEach((Model) => Model.clearCache());
			const loaded = await Visit.get(visit.id);
			expect(loaded.pet.owner).to.equal(loaded.owner);
			expect(loaded.vet.clinicOwner).to.equal(loaded.owner);
		});

		describe('jsonify()', () => {
			it('by default: id and name only, no links', async () => {
				const { pet } = await seed();
				expect(await pet.jsonify()).to.deep.equal({
					id: pet.id,
					name: 'Rex',
				});
			});

			it('without a name field: id only', async () => {
				const { bob, vet, pet } = await seed();
				const visit = await Visit.create({ pet, vet, owner: bob });
				expect(await visit.jsonify()).to.deep.equal({ id: visit.id });
			});

			it('includeLinked: each link as its own default jsonify()', async () => {
				const { bob, vet, pet } = await seed();
				expect(await pet.jsonify({ includeLinked: true })).to.deep.equal({
					id: pet.id,
					name: 'Rex',
					owner: { id: bob.id, name: 'Bob' },
					vet: { id: vet.id, name: 'Dr V' },
				});
			});

			it('includeLinked leaves out a null link', async () => {
				const orphan = await Pet.create({ name: 'Stray' });
				expect(await orphan.jsonify({ includeLinked: true })).to.deep.equal({
					id: orphan.id,
					name: 'Stray',
				});
			});

			it('excludeLinked: every set non-link field; isDeleted only when true', async () => {
				const { pet } = await seed();
				expect(await pet.jsonify({ excludeLinked: true })).to.deep.equal({
					id: pet.id,
					name: 'Rex',
				});

				await pet.remove();
				expect(await pet.jsonify({ excludeLinked: true })).to.deep.equal({
					id: pet.id,
					name: 'Rex',
					isDeleted: true,
				});
			});

			it('both flags: non-link fields and the links', async () => {
				const { bob, vet, pet } = await seed();
				expect(
					await pet.jsonify({ includeLinked: true, excludeLinked: true }),
				).to.deep.equal({
					id: pet.id,
					name: 'Rex',
					owner: { id: bob.id, name: 'Bob' },
					vet: { id: vet.id, name: 'Dr V' },
				});
			});

			it('a link whose value has no jsonify() is included as it is', async () => {
				const { pet } = await seed();
				pet.owner = { id: 42, custom: true };
				expect(
					(await pet.jsonify({ includeLinked: true })).owner,
				).to.deep.equal({ id: 42, custom: true });
			});

			// Was a known bug (found in step 3, fixed in step 4): the cycle guard
			// handed a nested call the outer call's own pending promise, so a row
			// whose link reached back to itself waited on itself forever.
			it('known bug: includeLinked on a row that links to itself never resolves', async () => {
				const { alice } = await seed();
				await alice.patch({ bestFriend: alice.id });

				const json = await Promise.race([
					alice.jsonify({ includeLinked: true }),
					new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
				]);
				expect(json).to.not.equal('hung');
				expect(json.bestFriend).to.include({ id: alice.id, name: 'Alice' });
			});

			// Was a known bug (found in step 3, fixed in step 4): while an
			// includeLinked call was pending, any other jsonify() on the same
			// instance returned that call's result (the same object), whatever
			// options it asked for.
			it("known bug: a jsonify() during another gets that call's result, not its own", async () => {
				const { bob, pet } = await seed();
				const [linked, plain] = await Promise.all([
					pet.jsonify({ includeLinked: true }),
					pet.jsonify({ excludeLinked: true }),
				]);
				expect(linked.owner).to.deep.equal({ id: bob.id, name: 'Bob' });
				expect(plain).to.deep.equal({ id: pet.id, name: 'Rex' });
			});
		});
	});
});
