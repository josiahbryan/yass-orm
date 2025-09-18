#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Simple test runner for event loop specific tests
 * Usage: node test/run-eventloop-tests.js
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('Running Event Loop Tests for promisePoolMap...\n');

const testFiles = [
	'test/promisePoolMap.eventloop.test.js',
	'test/promisePoolMap.integration.test.js',
];

const mochaPath = path.join(__dirname, '..', 'node_modules', '.bin', 'mocha');
const args = [
	'--exit',
	'--reporter',
	'spec',
	'--timeout',
	'15000',
	...testFiles,
];

const mocha = spawn(mochaPath, args, {
	stdio: 'inherit',
	cwd: path.join(__dirname, '..'),
});

mocha.on('close', (code) => {
	console.log(`\nEvent loop tests completed with exit code ${code}`);
	process.exit(code);
});

mocha.on('error', (err) => {
	console.error('Failed to start test runner:', err);
	process.exit(1);
});
