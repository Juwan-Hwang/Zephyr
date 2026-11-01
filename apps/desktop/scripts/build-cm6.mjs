// Build src/cm6.bundle.js (committed) from src/ui/editor/cm6-entry.js.
//
// Uses esbuild's JS API rather than its CLI: after `pnpm install
// --ignore-scripts && pnpm rebuild esbuild` the package's bin is replaced
// by the native binary while pnpm's shim still runs it with node.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
    absWorkingDir: root,
    entryPoints: ['src/ui/editor/cm6-entry.js'],
    bundle: true,
    format: 'esm',
    minify: true,
    outfile: 'src/cm6.bundle.js',
    banner: { js: '// @ts-nocheck' },
    logLevel: 'info',
});
