/**
 * hivemind join / update / leave (ARCHITECTURE.md §17 step 5 and "When you're done with a room").
 * @typedef {import('./context.mjs').Context} Context
 * @typedef {import('./install.mjs').Report} Report
 */
import { parseArgs } from './args.mjs';
import { call, looksLikeAgentToken, normalizeServer } from './api.mjs';
import { CliError, paths } from './context.mjs';
import { installAll, readConfig, uninstallAll } from './install.mjs';
import { identity } from '../hook/git.mjs';

/**
 * @param {Context} ctx
 * @param {Report} report
 */
function printReport(ctx, report) {
  for (const l of report.lines) ctx.out(`${l}\n`);
  for (const w of report.warnings) ctx.err(`warning: ${w}\n`);
}

/**
 * hivemind join [--server <url>] [--yes] [--token-stdin]
 * The token is asked for with hidden input in a terminal, or read as one piped line with --token-stdin; it is never
 * an argument and never an environment variable.
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function join(argv, ctx) {
  const { flags, options } = parseArgs(argv, { flags: ['yes', 'token-stdin'], options: ['server'] });
  const existing = readConfig(ctx);
  const server = normalizeServer(options.server ?? ctx.env.HIVEMIND_SERVER ?? (await ctx.readLine('Server URL')));
  const token = flags.has('token-stdin') ? await ctx.readStdin() : await ctx.readSecret('Your agent token (input hidden)');
  if (!looksLikeAgentToken(token)) throw new CliError('that does not look like an agent token (they start with hm_a.)');

  const ident = await identity(ctx.cwd);
  if (!ident) throw new CliError('run join inside the project: a Git repository with at least one commit');

  const who = await call(ctx, server, '/whoami', { token });
  if (typeof who.room !== 'string' || typeof who.person !== 'string') throw new CliError('the server answered, but not as a Hivemind server');
  ctx.out(`Server accepted the token: you are "${who.person}" in room "${who.room}" (mode ${who.mode ?? 'unknown'}).\n`);
  if (!flags.has('yes') && ctx.interactive) {
    const answer = (await ctx.readLine(`Join as ${who.person}? [Y/n]`)).toLowerCase();
    if (answer !== '' && answer !== 'y' && answer !== 'yes') throw new CliError('cancelled');
  }

  // One room per laptop: another room replaces the old mapping, the same room adds this repo to it.
  const sameRoom = existing && existing.server === server && existing.room === who.room;
  const repos = sameRoom ? [...existing.repos] : [];
  if (!repos.includes(ident.repo)) repos.push(ident.repo);
  const report = await installAll(ctx, { server, room: who.room, person: who.person, token, repos });
  printReport(ctx, report);
  ctx.out(`This repository (${ident.repoName ?? ident.root}) is mapped to room "${who.room}".\n`);
  ctx.out('Restart any Claude Code or Codex session that is already running, then run: hivemind doctor\n');
  return report.failed ? 1 : 0;
}

/**
 * hivemind update: refresh the hook folder and every registration from this laptop's config.
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function update(argv, ctx) {
  parseArgs(argv);
  const config = readConfig(ctx);
  if (!config) throw new CliError(`nothing to update: ${paths(ctx).config} is missing. Run hivemind join first.`);
  const report = await installAll(ctx, config);
  printReport(ctx, report);
  ctx.out('Codex users: approve the hooks again with /hooks if Codex asks.\n');
  return report.failed ? 1 : 0;
}

/**
 * hivemind leave: remove this laptop's config and the registrations join added.
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function leave(argv, ctx) {
  parseArgs(argv);
  const report = await uninstallAll(ctx);
  printReport(ctx, report);
  if (report.failed) return 1;
  ctx.out('Left. Project files (.hivemind/project.json, AGENTS.md, CLAUDE.md) were not touched.\n');
  return 0;
}
