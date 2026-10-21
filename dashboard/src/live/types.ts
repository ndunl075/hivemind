/** The seam between the dashboard and its data. W7 swaps the source behind `createSource` for the live socket. */
import type { Pulse, Snapshot } from '../../../shared/contracts';
import type { ConnectionState } from '../model';

export interface LiveHandlers {
  onSnapshot(snapshot: Snapshot): void;
  onPulse(pulse: Pulse): void;
  onStatus(state: ConnectionState): void;
}

export interface SourceOptions {
  room: string;
  /** Viewer token, or null. */
  token: string | null;
  /** Demo switch from the page URL (`?demo=offline`); only the fake source reads it. */
  demo: string | null;
}

export interface LiveSource {
  /** Starts delivering data; returns a function that stops it. */
  start(handlers: LiveHandlers): () => void;
}
