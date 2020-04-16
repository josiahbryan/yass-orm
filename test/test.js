'use strict';

const expect = require('chai').expect;
const YassORM = require('../lib');

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
			schema: {
				name: t.string,
			}
		}
	};
	
	it('should load properly',  () => {});
	
	it('should convert schema', () => {
		const schema = YassORM.convertDefinition(fakeSchema);
		expect(schema.fieldMap.id.type).to.equal("primaryKey");
		expect(schema.fieldMap.name.type).to.equal("varchar");
	});

	it('should load definition from function', () => {
		const NewClass = YassORM.loadDefinition(fakeSchema);
		expect(typeof(NewClass.schema)).to.equal('function');

		const schema = NewClass.schema();
		expect(schema.fieldMap.id.type).to.equal("primaryKey");
		expect(schema.fieldMap.name.type).to.equal("varchar");
	});
});