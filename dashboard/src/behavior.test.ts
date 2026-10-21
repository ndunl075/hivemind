import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../shared/contracts';
import { mountApp, type App } from './app';
import { fixtureSnapshot } from './live/fixture';
import type { LiveHandlers, LiveSource } from './live/types';

let app: App | null = null;
let root: HTMLElement;

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  app?.stop();
  app = null;
  vi.useRealTimers();
});

function mount(snapshot: Snapshot, opts: { demo?: string | null; needsToken?: boolean } = {}) {
  let h: LiveHandlers | null = null;
  const source: LiveSource = {
    start(handlers) {
      h = handlers;
      return () => {};
    },
  };
  app = mountApp(root, {
    createSource: () => source,
    sourceNeedsToken: opts.needsToken ?? false,
    room: 'demo',
    token: null,
    demo: opts.demo ?? null,
    clock: () => snapshot.now,
  });
  if (!opts.needsToken) {
    h!.onStatus('open');
    h!.onSnapshot(snapshot);
  }
  return () => h!;
}

const key = (name: string, extra: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });

describe('token prompt focus handling', () => {
  it('makes the page behind inert and keeps focus in the dialog', () => {
    mount(structuredClone(fixtureSnapshot), { needsToken: true });
    const overlay = root.querySelector<HTMLElement>('.token-overlay')!;
    const behind = [...root.children].filter((c) => c !== overlay);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((c) => c.hasAttribute('inert'))).toBe(true);
    expect(overlay.hasAttribute('inert')).toBe(false);
    const input = overlay.querySelector('input')!;
    const button = overlay.querySelector('button')!;
    expect(document.activeElement).toBe(input);
    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    button.focus();
    overlay.dispatchEvent(key('Tab'));
    expect(document.activeElement).toBe(input);
    overlay.dispatchEvent(key('Tab', { shiftKey: true }));
    expect(document.activeElement).toBe(button);
  });

  it('removes inert once a token is accepted', () => {
    mount(structuredClone(fixtureSnapshot), { needsToken: true });
    const overlay = root.querySelector<HTMLElement>('.token-overlay')!;
    overlay.querySelector('input')!.value = 'hm_v.test.demo.1.AAAA';
    overlay.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(root.querySelectorAll('[inert]')).toHaveLength(0);
  });

  it('ignores Escape when a token is required', () => {
    mount(structuredClone(fixtureSnapshot), { needsToken: true });
    const overlay = root.querySelector<HTMLElement>('.token-overlay')!;
    overlay.dispatchEvent(key('Escape'));
    expect(overlay.hidden).toBe(false);
    expect(root.querySelectorAll('[inert]').length).toBeGreaterThan(0);
  });

  it('closes the preview prompt with Escape and returns focus', () => {
    mount(structuredClone(fixtureSnapshot), { demo: 'prompt' });
    const preview = root.querySelector<HTMLElement>('.token-overlay')!;
    preview.dispatchEvent(key('Escape'));
    expect(preview.hidden).toBe(true);
    expect(root.querySelectorAll('[inert]')).toHaveLength(0);
  });
});

describe('live updates', () => {
  it('updates activity ages in place without rebuilding the list', () => {
    const handlers = mount(structuredClone(fixtureSnapshot));
    const row = root.querySelector('.act-row')!;
    expect(row.querySelector('.act-age')!.textContent).toBe('12s ago');
    const later = structuredClone(fixtureSnapshot);
    later.now += 5000;
    handlers().onSnapshot(later);
    expect(root.querySelector('.act-row')).toBe(row);
    expect(row.querySelector('.act-age')!.textContent).toBe('17s ago');
    const more = structuredClone(later);
    more.activity.unshift({ seq: 119, ts: more.now, type: 'push', actor: 'codex-ana', text: 'codex-ana pushed main' });
    handlers().onSnapshot(more);
    expect(root.querySelectorAll('.act-row')).toHaveLength(7);
  });

  it('lists the current edges for screen readers', () => {
    mount(structuredClone(fixtureSnapshot));
    const list = root.querySelector('.graph .sr-only')!;
    const items = [...list.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toContain('claude-nico-2 blocked from login.ts, held by codex-ana');
    expect(items).toContain('claude-nico messaged codex-ana');
    expect(items).toContain('codex-sam messaged everyone');
    expect(items).toContain('claude-nico-2 waits on codex-ana');
    expect(list.getAttribute('aria-live')).toBe('polite');
  });
});

describe('auth failure from the live source', () => {
  it('stops the source, forgets the token, re-prompts, and restarts with the new token', async () => {
    const handlers: LiveHandlers[] = [];
    const tokens: (string | null)[] = [];
    let stopped = 0;
    const createSource = (opts: { token: string | null }): LiveSource => {
      tokens.push(opts.token);
      return {
        start(h) {
          handlers.push(h);
          return () => { stopped += 1; };
        },
      };
    };
    localStorage.setItem('hivemind.viewer.demo', 'hm_v.test.1.AAAA');
    const snap = structuredClone(fixtureSnapshot);
    app = mountApp(root, { createSource, sourceNeedsToken: true, room: 'demo', token: 'hm_v.test.1.AAAA', demo: null, clock: () => snap.now });
    expect(root.querySelector('[inert]')).toBeNull();

    handlers[0]!.onAuthFailure!();
    await Promise.resolve();
    expect(stopped).toBe(1);
    expect(root.querySelector('[inert]')).not.toBeNull();
    expect(localStorage.getItem('hivemind.viewer.demo')).toBeNull();

    const overlay = root.querySelector<HTMLElement>('.token-overlay')!;
    const input = overlay.querySelector('input')!;
    input.value = 'hm_v.test.2.BBBB';
    overlay.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(tokens).toEqual(['hm_v.test.1.AAAA', 'hm_v.test.2.BBBB']);
    expect(handlers.length).toBe(2);
    expect(localStorage.getItem('hivemind.viewer.demo')).toBe('hm_v.test.2.BBBB');
    expect(root.querySelector('[inert]')).toBeNull();

    // A late failure from the replaced source is ignored.
    handlers[0]!.onAuthFailure!();
    await Promise.resolve();
    expect(stopped).toBe(1);
    expect(root.querySelector('[inert]')).toBeNull();
  });

  it('handles a failure reported synchronously inside start(), with no connecting banner', async () => {
    let stopped = 0;
    const source: LiveSource = {
      start(h) {
        h.onAuthFailure!();
        return () => { stopped += 1; };
      },
    };
    vi.useFakeTimers();
    let now = fixtureSnapshot.now;
    app = mountApp(root, { createSource: () => source, sourceNeedsToken: true, room: 'demo', token: 'hm_v.test.1.AAAA', demo: null, clock: () => now });
    await Promise.resolve();
    expect(stopped).toBe(1);
    expect(root.querySelector('[inert]')).not.toBeNull();
    now += 60_000;
    vi.advanceTimersByTime(1000);
    expect(root.textContent).not.toContain('Connecting to the room');
    expect(root.textContent).not.toContain('Reconnecting');
    app.stop();
    app = null;
    expect(stopped).toBe(1);
  });

  it('shows no connecting banner while the initial token prompt is open', () => {
    vi.useFakeTimers();
    let now = fixtureSnapshot.now;
    const source: LiveSource = { start() { return () => {}; } };
    app = mountApp(root, { createSource: () => source, sourceNeedsToken: true, room: 'demo', token: null, demo: null, clock: () => now });
    now += 60_000;
    vi.advanceTimersByTime(1000);
    expect(root.querySelector('[inert]')).not.toBeNull();
    expect(root.textContent).not.toContain('Connecting to the room');
  });
});
