/**
 * The live source: the room's dashboard WebSocket (`/r/<room>/ws`, subprotocols ['hivemind', <viewer token>]).
 * Reconnects with exponential backoff and jitter, resets the backoff once a connection delivers data, and keeps
 * the last snapshot on screen meanwhile (the app shows the reconnecting banner after 10 s).
 */
import { DASHBOARD_SUBPROTOCOL } from '../../../shared/contracts';
import { parseMessage } from '../validate';
import type { LiveHandlers, LiveSource, SourceOptions } from './types';

export const BACKOFF_START_MS = 500;
export const BACKOFF_MAX_MS = 15_000;
/** The server answers the text 'ping' without waking the room; it keeps idle proxies from dropping the socket. */
export const PING_EVERY_MS = 25_000;

/** Delay before reconnect attempt number `attempt` (0 = first retry); `random` is in [0, 1). */
export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.5 + random / 2));
}

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SocketEnv {
  url: string;
  open(url: string, protocols: string[]): SocketLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  random(): number;
}

export function browserSocketEnv(room: string): SocketEnv {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    url: `${scheme}//${location.host}/r/${encodeURIComponent(room)}/ws`,
    open: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    random: () => Math.random(),
  };
}

export function createSocketSource(opts: SourceOptions, env: SocketEnv = browserSocketEnv(opts.room)): LiveSource {
  return {
    start(h: LiveHandlers) {
      let stopped = false;
      let attempt = 0;
      let socket: SocketLike | null = null;
      let retry: unknown = null;
      let ping: unknown = null;

      const connect = (): void => {
        retry = null;
        h.onStatus('connecting');
        const protocols = opts.token ? [DASHBOARD_SUBPROTOCOL, opts.token] : [DASHBOARD_SUBPROTOCOL];
        let ws: SocketLike;
        try {
          ws = env.open(env.url, protocols);
        } catch {
          scheduleRetry();
          return;
        }
        socket = ws;
        ws.onopen = () => {
          if (stopped || socket !== ws) return;
          h.onStatus('open');
          ping = env.setInterval(() => {
            try { ws.send('ping'); } catch { /* the close handler takes over */ }
          }, PING_EVERY_MS);
        };
        ws.onmessage = (ev) => {
          if (stopped || socket !== ws || typeof ev.data !== 'string') return;
          let raw: unknown;
          try { raw = JSON.parse(ev.data); } catch { return; }
          const msg = parseMessage(raw);
          if (!msg) return;
          attempt = 0; // the connection is really serving data
          if (msg.type === 'snapshot') h.onSnapshot(msg);
          else h.onPulse(msg);
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          if (ping !== null) env.clearInterval(ping);
          ping = null;
          if (stopped) return;
          h.onStatus('closed');
          scheduleRetry();
        };
        ws.onerror = () => { /* a close always follows */ };
      };

      const scheduleRetry = (): void => {
        if (stopped || retry !== null) return;
        retry = env.setTimeout(connect, backoffDelay(attempt++, env.random()));
      };

      connect();
      return () => {
        stopped = true;
        if (retry !== null) env.clearTimeout(retry);
        if (ping !== null) env.clearInterval(ping);
        const s = socket;
        socket = null;
        try { s?.close(); } catch { /* already closed */ }
      };
    },
  };
}
