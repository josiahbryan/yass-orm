/**
 * A TCP proxy in front of the test database that can lose ONE reply.
 *
 * Bytes pass through untouched until the proxy is armed with a pattern. The
 * next client packet that matches is forwarded to the server, the server runs
 * it (and, with autocommit, commits it), and the server's reply is dropped:
 * both sockets are closed instead. The client sees its connection die
 * mid-statement ("socket has unexpectedly been closed", 45009) while the
 * statement has in fact been applied. This is the commit-then-lose-response
 * case BDL-4470 is about, on a real server and the real driver.
 *
 * The pattern is matched against the packet as latin1 text, so it sees the
 * SQL the driver sends with the text protocol (mariadb's default).
 */
const net = require('node:net');

async function startLoseReplyProxy({ host, port }) {
	const sockets = new Set();
	const state = { armed: null, matched: 0, dropped: 0 };

	const track = (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => {});
	};

	const server = net.createServer((client) => {
		const upstream = net.connect(port, host);
		track(client);
		track(upstream);
		let dropNextReply = false;

		client.on('data', (buf) => {
			const text = buf.toString('latin1');
			if (state.armed && state.armed.test(text)) {
				state.matched += 1;
				state.armed = null;
				dropNextReply = true;
			}
			upstream.write(buf);
		});
		upstream.on('data', (buf) => {
			if (dropNextReply) {
				state.dropped += 1;
				client.destroy();
				upstream.destroy();
				return;
			}
			client.write(buf);
		});
		client.on('close', () => upstream.destroy());
		upstream.on('close', () => client.destroy());
	});

	await new Promise((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});

	return {
		host: '127.0.0.1',
		port: server.address().port,
		state,
		/** Lose the reply to the next client packet matching `pattern`. */
		loseReplyTo(pattern) {
			state.armed = pattern;
		},
		disarm() {
			state.armed = null;
		},
		async close() {
			sockets.forEach((socket) => socket.destroy());
			await new Promise((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

module.exports = { startLoseReplyProxy };
