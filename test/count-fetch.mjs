/**
 * Test-only preload (node --import): records every request the hook makes to the server, one line per request, in the
 * file named by HIVEMIND_COUNT_FILE. Used by test/e2e/team-scale.test.ts to count real traffic. Never loaded in production.
 */
import { appendFileSync } from 'node:fs';

const file = process.env.HIVEMIND_COUNT_FILE;
const real = globalThis.fetch;
if (file && typeof real === 'function') {
  globalThis.fetch = async (input, init) => {
    let label = 'other';
    try {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      const path = new URL(url).pathname;
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      label = `${path} ${body?.event ?? ''}${body?.event === 'PostToolUse' && body?.git ? ' +git' : ''}`.trim();
    } catch { /* label stays "other" */ }
    appendFileSync(file, `${label}\n`);
    return real(input, init);
  };
}
