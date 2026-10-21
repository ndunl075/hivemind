/**
 * Installing and removing everything that lives on the laptop (ARCHITECTURE.md §6.1): the hook folder, config.json,
 * Claude Code's and Codex's user-level registrations. Used by join, update and leave.
 *
 * What was added is recorded in $HIVEMIND_HOME/install.json (no secrets), so `leave` removes exactly that.
 * @typedef {import('./context.mjs').Context} Context
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexMcpBlock, hasOurBlock, removeBlock, setBlock } from './codex-config.mjs';
import { CliError, paths } from './context.mjs';
import { readJsonObject, readText, removeDirIfEmpty, removeFile, writeAtomic, writeIfChanged, writeJson } from './files.mjs';
import { mergeHooks, oursMatcher, removeHooks } from './hooks-merge.mjs';
import {
  ALLOW_RULE, CLAUDE_SPECS, CODEX_SPECS, addJsonCommands, claudeHandler, claudeMcpJson, codexHandler, headersHelperCommand,
  helperCmdText, isOurHelper,
} from './registrations.mjs';

/** The hook's runtime files; tests (*.test.mjs) are never copied. */
export const HOOK_FILES = ['hook.mjs', 'claude.mjs', 'codex.mjs', 'git.mjs', 'limits.mjs'];
/** The helper that sits next to them. */
export const HELPER_FILE = 'headers-helper.mjs';
/** The Windows wrapper that runs it (written on Windows only, removed everywhere). */
export const HELPER_CMD_FILE = 'headers-helper.cmd';

/**
 * @typedef {{ server: string, room: string, person: string, token: string, repos: string[] }} HivemindConfig
 * @typedef {{
 *   version: 1,
 *   node: string,
 *   claude: { settings: boolean, settingsCreated: boolean, allowAdded: boolean, mcp: boolean },
 *   codex: { hooks: boolean, hooksCreated: boolean, config: boolean, configCreated: boolean },
 * }} Manifest
 */

/** @returns {Manifest} */
function emptyManifest() {
  return {
    version: 1,
    node: '',
    claude: { settings: false, settingsCreated: false, allowAdded: false, mcp: false },
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
    return { ...base, ...m, claude: { ...base.claude, ...m.claude }, codex: { ...base.codex, ...m.codex } };
  } catch {
    return null;
  }
}

/**
 * @param {Context} ctx
 * @returns {HivemindConfig | null}
 */
export function readConfig(ctx) {
  const text = readText(paths(ctx).config);
  if (text === null) return null;
  try {
    const c = JSON.parse(text);
    if (typeof c?.server !== 'string' || typeof c?.token !== 'string' || !Array.isArray(c?.repos)) return null;
    return {
      server: c.server,
      room: String(c.room ?? ''),
      person: String(c.person ?? ''),
      token: c.token,
      repos: c.repos.filter((/** @type {unknown} */ r) => typeof r === 'string'),
    };
  } catch {
    return null;
  }
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
  ];
  for (const [src, name] of files) {
    const text = readText(fileURLToPath(src));
    if (text === null) throw new CliError(`the Hivemind package is incomplete: ${name} is missing`);
    if (writeIfChanged(join(p.hookDir, name), text)) changed = true;
  }
  if (ctx.platform === 'win32' && writeIfChanged(p.helperCmd, helperCmdText(ctx.nodePath))) changed = true;
  return changed;
}

/**
 * Write config.json (owner-only). The folder is made owner-only too, where the OS supports it.
 * @param {Context} ctx
 * @param {HivemindConfig} config
 */
