/* eslint-disable no-console */
/* global describe, it, before */
const { expect } = require('chai');
const { spawn } = require('child_process');
const path = require('path');
const config = require('../lib/config');

const BIN = path.resolve(__dirname, '..', 'bin', 'schema-sync');

function runBin(args, { timeoutMs = 30000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [BIN, ...args], {
			cwd: path.resolve(__dirname, '..'),
			env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk.toString();
		});
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`schema-sync bin timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

describe('#schemaSync bin exit code', () => {
	before(function beforeBinExitCodeSuite() {
		if ((config.dialect || 'mysql') !== 'mysql') {
			this.skip();
		}
	});

	it('exits 0 when all definition files sync cleanly', async () => {
		const fakeSchemas = [
			path.resolve(__dirname, 'fakeSchema.js'),
			path.resolve(__dirname, 'fakeSchemaDb2.js'),
			path.resolve(__dirname, 'fakeSchemaUuid.js'),
		];
		const { code, stderr } = await runBin(fakeSchemas);
		expect(code, `stderr was:\n${stderr}`).to.equal(0);
	});

	it('exits non-zero when a definition file is missing', async () => {
		const bogus = path.resolve(
			__dirname,
			'doesNotExist_schemaSyncBin.js',
		);
		const { code, stderr } = await runBin([bogus]);
		expect(code).to.not.equal(0);
		expect(stderr).to.match(/schema-sync error|Unexpected error/);
	});
});
