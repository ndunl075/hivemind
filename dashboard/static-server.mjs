// Tiny static server for dashboard/dist, used by `build.mjs --serve` and the screenshot script.
// It mirrors the Worker's assets behaviour: the headers from `_headers` on every response, and a single-page-app
// fallback so /r/<room> serves index.html.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function globalHeaders(dist) {
  const file = join(dist, '_headers');
  if (!existsSync(file)) return {};
  const first = readFileSync(file, 'utf8').split(/\r?\n\r?\n/)[0] ?? '';
  const out = {};
  for (const line of first.split(/\r?\n/).slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export function startStaticServer(dist, port) {
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dist, pathname));
    const inside = file.startsWith(normalize(dist));
    const isFile = inside && existsSync(file) && statSync(file).isFile();
    // Anything that is not an asset is the app (single-page-app fallback).
    if (!isFile) file = join(dist, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...globalHeaders(dist) });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
