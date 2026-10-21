/** The built page must obey the §13 CSP: same-origin assets only, and the _headers file says so. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const dashboard = join(import.meta.dirname, '..');
const dist = join(dashboard, 'dist');

beforeAll(() => {
  execFileSync(process.execPath, [join(dashboard, 'build.mjs')], { cwd: join(dashboard, '..'), stdio: 'pipe' });
}, 60_000);

function csp(file: string): Map<string, string> {
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('Content-Security-Policy:'))!;
  const policy = line.slice(line.indexOf(':') + 1);
  return new Map(
    policy
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(/\s+/)[0]!, d.split(/\s+/).slice(1).join(' ')]),
  );
}

describe('_headers', () => {
  const policy = csp(join(dashboard, 'src/_headers'));
  it('carries the §13 Content-Security-Policy', () => {
    expect(policy.get('default-src')).toBe("'none'");
    for (const d of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src']) expect(policy.get(d), d).toBe("'self'");
    expect(policy.get('base-uri')).toBe("'none'");
    expect(policy.get('form-action')).toBe("'none'");
    expect(policy.get('frame-ancestors')).toBe("'none'");
    expect([...policy.values()].join(' ')).not.toMatch(/unsafe-|https?:|\*/);
  });
  it('is shipped in the build, and fonts are not cached as immutable', () => {
    const source = readFileSync(join(dashboard, 'src/_headers'), 'utf8');
    expect(readFileSync(join(dist, '_headers'), 'utf8')).toBe(source);
    expect(source).not.toMatch(/immutable/);
  });
});

describe('built page', () => {
  it('index.html references only same-origin assets that exist in the build', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(3);
    const files = readdirSync(dist, { recursive: true }).map((p) => `/${String(p).replace(/\\/g, '/')}`);
    for (const u of urls) {
      expect(u, u).toMatch(/^\/[^/]/);
      expect(files, u).toContain(u);
    }
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=|\son\w+=/);
  });
  it('css and js load nothing from other origins', () => {
    const css = readFileSync(join(dist, 'app.css'), 'utf8');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)/g)) expect(m[1], m[1]).toMatch(/^\/fonts\//);
    const js = readFileSync(join(dist, 'app.js'), 'utf8');
    expect(js).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});

describe('dev server', () => {
  it('serves index.html for /r/<room> with the CSP', async () => {
    const { startStaticServer } = await import('../static-server.mjs');
    const server = await startStaticServer(dist, 0);
    const { port } = server.address() as { port: number };
    const fetchText = (path: string) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        get({ host: '127.0.0.1', port, path }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        }).on('error', reject);
      });
    try {
      const page = await fetchText('/r/demo');
      expect(page.status).toBe(200);
      expect(page.body).toContain('<div id="app">');
      expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'");
      expect((await fetchText('/logo.svg')).headers['content-type']).toBe('image/svg+xml');
    } finally {
      server.close();
    }
  });
});
