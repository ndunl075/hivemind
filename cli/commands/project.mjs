/**
 * hivemind init: .hivemind/project.json (defaults from ARCHITECTURE.md §9) and the protocol section in AGENTS.md and
 * CLAUDE.md. Existing files are merged into, never replaced; running it twice changes nothing.
 * @typedef {import('./context.mjs').Context} Context
 */
import { join } from 'node:path';
import { parseArgs } from './args.mjs';
import { paths } from './context.mjs';
import { readText, removeFile, writeAtomic, writeIfChanged } from './files.mjs';
import { protocolText, setSection } from './markers.mjs';
import { identity } from '../hook/git.mjs';

export const DEFAULT_SETTINGS = {
  requireTask: true,
  advisory: ['package.json', '**/package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock*'],
  ignore: [],
};

/**
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function init(argv, ctx) {
  parseArgs(argv);
  const root = (await identity(ctx.cwd))?.root ?? ctx.cwd;
  const settingsPath = join(root, '.hivemind', 'project.json');
  if (readText(settingsPath) === null) {
    writeAtomic(settingsPath, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
    ctx.out(`Wrote ${settingsPath} (lock settings; no secrets)\n`);
  } else {
    ctx.out(`Kept ${settingsPath} as it is\n`);
  }
  const protocol = protocolText();
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = join(root, name);
    const changed = writeIfChanged(file, setSection(readText(file), protocol));
    ctx.out(`${changed ? 'Updated' : 'Already up to date:'} ${file}\n`);
  }
  ctx.out('Review the changes and commit them.\n');
  return 0;
}

/** Local pause and resume (Hivemind's kill switch for this laptop only). */
export const power = {
  /**
   * @param {string[]} argv
   * @param {Context} ctx
   */
  async off(argv, ctx) {
    parseArgs(argv);
    const p = paths(ctx);
    if (readText(p.off) === null) writeAtomic(p.off, `paused ${new Date(ctx.now()).toISOString()}\n`);
    ctx.out('Hivemind is paused on this laptop. Resume with: hivemind on\n');
    return 0;
  },
  /**
   * @param {string[]} argv
   * @param {Context} ctx
   */
  async on(argv, ctx) {
    parseArgs(argv);
    ctx.out(removeFile(paths(ctx).off) ? 'Hivemind is on again on this laptop.\n' : 'Hivemind was already on.\n');
    return 0;
  },
};
