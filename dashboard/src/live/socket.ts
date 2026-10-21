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
/** A connection counts as healthy (the backoff resets) only after staying open this long. */
export const STABLE_AFTER_MS = 10_000;
/** This many closes in a row without a successful open are treated as the token being refused. */
export const AUTH_FAILURE_AFTER = 3;

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
      let stable: unknown = null;
      let failures = 0; // closes in a row without an open
      let authReported = false;

      const connect = (): void => {
        retry = null;
        if (!opts.token) { // never connect without a token: ask for one
          h.onStatus('closed');
          h.onAuthFailure?.();
          return;
        }
        h.onStatus('connecting');
        const protocols = [DASHBOARD_SUBPROTOCOL, opts.token];
        let ws: SocketLike;
        try {
          ws = env.open(env.url, protocols);
        } catch {
          scheduleRetry();
          return;
        }
        socket = ws;
        let opened = false;
        ws.onopen = () => {
          if (stopped || socket !== ws) return;
          opened = true;
          failures = 0;
          authReported = false;
          stable = env.setTimeout(() => { attempt = 0; }, STABLE_AFTER_MS);
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
          if (msg.type === 'snapshot') h.onSnapshot(msg);
          else h.onPulse(msg);
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          if (ping !== null) env.clearInterval(ping);
          ping = null;
          if (stable !== null) env.clearTimeout(stable);
          stable = null;
          if (stopped) return;
          if (!opened) {
            failures++;
            if (failures >= AUTH_FAILURE_AFTER && !authReported) {
              authReported = true;
              h.onAuthFailure?.();
            }
          }
          h.onStatus('closed');
          scheduleRetry();
        };
        ws.onerror = (ev) => { console.debug('[hivemind] dashboard socket error', ev); }; // a close always follows
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
        if (stable !== null) env.clearTimeout(stable);
        const s = socket;
        socket = null;
        try { s?.close(); } catch { /* already closed */ }
      };
    },
  };
}
