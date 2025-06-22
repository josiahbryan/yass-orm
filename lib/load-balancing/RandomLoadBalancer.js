/* eslint-disable no-unused-vars */
const { LoadBalancer } = require('./LoadBalancer');

class RandomLoadBalancer extends LoadBalancer {
	async getNextReadConn({ targets }) {
		return {
			queryId: Math.random(),
			conn: targets[Math.floor(Math.random() * targets.length)],
		};
	}
}

module.exports = { RandomLoadBalancer };
