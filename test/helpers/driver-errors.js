/**
 * Driver-shaped errors (mariadb connector, code + errno, not just message
 * text), for the lost-connection retry tests.
 */
const socketClosed = () =>
	Object.assign(
		new Error(
			'(conn=42, no: 45009, SQLState: 08S01) socket has unexpectedly been closed',
		),
		{ errno: 45009, code: 'ER_SOCKET_UNEXPECTED_CLOSE' },
	);
const protocolLost = () =>
	Object.assign(
		new Error('Connection lost: The server closed the connection.'),
		{
			code: 'PROTOCOL_CONNECTION_LOST',
		},
	);
const poolAcquireTimeout = () =>
	Object.assign(
		new Error(
			'(conn=-1, no: 45028, SQLState: HY000) retrieve connection from pool timeout after 10001ms',
		),
		{ errno: 45028, code: 'ER_GET_CONNECTION_TIMEOUT' },
	);
const connRefused = () =>
	Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:25060'), {
		errno: -111,
		code: 'ECONNREFUSED',
	});
const connReset = () =>
	Object.assign(new Error('read ECONNRESET'), {
		errno: -104,
		code: 'ECONNRESET',
	});
const cmdConnectionClosed = () =>
	Object.assign(
		new Error(
			'(conn=42, no: 45013, SQLState: 08S01) Cannot execute new commands: connection closed',
		),
		{ errno: 45013, code: 'ER_CMD_CONNECTION_CLOSED' },
	);

module.exports = {
	socketClosed,
	protocolLost,
	poolAcquireTimeout,
	connRefused,
	connReset,
	cmdConnectionClosed,
};
