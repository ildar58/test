import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  sourcemap: true,
  target: ['es2020'],
};

// ESM build for bundler consumers.
const esm = { ...common, format: 'esm', outfile: 'dist/index.mjs' };

// IIFE build exposing the global PamPlayer (loaded by the replayer UI).
const iife = {
  ...common,
  format: 'iife',
  globalName: 'PamPlayer',
  outfile: 'dist/pam-player.iife.js',
};

if (watch) {
  const ctx = await context(esm);
  await ctx.watch();
  console.log('watching…');
} else {
  await build(esm);
  await build(iife);
  console.log('built dist/index.mjs and dist/pam-player.iife.js');
}
