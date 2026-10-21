#!/usr/bin/env node
/**
 * Hivemind CLI (ARCHITECTURE.md §17). Plain ESM, no build step; run with `npx github:ndunl075/hivemind#<tag> <command>`.
 * The commands live in cli/commands/. Secrets (agent token, admin secret) are read with hidden input or from the
 * environment, never from arguments.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { invite, revoke, room, rotate } from './commands/admin.mjs';
import { CliError, createContext } from './commands/context.mjs';
import { doctor } from './commands/doctor.mjs';
import { join, leave, update } from './commands/join.mjs';
import { init, power } from './commands/project.mjs';
import { mode, unlock } from './commands/room-control.mjs';
import { terminalReaders } from './commands/secrets.mjs';

/**
 * @typedef {import('./commands/context.mjs').Context} Context
 */

const HELP = `hivemind - live coordination for AI coding agents

Once per team (admin; asks for the admin secret in a terminal, or reads HIVEMIND_ADMIN_TOKEN, or --token-stdin):
  hivemind room create <room>              create a room, print the dashboard link (once)
  hivemind invite <room> <person>          print that person's agent token (once)
  hivemind revoke <room> <person>          revoke one person's token
  hivemind rotate <room> --agents|--viewer invalidate all agent tokens, or the dashboard link
  hivemind room delete <room> [--yes]      delete the room's data

Once per project repo:
  hivemind init                            write .hivemind/project.json and the protocol in AGENTS.md and CLAUDE.md

Once per laptop, inside the project:
  hivemind join [--server <url>] [--yes]   register hooks and MCP for Claude Code and Codex (asks for your token, hidden,
                                           in a terminal; or add --token-stdin and pipe it in)
  hivemind doctor                          check the setup and print the self-test prompt for each app

While working:
  hivemind mode enforce|warn|off           change the room's enforcement
  hivemind unlock <path>                   emergency release of a file or folder
  hivemind unlock --agent <callsign>       emergency release of everything an agent holds
  hivemind off | on                        pause or resume Hivemind on this laptop only
  hivemind update                          refresh the hook folder and registrations
  hivemind leave [--room <name>|--all]     leave this project's room (or one room, or every room)

Admin commands also take --server <url> (or HIVEMIND_SERVER).
`;

/**
 * @type {Record<string, (argv: string[], ctx: Context) => Promise<number>>}
 */
const COMMANDS = {
  room,
  invite,
  revoke,
  rotate,
  init,
  join,
  doctor,
  mode,
  unlock,
  off: power.off,
  on: power.on,
  update,
  leave,
};

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Run one command line. Returns the exit code; never throws for user errors.
 * @param {string[]} argv arguments after `hivemind`
 * @param {Context} ctx
 * @returns {Promise<number>}
 */
export async function main(argv, ctx) {
  const [name, ...rest] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    ctx.out(HELP);
    return name === undefined ? 1 : 0;
  }
  if (name === '--version' || name === '-v') {
    ctx.out(`${version()}\n`);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    ctx.err(`hivemind: unknown command "${name}". Run hivemind help.\n`);
    return 1;
  }
  try {
    return await command(rest, ctx);
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(`hivemind: ${e.message}\n`);
      return e.code;
    }
    ctx.err(`hivemind: unexpected error: ${/** @type {Error} */ (e).message}\n`);
    return 1;
  }
}

/** True when this file is the program being run (also through an npm bin symlink), not imported by a test. */
function isEntry() {
  try {
    return Boolean(process.argv[1]) && realpathSync(/** @type {string} */ (process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2), createContext(terminalReaders()));
}
