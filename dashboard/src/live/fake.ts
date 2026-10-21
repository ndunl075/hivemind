/**
 * Fake live source for the fixture phase: the fixture snapshot, moved to the present, plus a scripted pulse
 * stream. Working agents keep reporting so their state stays "working"; everything else ages naturally.
 * `?demo=offline` shows the reconnecting banner. W7 replaces this with the real socket, and keeps this file.
 */
import type { ActivityView, EdgeView, Pulse, Snapshot } from '../../../shared/contracts';
import { deriveState } from '../../../shared/state';
import { fixtureSnapshot, shiftSnapshot } from './fixture';
import type { LiveHandlers, LiveSource, SourceOptions } from './types';

const SCRIPT: Omit<Pulse, 'at'>[] = [
  { type: 'pulse', kind: 'message', from: 'claude-nico', to: 'codex-ana' },
  { type: 'pulse', kind: 'denied', from: 'claude-nico-2', to: 'codex-ana', path: 'src/auth/login.ts' },
  { type: 'pulse', kind: 'push', from: 'claude-nico', path: 'src/app/page.tsx' },
  { type: 'pulse', kind: 'broadcast', from: 'codex-sam' },
  { type: 'pulse', kind: 'message', from: 'codex-ana', to: 'claude-nico' },
];

const SCRIPT_TEXT = [
  'claude-nico → codex-ana: Can you export the User type from src/types.ts?',
  'claude-nico-2 was blocked from src/auth/login.ts (held by codex-ana)',
  'claude-nico pushed main (1 file)',
  'codex-sam → everyone: Preview deploy finished.',
  'codex-ana → claude-nico: Done, User is exported.',
];

const ACTIVITY_TYPE = ['message', 'lock.denied', 'push', 'message', 'message'];

/** Moves a snapshot forward to `now`: working agents report in, the scripted pulse (if any) lands. */
export function advance(prev: Snapshot, now: number, step: number | null): Snapshot {
  const agents = prev.agents.map((a, i) =>
    deriveState(a, prev.now).state === 'working' ? { ...a, lastEvent: now - (2 + ((step ?? 0) + i * 3) % 8) * 1000 } : a,
  );
  let edges: EdgeView[] = prev.edges.filter((e) => now - e.at < 3 * 60_000 || e.kind === 'waiting' || e.kind === 'nearby');
  let activity: ActivityView[] = prev.activity;
  if (step !== null) {
    const p = SCRIPT[step % SCRIPT.length]!;
    const seq = (prev.activity[0]?.seq ?? 0) + 1;
    activity = [{ seq, ts: now, type: ACTIVITY_TYPE[step % SCRIPT.length]!, actor: p.from, text: SCRIPT_TEXT[step % SCRIPT.length]! }, ...prev.activity].slice(0, 30);
    if (p.kind === 'message' || p.kind === 'broadcast') {
      const kind = p.kind;
      edges = [...edges.filter((e) => !(e.kind === kind && e.from === p.from && e.to === p.to)), { kind, from: p.from, ...(p.to ? { to: p.to } : {}), at: now }];
    }
    if (p.kind === 'denied' && p.to) {
      edges = [...edges.filter((e) => e.kind !== 'blocked'), { kind: 'blocked', from: p.from, to: p.to, label: 'login.ts', at: now }];
    }
  }
  return { ...prev, now, agents, edges, activity };
}

export function createFakeSource(opts: SourceOptions): LiveSource {
  return {
    start(h: LiveHandlers) {
      let current = shiftSnapshot(fixtureSnapshot, Date.now());
      let step = 0;
      let tick = 0;
      let stopped = false;
      h.onSnapshot(current);
      if (opts.demo === 'offline') {
        h.onStatus('closed');
        return () => {
          stopped = true;
        };
      }
      h.onStatus('open');
      const timer = setInterval(() => {
        if (stopped) return;
        tick++;
        const pulseNow = tick % 5 === 0;
        const now = Date.now();
        current = advance(current, now, pulseNow ? step : null);
        if (pulseNow) {
          const p = SCRIPT[step % SCRIPT.length]!;
          step++;
          h.onPulse({ ...p, at: now } as Pulse);
        }
        h.onSnapshot(current);
      }, 1000);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  };
}
