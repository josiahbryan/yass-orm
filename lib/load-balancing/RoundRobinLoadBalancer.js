/* eslint-disable no-unused-vars */
const { LoadBalancer } = require('./LoadBalancer');

class RoundRobinLoadBalancer extends LoadBalancer {
	constructor(...args) {
		super(...args);
		this.lastReadConn = 0;
	}

	async getNextReadConn({ targets }) {
		this.lastReadConn++;
		if (this.lastReadConn >= targets.length) {
			this.lastReadConn = 0;
		}
		return { queryId: Math.random(), conn: targets[this.lastReadConn] };
	}
}

module.exports = { RoundRobinLoadBalancer };
