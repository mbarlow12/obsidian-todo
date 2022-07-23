import esbuild from "esbuild";
import process from "process";
import builtins from 'builtin-modules'

const banner =
`/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = (process.argv[2] === 'production');
const test = (process.argv[2] === 'test' || process.argv[3] === 'test');

let entryPoint;
if (!test) {
	entryPoint = 'src/main.ts';
}
else {
}

esbuild.build({
	banner: {
		js: banner,
	},
	entryPoints: [ entryPoint ],
	bundle: true,
	// minify: prod,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/closebrackets',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/comment',
		'@codemirror/fold',
		'@codemirror/gutter',
		'@codemirror/highlight',
		'@codemirror/history',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/matchbrackets',
		'@codemirror/panel',
		'@codemirror/rangeset',
		'@codemirror/rectangular-selection',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/stream-parser',
		'@codemirror/text',
		'@codemirror/tooltip',
		'@codemirror/view',
		...builtins],
	format: 'cjs',
	watch: false,
	target: 'es2016',
	logLevel: "info",
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outdir: 'dist',
}).catch(() => process.exit(1));
