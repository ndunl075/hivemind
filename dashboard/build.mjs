// Builds the dashboard into dashboard/dist.
// `node dashboard/build.mjs --serve [port]` rebuilds on change and serves dist (default port 5173) with the
// _headers CSP and a single-page-app fallback, like the Worker.
import { context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startStaticServer } from './static-server.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(here, 'dist');
const serveAt = process.argv.indexOf('--serve');
const port = serveAt >= 0 ? Number(process.argv[serveAt + 1]) || 5173 : null;

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'fonts'), { recursive: true });
cpSync(join(here, 'src/index.html'), join(dist, 'index.html'));
cpSync(join(here, 'src/_headers'), join(dist, '_headers'));
// The brand assets are owned by the architect and only read here.
cpSync(join(root, 'assets/favicon.svg'), join(dist, 'favicon.svg'));
cpSync(join(root, 'assets/logo.svg'), join(dist, 'logo.svg'));
// Self-hosted fonts (latin subset): one variable Inter file, two Geist Mono weights.
const fonts = [
  ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter-latin-wght-normal.woff2'],
  ['@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2', 'geist-mono-latin-400-normal.woff2'],
  ['@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2', 'geist-mono-latin-500-normal.woff2'],
];
for (const [from, to] of fonts) cpSync(join(root, 'node_modules', from), join(dist, 'fonts', to));

const ctx = await context({
  entryPoints: { app: join(here, 'src/main.ts') },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: dist,
  minify: port === null,
  sourcemap: port !== null,
  external: ['/fonts/*'],
  logLevel: 'info',
});
if (port === null) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  await startStaticServer(dist, port);
  console.log(`dashboard on http://localhost:${port}`);
}
