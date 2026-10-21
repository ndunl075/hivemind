import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from './fixture';
import { STABLE_AFTER_MS, BACKOFF_MAX_MS, BACKOFF_START_MS, backoffDelay, createSocketSource, PING_EVERY_MS, type SocketEnv, type SocketLike } from './socket';
import { createSource, needsToken, sourceNeedsToken } from './index';

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string, readonly protocols: string[]) {}
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
  deliver(data: unknown) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const intervals: { fn: () => void; ms: number; live: boolean }[] = [];
  let id = 0;
  const env: SocketEnv = {
    url: 'ws://host/r/demo/ws',
    open: (url, protocols) => { const s = new FakeSocket(url, protocols); sockets.push(s); return s; },
    setTimeout: (fn, ms) => { const t = { fn, ms, id: ++id, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { (t as { live: boolean }).live = false; },
    setInterval: (fn, ms) => { const t = { fn, ms, live: true }; intervals.push(t); return t; },
    clearInterval: (t) => { (t as { live: boolean }).live = false; },
    random: () => 1,
  };
  const events: string[] = [];
  const snaps: unknown[] = [];
  const pulses: unknown[] = [];
  const handlers = {
    onSnapshot: (s: unknown) => { snaps.push(s); },
    onPulse: (p: unknown) => { pulses.push(p); },
    onStatus: (s: string) => { events.push(s); },
  };
  const fireNextTimer = () => { const t = timers.find((x) => x.live); if (!t) throw new Error('no timer'); t.live = false; t.fn(); return t.ms; };
  return { env, sockets, timers, intervals, events, snaps, pulses, handlers, fireNextTimer };
}

describe('backoffDelay', () => {
  it('doubles from the start value up to the cap, with jitter between half and full', () => {
    expect(backoffDelay(0, 1)).toBe(BACKOFF_START_MS);
    expect(backoffDelay(1, 1)).toBe(BACKOFF_START_MS * 2);
    expect(backoffDelay(30, 1)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(3, 0)).toBe(BACKOFF_START_MS * 8 / 2);
  });
});

describe('socket source', () => {
  it('offers the hivemind subprotocol and the viewer token, and delivers snapshots and pulses', () => {
    const h = harness();
    createSocketSource({ room: 'demo', token: 'hm_v.demo.1.sig', demo: null }, h.env).start(h.handlers);
    const s = h.sockets[0]!;
    expect(s.protocols).toEqual(['hivemind', 'hm_v.demo.1.sig']);
    expect(h.events).toEqual(['connecting']);
    s.onopen?.({});
    expect(h.events).toEqual(['connecting', 'open']);
    s.deliver(fixtureSnapshot);
    s.deliver({ type: 'pulse', kind: 'push', from: 'claude-nico', at: 5 });
    s.deliver('not json');
    s.deliver({ type: 'something-else' });
    expect(h.snaps).toHaveLength(1);
    expect(h.pulses).toHaveLength(1);
  });

  it('pings while open', () => {
    const h = harness();
    createSocketSource({ room: 'demo', token: 't', demo: null }, h.env).start(h.handlers);
    h.sockets[0]!.onopen?.({});
    expect(h.intervals[0]!.ms).toBe(PING_EVERY_MS);
    h.intervals[0]!.fn();
    expect(h.sockets[0]!.sent).toEqual(['ping']);
  });

  it('reconnects with growing delays and resets only after staying open', () => {
    const h = harness();
    createSocketSource({ room: 'demo', token: 't', demo: null }, h.env).start(h.handlers);
    h.sockets[0]!.onclose?.({});
    expect(h.events.at(-1)).toBe('closed');
    expect(h.fireNextTimer()).toBe(500);
    h.sockets[1]!.onclose?.({}); // never opened
    expect(h.fireNextTimer()).toBe(1000);
    h.sockets[2]!.onclose?.({});
    expect(h.fireNextTimer()).toBe(2000);
    h.sockets[3]!.onopen?.({});
    h.sockets[3]!.deliver(fixtureSnapshot);
    h.sockets[3]!.onclose?.({}); // opened, delivered, then dropped at once: no reset
    expect(h.fireNextTimer()).toBe(4000);
    h.sockets[4]!.onopen?.({});
    h.timers.find((t) => t.live && t.ms === STABLE_AFTER_MS)!.fn(); // stayed open long enough
    h.sockets[4]!.onclose?.({});
    expect(h.fireNextTimer()).toBe(500);
    expect(h.sockets).toHaveLength(6);
  });

  it('does not connect without a token and asks for one', () => {
    const h = harness();
    let auth = 0;
    createSocketSource({ room: 'demo', token: null, demo: null }, h.env).start({ ...h.handlers, onAuthFailure: () => { auth++; } });
    expect(h.sockets).toHaveLength(0);
    expect(auth).toBe(1);
    expect(h.events).toEqual(['closed']);
  });

  it('reports a refused token after repeated closes without an open, once per streak', () => {
    const h = harness();
    let auth = 0;
    createSocketSource({ room: 'demo', token: 'bad', demo: null }, h.env).start({ ...h.handlers, onAuthFailure: () => { auth++; } });
    for (let i = 0; i < 5; i++) {
      h.sockets[i]!.onclose?.({});
      if (i < 4) h.fireNextTimer();
    }
    expect(auth).toBe(1);
    h.fireNextTimer();
    h.sockets.at(-1)!.onopen?.({}); // a good connection ends the streak
    h.sockets.at(-1)!.onclose?.({});
    for (let i = 0; i < 3; i++) {
      h.fireNextTimer();
      h.sockets.at(-1)!.onclose?.({});
    }
    expect(auth).toBe(2);
  });

  it('stops: closes the socket, cancels the retry and ignores late events', () => {
    const h = harness();
    const stop = createSocketSource({ room: 'demo', token: 't', demo: null }, h.env).start(h.handlers);
    h.sockets[0]!.onopen?.({});
    stop();
    expect(h.sockets[0]!.closed).toBe(true);
    h.sockets[0]!.deliver(fixtureSnapshot);
    h.sockets[0]!.onclose?.({});
    expect(h.snaps).toHaveLength(0);
    expect(h.events.at(-1)).toBe('open');
    expect(h.intervals.every((i) => !i.live)).toBe(true);
    expect(h.sockets).toHaveLength(1);
  });

  it('is the default source and needs a token; ?demo= keeps the fake', () => {
    expect(sourceNeedsToken).toBe(true); // the test page has no ?demo=
    expect(needsToken('?demo=offline')).toBe(false);
    expect(needsToken('?demo=')).toBe(true);
    expect(needsToken('')).toBe(true);
    expect(typeof createSource({ room: 'demo', token: 't', demo: 'offline' }).start).toBe('function');
  });
});
