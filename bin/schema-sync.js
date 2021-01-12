#!/usr/bin/env node

// NOTE: The file `schema-sync` in this directory is a symlink to this file (schema-sync.js)
// so we don't break existing consumers of YASS that run schema-sync without the .js extension

/* eslint-disable no-console */
const syncUtil = require('../lib/sync-to-db');

async function main() {
	const sourceFiles = Array.from(process.argv).slice(2);

	// Add our match_ratio() function for use in finder.js
	syncUtil.uploadMatchRatioFunction();

	// Convert each definition to a schema using 'convert-definition-to-schema.js' in the current directory
	await syncUtil.promiseMap(sourceFiles, async (definitionFile) => {
		// -common-fields is used internally by convert-definition, so exlude it if someone
		// just did a glob pattern, like definitions/*.js */
		// Update to skip any files that start with a dash (-)
		if (definitionFile.match(/\/-[^/]+\.js/)) {
			return;
		}

		console.log(`[${process.pid}] Processing: ${definitionFile} ...`);

		// Convert the definition file to a JSON object containing a field list in the format that
		// is compatible with mysqlSchemaUpdate()
		const schema = syncUtil.convertFile(definitionFile);

		const { legacyExternalSchema } = schema;
		if (legacyExternalSchema) {
			console.warn(
				`[${process.pid}] NOT syncing ${definitionFile} to database, 'legacyExternalSchema' set to true`,
			);
			return;
		}

		await syncUtil.syncSchemaToDb(schema);
	});
}

main()
	.catch((ex) => console.error(ex))
	.then(() => process.exit());
