// Claude Code's headersHelper for a Hivemind MCP server: prints the Authorization header as JSON.
// It runs from $HIVEMIND_HOME/hook/ and reads the token from ../config.json, so the token is never stored in
// ~/.claude.json or put on a command line. Plain Node, no dependencies; copied there by `hivemind join`.
//
// One laptop can be in several rooms. Claude does not tell a helper which project it is for, so each room has its own
// MCP server (`hivemind`, `hivemind-<room>`) and the server's entry in ~/.claude.json passes its own name and the
// origin of its URL: `<helper> <name> <origin>`. The helper prints the token of the room stored under that name, and
// only if that room's server has that origin; anything else fails closed (exit 1, nothing printed), so a stale
// registration can never send one room's token to another room's server.
// Only a registration made before there were several rooms has no arguments; it means `hivemind`, and is served only
// from a config.json in the old single-room format (no `rooms` list).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

try {
  const file = fileURLToPath(new URL('../config.json', import.meta.url));
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const name = process.argv[2] ?? 'hivemind';
  const origin = process.argv[3];
  let entry;
  if (Array.isArray(config.rooms)) {
    entry = config.rooms.find((/** @type {any} */ r) => r?.mcp === name);
    if (origin === undefined && name !== 'hivemind') entry = undefined;
  } else if (name === 'hivemind') {
    entry = config; // the old single-room format
  }
  if (typeof entry?.token !== 'string' || entry.token === '') throw new Error('no token');
  if (origin !== undefined && new URL(entry.server).origin !== origin) throw new Error('wrong server');
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${entry.token}` }));
} catch {
  process.stderr.write('hivemind: no token found; run `hivemind join`\n');
  process.exitCode = 1;
}
