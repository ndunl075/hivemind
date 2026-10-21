// Builds the dashboard into dashboard/dist. Placeholder from the Wave 0 scaffold; W3 (dashboard) owns it.
// `node dashboard/build.mjs --serve [port]` rebuilds on change and serves dist (default port 5173).
import { context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const serveAt = process.argv.indexOf('--serve');
const port = serveAt >= 0 ? Number(process.argv[serveAt + 1] ?? 5173) || 5173 : null;

mkdirSync(dist, { recursive: true });
cpSync(join(here, 'src/index.html'), join(dist, 'index.html'));
cpSync(join(here, '../assets/favicon.svg'), join(dist, 'favicon.svg'));
const ctx = await context({ entryPoints: [join(here, 'src/main.ts')], bundle: true, format: 'esm', outfile: join(dist, 'app.js'), minify: port === null });
if (port === null) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  await ctx.serve({ servedir: dist, port });
  console.log(`dashboard on http://localhost:${port}`);
}
