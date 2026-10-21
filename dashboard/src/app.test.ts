import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../shared/contracts';
import { mountApp, type App } from './app';
import { fixtureSnapshot } from './live/fixture';
import type { LiveHandlers, LiveSource } from './live/types';

const EVIL = '<img src=x onerror="window.__pwned=1">';

function evilSnapshot(): Snapshot {
  const s = structuredClone(fixtureSnapshot);
  s.tasks[0]!.title = EVIL;
  s.tasks[0]!.note = EVIL;
  s.agents[0]!.callsign = 'claude-evil';
  s.agents[0]!.branch = EVIL;
  s.agents[0]!.activity = `Edit ${EVIL}`;
  s.tasks[0]!.owner = 'claude-evil';
  s.locks[0]!.path = `${EVIL}/`;
  s.activity[0]!.text = EVIL;
  s.edges = [{ kind: 'blocked', from: 'claude-evil', to: 'codex-ana', label: EVIL, at: s.now }];
  s.locks.forEach((l) => {
    if (l.holder === 'claude-nico') l.holder = 'claude-evil';
  });
  s.agents.forEach((a) => {
  });
  return s;
}

function fakeSource(): { source: LiveSource; handlers: () => LiveHandlers } {
  let h: LiveHandlers | null = null;
  return {
    source: {
      start(handlers) {
        h = handlers;
        return () => {};
      },
    },
    handlers: () => h!,
  };
}

let app: App | null = null;
let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  (window as unknown as { __pwned?: number }).__pwned = undefined;
});
afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
});

function mount(snapshot: Snapshot, opts: { demo?: string | null; needsToken?: boolean; token?: string | null } = {}) {
  const f = fakeSource();
  app = mountApp(root, {
    createSource: () => f.source,
    sourceNeedsToken: opts.needsToken ?? false,
    room: 'demo',
    token: opts.token ?? null,
    demo: opts.demo ?? null,
    clock: () => snapshot.now,
  });
  if (!opts.needsToken || opts.token) {
    f.handlers().onStatus('open');
    f.handlers().onSnapshot(snapshot);
  }
  return f;
}

describe('text escaping', () => {
  it('renders agent-supplied markup as text, everywhere', () => {
    mount(evilSnapshot());
    expect(root.querySelector('img[src="x"]')).toBeNull();
    expect(root.querySelectorAll('[onerror]')).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // Only the logo image exists.
    expect([...root.querySelectorAll('img')].every((i) => i.getAttribute('src') === '/logo.svg')).toBe(true);
    const title = [...root.querySelectorAll('.task-row .row-title')].find((el) => el.textContent === EVIL);
    expect(title).toBeDefined();
    expect(title!.children).toHaveLength(0);
    expect(root.querySelector('.act-text')!.textContent).toBe(EVIL);
    expect([...root.querySelectorAll('.row-path')].some((p) => p.textContent === `${EVIL}/`)).toBe(true);
    expect(root.querySelector('.edge-label')!.textContent).toContain('<img');
    expect(root.querySelector('.node[data-callsign="claude-evil"] .sub')!.textContent).toContain(EVIL);
  });

  it('uses no innerHTML-style sinks in the sources', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const files = walk(join(import.meta.dirname)).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('rendering', () => {
  it('shows the top bar, banners, graph nodes, panels and footer from the fixture', () => {
    mount(structuredClone(fixtureSnapshot));
    expect(root.querySelector('.room')!.textContent).toBe('demo');
    expect(root.querySelector('.chip-mode')!.textContent).toBe('mode: enforce');
    expect(root.querySelector('.counts')!.textContent).toBe('5 agents · 6 tasks · 5 locks');
    expect(root.querySelectorAll('.node')).toHaveLength(5);
    expect(root.querySelector('.banner')!.textContent).toContain('claude-sam');
    expect(root.querySelector('.node.state-working')).not.toBeNull();
    expect(root.querySelector('.node.state-quiet .state-label')!.textContent).toBe('quiet 14m');
    expect(root.querySelector('.node.unenforced')!.getAttribute('data-callsign')).toBe('claude-sam');
    for (const cls of ['edge-message', 'edge-blocked', 'edge-waiting', 'edge-nearby', 'edge-broadcast']) {
      expect(root.querySelector(`.${cls}`), cls).not.toBeNull();
    }
    expect(root.querySelectorAll('.task-row').length).toBeGreaterThan(3);
    expect(root.querySelectorAll('.lock-row')).toHaveLength(5);
    expect(root.querySelector('.lock-row.takeable')).toBeNull();
    expect(root.querySelectorAll('.act-row')).toHaveLength(6);
    expect(root.querySelector('.usage-text')!.textContent).toBe('12,840 of 100,000 requests');
  });

  it('shows the mode banner when the room is not enforcing', () => {
    mount({ ...structuredClone(fixtureSnapshot), mode: 'warn' });
    expect([...root.querySelectorAll('.banner')].some((b) => b.getAttribute('data-banner') === 'mode')).toBe(true);
  });

  it('shows the reconnect banner 10 seconds after the connection drops', () => {
    vi.useFakeTimers();
    let t = fixtureSnapshot.now;
    const f = fakeSource();
    app = mountApp(root, { createSource: () => f.source, sourceNeedsToken: false, room: 'demo', token: null, demo: null, clock: () => t });
    f.handlers().onStatus('open');
    f.handlers().onSnapshot(structuredClone(fixtureSnapshot));
    t += 1000;
    f.handlers().onStatus('closed');
    expect(root.querySelector('[data-banner="reconnect"]')).toBeNull();
    t += 11_000;
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('[data-banner="reconnect"]')).not.toBeNull();
    t += 1000;
    f.handlers().onStatus('open');
    expect(root.querySelector('[data-banner="reconnect"]')).toBeNull();
  });
});

describe('token prompt', () => {
  it('asks for a token when the source needs one and none is stored', () => {
    mount(structuredClone(fixtureSnapshot), { needsToken: true });
    const overlay = root.querySelector<HTMLElement>('.token-overlay')!;
    expect(overlay.hidden).toBe(false);
    const input = overlay.querySelector('input')!;
    input.value = 'nope';
    overlay.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(overlay.querySelector('.form-error')!.textContent).toContain('viewer token');
    expect(overlay.hidden).toBe(false);
    input.value = 'https://example.test/r/demo#v=hm_v.test.demo.1.AAAA';
    overlay.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(overlay.hidden).toBe(true);
  });

  it('stays hidden when a token is already known', () => {
    mount(structuredClone(fixtureSnapshot), { needsToken: true, token: 'hm_v.test.demo.1.AAAA' });
    expect(root.querySelector<HTMLElement>('.token-overlay')!.hidden).toBe(true);
  });

  it('can be previewed with ?demo=prompt', () => {
    mount(structuredClone(fixtureSnapshot), { demo: 'prompt' });
    expect(root.querySelector<HTMLElement>('.token-overlay')!.hidden).toBe(false);
  });
});
