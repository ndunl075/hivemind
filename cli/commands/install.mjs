/**
 * Installing and removing everything that lives on the laptop (ARCHITECTURE.md §6.1): the hook folder, config.json,
 * Claude Code's and Codex's user-level registrations. Used by join, update and leave.
 *
 * A laptop can be in several rooms (rooms.mjs). The hook folder and the hook registrations are shared; each room has
 * its own MCP server (`hivemind`, `hivemind-<room>`) in Claude Code and its own table in Codex's config.toml, and its
 * own permission rule. Installing reconciles the registrations with the room list: rooms in the list are added or
 * refreshed, rooms Hivemind registered earlier that are no longer in it are removed.
 *
 * What was added is recorded in $HIVEMIND_HOME/install.json (no secrets), so `leave` removes exactly that.
 * @typedef {import('./context.mjs').Context} Context
 * @typedef {import('./rooms.mjs').RoomEntry} HivemindConfig
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockNames, codexMcpBlock, hasOurBlock, removeBlock, setBlock, tomlServerNames } from './codex-config.mjs';
import { CliError, paths } from './context.mjs';
import { readJsonObject, readText, removeDirIfEmpty, removeFile, writeAtomic, writeIfChanged, writeJson } from './files.mjs';
import { mergeHooks, oursMatcher, removeHooks } from './hooks-merge.mjs';
import {
  ALLOW_RULE, CLAUDE_SPECS, CODEX_SPECS, addJsonCommands, allowRule, claudeHandler, claudeMcpJson, codexHandler, headersHelperCommand,
  helperCmdText, isOurHelper,
} from './registrations.mjs';
import { DEFAULT_MCP, candidateNames, configJson, roomsFromJson } from './rooms.mjs';

/** The hook's runtime files; tests (*.test.mjs) are never copied. */
export const HOOK_FILES = ['hook.mjs', 'claude.mjs', 'codex.mjs', 'git.mjs', 'limits.mjs'];
/** The helper that sits next to them: the plain `hivemind` server uses this one. */
export const HELPER_FILE = 'headers-helper.mjs';
/** The Windows wrapper that runs it (written on Windows only, removed everywhere). */
export const HELPER_CMD_FILE = 'headers-helper.cmd';
/**
 * The same helper under a name only this version knows, for every other room's server. An older CLI rewrites
 * headers-helper.mjs with its own (argument-ignoring) version and never touches this one, so after a downgrade the
 * servers that depend on the arguments keep running a helper that checks them.
 */
export const ROOM_HELPER_FILE = 'headers-helper-room.mjs';
export const ROOM_HELPER_CMD_FILE = 'headers-helper-room.cmd';

/**
 * `mcp` and `allowRules` are lists of what Hivemind registered / added (a manifest written before several rooms
 * existed has neither: `mcp: true` then means the server named `hivemind`, and `allowAdded` its rule).
 * @typedef {{
 *   version: 1,
 *   node: string,
 *   claude: { settings: boolean, settingsCreated: boolean, allowAdded: boolean, mcp: boolean, mcpServers: string[], allowRules: string[] },
 *   codex: { hooks: boolean, hooksCreated: boolean, config: boolean, configCreated: boolean },
 * }} Manifest
 */

/** @returns {Manifest} */
function emptyManifest() {
  return {
    version: 1,
    node: '',
    claude: { settings: false, settingsCreated: false, allowAdded: false, mcp: false, mcpServers: [], allowRules: [] },
    codex: { hooks: false, hooksCreated: false, config: false, configCreated: false },
  };
}

/**
 * @param {Context} ctx
 * @returns {Manifest | null}
 */
