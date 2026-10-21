/** The one place the app learns where its data comes from: the live socket. `fake.ts` stays for development. */
import { createFakeSource } from './fake';
import { createSocketSource } from './socket';
import type { LiveSource, SourceOptions } from './types';

export type { LiveHandlers, LiveSource, SourceOptions } from './types';

/** Whether this source needs a viewer token before it can connect. */
export const sourceNeedsToken = true;

export function createSource(opts: SourceOptions): LiveSource {
  // `?demo=...` keeps the scripted fixture available while developing the page without a server.
  if (opts.demo !== null && opts.demo !== '') return createFakeSource(opts);
  return createSocketSource(opts);
}
