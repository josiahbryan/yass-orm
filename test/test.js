'use strict';

const expect = require('chai').expect;
const YassORM = require('../lib');
const uuid = require('uuid').v4;

// Util to catch async errors
async function wait(done, f) {
	try {
		await f();
		done();
	} catch(e) {
		done(e);
	}
}

describe('#YASS-ORM', function() {
	const fakeSchema = ({ types: t }) => {
		return { 
			table: 'yass_test1',
			schema: {
				name: t.string,
			}
		}
	};

	const fakeSchemaUuid = ({ types: t }) => {
		return { 
			table: 'yass_test2',
			schema: {
				id: t.uuidKey,
				name: t.string,
			}
		}
	};
	
	it('should load properly',  () => {});
	
	it('should convert schema', () => {
		const schema = YassORM.convertDefinition(fakeSchema);
		expect(schema.fieldMap.id.type).to.equal("idKey");
		expect(schema.fieldMap.name.type).to.equal("varchar");
	});

	let NewClass;
	it('should load definition from function', () => {
		NewClass = YassORM.loadDefinition(fakeSchema);
		expect(typeof(NewClass.schema)).to.equal('function');

		const schema = NewClass.schema();
		expect(schema.fieldMap.id.type).to.equal("idKey");
		expect(schema.fieldMap.name.type).to.equal("varchar");
	});

	let UuuidClass;
	it('should load definition from function for uuid schema', () => {
		UuuidClass = YassORM.loadDefinition(fakeSchemaUuid);
		expect(typeof(UuuidClass.schema)).to.equal('function');

		const schema = NewClass.schema();
		expect(schema.fieldMap.id.type).to.equal("idKey");
		expect(schema.fieldMap.name.type).to.equal("varchar");
	});

	let sample;
	it('should create new object', async () => {
		sample = await NewClass.create({ name: "foobar" });
		expect(sample.id).to.not.equal(null);
		expect(sample.id).to.not.equal(undefined);
		expect(sample.id).to.be.a('number');
		expect(sample.name).to.equal('foobar');
	})

	let sampleFoc;
	it('should find or create an object - create first', async () => {
		sampleFoc = await NewClass.findOrCreate({ name: "foc1" });
		expect(sampleFoc.id).to.not.equal(null);
		expect(sampleFoc.id).to.not.equal(undefined);
		expect(sampleFoc.id).to.be.a('number');
		expect(sampleFoc.name).to.equal('foc1');
	})

	it('should find same object as before in findOrCreate', async () => {
		const foc2 = await NewClass.findOrCreate({ name: "foc1" });
		expect(foc2.id).to.not.equal(null);
		expect(foc2.id).to.not.equal(undefined);
		expect(foc2.id).to.be.a('number');
		expect(foc2.id).to.equal(sampleFoc.id);
	});

	it('should patch objects', async () => {
		await sample.patch({
			name: "framitz"
		})
		// Read straight from DB
		const raw = (await (await NewClass.dbh()).pquery(`select name from yass_test1 where id=:id`, sample))[0];
		expect(raw.name).to.equal('framitz');
	})

	it('should soft-delete objects', async () => {
		await sampleFoc.remove();
		expect(sampleFoc.isDeleted).to.equal(true);
	})

	it('should allow hard delete', async () => {
		await (await sampleFoc.dbh()).pquery(`delete from yass_test1 where id=:id or id=:sampleId`, { id: sampleFoc, sampleId: sample.id });
		const retest = await NewClass.get(sampleFoc.id);
		expect(retest).to.equal(null);
	})


	it('should create new object with a uuid key', async () => {
		const id =  uuid();
		sample = await UuuidClass.create({ id, name: "foobar" });
		expect(sample.id).to.not.equal(null);
		expect(sample.id).to.not.equal(undefined);
		expect(sample.id).to.be.a('string');
		expect(sample.id).to.equal(id);
		expect(sample.name).to.equal('foobar');
	})

	it('should patch objects with uuid keys', async () => {
		await sample.patch({
			name: "framitz"
		})
		// Read straight from DB
		const raw = (await (await UuuidClass.dbh()).pquery(`select name from yass_test2 where id=:id`, sample))[0];
		expect(raw.name).to.equal('framitz');
	})

	it('should soft-delete objects with uuid keys', async () => {
		await sample.remove();
		expect(sample.isDeleted).to.equal(true);
	})

	it('should allow hard delete for objects with uuid keys', async () => {
		await (await sampleFoc.dbh()).pquery(`delete from yass_test2 where id=:id`, sample);
		const retest = await UuuidClass.get(sample.id);
		expect(retest).to.equal(null);
	})
});