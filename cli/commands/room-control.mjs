/**
 * Commands any teammate can run with their own agent token: hivemind mode, hivemind unlock (ARCHITECTURE.md §17).
 * @typedef {import('./context.mjs').Context} Context
 */
import { parseArgs } from './args.mjs';
import { call, normalizeServer } from './api.mjs';
import { CliError, paths } from './context.mjs';
import { readConfig } from './install.mjs';
import { identity, normalize } from '../hook/git.mjs';

/** @param {Context} ctx */
function needConfig(ctx) {
  const config = readConfig(ctx);
  if (!config) throw new CliError(`this laptop has not joined a room (${paths(ctx).config} is missing). Run hivemind join first.`);
  return { server: normalizeServer(config.server), token: config.token, room: config.room };
}

/**
 * hivemind mode enforce|warn|off
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function mode(argv, ctx) {
  const { positionals } = parseArgs(argv);
  const [m] = positionals;
  if (positionals.length !== 1 || (m !== 'enforce' && m !== 'warn' && m !== 'off')) throw new CliError('usage: hivemind mode enforce|warn|off');
  const { server, token, room } = needConfig(ctx);
  const res = await call(ctx, server, '/mode', { token, body: { mode: m } });
  ctx.out(`Room "${room}" is now in ${res.mode ?? m} mode.\n`);
  return 0;
}

/**
 * hivemind unlock <path> | hivemind unlock --agent <callsign>
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function unlock(argv, ctx) {
  const { positionals, options } = parseArgs(argv, { options: ['agent'] });
  const { server, token } = needConfig(ctx);
  /** @type {{ agent: string } | { path: { repo: string, path: string } }} */
  let body;
  if (options.agent !== undefined) {
    if (positionals.length > 0) throw new CliError('give a path or --agent <callsign>, not both');
    body = { agent: options.agent };
  } else {
    if (positionals.length !== 1) throw new CliError('usage: hivemind unlock <path> | hivemind unlock --agent <callsign>');
    const ident = await identity(ctx.cwd);
    if (!ident) throw new CliError('run unlock inside the project, so the path can be matched to its repository');
    const [rel] = normalize(ident.root, ctx.cwd, [/** @type {string} */ (positionals[0])]);
    if (!rel) throw new CliError('that path is outside this repository');
    body = { path: { repo: ident.repo, path: rel } };
  }
  const res = await call(ctx, server, '/unlock', { token, body });
  const released = Array.isArray(res.released) ? res.released : [];
  ctx.out(released.length === 0 ? 'Nothing was locked there.\n' : `Released ${released.length} lock${released.length === 1 ? '' : 's'}. Every agent has been told.\n`);
  if (typeof res.note === 'string' && res.note) ctx.out(`${res.note}\n`);
  return 0;
}
