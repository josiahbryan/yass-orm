/***********************************

	NOTE

	This file is used by 'schema-sync'
	to convert definition files to JSON.
	It doesn't actually update the database
	itself, instead, schema-sync takes care
	of the updates.


************************************/

const { convertDefinition } = require('../lib/def-to-schema');

// argv[0] = 'node', argv[1] = (this file), so argv[2] is the first arg to our script on the command line
const modelDefinition = require(process.argv[2]).default;

const schema = convertDefinition(modelDefinition);

// This JSON will be read by the schema-sync from STDOUT and used to sync mysql with the modelDefinition
console.log(JSON.stringify(schema));
