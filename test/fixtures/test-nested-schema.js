/**
 * Test fixture for nested object type generation
 * Tests all type definitions including newly added ones
 */
exports.default = ({ types: t }) => ({
	table: 'test_nested_types',
	schema: {
		id: t.uuidKey,

		// Simple nested object with direct schema fields
		entity: t.object({
			name: t.string,
			aliases: t.array(t.string),
			entityType: t.enum(['person', 'place', 'organization', 'project']),
			attributes: t.object(),
		}),

		// Nested object with enum and datetime
		provenance: t.object({
			sourceType: t.enum([
				'direct_statement',
				'inference',
				'correction',
				'consolidation',
				'default',
			]),
			reasoningChain: t.array(
				t.object({
					step: t.int,
					type: t.string,
					content: t.string,
					sourceBeliefId: t.string,
				}),
			),
			lastVerifiedAt: t.datetime,
			verificationMethod: t.string,
		}),

		// Array of objects with enums inside
		revisionHistory: t.array(
			t.object({
				timestamp: t.datetime,
				changeType: t.enum([
					'created',
					'updated',
					'status_change',
					'confidence_adjusted',
				]),
				previousValue: t.string,
				newValue: t.string,
				reason: t.string,
			}),
		),

		// Simple array
		sourceEpisodes: t.array(t.string),

		// Top-level enum
		validityStatus: t.enum([
			'active',
			'potentially_stale',
			'invalidated',
			'superseded',
		]),

		// Plain fields
		confidence: t.float,
		mentionCount: t.int,
		createdAt: t.datetime,

		// ===== NEWLY ADDED TYPES =====

		// t.bigint - for large integers
		createdAtEpoch: t.bigint,

		// t.uuid - for UUID fields (not primary key)
		externalId: t.uuid,

		// t.any - for any/unknown values
		rawData: t.any,

		// t.number - alias for double
		score: t.number,

		// t.array() without arguments - generic array
		genericTags: t.array(),

		// Object with t.any inside
		customFields: t.array(
			t.object({
				id: t.string,
				name: t.string,
				value: t.any,
			}),
		),

		// Object with t.bigint
		poetState: t.object({
			version: t.string,
			createdAt: t.bigint,
			turnNumber: t.int,
		}),
	},
});
