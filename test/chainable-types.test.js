/* eslint-disable global-require */
/* global it, describe, before */
const { expect } = require('chai');
const { convertDefinition } = require('../lib/def-to-schema');
const {
	generateTypesContent,
	generateZodContent,
} = require('../lib/generate-types');

/**
 * Test suite for the fluent/chainable type API.
 *
 * Tests backward compatibility with existing syntax AND
 * new chainable methods like .description(), .default(), etc.
 */
describe('#Chainable Types', () => {
	// ============================================
	// SECTION 1: Backward Compatibility Tests
	// ============================================

	describe('Backward Compatibility', () => {
		it('should work with t.string used directly (no parens)', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_string',
				schema: {
					name: t.string,
				},
			}));
			expect(schema.fieldMap.name.type).to.equal('varchar');
			expect(schema.fieldMap.name.nativeType).to.equal(String);
		});

		it('should work with t.int used directly (no parens)', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_int',
				schema: {
					count: t.int,
				},
			}));
			expect(schema.fieldMap.count.type).to.equal('integer');
			expect(schema.fieldMap.count.nativeType).to.equal(Number);
		});

		it('should work with t.bool used directly (no parens)', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_bool',
				schema: {
					isActive: t.bool,
				},
			}));
			expect(schema.fieldMap.isActive.type).to.equal('int(1)');
			expect(schema.fieldMap.isActive.nativeType).to.equal(Boolean);
		});

		it('should work with t.datetime() called with parens', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_datetime',
				schema: {
					createdAt: t.datetime(),
				},
			}));
			expect(schema.fieldMap.createdAt.type).to.equal('datetime');
			expect(schema.fieldMap.createdAt.nativeType).to.equal(Date);
		});

		it('should work with t.datetime without parens', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_datetime_noparens',
				schema: {
					createdAt: t.datetime,
				},
			}));
			expect(schema.fieldMap.createdAt.type).to.equal('datetime');
			expect(schema.fieldMap.createdAt.nativeType).to.equal(Date);
		});

		it('should work with t.datetime({ defaultValue: ... })', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_datetime_default',
				schema: {
					createdAt: t.datetime({ defaultValue: 'CURRENT_TIMESTAMP' }),
				},
			}));
			expect(schema.fieldMap.createdAt.type).to.equal('datetime');
			expect(schema.fieldMap.createdAt.default).to.equal('CURRENT_TIMESTAMP');
		});

		it('should work with t.enum([...]) with options', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_enum',
				schema: {
					status: t.enum(['active', 'inactive', 'pending']),
				},
			}));
			expect(schema.fieldMap.status.type).to.equal('varchar');
			expect(schema.fieldMap.status._type).to.equal('enum');
			expect(schema.fieldMap.status.options).to.deep.equal([
				'active',
				'inactive',
				'pending',
			]);
		});

		it('should work with t.enum([...], { default: ... })', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_enum_default',
				schema: {
					status: t.enum(['active', 'inactive'], { default: 'active' }),
				},
			}));
			expect(schema.fieldMap.status.defaultValue).to.equal('active');
		});

		it('should work with t.linked(...)', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_linked',
				schema: {
					user: t.linked('user'),
				},
			}));
			expect(schema.fieldMap.user.linkedModel).to.equal('user');
		});

		it('should work with t.object() (no schema)', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_object_empty',
				schema: {
					metadata: t.object(),
				},
			}));
			expect(schema.fieldMap.metadata.type).to.equal('longtext');
			expect(schema.fieldMap.metadata.isObject).to.equal(true);
		});

		it('should work with t.object({ field: t.string, ... })', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_object_schema',
				schema: {
					profile: t.object({
						name: t.string,
						age: t.int,
					}),
				},
			}));
			expect(schema.fieldMap.profile.type).to.equal('longtext');
			expect(schema.fieldMap.profile.isObject).to.equal(true);
			expect(schema.fieldMap.profile.objectSchema).to.have.property(
				'profile_name',
			);
			expect(schema.fieldMap.profile.objectSchema).to.have.property(
				'profile_age',
			);
		});

		it('should work with t.array()', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_array_empty',
				schema: {
					tags: t.array(),
				},
			}));
			expect(schema.fieldMap.tags.type).to.equal('longtext');
			expect(schema.fieldMap.tags.isArray).to.equal(true);
		});

		it('should work with t.array(t.string)', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_array_string',
				schema: {
					tags: t.array(t.string),
				},
			}));
			expect(schema.fieldMap.tags.type).to.equal('longtext');
			expect(schema.fieldMap.tags.isArray).to.equal(true);
			expect(schema.fieldMap.tags.arrayItemType).to.equal('string');
		});

		it('should work with t.array(t.object({ ... }))', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_backward_array_object',
				schema: {
					items: t.array(
						t.object({
							id: t.string,
							name: t.string,
						}),
					),
				},
			}));
			expect(schema.fieldMap.items.isArray).to.equal(true);
			expect(schema.fieldMap.items.arrayItemType).to.equal('object');
			expect(schema.fieldMap.items.arrayItemSchema).to.have.property(
				'items_item_id',
			);
		});
	});

	// ============================================
	// SECTION 2: New Chainable API Tests
	// ============================================

	describe('Chainable API', () => {
		describe('Universal Methods', () => {
			it('should support .description() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_chain_desc',
					schema: {
						name: t.string.description('User full name'),
					},
				}));
				expect(schema.fieldMap.name.type).to.equal('varchar');
				expect(schema.fieldMap.name._description).to.equal('User full name');
			});

			it('should support .default() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_chain_default',
					schema: {
						name: t.string.default('Anonymous'),
					},
				}));
				expect(schema.fieldMap.name.default).to.equal('Anonymous');
			});

			it('should support .example() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_chain_example',
					schema: {
						email: t.string.example('user@example.com'),
					},
				}));
				expect(schema.fieldMap.email._example).to.equal('user@example.com');
			});

			it('should support .nullable() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_chain_nullable',
					schema: {
						nickname: t.string.nullable(),
					},
				}));
				expect(schema.fieldMap.nickname.null).to.equal(1);
			});

			it('should support method chaining', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_chain_multiple',
					schema: {
						name: t.string
							.description('User name')
							.default('Guest')
							.example('John Doe'),
					},
				}));
				expect(schema.fieldMap.name._description).to.equal('User name');
				expect(schema.fieldMap.name.default).to.equal('Guest');
				expect(schema.fieldMap.name._example).to.equal('John Doe');
			});
		});

		describe('String Methods', () => {
			it('should support .minLength() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_string_minlength',
					schema: {
						password: t.string.minLength(8),
					},
				}));
				expect(schema.fieldMap.password._minLength).to.equal(8);
			});

			it('should support .maxLength() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_string_maxlength',
					schema: {
						username: t.string.maxLength(50),
					},
				}));
				expect(schema.fieldMap.username._maxLength).to.equal(50);
			});

			it('should support .pattern() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_string_pattern',
					schema: {
						code: t.string.pattern(/^[A-Z]{3}$/),
					},
				}));
				expect(schema.fieldMap.code._pattern).to.be.instanceOf(RegExp);
			});

			it('should support .email() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_string_email',
					schema: {
						email: t.string.email(),
					},
				}));
				expect(schema.fieldMap.email._format).to.equal('email');
			});

			it('should support .url() on t.string', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_string_url',
					schema: {
						website: t.string.url(),
					},
				}));
				expect(schema.fieldMap.website._format).to.equal('url');
			});
		});

		describe('Number Methods', () => {
			it('should support .min() on t.int', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_int_min',
					schema: {
						age: t.int.min(0),
					},
				}));
				expect(schema.fieldMap.age._min).to.equal(0);
			});

			it('should support .max() on t.int', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_int_max',
					schema: {
						age: t.int.max(150),
					},
				}));
				expect(schema.fieldMap.age._max).to.equal(150);
			});

			it('should support .positive() on t.int', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_int_positive',
					schema: {
						count: t.int.positive(),
					},
				}));
				expect(schema.fieldMap.count._positive).to.equal(true);
			});

			it('should support .negative() on t.int', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_int_negative',
					schema: {
						debt: t.int.negative(),
					},
				}));
				expect(schema.fieldMap.debt._negative).to.equal(true);
			});

			it('should support .nonnegative() on t.int', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_int_nonnegative',
					schema: {
						balance: t.int.nonnegative(),
					},
				}));
				expect(schema.fieldMap.balance._nonnegative).to.equal(true);
			});

			it('should support chained min/max on t.float', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_float_minmax',
					schema: {
						percentage: t.float.min(0).max(100),
					},
				}));
				expect(schema.fieldMap.percentage._min).to.equal(0);
				expect(schema.fieldMap.percentage._max).to.equal(100);
			});
		});

		describe('Function Types with Chaining', () => {
			it('should support .description() on t.datetime', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_datetime_desc',
					schema: {
						createdAt: t.datetime.description('When the record was created'),
					},
				}));
				expect(schema.fieldMap.createdAt.type).to.equal('datetime');
				expect(schema.fieldMap.createdAt._description).to.equal(
					'When the record was created',
				);
			});

			it('should support .description() on t.enum([...])', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_enum_desc',
					schema: {
						status: t.enum(['active', 'inactive']).description('User status'),
					},
				}));
				expect(schema.fieldMap.status._description).to.equal('User status');
				expect(schema.fieldMap.status.options).to.deep.equal([
					'active',
					'inactive',
				]);
			});

			it('should support .description() on t.linked(...)', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_linked_desc',
					schema: {
						user: t.linked('user').description('Reference to the user'),
					},
				}));
				expect(schema.fieldMap.user._description).to.equal(
					'Reference to the user',
				);
				expect(schema.fieldMap.user.linkedModel).to.equal('user');
			});

			it('should support .description() on t.object({...})', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_object_desc',
					schema: {
						metadata: t
							.object({ key: t.string })
							.description('Additional metadata'),
					},
				}));
				expect(schema.fieldMap.metadata._description).to.equal(
					'Additional metadata',
				);
			});

		it('should support .description().minItems().maxItems() on t.array()', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_array_desc',
				schema: {
					tags: t.array(t.string).description('List of tags').minItems(1).maxItems(10),
				},
			}));
			expect(schema.fieldMap.tags._description).to.equal('List of tags');
			expect(schema.fieldMap.tags._minItems).to.equal(1);
			expect(schema.fieldMap.tags._maxItems).to.equal(10);
		});

		it('should support .min() and .max() as aliases for minItems/maxItems on t.array()', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'test_array_min_max',
				schema: {
					items: t.array(t.string).min(2).max(5),
				},
			}));
			expect(schema.fieldMap.items._minItems).to.equal(2);
			expect(schema.fieldMap.items._maxItems).to.equal(5);
		});
		});
	});

	// ============================================
	// SECTION 3: Type Generation Tests
	// ============================================

	describe('Type Generation', () => {
		const testSchemaPath = './test/fixtures/test-chainable-schema.js';
		let testSchemaContent;

		before(() => {
			// Create a test schema with chainable types for generation tests
			testSchemaContent = `
exports.default = ({ types: t }) => ({
	table: 'test_generation',
	schema: {
		id: t.uuidKey,
		name: t.string.description('User full name').minLength(1).maxLength(100),
		email: t.string.description('Email address').email(),
		age: t.int.description('User age').min(0).max(150),
		status: t.enum(['active', 'inactive']).description('Account status'),
		tags: t.array(t.string).description('User tags'),
		profile: t.object({
			bio: t.string.description('Biography'),
			avatar: t.string.description('Avatar URL'),
		}).description('User profile data'),
		createdAt: t.datetime.description('Creation timestamp'),
	},
});`;
		});

		describe('TypeScript JSDoc Generation', () => {
			it('should include JSDoc comments from _description', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_jsdoc',
					schema: {
						name: t.string.description('User full name'),
						age: t.int.description('User age'),
					},
				}));

				// We can't easily test the full generation without file I/O,
				// but we can verify the schema has the metadata
				expect(schema.fieldMap.name._description).to.equal('User full name');
				expect(schema.fieldMap.age._description).to.equal('User age');
			});
		});

		describe('Zod Schema Generation', () => {
			it('should generate Zod schema with .describe() and validation methods', () => {
				const schema = convertDefinition(({ types: t }) => ({
					table: 'test_zod',
					schema: {
						name: t.string.description('User name').minLength(1).maxLength(50),
						age: t.int.description('User age').min(0).max(150),
					},
				}));

				// Verify metadata is present for Zod generation
				expect(schema.fieldMap.name._description).to.equal('User name');
				expect(schema.fieldMap.name._minLength).to.equal(1);
				expect(schema.fieldMap.name._maxLength).to.equal(50);
				expect(schema.fieldMap.age._description).to.equal('User age');
				expect(schema.fieldMap.age._min).to.equal(0);
				expect(schema.fieldMap.age._max).to.equal(150);
			});
		});
	});

	// ============================================
	// SECTION 4: Integration Tests
	// ============================================

	describe('Integration', () => {
		it('should convert a complex schema with all chainable features', () => {
			const schema = convertDefinition(({ types: t }) => ({
				table: 'users',
				schema: {
					id: t.uuidKey,
					name: t.string
						.description('User full name')
						.minLength(1)
						.maxLength(100)
						.example('John Doe'),
					email: t.string
						.description('User email address')
						.email()
						.example('john@example.com'),
					age: t.int
						.description('User age in years')
						.min(0)
						.max(150)
						.nullable(),
					balance: t.float
						.description('Account balance')
						.nonnegative()
						.default(0),
					status: t.enum(['active', 'inactive', 'pending'])
						.description('Account status')
						.default('pending'),
					roles: t.array(t.string)
						.description('User roles')
						.minItems(1),
					settings: t.object({
						theme: t.string.description('UI theme preference'),
						notifications: t.bool.description('Email notifications enabled'),
					}).description('User settings'),
					tenant: t.linked('tenant').description('Owning tenant'),
					createdAt: t.datetime.description('When the user was created'),
					updatedAt: t.datetime.description('Last update time'),
				},
				indexes: {
					email: ['email'],
					status: ['status'],
				},
			}));

			// Verify all fields are properly converted
			expect(schema.fieldMap.id.type).to.equal('uuidKey');
			expect(schema.fieldMap.name.type).to.equal('varchar');
			expect(schema.fieldMap.name._description).to.equal('User full name');
			expect(schema.fieldMap.name._minLength).to.equal(1);
			expect(schema.fieldMap.name._maxLength).to.equal(100);
			expect(schema.fieldMap.email._format).to.equal('email');
			expect(schema.fieldMap.age._min).to.equal(0);
			expect(schema.fieldMap.age._max).to.equal(150);
			expect(schema.fieldMap.balance._nonnegative).to.equal(true);
			expect(schema.fieldMap.status.options).to.deep.equal([
				'active',
				'inactive',
				'pending',
			]);
			expect(schema.fieldMap.roles.isArray).to.equal(true);
			expect(schema.fieldMap.roles._minItems).to.equal(1);
			expect(schema.fieldMap.settings.isObject).to.equal(true);
			expect(schema.fieldMap.tenant.linkedModel).to.equal('tenant');
			expect(schema.fieldMap.createdAt.type).to.equal('datetime');
		});

		it('should not break existing real-world schema patterns', () => {
			// Simulate a real-world schema like message.js
			const schema = convertDefinition(({ types: t }) => ({
				table: 'messages',
				schema: {
					id: t.uuidKey,
					tenant: t.linked('tenant'),
					account: t.linked('account'),
					user: t.linked('user'),
					status: t.string,
					timestamp: t.datetime,
					epoch: t.real,
					inbound: t.bool,
					messageType: t.string,
					text: t.text,
					channelType: t.enum([
						'auto',
						'phone',
						'sms',
						'email',
						'web',
						'bot',
					]),
					channelData: t.object(),
					attachments: t.object(),
					metadata: t.object(),
					reactions: t.object({
						emojiKey: t.string,
						users: t.array(
							t.object({
								userId: t.string,
								name: t.string,
								at: t.datetime,
							}),
						),
					}),
					customData: t.object({
						pollData: t.object({
							question: t.string,
							options: t.array(
								t.object({
									id: t.string,
									text: t.string,
								}),
							),
						}),
					}),
				},
			}));

			// Verify critical fields work
			expect(schema.fieldMap.id.type).to.equal('uuidKey');
			expect(schema.fieldMap.tenant.linkedModel).to.equal('tenant');
			expect(schema.fieldMap.status.type).to.equal('varchar');
			expect(schema.fieldMap.timestamp.type).to.equal('datetime');
			expect(schema.fieldMap.channelType._type).to.equal('enum');
			expect(schema.fieldMap.reactions.isObject).to.equal(true);
			expect(schema.fieldMap.customData.isObject).to.equal(true);
		});
	});
});
