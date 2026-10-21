import { describe, expect, it } from 'vitest';
import { bowControl, convexHull, forceLayout, groupOutline, pointOnQuad, rectEdgePoint, ringLayout, type LayoutNode } from './layout';

const W = 220;
const H = 100;
const nodes: LayoutNode[] = [
  { id: 'claude-nico', group: 'nico', w: W, h: H },
  { id: 'claude-nico-2', group: 'nico', w: W, h: H },
  { id: 'codex-ana', group: 'ana', w: W, h: H },
  { id: 'codex-sam', group: 'sam', w: W, h: H },
  { id: 'claude-sam', group: 'sam', w: W, h: H },
];
const size = { width: 1000, height: 640 };

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }, w = W, h = H) {
  return Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < h;
}

describe('forceLayout', () => {
  const links = [{ a: 'claude-nico', b: 'codex-ana' }];
  const placed = forceLayout(nodes, links, size);

  it('places every node inside the frame without overlap', () => {
    expect(placed.size).toBe(nodes.length);
    for (const n of nodes) {
      const p = placed.get(n.id)!;
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x - W / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + W / 2).toBeLessThanOrEqual(size.width);
      expect(p.y - H / 2).toBeGreaterThanOrEqual(0);
      expect(p.y + H / 2).toBeLessThanOrEqual(size.height);
    }
    const ids = [...placed.keys()];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(overlaps(placed.get(ids[i]!)!, placed.get(ids[j]!)!)).toBe(false);
  });

  it('is deterministic', () => {
    expect([...forceLayout(nodes, links, size)]).toEqual([...placed]);
  });

  it('keeps one person closer together than strangers', () => {
    const d = (a: string, b: string) => Math.hypot(placed.get(a)!.x - placed.get(b)!.x, placed.get(a)!.y - placed.get(b)!.y);
    expect(d('claude-nico', 'claude-nico-2')).toBeLessThan(d('claude-nico-2', 'codex-sam'));
  });

  it('keeps nodes near their previous spot when a node is added', () => {
    const before = forceLayout(nodes.slice(0, 4), links, size);
    const after = forceLayout(nodes, links, size, { previous: before });
    const moved = Math.hypot(after.get('codex-ana')!.x - before.get('codex-ana')!.x, after.get('codex-ana')!.y - before.get('codex-ana')!.y);
    expect(moved).toBeLessThan(260);
  });

  it('fits a phone-sized frame', () => {
    const small = nodes.map((n) => ({ ...n, w: 164, h: 96 }));
    const frame = { width: 358, height: 560 };
    const p = forceLayout(small, links, frame, { pad: 20, gap: 14 });
    for (const n of small) {
      const q = p.get(n.id)!;
      expect(q.x - 82).toBeGreaterThanOrEqual(-0.5);
      expect(q.x + 82).toBeLessThanOrEqual(frame.width + 0.5);
    }
  });

  it('handles zero and one node', () => {
    expect(forceLayout([], [], size).size).toBe(0);
    expect(forceLayout([nodes[0]!], [], size).get('claude-nico')).toBeDefined();
  });
});

describe('ringLayout', () => {
  it('spreads nodes around the frame', () => {
    const p = ringLayout(nodes, size);
    expect(p.size).toBe(5);
    const xs = [...p.values()].map((q) => q.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(300);
  });
});

describe('geometry', () => {
  it('builds a convex hull', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ]);
    expect(hull).toHaveLength(4);
  });
  it('outlines a group with padding', () => {
    const o = groupOutline([{ x: 100, y: 100, w: 40, h: 20 }], 10);
    expect(o).toHaveLength(4);
    expect(Math.min(...o.map((p) => p.x))).toBe(70);
  });
  it('finds where a line leaves a rectangle', () => {
    expect(rectEdgePoint({ x: 0, y: 0 }, 100, 40, { x: 200, y: 0 })).toEqual({ x: 50, y: 0 });
    expect(rectEdgePoint({ x: 0, y: 0 }, 100, 40, { x: 0, y: -100 }, 4)).toEqual({ x: 0, y: -24 });
  });
  it('bows an edge sideways and samples the curve', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const c = bowControl(a, b, 30);
    expect(c).toEqual({ x: 50, y: 30 });
    expect(pointOnQuad(a, c, b, 0)).toEqual(a);
    expect(pointOnQuad(a, c, b, 1)).toEqual(b);
    expect(pointOnQuad(a, c, b, 0.5)).toEqual({ x: 50, y: 15 });
  });
});
