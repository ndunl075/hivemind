/**
 * File helpers: atomic writes, owner-only permissions, and read-parse that refuses to clobber a file it can't read.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CliError } from './context.mjs';

/**
 * @param {string} path
 * @returns {string | null} null when the file doesn't exist
 */
export function readText(path) {
  try {
    return readFileSync(path, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw new CliError(`cannot read ${path}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Where a write really lands: a symlinked dotfile is followed, so the link itself survives the atomic rename.
 * A dangling link resolves to its (missing) target.
 * @param {string} path
 * @param {number} [depth]
 * @returns {string}
 */
export function resolveTarget(path, depth = 0) {
  try {
    return realpathSync(path);
  } catch {
    /* missing, or a dangling link */
  }
  try {
    if (depth < 16 && lstatSync(path).isSymbolicLink()) return resolveTarget(resolve(dirname(path), readlinkSync(path)), depth + 1);
  } catch {
    /* not there at all */
  }
  return path;
}

/**
 * Write through a temp file and a rename, so a crash never leaves half a file.
 * `mode` (where the OS has modes) is for files that hold a secret and is always applied; without it an existing
 * file keeps the mode it had. Symlinks are followed (see resolveTarget).
 * @param {string} path
 * @param {string} text
 * @param {number} [mode]
 */
export function writeAtomic(path, text, mode) {
  const target = resolveTarget(path);
  let useMode = mode;
  if (useMode === undefined) {
    try { useMode = statSync(target).mode & 0o7777; } catch { /* new file: the umask decides */ }
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, useMode === undefined ? undefined : { mode: useMode });
    if (useMode !== undefined) {
      try { chmodSync(tmp, useMode); } catch { /* Windows */ }
    }
    renameSync(tmp, target);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new CliError(`cannot write ${path}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Write only if the content differs. Returns true when the file changed. A `mode` is enforced even when the content is the same.
 * @param {string} path
 * @param {string} text
 * @param {number} [mode]
 */
export function writeIfChanged(path, text, mode) {
  if (readText(path) === text) {
    if (mode !== undefined) {
      try { chmodSync(resolveTarget(path), mode); } catch { /* Windows */ }
    }
    return false;
  }
  writeAtomic(path, text, mode);
  return true;
}

/**
 * " (line 3, column 5)" from a JSON.parse error, or "". The parser's own message quotes the file, which can hold
 * secrets, so it is never shown.
 * @param {string} text
 * @param {string} message
 */
function where(text, message) {
  const m = /position (\d+)/.exec(message);
  if (!m) return '';
  const before = text.slice(0, Number(m[1]));
  const line = before.split('\n').length;
  const column = before.length - before.lastIndexOf('\n');
  return ` (line ${line}, column ${column})`;
}

/**
 * Parse a JSON object file. Missing gives `fallback`; invalid JSON is an error and the file is left alone.
 * @param {string} path
 * @param {Record<string, any>} fallback
 * @returns {{ value: Record<string, any>, existed: boolean }}
 */
export function readJsonObject(path, fallback) {
  const text = readText(path);
  if (text === null) return { value: structuredClone(fallback), existed: false };
  if (text.trim() === '') return { value: structuredClone(fallback), existed: true };
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new CliError(`${path} is not valid JSON${where(text, /** @type {Error} */ (e).message)}; fix or remove it and run this again. Nothing was changed.`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CliError(`${path} is not a JSON object; nothing was changed.`);
  return { value: v, existed: true };
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {number} [mode]
 */
export function writeJson(path, value, mode) {
  return writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

/**
 * @param {string} path
 */
export function removeFile(path) {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * Remove an empty folder and say whether it went. Never recursive.
 * @param {string} path
 */
export function removeDirIfEmpty(path) {
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
}
