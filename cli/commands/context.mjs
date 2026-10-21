/**
 * The CLI's environment, in one object so tests can swap every outside dependency: output, input, the runner for
 * `claude` and `codex`, fetch, the home folders, the node path. Nothing else in cli/commands reads process.* directly.
 */
import { spawn } from 'node:child_process';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

/** A user-facing failure: the message is printed, the exit code returned. Never put a secret in one. */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   */
  constructor(message, code = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} RunResult
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: Record<string, string | undefined> }) => Promise<RunResult>} Runner
 *
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   homedir: string,
 *   cwd: string,
 *   nodePath: string,
 *   platform: string,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   runner: Runner,
 *   fetch: typeof fetch,
 *   readSecret: (label: string) => Promise<string>,
 *   readLine: (label: string) => Promise<string>,
 *   interactive: boolean,
 *   now: () => number,
 * }} Context
 */

/**
 * Quote one argument for cmd.exe when a Windows .cmd shim has to run through a shell.
 * @param {string} a
 */
function cmdQuote(a) {
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Runs a program with no shell. On Windows a program installed as a .cmd shim is not found that way, so a second
 * attempt goes through the shell with every argument quoted. A missing program is code 127, not a throw.
 * @type {Runner}
 */
export function defaultRunner(cmd, args, opts = {}) {
  /**
   * @param {boolean} shell
   * @returns {Promise<RunResult & { missing?: boolean }>}
   */
  const attempt = (shell) =>
    new Promise((resolve) => {
      const child = spawn(shell ? cmdQuote(cmd) : cmd, shell ? args.map(cmdQuote) : args, {
        cwd: opts.cwd,
        env: /** @type {NodeJS.ProcessEnv} */ (opts.env ?? process.env),
        shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c) => { stdout += c; });
      child.stderr?.on('data', (c) => { stderr += c; });
      child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(/** @type {Error} */ (e).message), missing: true }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  return attempt(false).then((r) => (r.missing && process.platform === 'win32' ? attempt(true) : r));
}

/**
 * @param {Partial<Context>} [over]
 * @returns {Context}
 */
export function createContext(over = {}) {
  const env = over.env ?? process.env;
  return {
    env,
    homedir: over.homedir ?? osHomedir(),
    cwd: over.cwd ?? process.cwd(),
    nodePath: over.nodePath ?? process.execPath,
    platform: over.platform ?? process.platform,
    out: over.out ?? ((t) => { process.stdout.write(t); }),
    err: over.err ?? ((t) => { process.stderr.write(t); }),
    runner: over.runner ?? defaultRunner,
    fetch: over.fetch ?? globalThis.fetch,
    readSecret: over.readSecret ?? (async () => { throw new CliError('no terminal to ask on; use the environment variable named in the help'); }),
    readLine: over.readLine ?? (async () => { throw new CliError('no terminal to ask on'); }),
    interactive: over.interactive ?? Boolean(process.stdin.isTTY),
    now: over.now ?? Date.now,
  };
}

/**
 * Every path the CLI reads or writes, from the context's environment.
 * @param {Context} ctx
 */
export function paths(ctx) {
  const home = ctx.env.HIVEMIND_HOME || join(ctx.homedir, '.hivemind');
  const claudeDir = ctx.env.CLAUDE_CONFIG_DIR || join(ctx.homedir, '.claude');
  const codexDir = ctx.env.CODEX_HOME || join(ctx.homedir, '.codex');
  return {
    home,
    hookDir: join(home, 'hook'),
    hookScript: join(home, 'hook', 'hook.mjs'),
    helperScript: join(home, 'hook', 'headers-helper.mjs'),
    config: join(home, 'config.json'),
    manifest: join(home, 'install.json'),
    off: join(home, 'off'),
    hookLog: join(home, 'hook.log'),
    state: join(home, 'state'),
    claudeDir,
    claudeSettings: join(claudeDir, 'settings.json'),
    codexDir,
    codexHooks: join(codexDir, 'hooks.json'),
    codexToml: join(codexDir, 'config.toml'),
  };
}
