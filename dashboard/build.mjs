// Builds the dashboard into dashboard/dist. Placeholder from the Wave 0 scaffold; W3 (dashboard) owns it.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });
await build({ entryPoints: [join(here, 'src/main.ts')], bundle: true, format: 'esm', outfile: join(dist, 'app.js'), minify: true });
cpSync(join(here, 'src/index.html'), join(dist, 'index.html'));
cpSync(join(here, '../assets/favicon.svg'), join(dist, 'favicon.svg'));
