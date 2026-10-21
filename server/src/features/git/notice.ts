/** The push notice of ARCHITECTURE.md §12. Pure. */
import { cleanLine } from '../messages/sanitize';

/** Paths named in a notice before it says "…". */
const SHOWN = 3;

/**
 * `codex-ana pushed main (3 files: src/auth/login.ts, src/auth/session.ts, src/types.ts, …). Pull before editing those.`
 * Branch and paths are written by a teammate's agent: one clean, bounded line each.
 */
export function pushNotice(by: string, branch: string, paths: string[]): string {
  const shown = paths.slice(0, SHOWN).map((p) => cleanLine(p, 200));
  const more = paths.length > SHOWN ? ', …' : '';
  const count = `${paths.length} file${paths.length === 1 ? '' : 's'}`;
  return `${by} pushed ${cleanLine(branch, 100)} (${count}: ${shown.join(', ')}${more}). Pull before editing ${paths.length === 1 ? 'that file' : 'those'}.`;
}
