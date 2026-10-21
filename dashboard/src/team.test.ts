import { describe, expect, it } from 'vitest';
import { bigTeamSnapshot } from './live/bigTeam';
import { buildViewModel, checkoutLabels } from './model';
import { gridLayout, forceLayout, type LayoutNode } from './layout';
import { NO_FOCUS, normalizeUi, shapeViewModel, toggleEnded, toggleFocus } from './team';
import { createTeamBar } from './views/team';

const NOW = 1_900_000_000_000;
const vm = () => buildViewModel(bigTeamSnapshot(NOW), NOW);

describe('checkout labels', () => {
  it('numbers a person\'s checkouts by first sight and skips single-checkout people', () => {
    const l = checkoutLabels([
      { person: 'a', checkout: 'zzz', startedAt: 1 },
      { person: 'a', checkout: 'aaa', startedAt: 5 },
      { person: 'a', checkout: 'zzz', startedAt: 9 },
      { person: 'b', checkout: 'only', startedAt: 1 },
      { person: 'c', checkout: null, startedAt: 1 },
    ]);
    expect(l.get('a|zzz')).toBe('checkout 1/2');
    expect(l.get('a|aaa')).toBe('checkout 2/2');
    expect(l.size).toBe(2);
  });

  it('never shows ids, and labels agents in the view-model', () => {
    const agents = vm().agents;
    expect(agents.find((a) => a.callsign === 'codex-nico')!.checkoutLabel).toBe('checkout 2/3');
    expect(agents.every((a) => a.checkoutLabel === null || /^checkout \d\/\d$/.test(a.checkoutLabel))).toBe(true);
  });
});

describe('people summary', () => {
  it('counts live and ended agents, tasks in progress and locks per person', () => {
    const v = vm();
    const nico = v.people.find((p) => p.person === 'nico')!;
    expect(v.people.map((p) => p.person)).toEqual(['ana', 'lena', 'nico', 'omar', 'priya', 'sam']);
    expect(nico).toMatchObject({ live: 3, ended: 2, checkouts: 3 });
    const snap = bigTeamSnapshot(NOW);
    const mine = new Set(snap.agents.filter((a) => a.person === 'nico').map((a) => a.callsign));
    expect(nico.locks).toBe(snap.locks.filter((l) => mine.has(l.holder)).length);
    expect(nico.tasksInProgress).toBe(snap.tasks.filter((t) => t.status === 'in_progress' && t.owner && mine.has(t.owner)).length);
    expect(v.people.reduce((n, p) => n + p.live, 0)).toBe(v.counts.agents);
  });
});

describe('shapeViewModel', () => {
  it('collapses ended agents until a person is expanded', () => {
    const v = vm();
    const shown = shapeViewModel(v, NO_FOCUS);
    expect(shown.agents.every((a) => a.state !== 'ended')).toBe(true);
    expect(shown.agents).toHaveLength(16);
    const open = shapeViewModel(v, toggleEnded(NO_FOCUS, 'nico'));
    expect(open.agents.filter((a) => a.state === 'ended').map((a) => a.person)).toEqual(['nico', 'nico']);
    expect(shapeViewModel(v, toggleEnded(toggleEnded(NO_FOCUS, 'nico'), 'nico')).agents).toHaveLength(16);
  });

  it('focuses one person across agents, tasks, locks and activity, and clears', () => {
    const v = vm();
    const ui = toggleFocus(NO_FOCUS, 'ana');
    const f = shapeViewModel(v, ui);
    expect(f.agents.every((a) => a.person === 'ana')).toBe(true);
    expect(f.tasks.items.every((t) => t.owner?.endsWith('-ana') || t.owner?.includes('-ana-'))).toBe(true);
    expect(f.locks.every((l) => l.holder.includes('-ana'))).toBe(true);
    expect(f.activity.every((a) => a.actor?.includes('-ana'))).toBe(true);
    expect(f.edges.every((e) => f.agents.some((a) => a.callsign === e.from))).toBe(true);
    expect(f.counts).toEqual(v.counts);
    expect(toggleFocus(ui, 'ana').focus).toBeNull();
    expect(shapeViewModel(v, toggleFocus(ui, 'ana')).tasks.items).toHaveLength(v.tasks.items.length);
  });

  it('drops a focus on someone who left', () => {
    expect(normalizeUi({ focus: 'ghost', expanded: new Set() }, vm()).focus).toBeNull();
  });
});

describe('team bar', () => {
  it('renders keyboard-operable buttons and reports clicks, reusing elements between updates', () => {
    const calls: string[] = [];
    const bar = createTeamBar({ onFocus: (p) => calls.push(`focus ${p}`), onClear: () => calls.push('clear'), onToggleEnded: (p) => calls.push(`ended ${p}`) });
    document.body.append(bar.el);
    bar.update(vm(), NO_FOCUS);
    const first = bar.el.querySelector('.team-main')!;
    expect(first.tagName).toBe('BUTTON');
    expect(first.textContent).toContain('3 live');
    expect(bar.el.querySelector<HTMLElement>('.team-clear')!.hidden).toBe(true);
    bar.update(vm(), toggleFocus(NO_FOCUS, 'ana'));
    expect(bar.el.querySelector('.team-main')).toBe(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(bar.el.querySelector<HTMLElement>('.team-clear')!.hidden).toBe(false);
    (first as HTMLElement).click();
    bar.el.querySelector<HTMLElement>('.team-ended')!.click();
    bar.el.querySelector<HTMLElement>('.team-clear')!.click();
    expect(calls).toEqual(['focus ana', 'ended ana', 'clear']);
    bar.el.remove();
  });
});

describe('layouts at team size', () => {
  const nodes: LayoutNode[] = vm().agents.map((a) => ({ id: a.callsign, group: a.person, cluster: a.checkout ?? '', w: 176, h: 94 }));
  const overlaps = (pos: Map<string, { x: number; y: number }>) =>
    nodes.flatMap((a, i) => nodes.slice(i + 1).filter((b) => {
      const p = pos.get(a.id)!;
      const q = pos.get(b.id)!;
      return Math.abs(p.x - q.x) < (a.w + b.w) / 2 && Math.abs(p.y - q.y) < (a.h + b.h) / 2;
    }));

  it('grid layout never overlaps and fits its height', () => {
    const { positions, height } = gridLayout(nodes, 375, { pad: 13, gap: 14 });
    expect(overlaps(positions)).toEqual([]);
    expect(Math.max(...[...positions.values()].map((p) => p.y)) + 47).toBeLessThanOrEqual(height);
  });

  it('force layout gives 16 cards room in a laptop-sized frame', () => {
    const pos = forceLayout(nodes, [], { width: 986, height: 1100 }, { pad: 38, gap: 14, groupGap: 48 });
    expect(overlaps(pos)).toEqual([]);
  });
});
