module.exports = {
	extends: ['danbriggs5-base', 'plugin:prettier/recommended'],
	parser: 'babel-eslint',
	env: {
		es2020: true,
		node: true,
	},
	overrides: [
		{
			files: ['**/*.ts', '**/*.d.ts'],
			parser: '@typescript-eslint/parser',
			plugins: ['@typescript-eslint'],
			parserOptions: {
				ecmaVersion: 2020,
				sourceType: 'module',
				project: './tsconfig.json',
			},
			settings: {
				'import/resolver': {
					typescript: {
						project: './tsconfig.json',
					},
				},
			},
			rules: {
				// TS handles these, and they frequently false-positive in d.ts files.
				'no-undef': 'off',
				'no-unused-vars': 'off',

				// Use TS-aware versions that understand function overloads
				'no-redeclare': 'off',
				'@typescript-eslint/no-redeclare': 'off', // Overloads are legit in .d.ts

				// Disable duplicate class members check - TS overloads are valid
				'no-dupe-class-members': 'off',

				// Use TS-aware version for shadowing
				'no-shadow': 'off',
				'@typescript-eslint/no-shadow': 'off', // Allow param names like `config`

				// Don't require extensions for TS imports
				'import/extensions': 'off',

				// tsd is a type-test framework, not a real runtime dep
				'import/no-extraneous-dependencies': [
					'error',
					{ devDependencies: ['**/*.test-d.ts', 'test-d/**'] },
				],

				// Don't complain about unresolved tsd (type-test only)
				'import/no-unresolved': ['error', { ignore: ['^tsd$'] }],
			},
		},
	],
	rules: {
		// https://github.com/eslint/eslint/issues/5074
		'prefer-const': 'off',
		// I want to do this, so stop
		'import/prefer-default-export': 'off',
		// I want to do this, so stop
		'import/no-named-as-default': 'off',
		// I want to do this, so stop
		'no-underscore-dangle': 'off',
		// This protects people who don't put semicolons, which we always do, so stop
		'no-plusplus': 'off',
		// Because we're coming from C++, many architectural decisions
		// will use value accessors as functions
		'class-methods-use-this': 'off',
		'no-param-reassign': [
			'error',
			{
				props: true,
				ignorePropertyModificationsFor: ['socket', 'req'],
			},
		],
	},
};
