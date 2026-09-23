/**
 * A CommonJS copy of Rubber's `shared/utils/withRelativeModelLinks.js` (the
 * logic unchanged, comments trimmed), so the characterization tests exercise
 * the shape Rubber's ~69 `relativeModelLinkHelper.js` files hand to yass:
 * a definition function whose `types` is a spread copy of yass's, with
 * `linked` replaced by one that passes ABSOLUTE paths.
 */
const path = require('path');
const fs = require('fs');

const MODEL_EXTENSIONS = ['.js', '.ts', '.cjs', '.mjs'];

function withRelativeModelLinks(
	modelPath,
	fn,
	{ localPath, paths = [localPath] } = {},
) {
	const factory = ({ types }) => {
		const linked = (model) => {
			let found = false;
			const validLink = paths
				.map((includePath) => {
					if (found) {
						return undefined;
					}
					if (includePath) {
						const hasKnownExtension = MODEL_EXTENSIONS.some((ext) =>
							`${model}`.endsWith(ext),
						);

						if (hasKnownExtension) {
							const localResolved = path.resolve(includePath, model);
							if (fs.existsSync(localResolved)) {
								return types.linked(localResolved);
							}
						} else {
							const foundPath = MODEL_EXTENSIONS.map((ext) =>
								path.resolve(includePath, `${model}${ext}`),
							).find((p) => fs.existsSync(p));

							if (foundPath) {
								return types.linked(foundPath);
							}
						}
					}
					return undefined;
				})
				.filter(Boolean)
				.shift();

			if (validLink) {
				return validLink;
			}

			return types.linked(path.resolve(localPath, modelPath, model));
		};

		return fn({ types: { ...types, linked } });
	};

	factory.original = fn.toString();
	return factory;
}

module.exports = withRelativeModelLinks;
