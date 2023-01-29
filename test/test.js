/* eslint-disable global-require */
/* global it, describe */
const { expect } = require('chai');
const uuid = require('uuid').v4;
const YassORM = require('../lib');

const { debugSql } = YassORM.DatabaseObject;

/*
	NOTE:

	For tests to run successfully, you will need to do the following steps:

	* Copy `sample.yass-orm.js` to `.yass-orm.js`
	* Modify .yass-orm.js to suit the user/pass for your local DB
	* Ensure database 'test' exists
	* Create two test tables:
		* create table yass_test1 (id int primary key auto_increment, name varchar(255), isDeleted int default 0, nonce varchar(255));
		* create table yass_test2 (id varchar(255), name varchar(255), isDeleted int default 0, nonce varchar(255));

*/

describe('#YASS-ORM', () => {
	const fakeSchema = require('./fakeSchema').default;

	const fakeSchemaUuid = require('./fakeSchemaUuid').default;

	const fakeSchemaDb2 = require('./fakeSchemaDb2').default;

	it('should convert schema', () => {
		const schema = YassORM.convertDefinition(fakeSchema);
		expect(schema.fieldMap.id.type).to.equal('idKey');
		expect(schema.fieldMap.name.type).to.equal('varchar');
	});

	let NewClass;
	it('should load definition from function', () => {
		NewClass = YassORM.loadDefinition(fakeSchema);
		expect(typeof NewClass.schema).to.equal('function');

		const schema = NewClass.schema();
		expect(schema.fieldMap.id.type).to.equal('idKey');
		expect(schema.fieldMap.id.field).to.equal('id');
		expect(schema.fieldMap.name.type).to.equal('varchar');
	});

	let UuuidClass;
	it('should load definition from function for uuid schema', () => {
		UuuidClass = YassORM.loadDefinition(fakeSchemaUuid);
		expect(typeof UuuidClass.schema).to.equal('function');

		const schema = UuuidClass.schema();
		expect(schema.fieldMap.id.type).to.equal('uuidKey');
		expect(schema.fieldMap.name.type).to.equal('varchar');
	});

	let Db2Class;
	it('should load definition from function for secondary database schema', () => {
		expect(NewClass.schema().fieldMap.id.field).to.equal('id');

		Db2Class = YassORM.loadDefinition(fakeSchemaDb2);

		// We had bugs where loading fakeSchemaDb2 poluted the field name of another class,
		// so this checks for regressions
		expect(NewClass.schema().fieldMap.id.field).to.equal('id');

		expect(typeof Db2Class.schema).to.equal('function');

		const schema = Db2Class.schema();
		expect(schema.fieldMap.id.type).to.equal('uuidKey');
		expect(schema.fieldMap.id.field).to.equal('id');
		expect(schema.fieldMap.name.type).to.equal('varchar');
		expect(schema.table).to.equal('yass_test2.yass_test3');
	});

	let sample;
	it('should create new object', async () => {
		sample = await NewClass.create({ name: 'foobar' });
		// console.log(`created`, sample, NewClass);
		expect(sample.id).to.not.equal(null);
		expect(sample.id).to.not.equal(undefined);
		expect(sample.id).to.be.a('number');
		expect(sample.name).to.equal('foobar');
	});

	let sampleFoc;
	it('should find or create an object - create first', async () => {
		sampleFoc = await NewClass.findOrCreate({ name: 'foc1' });
		expect(sampleFoc.id).to.not.equal(null);
		expect(sampleFoc.id).to.not.equal(undefined);
		expect(sampleFoc.id).to.be.a('number');
		expect(sampleFoc.name).to.equal('foc1');
	});

	it('should find same object as before in findOrCreate', async () => {
		const foc2 = await NewClass.findOrCreate({ name: 'foc1' });
		expect(foc2.id).to.not.equal(null);
		expect(foc2.id).to.not.equal(undefined);
		expect(foc2.id).to.be.a('number');
		expect(foc2.id).to.equal(sampleFoc.id);
	});

	it('should patch objects', async () => {
		await sample.patch({
			name: 'framitz',
		});
		// Read straight from DB
		const raw = (
			await (
				await NewClass.dbh()
			).pquery(`select name from yass_test1 where id=:id`, sample)
		)[0];
		expect(raw.name).to.equal('framitz');
	});

	it('should patch objects if giving nonce but no nonce on schema', async () => {
		let error;
		await sample
			.patch({
				name: 'framitz2',
				nonce: Date.now(),
			})
			.catch((err) => {
				error = err;
			});
		expect(error).to.equal(undefined);
	});

	it('should soft-delete objects', async () => {
		await sampleFoc.remove();
		expect(sampleFoc.isDeleted).to.equal(true);
	});

	it('should allow hard delete', async () => {
		await (
			await sampleFoc.dbh()
		).pquery(`delete from yass_test1 where id=:id or id=:sampleId`, {
			id: sampleFoc,
			sampleId: sample.id,
		});
		const retest = await NewClass.get(sampleFoc.id);
		expect(retest).to.equal(null);
	});

	it('should create new object with a uuid key', async () => {
		const id = uuid();
		sample = await UuuidClass.create({ id, name: 'foobar' });
		expect(sample.id).to.not.equal(null);
		expect(sample.id).to.not.equal(undefined);
		expect(sample.id).to.be.a('string');
		expect(sample.id).to.equal(id);
		expect(sample.name).to.equal('foobar');
	});

	it('should patch objects with uuid keys', async () => {
		await sample.patch({
			name: 'framitz',
		});
		// Read straight from DB
		const raw = (
			await (
				await UuuidClass.dbh()
			).pquery(`select name from yass_test2 where id=:id`, sample)
		)[0];
		expect(raw.name).to.equal('framitz');
	});

	it('should soft-delete objects with uuid keys', async () => {
		await sample.remove();
		expect(sample.isDeleted).to.equal(true);
	});

	it('should reject editing if nonce changed on disk using explicit changed nonce', async () => {
		let error;
		await sample
			.patch({
				name: 'framitz2',
				nonce: Date.now(),
			})
			.catch((err) => {
				error = err;
			});
		expect(error.code).to.equal('ERR_NONCE');
		// console.log(error);
	});

	it('should reject editing if nonce changed on disk using nonce in memory', async () => {
		await (
			await sampleFoc.dbh()
		).pquery(`update yass_test2 set nonce=NOW() where id=:id`, sample);
		let error;
		await sample
			.patch({
				name: 'framitz2',
			})
			.catch((err) => {
				error = err;
			});
		expect(error.code).to.equal('ERR_NONCE');
		// console.log(error);
	});

	it('should allow editing after fresh reload when nonce changed on disk', async () => {
		const sample2 = await UuuidClass.get(sample.id);
		let error;
		const result = await sample2
			.patch({
				name: 'framitz2',
			})
			.catch((err) => {
				error = err;
			});
		expect(error).to.equal(undefined);
		expect(result.name).to.equal('framitz2');
		// console.log(error);
	});

	it('should allow hard delete for objects with uuid keys', async () => {
		await (
			await sampleFoc.dbh()
		).pquery(`delete from yass_test2 where id=:id`, sample);
		const retest = await UuuidClass.get(sample.id);
		expect(retest).to.equal(null);
	});

	let createdId;
	it('should create new object in secondary database', async () => {
		const id = uuid();
		createdId = id;
		sample = await Db2Class.create({ id, name: 'foobar' });
		expect(sample.id).to.equal(id);
		expect(sample.name).to.equal('foobar');
		expect(sample.table()).to.equal('yass_test2.yass_test3');
	});

	it('should find object in secondary database with prefixed select from first class', async () => {
		const [data] = await UuuidClass.withDbh((dbh) =>
			dbh.pquery('select * from yass_test2.yass_test3 where id=:createdId', {
				createdId,
			}),
		);
		expect(data.id).to.equal(createdId);
	});

	it('should allow hard delete for objects in secondary database', async () => {
		await Db2Class.withDbh((dbh) =>
			dbh.pquery(`delete from yass_test2.yass_test3 where id=:id`, {
				id: createdId,
			}),
		);
		const retest = await Db2Class.get(createdId);
		expect(retest).to.equal(null);
	});

	it('should print debugging SQL with dates properly stringified', () => {
		const dateString = debugSql(':date', {
			date: new Date('2023-01-23 01:01:01.000Z'),
		});
		expect(dateString).to.equal('2023-01-23 01:01:01');
	});

	it('should print debugging SQL with nulls NOT stringified', () => {
		const string = debugSql(':nullValue', {
			nullValue: null,
		});
		expect(string).to.equal('null');
	});

	it('should print debugging SQL with numbers not quoted', () => {
		const string = debugSql(':number', {
			number: 1,
		});
		expect(string).to.equal('1');
	});

	it('should print debugging SQL with strings quoted with single quotes', () => {
		const string = debugSql(':string', {
			string: 'bob',
		});
		expect(string).to.equal("'bob'");
	});

	it('should print debugging SQL without guarding undefined', () => {
		const string = debugSql(':string', {
			string: undefined,
		});
		expect(string).to.equal('undefined');
	});
});
