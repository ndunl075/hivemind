// Claude Code's headersHelper for a Hivemind MCP server: prints the Authorization header as JSON.
// It runs from $HIVEMIND_HOME/hook/ and reads the token from ../config.json, so the token is never stored in
// ~/.claude.json or put on a command line. Plain Node, no dependencies; copied there by `hivemind join`.
//
// One laptop can be in several rooms. Claude does not tell a helper which project it is for, so each room has its own
// MCP server (`hivemind`, `hivemind-<room>`) and the server's entry in ~/.claude.json passes its own name as the one
// argument; the helper prints that room's token. No argument means `hivemind`, which is also what a registration made
// before there were several rooms does. A config.json without a `rooms` list is one room.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

try {
  const file = fileURLToPath(new URL('../config.json', import.meta.url));
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const name = process.argv[2] ?? 'hivemind';
  const rooms = Array.isArray(config.rooms) ? config.rooms : [config];
  const entry = rooms.find((/** @type {any} */ r) => (typeof r?.mcp === 'string' ? r.mcp : 'hivemind') === name)
    ?? (name === 'hivemind' ? rooms[0] : undefined);
  if (typeof entry?.token !== 'string' || entry.token === '') throw new Error('no token');
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${entry.token}` }));
} catch {
  process.stderr.write('hivemind: no token found; run `hivemind join`\n');
  process.exitCode = 1;
}
