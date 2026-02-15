# yass-orm SQLite Polymorphic Support - Implementation Plan

## Overview

This plan outlines how to make yass-orm work with both MySQL/MariaDB and SQLite while maintaining backward compatibility with existing MySQL codebases.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      yass-orm (existing API)                 │
│  .search() .create() .patch() .fromSql() .pquery() etc.     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Dialect Abstraction Layer                 │
│  - Query transformation                                      │
│  - Placeholder conversion                                    │
│  - Identifier quoting                                        │
│  - Type mapping                                              │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│     MySQL Dialect        │    │     SQLite Dialect       │
│  - mariadb driver        │    │  - better-sqlite3        │
│  - Named placeholders    │    │  - Positional placeholders│
│  - Backtick quoting      │    │  - Double-quote quoting  │
│  - Full schema sync      │    │  - Limited schema sync   │
└──────────────────────────────┘    └──────────────────────────┘
```

## Phase 1: Dialect Abstraction Layer

### 1.1 Create Base Dialect Class

**File: `lib/dialects/BaseDialect.js`**

```javascript
class BaseDialect {
  // Identifier quoting
  quoteIdentifier(name) { throw new Error('Not implemented'); }

  // Placeholder format for parameterized queries
  formatPlaceholder(name, index) { throw new Error('Not implemented'); }

  // Convert named params object to driver-expected format
  prepareParams(namedParams) { throw new Error('Not implemented'); }

  // Transform SQL for dialect-specific syntax
  transformSql(sql, params) { throw new Error('Not implemented'); }

  // Type mappings for schema sync
  mapType(yassType) { throw new Error('Not implemented'); }

  // Schema introspection
  async getTableColumns(handle, tableName) { throw new Error('Not implemented'); }
  async getTableIndexes(handle, tableName) { throw new Error('Not implemented'); }
  async tableExists(handle, tableName) { throw new Error('Not implemented'); }

  // DDL generation
  generateCreateTable(tableName, fields, options) { throw new Error('Not implemented'); }
  generateAlterTable(tableName, changes) { throw new Error('Not implemented'); }
  generateCreateIndex(tableName, indexName, columns, options) { throw new Error('Not implemented'); }

  // Connection factory
  async createConnection(config) { throw new Error('Not implemented'); }
  async createPool(config) { throw new Error('Not implemented'); }

  // Feature flags
  get supportsFullTextSearch() { return false; }
  get supportsJsonOperators() { return false; }
  get supportsStoredFunctions() { return false; }
  get supportsAlterColumn() { return false; }
  get supportsNamedPlaceholders() { return false; }
}
```

### 1.2 MySQL Dialect (Extract Existing Behavior)

**File: `lib/dialects/MySQLDialect.js`**

```javascript
const mariadb = require('mariadb');

