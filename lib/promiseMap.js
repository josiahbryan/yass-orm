async function promiseMap(
	list = null,
	next = (/* d, idx */) => {},
	debug = null,
) {
	const all = Array.from((await list) || []);
	const total = all.length;
	const done = [];

	let p = Promise.resolve();
	all.forEach((d, idx) => {
		p = p
			.then(() => next(d, idx))
			.then((result) => {
				done.push(result);
				if (debug) {
					// eslint-disable-next-line no-console
					console.log(`[promiseAll:${debug}] Done ${done.length} / ${total}`);
				}
			});
	});
	await p;
	return done;
}

exports.promiseMap = promiseMap;
