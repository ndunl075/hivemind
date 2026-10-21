/** The one place the app learns where its data comes from: the live socket. `fake.ts` stays for development. */
import { createFakeSource } from './fake';
import { createSocketSource } from './socket';
import type { LiveSource, SourceOptions } from './types';

export type { LiveHandlers, LiveSource, SourceOptions } from './types';

/** The scripted fake runs without a token, so a `?demo=` page doesn't ask for one; the live socket needs one. */
export function needsToken(search: string): boolean {
  const demo = new URLSearchParams(search).get('demo');
  return demo === null || demo === '';
}

/** Whether this source needs a viewer token before it can connect. */
export const sourceNeedsToken = needsToken(typeof location === 'undefined' ? '' : location.search);

export function createSource(opts: SourceOptions): LiveSource {
  // `?demo=...` keeps the scripted fixture available while developing the page without a server.
  if (opts.demo !== null && opts.demo !== '') return createFakeSource(opts);
  return createSocketSource(opts);
}