export function readManifest(ctx) {
  const text = readText(paths(ctx).manifest);
  if (text === null) return null;
  try {
    const m = JSON.parse(text);
    const base = emptyManifest();
    const out = { ...base, ...m, claude: { ...base.claude, ...m.claude }, codex: { ...base.codex, ...m.codex } };
    if (!Array.isArray(m.claude?.mcpServers)) out.claude.mcpServers = m.claude?.mcp === true ? [DEFAULT_MCP] : [];
    if (!Array.isArray(m.claude?.allowRules)) out.claude.allowRules = m.claude?.allowAdded === true ? [ALLOW_RULE] : [];
    return out;
  } catch {
    return null;
  }
}

/**
 * Every room in config.json, old single-room format or new. Null when the file is missing or unusable.
 * @param {Context} ctx
 * @returns {HivemindConfig[] | null}
 */
export function readRooms(ctx) {
  const text = readText(paths(ctx).config);
  if (text === null) return null;
  try {
    return roomsFromJson(JSON.parse(text.replace(/^﻿/, '')));
  } catch {
    return null;
  }
}

/**
 * The primary room (the one the plain `hivemind` MCP server serves): what callers that only need a server address
 * read, and what an older CLI sees. Null when there is no config.
 * @param {Context} ctx
 * @returns {HivemindConfig | null}
 */
export function readConfig(ctx) {
  const rooms = readRooms(ctx);
  if (!rooms) return null;
  return rooms.find((r) => r.mcp === DEFAULT_MCP) ?? rooms[0] ?? null;
}

/**
 * Run `fn` while holding the Hivemind lock (an exclusively created file in the Hivemind home), so two commands that
 * change the setup (join, update, leave) can't interleave their reads and writes of config.json and the registrations.
 * A lock older than a minute belongs to a command that died and is taken over.
 * @template T
 * @param {Context} ctx
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(ctx, fn) {
  const p = paths(ctx);
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  const give = Date.now() + 15000;
  for (;;) {
    try {
      const fd = openSync(p.lock, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(p.lock).mtimeMs > 60000) {
          unlinkSync(p.lock);
          continue;
        }
      } catch { /* it just went away: try again */ }
      if (Date.now() > give) throw new CliError(`another hivemind command is changing this laptop's setup (${p.lock}). Wait for it to finish; if none is running, delete that file.`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(p.lock); } catch { /* gone */ }
    removeDirIfEmpty(p.home); // a leave that removed everything else leaves the folder to us
  }
}

/**
 * MCP server names a new room must not take: ones Hivemind registered and may still have (a room that was left but whose
 * server could not be removed), and any candidate that Claude Code or Codex already has under that name (the user's own).
 * @param {Context} ctx
 * @param {string} room
 * @returns {Promise<Set<string>>}
 */
export async function takenMcpNames(ctx, room) {
  const taken = new Set(readManifest(ctx)?.claude.mcpServers ?? []);
  const toml = readText(paths(ctx).codexToml);
  const tomlNames = tomlServerNames(toml);
  const ourBlocks = toml === null ? [] : blockNames(toml);
  for (const n of candidateNames(room, 12)) {
    // Ours are rewritten by the join that is about to run; anyone else's stay.
    if (tomlNames.has(n) && !ourBlocks.includes(n)) taken.add(n);
    const got = await ctx.runner('claude', ['mcp', 'get', n]);
    if (got.code === 0 && !isOurHelperText(ctx, got.stdout)) taken.add(n);
  }
  return taken;
}

/**
 * The hook files, byte for byte as they ship. Returns true if anything changed.
 * @param {Context} ctx
 */