export function writeConfig(ctx, config) {
  const p = paths(ctx);
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  try { chmodSync(p.home, 0o700); } catch { /* Windows */ }
  return writeJson(p.config, { server: config.server, room: config.room, person: config.person, token: config.token, repos: config.repos }, 0o600);
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
 * Register with Claude Code: hooks and the allow rule in settings.json, and the MCP server through the claude CLI.
 * @param {Context} ctx
 * @param {HivemindConfig} config
 * @param {Manifest} manifest updated in place
 * @param {boolean} claudeOnPath
 * @param {Report} report
 */
async function registerClaude(ctx, config, manifest, claudeOnPath, report) {
  const p = paths(ctx);
  const isOurs = oursMatcher(p.hookScript);
  const { value: settings, existed } = readJsonObject(p.claudeSettings, {});
  const next = mergeHooks(settings, CLAUDE_SPECS, (spec) => claudeHandler(ctx.nodePath, p.hookScript, spec), isOurs);
  if (next.permissions === undefined) next.permissions = {};
  if (typeof next.permissions !== 'object' || next.permissions === null || Array.isArray(next.permissions)) {
    throw new CliError(`"permissions" in ${p.claudeSettings} is not an object; nothing was changed.`);
  }
  const perms = /** @type {Record<string, any>} */ (next.permissions);
  if (perms.allow === undefined) perms.allow = [];
  if (!Array.isArray(perms.allow)) throw new CliError(`"permissions.allow" in ${p.claudeSettings} is not a list; nothing was changed.`);
  if (!perms.allow.includes(ALLOW_RULE)) {
    perms.allow.push(ALLOW_RULE);
    manifest.claude.allowAdded = true;
  }
  if (!same(next, settings)) writeJson(p.claudeSettings, next);
  manifest.claude.settings = true;
  manifest.claude.settingsCreated = manifest.claude.settingsCreated || !existed;
  report.lines.push(`Claude Code: hooks registered in ${p.claudeSettings}`);

  // The MCP server: the JSON holds the URL and a headersHelper, never the token.
  const helper = headersHelperCommand(ctx.platform, ctx.nodePath, p.helperScript, p.helperCmd);
  const json = JSON.stringify(claudeMcpJson(config.server, helper));
  if (!claudeOnPath) {
    const by = addJsonCommands(ctx.platform, json).map((c) => `  ${c.shell}:  ${c.command}`).join('\n');
    report.warnings.push(
      `Claude Code: the "claude" program was not found, so the MCP server was not added. Once it is on your PATH, run: hivemind update\nOr add it by hand:\n${by}`,
    );
    return;
  }
  const got = await ctx.runner('claude', ['mcp', 'get', 'hivemind']);
  if (got.code === 0) {
    // An entry named "hivemind" that is not ours belongs to the user: never replace it.
    if (!isOurHelper(got.stdout, p.helperScript, p.helperCmd) && !manifest.claude.mcp) {
      throw new CliError(
        'Claude Code already has its own MCP server named "hivemind", so the Hivemind one was not added. Rename or remove yours (claude mcp remove --scope user hivemind), then run hivemind update.',
      );
    }
    if (got.stdout.includes(`${config.server}/mcp`) && got.stdout.includes(helper)) {
      manifest.claude.mcp = true;
      report.lines.push('Claude Code: MCP server "hivemind" already set up');
      return;
    }
    const removed = await ctx.runner('claude', ['mcp', 'remove', '--scope', 'user', 'hivemind']);
    if (removed.code !== 0) throw new CliError(`could not replace Hivemind's old MCP entry (${firstLine(removed.stderr || removed.stdout)}); run: claude mcp remove --scope user hivemind`);
  }
  const added = await ctx.runner('claude', ['mcp', 'add-json', '--scope', 'user', 'hivemind', json]);
  if (added.code !== 0) {
    report.failed = true;
    report.warnings.push(`Claude Code: "claude mcp add-json" failed: ${firstLine(added.stderr || added.stdout)}`);
    return;
  }
  manifest.claude.mcp = true;
  report.lines.push('Claude Code: MCP server "hivemind" added (user scope)');
}

/**
 * Register with Codex: hooks in hooks.json (command and commandWindows), and the MCP table in config.toml.
 * @param {Context} ctx
 * @param {HivemindConfig} config
 * @param {Manifest} manifest updated in place
 * @param {Report} report
 */
function registerCodex(ctx, config, manifest, report) {
  const p = paths(ctx);
  const isOurs = oursMatcher(p.hookScript);
  const { value: hooks, existed } = readJsonObject(p.codexHooks, {});
  const next = mergeHooks(hooks, CODEX_SPECS, (spec) => codexHandler(ctx.nodePath, p.hookScript, spec), isOurs);
  // Check the TOML before writing anything, so a conflict leaves both Codex files untouched.
  const toml = readText(p.codexToml);
  const tomlNext = setBlock(toml, codexMcpBlock(config.server, config.token), p.codexToml);
  if (!same(next, hooks)) writeJson(p.codexHooks, next);
  manifest.codex.hooks = true;
  manifest.codex.hooksCreated = manifest.codex.hooksCreated || !existed;
  writeIfChanged(p.codexToml, tomlNext, 0o600); // it holds the token: owner-only, even if the file was 0644 before
  manifest.codex.config = true;
  manifest.codex.configCreated = manifest.codex.configCreated || toml === null;
  report.lines.push(`Codex: hooks registered in ${p.codexHooks}, MCP server in ${p.codexToml}`);
  report.lines.push('Codex: open Codex and approve the new hooks once with /hooks');
}

/**
 * The shared part of join and update.
 * @param {Context} ctx
 * @param {HivemindConfig} config
 * @returns {Promise<Report>}
 */
export async function installAll(ctx, config) {
  const p = paths(ctx);
  /** @type {Report} */
  const report = { lines: [], warnings: [], failed: false };
  writeConfig(ctx, config);
  copyRuntime(ctx);
  report.lines.push(`Hook installed in ${p.hookDir}`);
  const apps = await detectApps(ctx);
  const manifest = readManifest(ctx) ?? emptyManifest();
  manifest.node = ctx.nodePath;

  if (apps.claude) {
    try {
      await registerClaude(ctx, config, manifest, apps.claudeOnPath, report);
    } catch (e) {
      report.failed = true;
      report.warnings.push(`Claude Code: ${/** @type {Error} */ (e).message}`);
    }
  } else {
    report.lines.push('Claude Code: not found, skipped');
  }
  if (apps.codex) {
    try {
      registerCodex(ctx, config, manifest, report);
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
 * Remove exactly what join added.
 * @param {Context} ctx
 * @returns {Promise<Report>}
 */
export async function uninstallAll(ctx) {
  const p = paths(ctx);
  /** @type {Report} */
  const report = { lines: [], warnings: [], failed: false };
  const manifest = readManifest(ctx);
  const isOurs = oursMatcher(p.hookScript);

  // Claude settings.json
  try {
    const { value: settings, existed } = readJsonObject(p.claudeSettings, {});
    if (existed) {
      let next = removeHooks(settings, isOurs);
      if (manifest?.claude.allowAdded && Array.isArray(next.permissions?.allow)) {
        next.permissions = { ...next.permissions, allow: next.permissions.allow.filter((/** @type {unknown} */ r) => r !== ALLOW_RULE) };
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

  // Claude MCP server: only an entry that is ours (join recorded it, or its helper path is ours).
  try {
    const got = await ctx.runner('claude', ['mcp', 'get', 'hivemind']);
    if (got.code === 0) {
      if (isOurHelper(got.stdout, p.helperScript, p.helperCmd)) {
        const r = await ctx.runner('claude', ['mcp', 'remove', '--scope', 'user', 'hivemind']);
        if (r.code === 0) report.lines.push('Claude Code: MCP server "hivemind" removed');
        else {
          report.failed = true;
          report.warnings.push(`Claude Code: could not remove the MCP server (${firstLine(r.stderr || r.stdout)}). Run: claude mcp remove --scope user hivemind`);
        }
      } else {
        report.lines.push('Claude Code: the MCP server named "hivemind" is not the Hivemind one, so it was left alone');
      }
    } else if (got.code === 127 && manifest?.claude.mcp === true) {
      report.failed = true;
      report.warnings.push('Claude Code: the "claude" program was not found, so the MCP server could not be removed. Put it on your PATH, or run: claude mcp remove --scope user hivemind');
    }
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
    if (toml !== null && hasOurBlock(toml)) {
      const rest = removeBlock(toml, p.codexToml);
      if (manifest?.codex.configCreated && rest.trim() === '') removeFile(p.codexToml);
      else writeAtomic(p.codexToml, rest);
      report.lines.push(`Codex: MCP server removed from ${p.codexToml}`);
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
  for (const f of [...HOOK_FILES, HELPER_FILE, HELPER_CMD_FILE]) removeFile(join(p.hookDir, f));
  removeDirIfEmpty(p.hookDir);
  for (const f of [p.config, p.manifest, p.off, p.hookLog, `${p.hookLog}.1`]) removeFile(f);
  if (existsSync(p.state)) rmSync(p.state, { recursive: true, force: true });
  if (existsSync(p.home) && readdirSync(p.home).length === 0) removeDirIfEmpty(p.home);
  report.lines.push(`Removed Hivemind's files from ${p.home}`);
  return report;
}
