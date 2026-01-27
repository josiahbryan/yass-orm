/* eslint-disable no-unused-expressions */
/* global it, describe */
const { expect } = require('chai');
const { singularize, toPascalCase } = require('../lib/generate-types');

describe('#generate-types singularization', () => {
	describe('singularize()', () => {
		it('should handle words ending in -xes (inboxes → inbox)', () => {
			expect(singularize('chat_inboxes')).to.equal('chat_inbox');
			expect(singularize('boxes')).to.equal('box');
		});

		it('should handle words ending in -sses (glasses → glass)', () => {
			expect(singularize('glasses')).to.equal('glass');
			expect(singularize('classes')).to.equal('class');
		});

		it('should handle words ending in -ches (matches → match)', () => {
			expect(singularize('matches')).to.equal('match');
			expect(singularize('batches')).to.equal('batch');
		});

		it('should handle words ending in -shes (wishes → wish)', () => {
			expect(singularize('wishes')).to.equal('wish');
			expect(singularize('dishes')).to.equal('dish');
		});

		it('should handle words ending in -zes (buzzes → buzz)', () => {
			expect(singularize('buzzes')).to.equal('buzz');
			expect(singularize('fizzes')).to.equal('fizz');
		});

		it('should handle words ending in -ies (categories → category)', () => {
			expect(singularize('categories')).to.equal('category');
			expect(singularize('entries')).to.equal('entry');
		});

		it('should handle regular plurals ending in -s (users → user)', () => {
			expect(singularize('users')).to.equal('user');
			expect(singularize('messages')).to.equal('message');
			expect(singularize('vehicles')).to.equal('vehicle');
			expect(singularize('places')).to.equal('place');
		});

		it('should handle snake_case table names', () => {
			expect(singularize('user_devices')).to.equal('user_device');
			expect(singularize('account_places')).to.equal('account_place');
			expect(singularize('time_dept_rates')).to.equal('time_dept_rate');
		});
	});

	describe('toPascalCase() + singularize() integration', () => {
		it('should produce correct type names for -xes tables', () => {
			expect(toPascalCase(singularize('chat_inboxes'))).to.equal('ChatInbox');
		});

		it('should produce correct type names for -ies tables', () => {
			expect(toPascalCase(singularize('categories'))).to.equal('Category');
		});

		it('should produce correct type names for regular tables', () => {
			expect(toPascalCase(singularize('users'))).to.equal('User');
			expect(toPascalCase(singularize('messages'))).to.equal('Message');
		});

		it('should produce correct type names for snake_case tables', () => {
			expect(toPascalCase(singularize('user_devices'))).to.equal('UserDevice');
			expect(toPascalCase(singularize('chat_inboxes'))).to.equal('ChatInbox');
		});
	});
});