class MySQLDialect extends BaseDialect {
  quoteIdentifier(name) {
    return `\`${name.replace(/`/g, '``')}\``;
  }

  formatPlaceholder(name, index) {
    return `:${name}`;
  }

  prepareParams(namedParams) {
    // MariaDB driver accepts named params directly
    return namedParams;
  }

  transformSql(sql, params) {
    // MySQL uses :name syntax natively with mariadb driver
    return sql;
  }

  mapType(yassType) {
    const typeMap = {
      'idKey': 'int(11) PRIMARY KEY AUTO_INCREMENT',
      'uuidKey': 'char(36) COLLATE utf8mb4_bin PRIMARY KEY',
      'string': 'varchar(255)',
      'text': 'longtext',
      'int': 'int(11)',
      'integer': 'int(11)',
      'bool': 'int(1)',
      'boolean': 'int(1)',
      'real': 'double',
      'double': 'double',
      'date': 'date',
      'datetime': 'datetime',
      'time': 'time',
      'json': 'longtext', // JSON stored as text
    };
    return typeMap[yassType] || yassType;
  }

  async getTableColumns(handle, tableName) {
    const rows = await handle.query(`SHOW FULL COLUMNS FROM ${this.quoteIdentifier(tableName)}`);
    return rows.map(row => ({
      name: row.Field,
      type: row.Type,
      nullable: row.Null === 'YES',
      defaultValue: row.Default,
      primaryKey: row.Key === 'PRI',
      autoIncrement: (row.Extra || '').includes('auto_increment'),
      collation: row.Collation,
    }));
  }

  async getTableIndexes(handle, tableName) {
    const rows = await handle.query(`SHOW INDEXES FROM ${this.quoteIdentifier(tableName)}`);
    // Group by Key_name
    const indexes = {};
    for (const row of rows) {
      const name = row.Key_name;
      if (!indexes[name]) {
        indexes[name] = {
          name,
          columns: [],
          unique: row.Non_unique === 0,
          type: row.Index_type,
        };
      }
      indexes[name].columns.push(row.Column_name || row.Expression);
    }
    return Object.values(indexes);
  }

  async tableExists(handle, db, tableName) {
    const rows = await handle.query(
      `SHOW TABLES IN ${this.quoteIdentifier(db)} WHERE \`Tables_in_${db}\`=?`,
      [tableName]
    );
    return rows.length > 0;
  }

  async createPool(config) {
    return mariadb.createPool({
      host: config.host,
      port: config.port || 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: config.connectionLimit || 10,
      charset: config.charset || 'utf8mb4',
      timezone: 'Etc/GMT+0',
      skipSetTimezone: true,
      allowPublicKeyRetrieval: true,
      idleTimeout: 600,
    });
  }

  get supportsFullTextSearch() { return true; }
  get supportsJsonOperators() { return true; }
  get supportsStoredFunctions() { return true; }
  get supportsAlterColumn() { return true; }
  get supportsNamedPlaceholders() { return true; }
}
```

### 1.3 SQLite Dialect

**File: `lib/dialects/SQLiteDialect.js`**

```javascript
const Database = require('better-sqlite3');

class SQLiteDialect extends BaseDialect {
  quoteIdentifier(name) {
    return `"${name.replace(/"/g, '""')}"`;
  }

  formatPlaceholder(name, index) {
    // SQLite supports $name, :name, @name, and ?
    // Using $ for consistency and avoiding : collision with JSON
    return `$${name}`;
  }

  prepareParams(namedParams) {
    // better-sqlite3 expects params prefixed with $
    const result = {};
    for (const [key, value] of Object.entries(namedParams || {})) {
      result[`$${key}`] = this.deflateValue(value);
    }
    return result;
  }

  deflateValue(value) {
    // SQLite-specific value transformation
    if (value === true) return 1;
    if (value === false) return 0;
    if (value instanceof Date) {
      return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      return JSON.stringify(value);
    }
    return value;
  }

