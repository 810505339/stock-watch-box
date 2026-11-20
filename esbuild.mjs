import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs',
    target: 'node18', external: ['vscode'], outfile: 'dist/extension.js', sourcemap: true }),
  build({ entryPoints: ['media/detail.js'], bundle: true, platform: 'browser', format: 'iife',
    target: 'es2020', outfile: 'dist/detail.js', minify: true }),
  build({ entryPoints: ['media/intraday.js'], bundle: true, platform: 'browser', format: 'iife',
    globalName: 'StockWatchIntraday', target: 'es2020', outfile: 'dist/intraday.js', minify: true }),
]);
await copyFile('node_modules/lightweight-charts/LICENSE', 'dist/lightweight-charts-LICENSE.txt');
