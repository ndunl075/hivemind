/**
 * The `wait` registry (ARCHITECTURE.md §7, §8.2): one parked promise per caller, resolved by the first
 * matching wake key or by a timer. Parked waits end if the Room restarts; the caller simply gets a timeout.
 */
import { LIMITS, type Callsign, type WakeKey } from '../../shared/contracts';

/** Lines up with ToolResults['wait'].event; `key` is the wake key that fired. */
export type WaitResult = { event: 'message' | 'release' | 'task'; key: WakeKey } | { event: 'timeout' };

function eventOf(key: WakeKey): 'message' | 'release' | 'task' {
  const kind = key.slice(0, key.indexOf(':'));
  return kind === 'release' || kind === 'task' ? kind : 'message';
}

interface Parked {
  keys: Set<WakeKey>;
  resolve: (r: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WaitRegistry {
  private readonly parked = new Map<Callsign, Parked>();

  park(callsign: Callsign, keys: WakeKey[], seconds: number): Promise<WaitResult> {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new RangeError('seconds must be a finite number');
    this.settle(callsign, { event: 'timeout' });
    const ms = Math.min(Math.max(seconds, 0), LIMITS.waitMaxSeconds) * 1000;
    return new Promise<WaitResult>((resolve) => {
      const timer = setTimeout(() => this.settle(callsign, { event: 'timeout' }), ms);
      this.parked.set(callsign, { keys: new Set(keys), resolve, timer });
    });
  }

  /** Resolves every parked wait that listens for one of the keys. */
  wake(keys: WakeKey[]): void {
    if (this.parked.size === 0) return;
    for (const [callsign, p] of [...this.parked]) {
      const hit = keys.find((k) => p.keys.has(k));
      if (hit !== undefined) this.settle(callsign, { event: eventOf(hit), key: hit });
    }
  }

  cancelAll(): void {
    for (const callsign of [...this.parked.keys()]) this.settle(callsign, { event: 'timeout' });
  }

  size(): number {
    return this.parked.size;
  }

  private settle(callsign: Callsign, result: WaitResult): void {
    const p = this.parked.get(callsign);
    if (!p) return;
    this.parked.delete(callsign);
    clearTimeout(p.timer);
    p.resolve(result);
  }
}
