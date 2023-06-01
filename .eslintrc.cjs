module.exports = {
	extends: ['danbriggs5-base', 'plugin:prettier/recommended'],
	parser: 'babel-eslint',
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
		'space-before-blocks': 'error',
		'keyword-spacing': 'error',
		'no-param-reassign': [
			'error',
			{
				props: true,
				ignorePropertyModificationsFor: ['socket', 'req'],
			},
		],
	},
};
