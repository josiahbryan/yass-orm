# Fluent Schema API

The Fluent Schema API provides a chainable, expressive way to define schema fields with rich metadata. Inspired by Zod and Yup, this API lets you add descriptions, validation hints, and examples directly in your schema definitions.

## Table of Contents

- [Basic Usage](#basic-usage)
- [Universal Methods](#universal-methods)
- [String Methods](#string-methods)
- [Number Methods](#number-methods)
- [Array Methods](#array-methods)
- [Function Types with Chaining](#function-types-with-chaining)
- [Metadata Flow](#metadata-flow)
- [Complete Example](#complete-example)
- [Backward Compatibility](#backward-compatibility)

## Basic Usage

The fluent API allows you to chain methods on any type definition:

```javascript
export default ({ types: t }) => ({
  table: 'users',
  schema: {
    id: t.uuidKey,
    
    // Simple field - works exactly as before
    name: t.string,
    
    // With fluent API - add metadata!
    email: t.string
      .description('User email address')
      .email()
      .example('john@example.com'),
    
    // Chain multiple methods
    age: t.int
      .description('User age in years')
      .min(0)
      .max(150)
      .nullable(),
  },
});
```

## Universal Methods

These methods are available on **all types**:

### `.description(text)`

Adds documentation text that flows to:
- TypeScript JSDoc comments in generated `.d.ts` files
- Zod `.describe()` calls in generated `.zod.ts` files
- MySQL `COMMENT` clauses when syncing schema

```javascript
name: t.string.description('User full name')
```

**Generated TypeScript:**
```typescript
interface UserInstance {
  /** User full name */
  name: string;
}
```

**Generated Zod:**
```typescript
const UserSchema = z.object({
  name: z.string().describe('User full name'),
});
```

**Generated MySQL:**
```sql
`name` VARCHAR(255) COMMENT 'User full name'
```

### `.default(value)`

Sets a default value for the field:

```javascript
status: t.string.default('pending')
balance: t.float.default(0)
```

### `.example(value)`

Adds an example value for documentation:

```javascript
email: t.string.example('user@example.com')
```

**Generated TypeScript:**
```typescript
/**
 * User email
 * @example "user@example.com"
 */
email: string;
```

### `.nullable()`

Marks the field as nullable:

```javascript
nickname: t.string.nullable()
```

## String Methods

These methods are available on string types (`t.string`, `t.text`, `t.uuid`, `t.bigint`):

### `.minLength(n)` / `.maxLength(n)`

Set length constraints:

```javascript
username: t.string.minLength(3).maxLength(50)
password: t.string.minLength(8)
```

**Generated Zod:**
```typescript
username: z.string().min(3).max(50),
password: z.string().min(8),
```

### `.pattern(regex)`

Set a regex pattern for validation:

```javascript
code: t.string.pattern(/^[A-Z]{3}-\d{4}$/)
```

**Generated Zod:**
```typescript
code: z.string().regex(/^[A-Z]{3}-\d{4}$/),
```

### `.email()` / `.url()`

Mark as email or URL format:

```javascript
email: t.string.email()
website: t.string.url()
```

**Generated Zod:**
```typescript
email: z.string().email(),
website: z.string().url(),
```

## Number Methods

These methods are available on number types (`t.int`, `t.float`, `t.real`, `t.number`):

### `.min(n)` / `.max(n)`

Set value range constraints:

```javascript
age: t.int.min(0).max(150)
percentage: t.float.min(0).max(100)
```

**Generated Zod:**
```typescript
age: z.number().int().min(0).max(150),
percentage: z.number().min(0).max(100),
```

### `.positive()` / `.negative()` / `.nonnegative()`

Set sign constraints:

```javascript
price: t.float.positive()        // > 0
debt: t.float.negative()         // < 0
balance: t.float.nonnegative()   // >= 0
```

**Generated Zod:**
```typescript
price: z.number().positive(),
debt: z.number().negative(),
balance: z.number().nonnegative(),
```

## Array Methods

These methods are available on array types (`t.array()`):

### `.minItems(n)` / `.maxItems(n)` (or `.min(n)` / `.max(n)`)

Set array length constraints:

```javascript
tags: t.array(t.string).minItems(1).maxItems(10)

// Zod-compatible aliases also work:
roles: t.array(t.string).min(1).max(5)
```

**Generated Zod:**
```typescript
tags: z.array(z.string()).min(1).max(10),
roles: z.array(z.string()).min(1).max(5),
```

## Function Types with Chaining

Types that are called as functions also support chaining:

### `t.datetime`

```javascript
// All of these work:
createdAt: t.datetime                                    // No parens
updatedAt: t.datetime()                                  // Empty parens
scheduledAt: t.datetime({ defaultValue: 'CURRENT_TIMESTAMP' })  // With options

// With chaining:
publishedAt: t.datetime.description('When the post was published')
```

### `t.enum([...])`

```javascript
status: t.enum(['active', 'inactive', 'pending'])
  .description('Account status')
  .default('pending')
```

### `t.linked(...)`

```javascript
user: t.linked('user').description('The user who created this record')
tenant: t.linked('tenant').description('Owning tenant')
```

### `t.object({...})`

```javascript
profile: t.object({
  bio: t.string.description('User biography'),
  avatar: t.string.description('Avatar URL'),
}).description('User profile data')
```

### `t.array(...)`

```javascript
tags: t.array(t.string)
  .description('List of tags')
  .minItems(1)

items: t.array(t.object({
  id: t.string,
  name: t.string,
})).description('Order items').maxItems(100)
```

## Metadata Flow

The fluent API metadata flows through to multiple outputs:

| Metadata | TypeScript `.d.ts` | Zod `.zod.ts` | MySQL Schema |
|----------|-------------------|---------------|--------------|
| `_description` | JSDoc comment | `.describe()` | `COMMENT` clause |
| `_example` | `@example` tag | - | - |
| `_minLength` | - | `.min()` | - |
| `_maxLength` | - | `.max()` | - |
| `_pattern` | - | `.regex()` | - |
| `_format: 'email'` | - | `.email()` | - |
| `_format: 'url'` | - | `.url()` | - |
| `_min` | - | `.min()` | - |
| `_max` | - | `.max()` | - |
| `_positive` | - | `.positive()` | - |
| `_negative` | - | `.negative()` | - |
| `_nonnegative` | - | `.nonnegative()` | - |
| `_minItems` | - | `.min()` (array) | - |
| `_maxItems` | - | `.max()` (array) | - |

## Complete Example

Here's a comprehensive example showing the fluent API in action:

```javascript
export default ({ types: t }) => ({
  table: 'products',
  schema: {
    id: t.uuidKey,
    
    // String with validation
    name: t.string
      .description('Product name')
      .minLength(1)
      .maxLength(200)
      .example('Wireless Headphones'),
    
    sku: t.string
      .description('Stock keeping unit')
      .pattern(/^[A-Z]{2}-\d{6}$/)
      .example('WH-123456'),
    
    // Number with constraints
    price: t.float
      .description('Product price in USD')
      .positive()
      .example(99.99),
    
    stock: t.int
      .description('Available quantity')
      .nonnegative()
      .default(0),
    
    // Enum with default
    status: t.enum(['draft', 'active', 'discontinued'])
      .description('Product status')
      .default('draft'),
    
    // Array with length constraints
    tags: t.array(t.string)
      .description('Product tags for search')
      .min(1)
      .max(10),
    
    // Nested object with documented fields
    dimensions: t.object({
      width: t.float.description('Width in centimeters'),
      height: t.float.description('Height in centimeters'),
      depth: t.float.description('Depth in centimeters'),
      weight: t.float.description('Weight in kilograms'),
    }).description('Physical dimensions'),
    
    // Linked models
    category: t.linked('category').description('Product category'),
    vendor: t.linked('vendor').description('Product vendor'),
    
    // Timestamps
    createdAt: t.datetime.description('When the product was created'),
    updatedAt: t.datetime.description('Last modification time'),
  },
  
  indexes: {
    sku: ['sku'],
    status: ['status'],
    category: ['category'],
  },
});
```

## Backward Compatibility

The fluent API is **100% backward compatible**. All existing schemas continue to work without modification:

```javascript
// These all work exactly as before:
name: t.string,
count: t.int,
isActive: t.bool,
createdAt: t.datetime,
createdAt: t.datetime(),
status: t.enum(['a', 'b']),
user: t.linked('user'),
metadata: t.object(),
tags: t.array(),
```

You can gradually adopt the fluent API field by field - no migration required!

## Type Generation

To generate TypeScript types and Zod schemas that include the fluent API metadata:

```bash
# Generate both .d.ts and .zod.ts files
npx yass-orm-generate-types --zod path/to/defs/*.js

# Generate only .zod.ts files
npx yass-orm-generate-types --zod-only path/to/defs/*.js
```

The generator will automatically:
- Add JSDoc comments from `.description()` and `.example()`
- Add Zod validation methods from length/range constraints
- Add MySQL `COMMENT` clauses during schema sync
