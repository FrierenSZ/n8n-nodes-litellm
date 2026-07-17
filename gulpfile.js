const { src, dest } = require('gulp');

// Copies node/credential icons into dist alongside the compiled .js
function buildIcons() {
	return src('nodes/**/*.{png,svg}', { encoding: false }).pipe(dest('dist/nodes'));
}

exports['build:icons'] = buildIcons;