  transformSql(sql, params) {
    // Convert :name to $name for SQLite
    let transformed = sql;

    // Sort keys by length descending to handle :userName before :user
    const keys = Object.keys(params || {}).sort((a, b) => b.length - a.length);

    for (const key of keys) {
      // Replace :key with $key (but not inside strings)
      transformed = transformed.replace(
        new RegExp(`:${key}(?![a-zA-Z0-9_])`, 'g'),
        `$${key}`
      );
    }

    // Convert MySQL JSON operator ->> to json_extract
    // `col->>"$.path"` becomes `json_extract(col, '$.path')`
    transformed = transformed.replace(
      /(\w+)->>["'](\$\.[^"']+)["']/g,
      "json_extract($1, '$2')"
    );

    // Convert backticks to double quotes
    transformed = transformed.replace(/`([^`]+)`/g, '"$1"');

    // Convert IFNULL (works in both, but ensure compatibility)
    // Both MySQL and SQLite support IFNULL, so no change needed

    // Convert CONCAT() to || operator
    transformed = transformed.replace(
      /CONCAT\s*\(([^)]+)\)/gi,
      (match, args) => {
        const parts = args.split(',').map(p => p.trim());
        return `(${parts.join(' || ')})`;
      }
    );

    return transformed;
  }

  mapType(yassType) {
    // SQLite has dynamic typing, but we map for documentation
    const typeMap = {
      'idKey': 'INTEGER PRIMARY KEY AUTOINCREMENT',
      'uuidKey': 'TEXT PRIMARY KEY',
      'string': 'TEXT',
      'text': 'TEXT',
      'int': 'INTEGER',
      'integer': 'INTEGER',
      'bool': 'INTEGER',
      'boolean': 'INTEGER',
      'real': 'REAL',
      'double': 'REAL',
      'date': 'TEXT',      // Store as ISO string
      'datetime': 'TEXT',  // Store as ISO string
      'time': 'TEXT',      // Store as ISO string
      'json': 'TEXT',      // JSON stored as text
    };
    return typeMap[yassType] || 'TEXT';
  }

  async getTableColumns(handle, tableName) {
    const rows = handle.prepare(`PRAGMA table_info("${tableName}")`).all();
    return rows.map(row => ({
      name: row.name,
      type: row.type,
      nullable: row.notnull === 0,
      defaultValue: row.dflt_value,
      primaryKey: row.pk === 1,
      autoIncrement: row.pk === 1 && row.type.toUpperCase() === 'INTEGER',
    }));
  }

  async getTableIndexes(handle, tableName) {
    const indexList = handle.prepare(`PRAGMA index_list("${tableName}")`).all();
    const indexes = [];

    for (const idx of indexList) {
      const columns = handle.prepare(`PRAGMA index_info("${idx.name}")`).all();
      indexes.push({
        name: idx.name,
        columns: columns.map(c => c.name),
        unique: idx.unique === 1,
        type: 'BTREE', // SQLite default
      });
    }

    return indexes;
  }

  async tableExists(handle, db, tableName) {
    const row = handle.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(tableName);
    return !!row;
  }

  createConnection(config) {
    const db = new Database(config.filename || ':memory:', {
      verbose: config.verbose ? console.log : undefined,
    });

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // Wrap in async-compatible interface
    return this.wrapConnection(db);
  }

  wrapConnection(db) {
    // Create a wrapper that matches the mariadb interface
    return {
      _db: db,

      query(sql, params) {
        // Handle both positional and named params
        const stmt = db.prepare(sql);

        if (sql.trim().toUpperCase().startsWith('SELECT') ||
            sql.trim().toUpperCase().startsWith('PRAGMA')) {
          return Promise.resolve(
            Array.isArray(params) ? stmt.all(...params) : stmt.all(params || {})
          );
        } else {
          const result = Array.isArray(params)
            ? stmt.run(...params)
            : stmt.run(params || {});
          return Promise.resolve({
            affectedRows: result.changes,
            insertId: result.lastInsertRowid,
          });
        }
      },

      pquery(sql, params, opts = {}) {
        const transformed = this.dialect.transformSql(sql, params);
        const prepared = this.dialect.prepareParams(params);
        return this.query(transformed, prepared);
      },

      escapeId(name) {
        return `"${name.replace(/"/g, '""')}"`;
      },

      escape(value) {
        if (value === null || value === undefined) return 'NULL';
        if (typeof value === 'number') return String(value);
        if (typeof value === 'boolean') return value ? '1' : '0';
        return `'${String(value).replace(/'/g, "''")}'`;
      },

      end() {
        db.close();
        return Promise.resolve();
      },
    };
  }

  // No pool for SQLite - single connection per file
  async createPool(config) {
    return this.createConnection(config);
  }

  // Feature flags
  get supportsFullTextSearch() { return false; } // FTS5 is different
  get supportsJsonOperators() { return true; }   // Via json_extract()
  get supportsStoredFunctions() { return false; }
  get supportsAlterColumn() { return false; }    // Need table recreation
  get supportsNamedPlaceholders() { return true; } // With $ prefix
}
```

## Phase 2: Refactor dbh.js for Dialect Support

### 2.1 Update Connection Factory

**File: `lib/dbh.js` (modified)**

```javascript
const { MySQLDialect } = require('./dialects/MySQLDialect');
const { SQLiteDialect } = require('./dialects/SQLiteDialect');

// Dialect registry
const dialects = {
  mysql: MySQLDialect,
  mariadb: MySQLDialect,
  sqlite: SQLiteDialect,
  sqlite3: SQLiteDialect,
};

function getDialect(config) {
  const dialectName = config.dialect || 'mysql';
  const DialectClass = dialects[dialectName];

  if (!DialectClass) {
    throw new Error(`Unknown dialect: ${dialectName}. Supported: ${Object.keys(dialects).join(', ')}`);
  }

  return new DialectClass();
}

