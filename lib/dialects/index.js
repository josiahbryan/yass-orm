/**
 * Dialect Registry
 *
 * Central registry for database dialect implementations.
 * Provides factory function to get dialect by name.
 */

const { BaseDialect } = require('./BaseDialect.js');
const { MySQLDialect } = require('./MySQLDialect.js');
const { SQLiteDialect } = require('./SQLiteDialect.js');

/**
 * Registry of available dialects
 * Keys are dialect names, values are dialect classes
 */
const dialectRegistry = {
	mysql: MySQLDialect,
	mariadb: MySQLDialect, // MariaDB uses same dialect as MySQL
	sqlite: SQLiteDialect,
	sqlite3: SQLiteDialect, // Alias for sqlite
};

/**
 * Get a dialect instance by name
 * @param {string} dialectName - Name of the dialect (mysql, sqlite, etc.)
 * @returns {BaseDialect} - Dialect instance
 * @throws {Error} - If dialect is not found
 */
function getDialect(dialectName) {
	const name = (dialectName || 'mysql').toLowerCase();
	const DialectClass = dialectRegistry[name];

	if (!DialectClass) {
		const available = Object.keys(dialectRegistry).join(', ');
		throw new Error(
			`Unknown database dialect: "${dialectName}". Available dialects: ${available}`,
		);
	}

	return new DialectClass();
}

/**
 * Register a custom dialect
 * @param {string} name - Name for the dialect
 * @param {typeof BaseDialect} DialectClass - Dialect class extending BaseDialect
 */
function registerDialect(name, DialectClass) {
	if (!(DialectClass.prototype instanceof BaseDialect)) {
		throw new Error('Dialect class must extend BaseDialect');
	}
	dialectRegistry[name.toLowerCase()] = DialectClass;
}

/**
 * Get list of available dialect names
 * @returns {string[]} - Array of dialect names
 */
function getAvailableDialects() {
	return Object.keys(dialectRegistry);
}

/**
 * Check if a dialect is available
 * @param {string} dialectName - Name of the dialect
 * @returns {boolean} - True if dialect is registered
 */
function hasDialect(dialectName) {
	return dialectName && dialectName.toLowerCase() in dialectRegistry;
}

module.exports = {
	// Classes
	BaseDialect,
	MySQLDialect,
	SQLiteDialect,

	// Factory & Registry
	getDialect,
	registerDialect,
	getAvailableDialects,
	hasDialect,
	dialectRegistry,
};
