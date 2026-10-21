/** Checks that data from a source has the shape the views rely on (§8.2 snapshots and pulses). */
import type { DashboardMessage, Pulse, PulseKind, Snapshot } from '../../shared/contracts';

const PULSES: readonly PulseKind[] = ['message', 'broadcast', 'denied', 'push'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseMessage(raw: unknown): DashboardMessage | null {
  if (!isObj(raw)) return null;
  if (raw.type === 'pulse') {
    if (typeof raw.from !== 'string' || typeof raw.at !== 'number') return null;
    if (!PULSES.includes(raw.kind as PulseKind)) return null;
    return raw as unknown as Pulse;
  }
  if (raw.type === 'snapshot') {
    const ok =
      typeof raw.room === 'string' &&
      (raw.mode === 'enforce' || raw.mode === 'warn' || raw.mode === 'off') &&
      typeof raw.now === 'number' &&
      isObj(raw.usage) &&
      ['agents', 'tasks', 'locks', 'edges', 'activity'].every((k) => Array.isArray(raw[k]));
    return ok ? (raw as unknown as Snapshot) : null;
  }
  return null;
}
