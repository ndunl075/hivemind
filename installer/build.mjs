/**
 * Builds the two download bundles a non-technical teammate double-clicks (hivemind-windows.zip, hivemind-mac.zip).
 * Each holds an official Node 20 binary, the CLI files the package ships, the smol-toml dependency and a setup launcher.
 *
 *   npm run bundle        (run `npm ci` first: smol-toml is copied from node_modules)
 *
 * Node comes from nodejs.org/dist, is checked against that release's SHASUMS256.txt, and is cached in installer/.cache/.
 * Zips are written to installer/dist/. Builds are unsigned. Only Node built-ins are used.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gunzipSync } from 'node:zlib';

const NODE_VERSION = '20.20.2';
const DIST_URL = `https://nodejs.org/dist/v${NODE_VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const cacheDir = join(here, '.cache', `node-v${NODE_VERSION}`);
const outDir = join(here, 'dist');

/** @param {Buffer} buf */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------- Node downloads ----------

/** @type {Map<string, string> | undefined} */
let sums;

async function checksums() {
  if (sums) return sums;
  const file = join(cacheDir, 'SHASUMS256.txt');
  let text;
  if (existsSync(file)) text = readFileSync(file, 'utf8');
  else {
    const res = await fetch(`${DIST_URL}/SHASUMS256.txt`);
    if (!res.ok) throw new Error(`SHASUMS256.txt: HTTP ${res.status}`);
    text = await res.text();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, text);
  }
  sums = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

/**
 * The file `name` (as listed in SHASUMS256.txt) from nodejs.org, from the cache when its hash still matches.
 * @param {string} name
 */
async function fetchNode(name) {
  const want = (await checksums()).get(name);
  if (!want) throw new Error(`${name} is not listed in SHASUMS256.txt for v${NODE_VERSION}`);
  const cached = join(cacheDir, name.replaceAll('/', '_'));
  if (existsSync(cached)) {
    const buf = readFileSync(cached);
    if (sha256(buf) === want) return buf;
    rmSync(cached);
  }
  console.log(`downloading ${DIST_URL}/${name}`);
  const res = await fetch(`${DIST_URL}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`${name}: SHA-256 mismatch (expected ${want}, got ${got}); not using it`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, buf);
  return buf;
}

/**
 * One file out of a .tar.gz (ustar, with pax and GNU long-name records handled).
 * @param {Buffer} gz
 * @param {string} wanted
 */
function untarFile(gz, wanted) {
  const tar = gunzipSync(gz);
  let longName = '';
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const field = (/** @type {number} */ a, /** @type {number} */ n) => h.toString('utf8', a, a + n).split('\0')[0];
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').split('\0')[0]; continue; }
    if (type === 'x' || type === 'g') continue;
    if (longName) { name = longName; longName = ''; }
    if ((type === '0' || type === '') && name === wanted) return Buffer.from(body);
  }
  throw new Error(`${wanted} not found in the Node archive`);
}

// ---------- zip writer (deflate, Unix modes, fixed timestamps so builds are repeatable) ----------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * @typedef {{ name: string, data: Buffer, mode?: number }} Entry
 * @param {Entry[]} entries
 */
function zip(entries) {
  /** @type {Buffer[]} */ const parts = [];
  /** @type {Buffer[]} */ const central = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is honoured
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// ---------- what goes in the bundles ----------

/**
 * Every file under `dir`, sorted, filtered by its path relative to `dir` (with "/").
 * @param {string} dir
 * @param {(rel: string) => boolean} [keep]
 * @returns {string[]}
 */
function walk(dir, keep = () => true) {
  /** @type {string[]} */ const out = [];
  const visit = (/** @type {string} */ d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (keep(relative(dir, full).split(sep).join('/'))) out.push(full);
    }
  };
  visit(dir);
  return out;
}

/** The files `npm pack` would ship (package.json "files"), minus tests, plus smol-toml and a minimal package.json. */
function appFiles() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const smol = join(root, 'node_modules', 'smol-toml');
  if (!existsSync(join(smol, 'package.json'))) throw new Error('node_modules/smol-toml is missing: run `npm ci` first');
  const smolPkg = JSON.parse(readFileSync(join(smol, 'package.json'), 'utf8'));
  /** @type {Entry[]} */ const entries = [];
  const add = (/** @type {string} */ abs, /** @type {string} */ name) => entries.push({ name: `app/${name}`, data: readFileSync(abs) });
  const posix = (/** @type {string} */ abs, /** @type {string} */ base) => relative(base, abs).split(sep).join('/');
  for (const f of pkg.files) {
    const abs = join(root, f);
    if (statSync(abs).isDirectory()) {
      for (const file of walk(abs, (rel) => !rel.endsWith('.test.mjs') && !rel.endsWith('.gitkeep') && rel.split('/').pop() !== 'testkit.mjs')) add(file, posix(file, root));
    } else add(abs, f);
  }
  const pkgJson = { name: pkg.name, version: pkg.version, private: true, type: 'module', dependencies: { 'smol-toml': smolPkg.version } };
  entries.push({ name: 'app/package.json', data: Buffer.from(`${JSON.stringify(pkgJson, null, 2)}\n`) });
  for (const file of [join(smol, 'package.json'), join(smol, 'LICENSE'), ...walk(join(smol, 'dist'))]) {
    add(file, `node_modules/smol-toml/${posix(file, smol)}`);
  }
  return entries;
}

/** A launcher or readme with the line endings its platform expects. @param {string} file @param {string} eol */
const template = (file, eol) => Buffer.from(readFileSync(join(here, 'templates', file), 'utf8').replace(/\r\n/g, '\n').replaceAll('\n', eol));

async function main() {
  const app = appFiles().map((e) => ({ ...e, name: `Hivemind/${e.name}` }));
  mkdirSync(outDir, { recursive: true });

  const winNode = await fetchNode('win-x64/node.exe');
  writeFileSync(join(outDir, 'hivemind-windows.zip'), zip([
    { name: 'Hivemind/Hivemind Setup.cmd', data: template('windows-setup.cmd', '\r\n') },
    { name: 'Hivemind/README.txt', data: template('README-windows.txt', '\r\n') },
    { name: 'Hivemind/node/node.exe', data: winNode },
    ...app,
  ]));

  const [arm64, x64] = await Promise.all(['arm64', 'x64'].map(async (arch) => {
    const dir = `node-v${NODE_VERSION}-darwin-${arch}`;
    return untarFile(await fetchNode(`${dir}.tar.gz`), `${dir}/bin/node`);
  }));
  writeFileSync(join(outDir, 'hivemind-mac.zip'), zip([
    { name: 'Hivemind/Hivemind Setup.command', data: template('mac-setup.command', '\n'), mode: 0o755 },
    { name: 'Hivemind/README.txt', data: template('README-mac.txt', '\n') },
    { name: 'Hivemind/node/node-arm64', data: arm64, mode: 0o755 },
    { name: 'Hivemind/node/node-x64', data: x64, mode: 0o755 },
    ...app,
  ]));

  for (const f of ['hivemind-windows.zip', 'hivemind-mac.zip']) {
    const buf = readFileSync(join(outDir, f));
    console.log(`${f}  ${(buf.length / 1048576).toFixed(1)} MiB  sha256 ${sha256(buf)}`);
  }
}

main().catch((e) => {
  console.error(`bundle failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