export function copyRuntime(ctx) {
  const p = paths(ctx);
  mkdirSync(p.hookDir, { recursive: true, mode: 0o700 });
  let changed = false;
  /** @type {Array<[URL, string]>} */
  const files = [
    ...HOOK_FILES.map((f) => /** @type {[URL, string]} */ ([new URL(`../hook/${f}`, import.meta.url), f])),
    [new URL(`./${HELPER_FILE}`, import.meta.url), HELPER_FILE],
    [new URL(`./${HELPER_FILE}`, import.meta.url), ROOM_HELPER_FILE],
  ];
  for (const [src, name] of files) {
    const text = readText(fileURLToPath(src));
    if (text === null) throw new CliError(`the Hivemind package is incomplete: ${name} is missing`);
    if (writeIfChanged(join(p.hookDir, name), text)) changed = true;
  }
  if (ctx.platform === 'win32') {
    if (writeIfChanged(p.helperCmd, helperCmdText(ctx.nodePath))) changed = true;
    if (writeIfChanged(p.roomHelperCmd, helperCmdText(ctx.nodePath, ROOM_HELPER_FILE))) changed = true;
  }
  return changed;
}

/**
 * Write config.json (owner-only): the rooms, plus the primary room's fields at the top level so an older hook or
 * helper still reads it (rooms.mjs). The folder is made owner-only too, where the OS supports it.
 * @param {Context} ctx
 * @param {HivemindConfig[]} rooms at least one
 */
export function writeConfig(ctx, rooms) {
  const p = paths(ctx);
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  try { chmodSync(p.home, 0o700); } catch { /* Windows */ }
  return writeJson(p.config, configJson(rooms), 0o600);
}

/**
 * Which apps to register with: the config folder exists, or the program answers.
 * @param {Context} ctx
 */
