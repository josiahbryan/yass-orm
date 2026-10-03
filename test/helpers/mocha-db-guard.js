// mocha preload (.mocharc.js): refuse to run against a non-test database
require('./live-db-guard').guard();