async function dbh(options = {}) {
  const dialect = getDialect(config);

  // ... rest of connection logic using dialect methods
  const conn = await dialect.createPool({
    host: options.host || config.host,
    port: options.port || config.port,
    user: options.user || config.user,
    password: options.password || config.password,
    database: options.db || config.schema,
    filename: options.filename || config.filename, // SQLite
    connectionLimit: options.connectionLimit || config.connectionLimit,
  });

  // Attach dialect to connection for use in queries
  conn.dialect = dialect;

  // Modify pquery to use dialect transformation
  const originalPquery = conn.pquery;
  conn.pquery = async function(sql, params, opts = {}) {
    const transformedSql = dialect.transformSql(sql, params);
    const preparedParams = dialect.prepareParams(params);
    return originalPquery.call(this, transformedSql, preparedParams, opts);
  };

  // ... rest of helper methods
  return conn;
}
```

## Phase 3: Schema Sync Abstraction

### 3.1 Create Schema Sync Strategy Interface

**File: `lib/schema-sync/SchemaSyncStrategy.js`**

```javascript
class SchemaSyncStrategy {
  constructor(dialect) {
    this.dialect = dialect;
  }

  async syncTable(handle, tableName, fields, options) {
    throw new Error('Not implemented');
  }

  async createTable(handle, tableName, fields, options) {
    throw new Error('Not implemented');
  }

  async alterTable(handle, tableName, changes) {
    throw new Error('Not implemented');
  }
}
```

### 3.2 MySQL Schema Sync (Extract Existing)

**File: `lib/schema-sync/MySQLSchemaSync.js`**

Extract existing `mysqlSchemaUpdate()` logic into this class.

### 3.3 SQLite Schema Sync

**File: `lib/schema-sync/SQLiteSchemaSync.js`**

```javascript
class SQLiteSchemaSync extends SchemaSyncStrategy {
  async syncTable(handle, tableName, fields, options) {
    const exists = await this.dialect.tableExists(handle, null, tableName);

    if (!exists) {
      return this.createTable(handle, tableName, fields, options);
    }

    // SQLite limitation: can only ADD columns, not modify/drop
    const existingColumns = await this.dialect.getTableColumns(handle, tableName);
    const existingNames = new Set(existingColumns.map(c => c.name));

    for (const field of fields) {
      if (!existingNames.has(field.field)) {
        // Add new column
        const typeSpec = this.dialect.mapType(field.type);
        const sql = `ALTER TABLE "${tableName}" ADD COLUMN "${field.field}" ${typeSpec}`;
        await handle.query(sql);
        console.log(`Added column ${field.field} to ${tableName}`);
      }
    }

    // Sync indexes
    if (options.indexes) {
      await this.syncIndexes(handle, tableName, options.indexes);
    }
  }

  async createTable(handle, tableName, fields, options) {
    const columnDefs = fields.map(field => {
      const typeSpec = this.dialect.mapType(field.type);
      const nullable = field.null === 0 ? ' NOT NULL' : '';
      const defaultVal = field.default !== undefined
        ? ` DEFAULT ${this.dialect.escape(field.default)}`
        : '';
      return `"${field.field}" ${typeSpec}${nullable}${defaultVal}`;
    });

    const sql = `CREATE TABLE "${tableName}" (${columnDefs.join(', ')})`;
    await handle.query(sql);
    console.log(`Created table ${tableName}`);

    // Create indexes
    if (options.indexes) {
      await this.syncIndexes(handle, tableName, options.indexes);
    }
  }

  async syncIndexes(handle, tableName, indexes) {
    const existing = await this.dialect.getTableIndexes(handle, tableName);
    const existingNames = new Set(existing.map(i => i.name));

    for (const [indexName, columns] of Object.entries(indexes)) {
      if (existingNames.has(indexName)) continue;

      // Skip fulltext indexes - not supported
      if (Array.isArray(columns) && columns[0] === 'fulltext') {
        console.log(`Skipping fulltext index ${indexName} (not supported in SQLite)`);
        continue;
      }

      // Skip JSON indexes for now
      const cols = Array.isArray(columns) ? columns : [columns];
      if (cols.some(c => String(c).includes('->>'))) {
        console.log(`Skipping JSON index ${indexName} (requires different syntax in SQLite)`);
        continue;
      }

      const columnList = cols.map(c => `"${c}"`).join(', ');
      const sql = `CREATE INDEX "${indexName}" ON "${tableName}" (${columnList})`;

      try {
        await handle.query(sql);
        console.log(`Created index ${indexName} on ${tableName}`);
      } catch (err) {
        console.error(`Failed to create index ${indexName}:`, err.message);
      }
    }
  }
}
```

## Phase 4: Configuration Updates

### 4.1 Update Config Schema

**File: `.yass-orm.js` example**

```javascript
module.exports = {
  // Existing MySQL config
  development: {
    dialect: 'mysql',  // NEW: explicit dialect
    host: 'localhost',
    user: 'root',
    password: 'testsys1',
    schema: 'rubber',
    port: 3306,
  },

  // SQLite config example
  test: {
    dialect: 'sqlite',
    filename: ':memory:',  // or './test.db'
  },

  // SQLite file-based
  embedded: {
    dialect: 'sqlite',
    filename: './data/app.sqlite',
  },
};
```

## Phase 5: Testing Strategy

### 5.1 Dialect-Agnostic Test Suite

```javascript
// test/dialect-tests.js
const dialects = ['mysql', 'sqlite'];