export async function detectApps(ctx) {
  const p = paths(ctx);
  const [claudeRun, codexRun] = await Promise.all([ctx.runner('claude', ['--version']), ctx.runner('codex', ['--version'])]);
  return {
    claude: existsSync(p.claudeDir) || claudeRun.code === 0,
    claudeOnPath: claudeRun.code === 0,
    codex: existsSync(p.codexDir) || codexRun.code === 0,
  };
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @typedef {{ lines: string[], warnings: string[], failed: boolean }} Report
 */

/**
 * The helper script and Windows wrapper for a server: `hivemind` has the original files, every other server the
 * room-only copies.
 * @param {Context} ctx
 * @param {string} mcp
 */
export function helperFiles(ctx, mcp) {
  const p = paths(ctx);
  return mcp === DEFAULT_MCP ? { script: p.helperScript, cmd: p.helperCmd } : { script: p.roomHelperScript, cmd: p.roomHelperCmd };
}

/** @param {Context} ctx @param {string} mcp @param {string} server */
function helperCommandFor(ctx, mcp, server) {
  const { script, cmd } = helperFiles(ctx, mcp);
  return headersHelperCommand(ctx.platform, ctx.nodePath, script, cmd, mcp, new URL(server).origin);
}

/**
 * Whether text from `claude mcp get` names one of our helper files.
 * @param {Context} ctx
 * @param {string} text
 */
export function isOurHelperText(ctx, text) {
  const p = paths(ctx);
  return isOurHelper(text, p.helperScript, p.helperCmd, p.roomHelperScript, p.roomHelperCmd);
}

/**
 * The command in the "Headers helper:" line of `claude mcp get`, or null when the output has no such line.
 * @param {string} text
 */
function printedHelper(text) {
  const m = /^\s*headers[ _-]?helper\s*:\s*(.*?)\s*$/im.exec(text);
  return m ? (m[1] ?? null) : null;
}

/**
 * One room's MCP server in Claude Code, through the claude CLI.
 * @param {Context} ctx
 * @param {HivemindConfig} room
 * @param {Manifest} manifest updated in place
 * @param {Report} report
 */
async function registerClaudeMcp(ctx, room, manifest, report) {
  const name = room.mcp;
  // The JSON holds the URL and a headersHelper, never the token. The helper is told which server it serves.
  const helper = helperCommandFor(ctx, name, room.server);
  const json = JSON.stringify(claudeMcpJson(room.server, helper));
  const got = await ctx.runner('claude', ['mcp', 'get', name]);
  if (got.code === 0) {
    // An entry with this name that is not ours belongs to the user: never replace it.
    if (!isOurHelperText(ctx, got.stdout) && !manifest.claude.mcpServers.includes(name)) {
      throw new CliError(
        `Claude Code already has its own MCP server named "${name}", so the Hivemind one was not added. Rename or remove yours (claude mcp remove --scope user ${name}), then run hivemind update.`,
      );
    }
    // Exactly this URL and exactly this helper command, as parsed from the output; anything else is replaced.
    if (got.stdout.includes(`${room.server}/mcp`) && printedHelper(got.stdout) === helper) {
      noteMcp(manifest, name);
      report.lines.push(`Claude Code: MCP server "${name}" already set up`);
      return;
    }
    const removed = await ctx.runner('claude', ['mcp', 'remove', '--scope', 'user', name]);
    if (removed.code !== 0) throw new CliError(`could not replace Hivemind's old MCP entry (${firstLine(removed.stderr || removed.stdout)}); run: claude mcp remove --scope user ${name}`);
  }
  const added = await ctx.runner('claude', ['mcp', 'add-json', '--scope', 'user', name, json]);
  if (added.code !== 0) {
    report.failed = true;
    report.warnings.push(`Claude Code: "claude mcp add-json" failed for "${name}": ${firstLine(added.stderr || added.stdout)}`);
    return;
  }
  noteMcp(manifest, name);
  report.lines.push(`Claude Code: MCP server "${name}" added (user scope)`);
}

/**
 * @param {Manifest} manifest
 * @param {string} name
 */
function noteMcp(manifest, name) {
  if (!manifest.claude.mcpServers.includes(name)) manifest.claude.mcpServers.push(name);
  manifest.claude.mcp = true;
}

/**
 * Register with Claude Code: hooks and the allow rules in settings.json, and one MCP server per room through the
 * claude CLI. Rooms Hivemind registered before that are no longer in the list are removed.
 * @param {Context} ctx
 * @param {HivemindConfig[]} rooms
 * @param {Manifest} manifest updated in place
 * @param {boolean} claudeOnPath
 * @param {Report} report
 */
async function registerClaude(ctx, rooms, manifest, claudeOnPath, report) {
  const p = paths(ctx);
  const isOursHook = oursMatcher(p.hookScript);
  const { value: settings, existed } = readJsonObject(p.claudeSettings, {});
  const next = mergeHooks(settings, CLAUDE_SPECS, (spec) => claudeHandler(ctx.nodePath, p.hookScript, spec), isOursHook);
  if (next.permissions === undefined) next.permissions = {};
  if (typeof next.permissions !== 'object' || next.permissions === null || Array.isArray(next.permissions)) {
    throw new CliError(`"permissions" in ${p.claudeSettings} is not an object; nothing was changed.`);
  }
  const perms = /** @type {Record<string, any>} */ (next.permissions);
  if (perms.allow === undefined) perms.allow = [];
  if (!Array.isArray(perms.allow)) throw new CliError(`"permissions.allow" in ${p.claudeSettings} is not a list; nothing was changed.`);
  const wanted = rooms.map((r) => allowRule(r.mcp));
  for (const rule of wanted) {
    if (!perms.allow.includes(rule)) {
      perms.allow.push(rule);
      if (!manifest.claude.allowRules.includes(rule)) manifest.claude.allowRules.push(rule);
      if (rule === ALLOW_RULE) manifest.claude.allowAdded = true;
    }
  }
  // A rule we added for a room that is gone goes too (one the user had before us stays).
  const stale = manifest.claude.allowRules.filter((r) => !wanted.includes(r));
  if (stale.length > 0) {
    perms.allow = perms.allow.filter((/** @type {unknown} */ r) => !stale.includes(/** @type {string} */ (r)));
    manifest.claude.allowRules = manifest.claude.allowRules.filter((r) => wanted.includes(r));
    if (stale.includes(ALLOW_RULE)) manifest.claude.allowAdded = false;
  }
  if (!same(next, settings)) writeJson(p.claudeSettings, next);
  manifest.claude.settings = true;
  manifest.claude.settingsCreated = manifest.claude.settingsCreated || !existed;
  report.lines.push(`Claude Code: hooks registered in ${p.claudeSettings}`);

  if (!claudeOnPath) {
    // Servers of rooms that are gone cannot be removed without claude: say so loudly, and keep them on record.
    for (const gone of manifest.claude.mcpServers.filter((n) => !rooms.some((r) => r.mcp === n))) {
      report.failed = true;
      report.warnings.push(`Claude Code: the "claude" program was not found, so the MCP server "${gone}" of a room you left could not be removed. Put claude on your PATH and run hivemind update, or run: claude mcp remove --scope user ${gone}`);
    }
    for (const room of rooms) {
      const helper = helperCommandFor(ctx, room.mcp, room.server);
      const json = JSON.stringify(claudeMcpJson(room.server, helper));
      const by = addJsonCommands(ctx.platform, json, `claude mcp add-json --scope user ${room.mcp}`).map((c) => `  ${c.shell}:  ${c.command}`).join('\n');
      report.warnings.push(
        `Claude Code: the "claude" program was not found, so the MCP server "${room.mcp}" was not added. Once it is on your PATH, run: hivemind update\nOr add it by hand:\n${by}`,
      );
    }
    return;
  }
  for (const room of rooms) {
    try {
      await registerClaudeMcp(ctx, room, manifest, report);
    } catch (e) {
      report.failed = true;
      report.warnings.push(`Claude Code: ${/** @type {Error} */ (e).message}`);
    }
  }
  // Servers we registered for rooms that are gone.
  const keep = rooms.map((r) => r.mcp);
  for (const name of [...manifest.claude.mcpServers]) {
    if (keep.includes(name)) continue;
    await removeClaudeMcp(ctx, name, manifest, report);
  }
  manifest.claude.mcp = manifest.claude.mcpServers.length > 0;
}

/**
 * Remove one of our MCP servers from Claude Code, if it is still ours.
 * @param {Context} ctx
 * @param {string} name
 * @param {Manifest | null} manifest updated in place
 * @param {Report} report
 */
async function removeClaudeMcp(ctx, name, manifest, report) {
  const got = await ctx.runner('claude', ['mcp', 'get', name]);
  if (got.code === 0) {
    if (isOurHelperText(ctx, got.stdout)) {
      const r = await ctx.runner('claude', ['mcp', 'remove', '--scope', 'user', name]);
      if (r.code === 0) {
        report.lines.push(`Claude Code: MCP server "${name}" removed`);
        if (manifest) manifest.claude.mcpServers = manifest.claude.mcpServers.filter((n) => n !== name);
      } else {
        report.failed = true;
        report.warnings.push(`Claude Code: could not remove the MCP server "${name}" (${firstLine(r.stderr || r.stdout)}). Run: claude mcp remove --scope user ${name}`);
      }
    } else {
      report.lines.push(`Claude Code: the MCP server named "${name}" is not the Hivemind one, so it was left alone`);
      if (manifest) manifest.claude.mcpServers = manifest.claude.mcpServers.filter((n) => n !== name);
    }
  } else if (got.code === 127 && manifest?.claude.mcpServers.includes(name)) {
    report.failed = true;
    report.warnings.push(`Claude Code: the "claude" program was not found, so the MCP server "${name}" could not be removed. Put it on your PATH, or run: claude mcp remove --scope user ${name}`);
  } else if (manifest) {
    manifest.claude.mcpServers = manifest.claude.mcpServers.filter((n) => n !== name); // already gone
  }
}

/**
 * Register with Codex: hooks in hooks.json (command and commandWindows), and one MCP table per room in config.toml.
 * @param {Context} ctx
 * @param {HivemindConfig[]} rooms
 * @param {Manifest} manifest updated in place
 * @param {Report} report
 */
function registerCodex(ctx, rooms, manifest, report) {
  const p = paths(ctx);
  const isOurs = oursMatcher(p.hookScript);
  const { value: hooks, existed } = readJsonObject(p.codexHooks, {});
  const next = mergeHooks(hooks, CODEX_SPECS, (spec) => codexHandler(ctx.nodePath, p.hookScript, spec), isOurs);
  // Check the TOML before writing anything, so a conflict leaves both Codex files untouched.
  const toml = readText(p.codexToml);
  let tomlNext = toml;
  for (const room of rooms) tomlNext = setBlock(tomlNext, codexMcpBlock(room.server, room.token, room.mcp), p.codexToml, room.mcp);
  const keep = rooms.map((r) => r.mcp);
  for (const name of blockNames(tomlNext ?? '')) if (!keep.includes(name)) tomlNext = removeBlock(tomlNext ?? '', p.codexToml, name);
  if (!same(next, hooks)) writeJson(p.codexHooks, next);
  manifest.codex.hooks = true;
  manifest.codex.hooksCreated = manifest.codex.hooksCreated || !existed;
  writeIfChanged(p.codexToml, tomlNext ?? '', 0o600); // it holds the tokens: owner-only, even if the file was 0644 before
  manifest.codex.config = true;
  manifest.codex.configCreated = manifest.codex.configCreated || toml === null;
  report.lines.push(`Codex: hooks registered in ${p.codexHooks}, MCP server${rooms.length === 1 ? '' : 's'} in ${p.codexToml}`);
  report.lines.push('Codex: open Codex and approve the new hooks once with /hooks');
}

/**
 * The shared part of join and update: write config.json for these rooms and make every registration match them.
 * @param {Context} ctx
 * @param {HivemindConfig | HivemindConfig[]} config one room, or the whole list (at least one)
 * @returns {Promise<Report>}
 */
export async function installAll(ctx, config) {
  const rooms = Array.isArray(config) ? config : [config];
  if (rooms.length === 0) throw new CliError('no room to install');
  const p = paths(ctx);
  /** @type {Report} */
  const report = { lines: [], warnings: [], failed: false };
  writeConfig(ctx, rooms);
  copyRuntime(ctx);
  report.lines.push(`Hook installed in ${p.hookDir}`);
  const apps = await detectApps(ctx);
  const manifest = readManifest(ctx) ?? emptyManifest();
  manifest.node = ctx.nodePath;

  if (apps.claude) {
    try {
      await registerClaude(ctx, rooms, manifest, apps.claudeOnPath, report);
    } catch (e) {
      report.failed = true;
      report.warnings.push(`Claude Code: ${/** @type {Error} */ (e).message}`);
    }
  } else {
    report.lines.push('Claude Code: not found, skipped');
  }
  if (apps.codex) {
    try {
      registerCodex(ctx, rooms, manifest, report);
    } catch (e) {
      report.failed = true;
      report.warnings.push(`Codex: ${/** @type {Error} */ (e).message}`);
    }
  } else {
    report.lines.push('Codex: not found, skipped');
  }
  writeJson(p.manifest, manifest, 0o600);
  return report;
}

/**
 * @param {string} s
 */
function firstLine(s) {
  return s.trim().split('\n')[0] || 'no message';
}

/**
 * Remove exactly what join added: every room's registrations, then Hivemind's own folder.
 * @param {Context} ctx
 * @returns {Promise<Report>}
 */
export async function uninstallAll(ctx) {
  const p = paths(ctx);
  /** @type {Report} */
  const report = { lines: [], warnings: [], failed: false };
  const manifest = readManifest(ctx);
  const isOurs = oursMatcher(p.hookScript);
  const rooms = readRooms(ctx) ?? [];

  // Claude settings.json
  try {
    const { value: settings, existed } = readJsonObject(p.claudeSettings, {});
    if (existed) {
      let next = removeHooks(settings, isOurs);
      const added = new Set([...(manifest?.claude.allowRules ?? []), ...(manifest?.claude.allowAdded ? [ALLOW_RULE] : [])]);
      if (added.size > 0 && Array.isArray(next.permissions?.allow)) {
        next.permissions = { ...next.permissions, allow: next.permissions.allow.filter((/** @type {unknown} */ r) => !added.has(/** @type {string} */ (r))) };
        if (next.permissions.allow.length === 0) delete next.permissions.allow;
        if (Object.keys(next.permissions).length === 0) delete next.permissions;
      }
      if (!same(next, settings)) {
        if (manifest?.claude.settingsCreated && Object.keys(next).length === 0) removeFile(p.claudeSettings);
        else writeJson(p.claudeSettings, next);
        report.lines.push(`Claude Code: hooks removed from ${p.claudeSettings}`);
      }
    }
  } catch (e) {
    report.failed = true;
    report.warnings.push(`Claude Code settings: ${/** @type {Error} */ (e).message}`);
  }

  // Claude MCP servers: only entries that are ours (join recorded them, or their helper path is ours).
  try {
    const names = [...new Set([DEFAULT_MCP, ...(manifest?.claude.mcpServers ?? []), ...rooms.map((r) => r.mcp)])];
    for (const name of names) await removeClaudeMcp(ctx, name, manifest, report);
  } catch (e) {
    report.failed = true;
    report.warnings.push(`Claude Code MCP: ${/** @type {Error} */ (e).message}`);
  }

  // Codex hooks.json and config.toml
  try {
    const { value: hooks, existed } = readJsonObject(p.codexHooks, {});
    if (existed) {
      const next = removeHooks(hooks, isOurs);
      if (!same(next, hooks)) {
        if (manifest?.codex.hooksCreated && Object.keys(next).length === 0) removeFile(p.codexHooks);
        else writeJson(p.codexHooks, next);
        report.lines.push(`Codex: hooks removed from ${p.codexHooks}`);
      }
    }
  } catch (e) {
    report.failed = true;
    report.warnings.push(`Codex hooks: ${/** @type {Error} */ (e).message}`);
  }
  try {
    const toml = readText(p.codexToml);
    if (toml !== null && blockNames(toml).length > 0) {
      let rest = toml;
      for (const name of blockNames(toml)) if (hasOurBlock(rest, name)) rest = removeBlock(rest, p.codexToml, name);
      if (manifest?.codex.configCreated && rest.trim() === '') removeFile(p.codexToml);
      else writeAtomic(p.codexToml, rest);
      report.lines.push(`Codex: MCP server${blockNames(toml).length === 1 ? '' : 's'} removed from ${p.codexToml}`);
    }
  } catch (e) {
    report.failed = true;
    report.warnings.push(`Codex config: ${/** @type {Error} */ (e).message}`);
  }

  // Our own folder: only the files we created, and only once every registration is gone. If one could not be
  // removed, the hook files and the install record stay so that leave can be run again after it is fixed.
  if (report.failed) {
    report.warnings.push(`Hivemind is only partly removed. ${p.home} (hook files, config and install record) was kept; fix the problem above, then run hivemind leave again.`);
    return report;
  }
  for (const f of [...HOOK_FILES, HELPER_FILE, HELPER_CMD_FILE, ROOM_HELPER_FILE, ROOM_HELPER_CMD_FILE]) removeFile(join(p.hookDir, f));
  removeDirIfEmpty(p.hookDir);
  for (const f of [p.config, p.manifest, p.off, p.hookLog, `${p.hookLog}.1`]) removeFile(f);
  if (existsSync(p.state)) rmSync(p.state, { recursive: true, force: true });
  if (existsSync(p.home) && readdirSync(p.home).length === 0) removeDirIfEmpty(p.home);
  report.lines.push(`Removed Hivemind's files from ${p.home}`);
  return report;
}
