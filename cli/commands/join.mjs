/**
 * hivemind join / update / leave (ARCHITECTURE.md §17 step 5 and "When you're done with a room").
 *
 * A laptop can be in several rooms, each tied to the repos it was joined from (rooms.mjs). `join` adds or refreshes
 * the room for the current project; `leave` removes the current project's mapping, `--room` one whole room, `--all`
 * everything.
 * @typedef {import('./context.mjs').Context} Context
 * @typedef {import('./install.mjs').Report} Report
 * @typedef {import('./rooms.mjs').RoomEntry} RoomEntry
 */
import { parseArgs } from './args.mjs';
import { call, looksLikeAgentToken, normalizeServer } from './api.mjs';
import { CliError, paths } from './context.mjs';
import { installAll, readRooms, uninstallAll } from './install.mjs';
import { allocateMcp, roomForRepo, sameRoom } from './rooms.mjs';
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
  const existing = readRooms(ctx) ?? [];
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

  // A repository belongs to one room. Joining it to this room takes it out of any other room on this laptop (a room
  // left with no repos is dropped); every other room is left exactly as it was.
  const isThis = sameRoom(server, who.room);
  /** @type {string[]} */
  const notes = [];
  const others = existing
    .filter((r) => !isThis(r))
    .map((r) => {
      if (!r.repos.includes(ident.repo)) return r;
      notes.push(`This repository was mapped to room "${r.room}"; it now belongs to "${who.room}".`);
      return { ...r, repos: r.repos.filter((x) => x !== ident.repo) };
    })
    .filter((r) => {
      if (r.repos.length > 0) return true;
      notes.push(`Room "${r.room}" has no repositories left on this laptop, so it was removed.`);
      return false;
    });
  const mine = existing.find(isThis);
  /** @type {RoomEntry} */
  const entry = mine
    ? { ...mine, server, person: who.person, token, repos: mine.repos.includes(ident.repo) ? [...mine.repos] : [...mine.repos, ident.repo] }
    : { server, room: who.room, person: who.person, token, repos: [ident.repo], mcp: allocateMcp(others, who.room) };
  // Keep the order rooms were joined in: the entry stays where it was, a new one goes last.
  const rooms = mine
    ? existing.flatMap((r) => (isThis(r) ? [entry] : others.filter((o) => o.mcp === r.mcp)))
    : [...others, entry];

  const report = await installAll(ctx, rooms);
  printReport(ctx, report);
  for (const n of notes) ctx.out(`${n}\n`);
  ctx.out(`This repository (${ident.repoName ?? ident.root}) is mapped to room "${who.room}".\n`);
  if (rooms.length > 1) ctx.out(`This laptop is in ${rooms.length} rooms: ${rooms.map((r) => `"${r.room}"`).join(', ')}. Its tools for "${who.room}" are served by the MCP server "${entry.mcp}".\n`);
  ctx.out('Restart any Claude Code or Codex session that is already running, then run: hivemind doctor\n');
  return report.failed ? 1 : 0;
}

/**
 * hivemind update: refresh the hook folder and every registration, for every room, from this laptop's config.
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function update(argv, ctx) {
  parseArgs(argv);
  const rooms = readRooms(ctx);
  if (!rooms) throw new CliError(`nothing to update: ${paths(ctx).config} is missing. Run hivemind join first.`);
  const report = await installAll(ctx, rooms);
  printReport(ctx, report);
  ctx.out('Codex users: approve the hooks again with /hooks if Codex asks.\n');
  return report.failed ? 1 : 0;
}

/**
 * hivemind leave [--room <name>] [--all]
 * Inside a project: stop using Hivemind for this project (its room too, once no other project here uses it).
 * --room <name>: drop that whole room, whatever repos it has here. --all: remove everything from this laptop.
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function leave(argv, ctx) {
  const { flags, options } = parseArgs(argv, { flags: ['all'], options: ['room'] });
  if (flags.has('all') && options.room !== undefined) throw new CliError('give --room <name> or --all, not both');
  const rooms = readRooms(ctx);
  // --all, or a laptop with no readable config (a half-installed setup is still cleaned up): everything goes.
  if (flags.has('all') || !rooms) return finishLeave(ctx, await uninstallAll(ctx), 'Left every room.');

  /** @type {RoomEntry[]} */
  let remaining;
  /** @type {string} */
  let message;
  if (options.room !== undefined) {
    const want = options.room;
    const hits = rooms.filter((r) => r.room === want || r.mcp === want);
    if (hits.length === 0) throw new CliError(`this laptop is not in a room called "${want}". Rooms here: ${rooms.map((r) => `"${r.room}"`).join(', ')}.`);
    if (hits.length > 1) throw new CliError(`more than one room is called "${want}" (on different servers). Name the one to leave by its MCP server: ${hits.map((r) => r.mcp).join(', ')}.`);
    remaining = rooms.filter((r) => r !== hits[0]);
    message = `Left room "${hits[0]?.room}".`;
  } else {
    const ident = await identity(ctx.cwd);
    const here = ident ? roomForRepo(rooms, ident.repo) : undefined;
    if (ident && here) {
      const left = { ...here, repos: here.repos.filter((x) => x !== ident.repo) };
      remaining = rooms.flatMap((r) => (r !== here ? [r] : left.repos.length > 0 ? [left] : []));
      message = left.repos.length > 0
        ? `This repository is no longer mapped to room "${here.room}" (its other repositories here still are).`
        : `Left room "${here.room}".`;
    } else if (rooms.length === 1) {
      // One room and nothing to tell which project is meant: leave it, as leave always did.
      remaining = [];
      message = `Left room "${rooms[0]?.room}".`;
    } else {
      throw new CliError(
        `this project is not mapped to any of your ${rooms.length} rooms (${rooms.map((r) => `"${r.room}"`).join(', ')}). Run leave inside a joined project, or use --room <name>, or --all.`,
      );
    }
  }
  const report = remaining.length === 0 ? await uninstallAll(ctx) : await installAll(ctx, remaining);
  return finishLeave(ctx, report, message, remaining.length);
}

/**
 * @param {Context} ctx
 * @param {Report} report
 * @param {string} message
 * @param {number} [stillIn] rooms still joined
 */
function finishLeave(ctx, report, message, stillIn = 0) {
  printReport(ctx, report);
  if (report.failed) return 1;
  ctx.out(`${message}${stillIn > 0 ? ` This laptop is still in ${stillIn} room${stillIn === 1 ? '' : 's'}.` : ''} Project files (.hivemind/project.json, AGENTS.md, CLAUDE.md) were not touched.\n`);
  return 0;
}
