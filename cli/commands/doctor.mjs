/**
 * hivemind doctor (ARCHITECTURE.md §17 step 6): checks this laptop, then prints the self-test prompt to paste into
 * each app. The agent's answer proves hooks fired and MCP works in that surface.
 * @typedef {import('./context.mjs').Context} Context
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from './args.mjs';
import { call, normalizeServer } from './api.mjs';
import { readBlock } from './codex-config.mjs';
import { paths } from './context.mjs';
import { readJsonObject, readText } from './files.mjs';
import { oursMatcher } from './hooks-merge.mjs';
import { HELPER_CMD_FILE, HELPER_FILE, HOOK_FILES, claudeConfigEntry, isOurClaudeEntry, readConfig, readManifest } from './install.mjs';
import { ALLOW_RULE, CLAUDE_SPECS, CODEX_SPECS } from './registrations.mjs';
import { identity } from '../hook/git.mjs';

export const SELF_TEST_PROMPT = [
  'Hivemind self-test. Do these steps in order and report exactly what happened. Do not edit any files.',
  '1. Quote the line of your Hivemind briefing that starts with "[Hivemind] You are". If you have no such briefing, answer HOOKS-MISSING and stop.',
  '2. Call the hivemind tool `status` with `me` set to the callsign from that line. Report the room mode it returns, or MCP-FAILED and the error.',
  '3. Finish with the word HIVEMIND-OK.',
].join('\n');

/**
 * @param {number} ms
 */
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function doctor(argv, ctx) {
  parseArgs(argv);
  const p = paths(ctx);
  let failures = 0;
  /** @param {'ok' | 'warn' | 'FAIL'} level @param {string} msg */
  const line = (level, msg) => {
    if (level === 'FAIL') failures++;
    ctx.out(`${level.padEnd(4)}  ${msg}\n`);
  };

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20 ? 'ok' : 'FAIL', `Node ${process.versions.node} (20 or newer is needed)`);

  // config.json
  const config = readConfig(ctx);
  if (!config) {
    line('FAIL', `${p.config} is missing or unreadable. Run: hivemind join`);
    return finish(ctx, failures);
  }
  line('ok', `config: room "${config.room}", person "${config.person}", ${config.repos.length} repo${config.repos.length === 1 ? '' : 's'} mapped`);
  if (ctx.platform !== 'win32') {
    try {
      const mode = statSync(p.config).mode & 0o777;
      line((mode & 0o077) === 0 ? 'ok' : 'warn', `config.json permissions ${mode.toString(8)}${(mode & 0o077) === 0 ? '' : ' (should be 600: it holds your token)'}`);
    } catch { /* ignore */ }
  }
  if (existsSync(p.off)) line('warn', 'Hivemind is paused on this laptop (hivemind off). Resume with: hivemind on');

  // Server and token
  try {
    const server = normalizeServer(config.server);
    const who = await call(ctx, server, '/whoami', { token: config.token });
    line('ok', `server ${server} accepts the token: ${who.person} in "${who.room}", mode ${who.mode}`);
  } catch (e) {
    line('FAIL', `server check failed: ${/** @type {Error} */ (e).message}`);
  }

  // This repository
  const ident = await identity(ctx.cwd);
  if (!ident) line('warn', 'the current folder is not a Git repository with a commit, so the repo mapping was not checked');
  else line(config.repos.includes(ident.repo) ? 'ok' : 'warn', config.repos.includes(ident.repo) ? 'this repository is mapped to the room' : 'this repository is NOT mapped to the room; run hivemind join inside it');

  // Hook files and node
  const missing = [...HOOK_FILES, HELPER_FILE, ...(ctx.platform === 'win32' ? [HELPER_CMD_FILE] : [])].filter((f) => !existsSync(`${p.hookDir}/${f}`));
  line(missing.length === 0 ? 'ok' : 'FAIL', missing.length === 0 ? `hook files present in ${p.hookDir}` : `hook files missing: ${missing.join(', ')}. Run: hivemind update`);
  const manifest = readManifest(ctx);
  if (manifest?.node) line(existsSync(manifest.node) ? 'ok' : 'FAIL', `node recorded for the hooks: ${manifest.node}${existsSync(manifest.node) ? '' : ' (no longer exists; run hivemind update)'}`);

  const isOurs = oursMatcher(p.hookScript);
  /** @type {string[]} */
  const apps = [];

  // Claude Code
  try {
    const { value: settings, existed } = readJsonObject(p.claudeSettings, {});
    if (existed || manifest?.claude.settings) {
      apps.push('Claude Code');
      checkHooks(settings, CLAUDE_SPECS.map((s) => s.event), isOurs, 'Claude Code', line, (h) => existsSync(String(h.command)) && existsSync(String(h.args?.[0])));
      const allow = settings.permissions?.allow;
      line(Array.isArray(allow) && allow.includes(ALLOW_RULE) ? 'ok' : 'FAIL', `Claude Code: permission rule "${ALLOW_RULE}" ${Array.isArray(allow) && allow.includes(ALLOW_RULE) ? 'present' : 'missing (tools would prompt); run hivemind update'}`);
      const got = await ctx.runner('claude', ['mcp', 'get', 'hivemind']);
      // `claude mcp get` doesn't print the headers helper, so ownership and URL are read from Claude's config file.
      const { entry } = claudeConfigEntry(ctx);
      const missing = /No MCP server named/i.test(`${got.stdout}\n${got.stderr}`);
      if (got.code === 127) line('warn', 'Claude Code: the "claude" program is not on PATH, so the MCP server was not checked');
      else if (got.code !== 0 && !missing) line('warn', `Claude Code: "claude" could not be run, so the MCP server was not checked`);
      else if (got.code !== 0) line('FAIL', 'Claude Code: MCP server "hivemind" is missing; run hivemind update');
      else if (!isOurClaudeEntry(got, entry, p)) line('FAIL', 'Claude Code: the MCP server named "hivemind" is not the Hivemind one (its helper is not ours); rename or remove it, then run hivemind update');
      else if ((typeof entry?.url === 'string' ? entry.url : got.stdout).indexOf(`${normalizeServer(config.server)}/mcp`) === -1) line('FAIL', 'Claude Code: MCP server "hivemind" points at a different URL than config.json; run hivemind update');
      else line('ok', 'Claude Code: MCP server "hivemind" is set up and is ours');
    }
  } catch (e) {
    line('FAIL', `Claude Code: ${/** @type {Error} */ (e).message}`);
  }

  // Codex
  try {
    const { value: hooks, existed } = readJsonObject(p.codexHooks, {});
    if (existed || manifest?.codex.hooks) {
      apps.push('Codex');
      checkHooks(hooks, CODEX_SPECS.map((s) => s.event), isOurs, 'Codex', line, codexHandlerValid);
      const toml = readText(p.codexToml);
      const block = toml === null ? null : readBlock(toml);
      if (!block) line('FAIL', 'Codex: [mcp_servers.hivemind] is missing from config.toml; run hivemind update');
      else {
        const urlOk = block.url === `${normalizeServer(config.server)}/mcp`;
        line(urlOk && block.hasAuth && block.approve ? 'ok' : 'FAIL', `Codex: MCP server ${urlOk ? 'URL matches' : 'URL differs from config.json'}, ${block.hasAuth ? 'has' : 'lacks'} a token header, tools ${block.approve ? 'pre-approved' : 'NOT pre-approved'}`);
      }
    }
  } catch (e) {
    line('FAIL', `Codex: ${/** @type {Error} */ (e).message}`);
  }
  if (apps.length === 0) line('FAIL', 'no Claude Code or Codex registration found. Run: hivemind join');

  // Recent hook activity
  const lastLog = lastHookLogTime(p.hookLog);
  if (lastLog === null) line('warn', 'hook.log has no entries yet: start a Claude Code or Codex session in a mapped repo, then run doctor again');
  else line('ok', `last hook activity ${ago(ctx.now() - lastLog)}`);

  ctx.out('\nSelf-test: paste this into each app you use (Claude Code app, Codex app, IDE extensions).\n');
  ctx.out('The answer must include a "[Hivemind] You are ..." line, a room mode, and HIVEMIND-OK.\n');
  ctx.out('If it says HOOKS-MISSING, hooks do not run in that app; tell the team (agents there work without enforcement).\n\n');
  ctx.out(`${SELF_TEST_PROMPT}\n\n`);
  ctx.out('Codex only: if hooks show as needing review, approve them with /hooks, then restart Codex.\n');
  return finish(ctx, failures);
}

