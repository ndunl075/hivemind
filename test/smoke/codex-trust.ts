/**
 * Marks a throwaway project as trusted in the user's Codex config (Codex only loads a project's hooks and MCP config
 * when the project is trusted), and takes exactly that entry out again.
 *  - The original file is copied to a stable backup path, printed, and kept until the restore succeeded.
 *  - The restore removes only the block this function appended (an exact match), never overwrites the file; if the
 *    file did not exist before and holds nothing else now, it is deleted.
 *  - The restore runs synchronously on process exit, SIGINT and SIGTERM, and is safe to call more than once.
 *  - If the restore fails, the backup path and the exact block to remove are printed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CODEX_BACKUP = join(homedir(), '.hivemind-dev', 'smoke-codex-config.backup');

export function trustProject(configPath: string, projectDir: string, say: (line: string) => void): () => void {
  const block = `\n[projects.'${projectDir}']\ntrust_level = "trusted"\n`;
  const existed = existsSync(configPath);
  mkdirSync(dirname(CODEX_BACKUP), { recursive: true });
  if (existed) copyFileSync(configPath, CODEX_BACKUP);
  else writeFileSync(CODEX_BACKUP, '(the Codex config did not exist before the smoke test)\n');
  say(`codex config backup kept at ${CODEX_BACKUP} until the restore succeeds`);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, (existed ? readFileSync(configPath, 'utf8') : '') + block);

  let done = false;
  const restore = (): void => {
    if (done) return;
    try {
      const now = readFileSync(configPath, 'utf8');
      const at = now.lastIndexOf(block);
      if (at < 0) throw new Error('the trust block is no longer in the file');
      const rest = now.slice(0, at) + now.slice(at + block.length);
      if (!existed && rest.trim() === '') rmSync(configPath);
      else writeFileSync(configPath, rest);
      rmSync(CODEX_BACKUP, { force: true });
      done = true;
      say('codex config restored: the trust entry was removed');
    } catch (e) {
      say(`COULD NOT RESTORE ${configPath} (${(e as Error).message}). The original is at ${CODEX_BACKUP}. Remove exactly this block:${block}`);
    }
  };
  process.once('exit', restore);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { restore(); process.exit(1); });
  return restore;
}
