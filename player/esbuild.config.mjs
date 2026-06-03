import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

// ESM: core + engine B in index.mjs; engine A (dynamic import) becomes its own chunk.
const esmSplit = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  outdir: 'dist',
  splitting: true,
  sourcemap: true,
  target: ['es2020'],
  entryNames: 'index',
  outExtension: { '.js': '.mjs' },
};

// IIFE: global PamPlayer, engine B only (engine A is ESM-only).
const iife = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'PamPlayer',
  outfile: 'dist/pam-player.iife.js',
  sourcemap: true,
  target: ['es2020'],
  external: ['rrweb-player'],
};

if (watch) {
  const ctx = await context(esmSplit);
  await ctx.watch();
  console.log('watching…');
} else {
  await build(esmSplit);
  await build(iife);
  console.log('built dist/index.mjs (+ engine chunk) and dist/pam-player.iife.js');
}
