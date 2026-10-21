import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../shared/contracts';
import { mountApp, type App } from './app';
import { bigTeamSnapshot } from './live/bigTeam';
import type { LiveSource } from './live/types';
import { buildViewModel, checkoutLabels, type CheckoutOrder } from './model';
import { forceLayoutFit, gridLayout, hasOverlap, type LayoutNode } from './layout';
import { NO_FOCUS, shapeViewModel, toggleFocus } from './team';
import { createGraph } from './views/graph';

const NOW = 1_900_000_000_000;
const snap = () => bigTeamSnapshot(NOW);
const key = (name: string) => new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function graphAt(width: number) {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  const g = createGraph();
  Object.defineProperty(g.el, 'clientWidth', { value: width, configurable: true });
  document.body.replaceChildren(g.el);
  return g;
}

const placed = (g: ReturnType<typeof createGraph>) =>
  [...g.el.querySelectorAll<HTMLElement>('.node')].map((n) => [n.dataset.callsign, n.style.transform] as const);

describe('graph at phone width (regression: focus switch left cards unplaced)', () => {
  it('places every card when focus moves straight from one person to another with the same agent count', () => {
    const g = graphAt(375);
    const full = buildViewModel(snap(), NOW);
    g.update(shapeViewModel(full, toggleFocus(NO_FOCUS, 'ana')));
    g.update(shapeViewModel(full, toggleFocus(NO_FOCUS, 'lena')));
    const cards = placed(g);
    expect(cards).toHaveLength(3);
    expect(cards.every(([id, t]) => /lena/.test(id!) && /translate\(/.test(t))).toBe(true);
    expect(new Set(cards.map(([, t]) => t)).size).toBe(cards.length);
  });

  it('places cards when the roster changes without changing the count', () => {
    const g = graphAt(375);
    const s1 = snap();
    g.update(buildViewModel(s1, NOW));
    const s2 = structuredClone(s1);
    s2.agents = s2.agents.map((a) => (a.callsign === 'codex-sam' ? { ...a, callsign: 'codex-sam-new' } : a));
    g.update(buildViewModel(s2, NOW));
    expect(placed(g).find(([id]) => id === 'codex-sam-new')![1]).toMatch(/translate\(/);
  });
});

describe('checkout labels', () => {
  it('keeps numbers stable when a checkout expires and when one re-joins', () => {
    const order: CheckoutOrder = new Map();
    const a = (checkout: string, startedAt: number) => ({ person: 'p', checkout, startedAt });
    expect([...checkoutLabels([a('x', 1), a('y', 2)], order)]).toEqual([
      ['p|x', 'checkout 1/2'],
      ['p|y', 'checkout 2/2'],
    ]);
    expect(checkoutLabels([a('y', 2)], order).get('p|y')).toBe('checkout 2/2');
    expect(checkoutLabels([a('y', 2), a('x', 99)], order).get('p|x')).toBe('checkout 1/2');
    expect(checkoutLabels([a('y', 2), a('x', 99), a('z', 100)], order).get('p|z')).toBe('checkout 3/3');
  });

  it('labels nothing for agents without a checkout or people with a single checkout', () => {
    const labels = checkoutLabels([
      { person: 'a', checkout: null, startedAt: 1 },
      { person: 'a', checkout: null, startedAt: 2 },
      { person: 'b', checkout: 'only', startedAt: 1 },
    ]);
    expect(labels.size).toBe(0);
    const s = snap();
    s.agents = s.agents.map((a) => ({ ...a, checkout: null }));
    const vm = buildViewModel(s, NOW);
    expect(vm.agents.every((x) => x.checkoutLabel === null)).toBe(true);
    expect(vm.people.every((p) => p.checkouts === 0)).toBe(true);
  });
});

describe('focus filtering', () => {
  it('shows exactly one person: agents, owned tasks, held locks and own activity', () => {
    const full = buildViewModel(snap(), NOW);
    const f = shapeViewModel(full, toggleFocus(NO_FOCUS, 'ana'));
    const mine = new Set(full.agents.filter((a) => a.person === 'ana').map((a) => a.callsign));
    expect(f.agents.every((a) => a.person === 'ana')).toBe(true);
    expect(f.tasks.items.length).toBeGreaterThan(0);
    expect(f.tasks.items.every((t) => t.owner !== null && mine.has(t.owner))).toBe(true);
    expect(f.locks.length).toBeGreaterThan(0);
    expect(f.locks.every((l) => mine.has(l.holder))).toBe(true);
    expect(f.activity.every((a) => a.actor !== null && mine.has(a.actor))).toBe(true);
    expect(f.tasks.hiddenUnowned).toBe(3);
    expect(shapeViewModel(full, NO_FOCUS).tasks.hiddenUnowned).toBe(0);
  });
});

describe('app: keyboard and labels', () => {
  let app: App | null = null;
  afterEach(() => app?.stop());

  function mount(s: Snapshot) {
    const source: LiveSource = {
      start(h) {
        h.onSnapshot(s);
        h.onStatus('open');
        return () => {};
      },
    };
    const root = document.createElement('div');
    document.body.append(root);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    app = mountApp(root, { createSource: () => source, sourceNeedsToken: false, room: 'demo', token: null, demo: 'team', clock: () => NOW });
    return root;
  }

  it('focuses with a click, says the top-bar counts are room-wide, and Escape clears', () => {
    const root = mount(snap());
    const chips = root.querySelectorAll<HTMLButtonElement>('.team-main');
    chips[0]!.click();
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(chips[0]!.getAttribute('aria-label')).not.toMatch(/Press/);
    expect(root.querySelector('.counts')!.textContent).toMatch(/^Whole room:/);
    expect(root.querySelector('.panel-meta .stat-hint')!.textContent).toBe('3 unowned tasks hidden');
    document.dispatchEvent(key('Escape'));
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.counts')!.textContent).not.toMatch(/Whole room/);
  });

  it('ignores an Escape that something else already handled', () => {
    const root = mount(snap());
    root.querySelector<HTMLButtonElement>('.team-main')!.click();
    const e = key('Escape');
    e.preventDefault();
    document.dispatchEvent(e);
    expect(root.querySelector('.team-main')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('moves keyboard focus back to the chip when "Show everyone" hides itself', () => {
    const root = mount(snap());
    const chip = root.querySelector<HTMLButtonElement>('.team-main')!;
    chip.click();
    const clear = root.querySelector<HTMLButtonElement>('.team-clear')!;
    clear.focus();
    clear.click();
    expect(clear.hidden).toBe(true);
    expect(document.activeElement).toBe(chip);
  });

  it('expands and collapses ended agents with the "N ended" button', () => {
    const root = mount(snap());
    const count = () => root.querySelectorAll('.node').length;
    expect(count()).toBe(16);
    const btn = root.querySelector<HTMLButtonElement>('.team-ended')!;
    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(count()).toBe(18);
    btn.click();
    expect(count()).toBe(16);
  });
});

describe('layouts at 30 agents', () => {
  const thirty = (): LayoutNode[] => {
    const nodes: LayoutNode[] = [];
    for (let p = 0; p < 6; p++) {
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < (c === 0 ? 3 : 1); k++) nodes.push({ id: `p${p}c${c}k${k}`, group: `p${p}`, cluster: `c${c}`, w: 176, h: 94 });
      }
    }
    return nodes;
  };

  it('uses 6 people with 3 checkouts and 30 cards', () => expect(thirty()).toHaveLength(30));

  it('grows a too-small frame until no card overlaps', () => {
    const nodes = thirty();
    const fit = forceLayoutFit(nodes, [], { width: 986, height: 500 }, { pad: 38, gap: 14, groupGap: 48 });
    expect(hasOverlap(nodes, fit.positions)).toBe(false);
    expect(fit.size.height).toBeGreaterThan(500);
  });

  it('grid layout at 375px never overlaps', () => {
    const nodes = thirty().map((n) => ({ ...n, w: 164 }));
    expect(hasOverlap(nodes, gridLayout(nodes, 375, { pad: 13, gap: 14 }).positions)).toBe(false);
  });
});

describe('layout cache', () => {
  it('restores identical positions after focus then clear, twice', () => {
    const g = graphAt(1366);
    const full = buildViewModel(snap(), NOW);
    const everyone = shapeViewModel(full, NO_FOCUS);
    g.update(everyone);
    const sorted = () => placed(g).sort((a, b) => a[0]!.localeCompare(b[0]!));
    const before = sorted();
    for (let i = 0; i < 2; i++) {
      g.update(shapeViewModel(full, toggleFocus(NO_FOCUS, 'ana')));
      g.update(everyone);
      expect(sorted()).toEqual(before);
    }
  });
});