/**
 * @param {Context} ctx
 * @param {number} failures
 */
function finish(ctx, failures) {
  if (failures > 0) ctx.out(`\n${failures} problem${failures === 1 ? '' : 's'} found.\n`);
  return failures > 0 ? 1 : 0;
}

/**
 * @param {Record<string, any>} root
 * @param {string[]} events
 * @param {(h: unknown) => boolean} isOurs
 * @param {string} label
 * @param {(level: 'ok' | 'warn' | 'FAIL', msg: string) => void} line
 * @param {(h: Record<string, any>) => boolean} valid
 */
function checkHooks(root, events, isOurs, label, line, valid) {
  /** @type {string[]} */
  const absent = [];
  /** @type {string[]} */
  const broken = [];
  for (const event of events) {
    const groups = Array.isArray(root.hooks?.[event]) ? root.hooks[event] : [];
    const handlers = groups.flatMap((/** @type {any} */ g) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter(isOurs);
    if (handlers.length === 0) absent.push(event);
    else if (!handlers.every(valid)) broken.push(event);
  }
  if (absent.length) line('FAIL', `${label}: hooks missing for ${absent.join(', ')}; run hivemind update`);
  else if (broken.length) line('FAIL', `${label}: hooks with a bad path or command for ${broken.join(', ')}; run hivemind update`);
  else line('ok', `${label}: all ${events.length} hooks registered with valid paths`);
}

/**
 * Timestamp of the last hook.log line, or null.
 * @param {string} file
 * @returns {number | null}
 */
function lastHookLogTime(file) {
  try {
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const ts = JSON.parse(/** @type {string} */ (lines[i])).ts;
      if (typeof ts === 'number') return ts;
      if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return Date.parse(ts);
    }
  } catch {
    /* none */
  }
  return null;
}

/**
 * A Codex handler is sound when it has both command forms, passes the exit code on under PowerShell, and the node
 * and hook script it names exist.
 * @param {Record<string, any>} h
 */
function codexHandlerValid(h) {
  if (typeof h.command !== 'string' || typeof h.commandWindows !== 'string' || !h.commandWindows.includes('exit $LASTEXITCODE')) return false;
  const m = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)" codex$/.exec(h.command);
  if (!m) return false;
  const unescape = (/** @type {string} */ x) => x.replace(/\\(.)/g, '$1');
  return existsSync(unescape(/** @type {string} */ (m[1]))) && existsSync(unescape(/** @type {string} */ (m[2])));
}
