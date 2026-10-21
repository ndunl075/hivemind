/**
 * File helpers: atomic writes, owner-only permissions, and read-parse that refuses to clobber a file it can't read.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
 * Write through a temp file and a rename, so a crash never leaves half a file. `mode` is applied where the OS has modes.
 * @param {string} path
 * @param {string} text
 * @param {number} [mode]
 */
export function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) {
      try { chmodSync(tmp, mode); } catch { /* Windows */ }
    }
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new CliError(`cannot write ${path}: ${/** @type {Error} */ (e).message}`);
  }
}

/**
 * Write only if the content differs. Returns true when the file changed.
 * @param {string} path
 * @param {string} text
 * @param {number} [mode]
 */
export function writeIfChanged(path, text, mode) {
  if (readText(path) === text) return false;
  writeAtomic(path, text, mode);
  return true;
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
    throw new CliError(`${path} is not valid JSON (${/** @type {Error} */ (e).message}); fix or remove it and run this again. Nothing was changed.`);
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
