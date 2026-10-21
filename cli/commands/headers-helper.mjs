// Claude Code's headersHelper for the Hivemind MCP server: prints the Authorization header as JSON.
// It runs from $HIVEMIND_HOME/hook/ and reads the token from ../config.json, so the token is never stored in
// ~/.claude.json or put on a command line. Plain Node, no dependencies; copied there by `hivemind join`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

try {
  const file = fileURLToPath(new URL('../config.json', import.meta.url));
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (typeof config.token !== 'string' || config.token === '') throw new Error('no token');
  process.stdout.write(JSON.stringify({ Authorization: `Bearer ${config.token}` }));
} catch {
  process.stderr.write('hivemind: no token found; run `hivemind join`\n');
  process.exitCode = 1;
}
