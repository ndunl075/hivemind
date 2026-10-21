import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from './live/fixture';
import { buildViewModel } from './model';
import { createGraph } from './views/graph';

function setup() {
  const graph = createGraph();
  document.body.replaceChildren(graph.el);
  graph.update(buildViewModel(fixtureSnapshot, fixtureSnapshot.now));
  return graph;
}

function media(reduced: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('pulse', () => {
  it('travels a dot along the edge for a message, and ripples for a broadcast', () => {
    media(false);
    const g = setup();
    g.pulse({ type: 'pulse', kind: 'message', from: 'claude-nico', to: 'codex-ana', at: 1 });
    expect(g.el.querySelectorAll('.dot')).toHaveLength(1);
    g.pulse({ type: 'pulse', kind: 'broadcast', from: 'codex-sam', at: 1 });
    expect(g.el.querySelectorAll('.ripple')).toHaveLength(3);
  });

  it('with reduced motion, only flashes the nodes: no dots, ripples or animation frames', () => {
    media(true);
    const g = setup();
    g.pulse({ type: 'pulse', kind: 'message', from: 'claude-nico', to: 'codex-ana', at: 1 });
    g.pulse({ type: 'pulse', kind: 'broadcast', from: 'codex-sam', at: 1 });
    g.pulse({ type: 'pulse', kind: 'denied', from: 'claude-nico-2', to: 'codex-ana', at: 1 });
    expect(g.el.querySelectorAll('.dot, .ripple')).toHaveLength(0);
    for (const name of ['claude-nico', 'codex-ana', 'codex-sam', 'claude-nico-2']) {
      expect(g.el.querySelector(`.node[data-callsign="${name}"]`)!.classList.contains('pulsed')).toBe(true);
    }
    expect(vi.mocked(requestAnimationFrame)).not.toHaveBeenCalled();
  });

  it('draws the person labels in their own layer above the edges', () => {
    media(false);
    const g = setup();
    const layers = [...g.el.querySelector('svg.edges')!.children].map((c) => c.getAttribute('class'));
    expect(layers.indexOf('labels')).toBeGreaterThan(layers.indexOf('links'));
    expect(g.el.querySelectorAll('.labels .hull-label')).toHaveLength(3);
  });
});
