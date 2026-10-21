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
 *   readStdin: () => Promise<string>,
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
 * The environment a child process (`claude`, `codex`) gets: everything except Hivemind secrets. A variable is
 * dropped when its name looks like one of ours (HIVEMIND_*TOKEN / *SECRET) or its value is a Hivemind token.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function scrubEnv(env) {
  /** @type {Record<string, string | undefined>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^HIVEMIND_.*(TOKEN|SECRET)/i.test(k)) continue;
    if (typeof v === 'string' && /^hm_[av]\./.test(v.trim())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * True when an argument holds a character cmd.exe would still act on inside quotes (%VAR% expansion, ^, & | < >)
 * or one that ends a command line. The shell fallback refuses such a call rather than risk running something else.
 * @param {string} cmd
 * @param {string[]} args
 */
export function shellUnsafe(cmd, args) {
  return [cmd, ...args].some((a) => /[%^&|<>\r\n\0]/.test(a));
}

/**
 * Runs a program with no shell. On Windows a program installed as a .cmd shim is not found that way, so a second
 * attempt goes through the shell with every argument quoted (skipped when an argument is not safe for cmd.exe).
 * A missing program is code 127, not a throw. Hivemind secrets are removed from the child's environment.
 * @type {Runner}
 */
export function defaultRunner(cmd, args, opts = {}) {
  const env = scrubEnv(opts.env ?? process.env);
  /**
   * @param {boolean} shell
   * @returns {Promise<RunResult & { missing?: boolean }>}
   */
  const attempt = (shell) =>
    new Promise((resolve) => {
      if (shell && shellUnsafe(cmd, args)) {
        resolve({ code: 127, stdout: '', stderr: 'not run: an argument has a character cmd.exe could misread (% ^ & | < >)', missing: false });
        return;
      }
      const child = spawn(shell ? cmdQuote(cmd) : cmd, shell ? args.map(cmdQuote) : args, {
        cwd: opts.cwd,
        env: /** @type {NodeJS.ProcessEnv} */ (env),
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
    runner: (cmd, args, opts = {}) => (over.runner ?? defaultRunner)(cmd, args, { ...opts, env: scrubEnv(opts.env ?? env) }),
    fetch: over.fetch ?? globalThis.fetch,
    readSecret: over.readSecret ?? (async () => { throw new CliError('no terminal to ask on; run this in a real terminal'); }),
    readStdin: over.readStdin ?? (async () => { throw new CliError('no piped input available'); }),
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
    helperCmd: join(home, 'hook', 'headers-helper.cmd'),
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