for (const dialectName of dialects) {
  describe(`yass-orm with ${dialectName}`, () => {
    let dbh;

    before(async () => {
      dbh = await factory({ dialect: dialectName, /* config */ });
    });

    after(async () => {
      await dbh.end();
    });

    it('should create records', async () => {
      const record = await dbh.create('test_table', { name: 'Test' });
      expect(record.id).to.exist;
      expect(record.name).to.equal('Test');
    });

    it('should search records', async () => {
      const records = await dbh.search('test_table', { name: 'Test' });
      expect(records).to.have.length.greaterThan(0);
    });

    // ... more tests
  });
}
```

## Phase 6: Implementation Order

### Step 1: Dialect Infrastructure (2-3 days)
- [ ] Create `lib/dialects/` directory
- [ ] Implement `BaseDialect.js`
- [ ] Implement `MySQLDialect.js` (extract from existing code)
- [ ] Add dialect detection to config

### Step 2: SQLite Dialect Core (2-3 days)
- [ ] Implement `SQLiteDialect.js`
- [ ] SQL transformation (`:name` → `$name`, backticks → quotes)
- [ ] Connection wrapper for better-sqlite3
- [ ] Basic query execution

### Step 3: Refactor dbh.js (1-2 days)
- [ ] Add dialect parameter support
- [ ] Wire up dialect-specific connection creation
- [ ] Ensure backward compatibility with MySQL

### Step 4: Schema Sync Abstraction (2-3 days)
- [ ] Create schema sync strategy interface
- [ ] Extract MySQL schema sync to strategy class
- [ ] Implement SQLite schema sync (limited)
- [ ] Handle unsupported features gracefully

### Step 5: Testing & Documentation (1-2 days)
- [ ] Create dialect-agnostic test suite
- [ ] Test both MySQL and SQLite
- [ ] Update README with SQLite usage
- [ ] Document limitations

## Known Limitations (SQLite)

1. **No ALTER COLUMN** - Can only ADD columns, not modify existing
2. **No FULLTEXT indexes** - FTS5 exists but has different API
3. **No stored functions** - Use JS-generated values
4. **No triggers via schema sync** - Must manage separately
5. **Single-writer** - SQLite is single-threaded for writes
6. **No read replicas** - No load balancing
7. **Date/time as strings** - No native datetime type

## Migration Guide

### From MySQL-only to Polymorphic

1. Add `dialect: 'mysql'` to existing config (optional, defaults to mysql)
2. No code changes required for MySQL users
3. To use SQLite, create new config with `dialect: 'sqlite'`

### Creating SQLite-compatible Models

```javascript
// Avoid MySQL-specific features
exports.default = (ctx) => {
  const t = ctx.types;
  return {
    table: 'users',
    schema: {
      id: t.uuidKey,        // Works in both (JS-generated UUID)
      name: t.string,       // Works in both
      email: t.string,      // Works in both
      createdAt: t.datetime, // Stored as TEXT in SQLite
      isDeleted: t.bool,    // Stored as INTEGER in SQLite
    },
    options: {
      indexes: {
        // Simple indexes work in both
        idx_email: ['email'],

        // AVOID: Fulltext indexes (MySQL only)
        // idx_name_ft: ['fulltext', 'name'],

        // AVOID: JSON indexes until implemented
        // idx_meta_type: ['metadata->>"$.type"'],
      },
    },
  };
};
```
