/** The one place the app learns where its data comes from. W7 replaces the fake with the live socket. */
import { createFakeSource } from './fake';
import type { LiveSource, SourceOptions } from './types';

export type { LiveHandlers, LiveSource, SourceOptions } from './types';

/** Whether this source needs a viewer token before it can connect. */
export const sourceNeedsToken = false;

export function createSource(opts: SourceOptions): LiveSource {
  return createFakeSource(opts);
}
