/**
 * The hive: agents as nodes grouped by person, joined by the five edge types (§14.2). HTML node cards sit over an
 * SVG layer that draws the person outlines, edges and pulse effects. All agent text goes in through textContent.
 */
import type { Pulse } from '../../../shared/contracts';
import { h, prefersReducedMotion, s, setClass, setText } from '../dom';
import { truncate } from '../format';
import {
  bowControl,
  forceLayout,
  gridLayout,
  groupOutline,
  pointOnQuad,
  rectEdgePoint,
  type LayoutLink,
  type LayoutNode,
  type Point,
} from '../layout';
import { describeEdge, type AgentVM, type EdgeVM, type ViewModel } from '../model';

interface NodeView {
  el: HTMLElement;
  callsign: HTMLElement;
  sub: HTMLElement;
  state: HTMLElement;
  locks: HTMLElement;
  flags: HTMLElement;
  task: HTMLElement;
  activity: HTMLElement;
}

export interface GraphView {
  el: HTMLElement;
  update(vm: ViewModel): void;
  pulse(p: Pulse): void;
  /** Re-run the layout, e.g. after the container changed size. */
  resize(): void;
}

/** Card sizes by how many agents are drawn: full cards for a few agents, smaller ones for a big team. */
const TIERS = {
  full: { w: 236, h: 122, gap: 26 },
  dense: { w: 204, h: 106, gap: 20 },
  tight: { w: 176, h: 94, gap: 14 },
} as const;
type Tier = keyof typeof TIERS;

function tierFor(count: number): Tier {
  return count <= 6 ? 'full' : count <= 12 ? 'dense' : 'tight';
}

const BOW: Record<string, number> = { message: 18, blocked: 44, waiting: -18, nearby: 0 };

function clawdGlyph(): SVGSVGElement {
  const svg = s('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', class: 'glyph glyph-claude' });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const inner = i % 2 === 0 ? 1.6 : 2.6;
    svg.append(
      s('line', {
        x1: 8 + Math.cos(a) * inner,
        y1: 8 + Math.sin(a) * inner,
        x2: 8 + Math.cos(a) * 6.6,
        y2: 8 + Math.sin(a) * 6.6,
      }),
    );
  }
  return svg;
}

function codexGlyph(): SVGSVGElement {
  const svg = s('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', class: 'glyph glyph-codex' });
  svg.append(s('path', { d: 'M3.5 4.5 L7.5 8 L3.5 11.5' }), s('line', { x1: 9, y1: 11.5, x2: 12.5, y2: 11.5 }));
  return svg;
}

function createNode(a: AgentVM): NodeView {
  const callsign = h('div', { class: 'callsign' });
  const sub = h('div', { class: 'sub' });
  const state = h('span', { class: 'state-label' });
  const locks = h('span', { class: 'lock-count' });
  const flags = h('span', { class: 'flags' });
  const task = h('div', { class: 'node-task' });
  const activity = h('div', { class: 'node-activity' });
  const el = h(
    'div',
    { class: 'node', tabindex: 0, role: 'group', 'data-callsign': a.callsign },
    h(
      'div',
      { class: 'node-head' },
      h('div', { class: `mark mark-${a.kind}` }, h('span', { class: 'ring' }), a.kind === 'claude' ? clawdGlyph() : codexGlyph()),
      h('div', { class: 'ident' }, callsign, sub),
    ),
    h('div', { class: 'node-state' }, state, flags, locks),
    task,
    activity,
  );
  return { el, callsign, sub, state, locks, flags, task, activity };
}

function roundedPath(points: Point[], r: number): string {
  const n = points.length;
  if (n === 0) return '';
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n]!;
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const toPrev = Math.hypot(prev.x - cur.x, prev.y - cur.y) || 1;
    const toNext = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
    const rr = Math.min(r, toPrev / 2, toNext / 2);
    const a = { x: cur.x + ((prev.x - cur.x) / toPrev) * rr, y: cur.y + ((prev.y - cur.y) / toPrev) * rr };
    const b = { x: cur.x + ((next.x - cur.x) / toNext) * rr, y: cur.y + ((next.y - cur.y) / toNext) * rr };
    d += `${i === 0 ? 'M' : 'L'}${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${cur.x.toFixed(1)} ${cur.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)} `;
  }
  return `${d}Z`;
}

export function createGraph(): GraphView {
  const hulls = s('g', { class: 'hulls' });
  const links = s('g', { class: 'links' });
  const fx = s('g', { class: 'fx' });
  const labels = s('g', { class: 'labels' });
  const defs = s(
    'defs',
    undefined,
    ...[
      ['arrow-blocked', 'var(--danger)'],
      ['arrow-waiting', 'var(--edge-gray)'],
    ].map(([id, color]) =>
      s(
        'marker',
        { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M1 1 L9 5 L1 9 Z', fill: color }),
      ),
    ),
  );
  const svg = s('svg', { class: 'edges', 'aria-hidden': 'true', preserveAspectRatio: 'none' }, defs, hulls, links, fx, labels);
  const nodesLayer = h('div', { class: 'nodes' });
  const empty = h('p', { class: 'empty-graph' }, 'No agents in this room yet.');
  const stage = h('div', { class: 'stage' }, svg, nodesLayer, empty);
  const connections = h('ul', { class: 'sr-only', 'aria-label': 'Connections between agents', 'aria-live': 'polite' });
  const el = h('section', { class: 'graph', 'aria-label': 'Agent graph' }, stage, connections);
  let connectionsKey = '';

  const views = new Map<string, NodeView>();
  let positions = new Map<string, Point>();
  let layoutKey = '';
  let drawKey = '';
  let last: ViewModel | null = null;
  let dims = { w: 236, h: 122 };
  let hullPad = 20;
  let nodeGap = 26;
  /** Narrow screens use a plain grid; wider ones the force layout. */
  let grid: { positions: Map<string, Point>; height: number } | null = null;
  let frame = { width: 1000, height: 600 };
  /** Cached container width (kept current by the ResizeObserver) so updates don't force layout. */
  let boxW = 0;
  let measuredKey = '';

  function measure(vm: ViewModel): void {
    if (boxW === 0) boxW = el.clientWidth || 1000;
    const count = vm.agents.length;
    const tier = tierFor(count);
    const key = `${boxW}|${count}|${vm.people.length}`;
    if (key === measuredKey) return;
    measuredKey = key;
    const width = boxW;
    const narrow = width < 700;
    const t = TIERS[tier];
    hullPad = narrow ? 9 : 20;
    nodeGap = narrow ? Math.min(t.gap, 14) : t.gap;
    dims = narrow ? { w: Math.min(t.w, Math.floor((width - 2 * (hullPad + 6) - 16) / 2)), h: t.h } : { w: t.w, h: t.h };
    setClass(stage, 'tier-dense', tier === 'dense');
    setClass(stage, 'tier-tight', tier === 'tight');
    let need = 0;
    grid = null;
    if (narrow) {
      const nodes: LayoutNode[] = vm.agents.map((a) => ({ id: a.callsign, group: a.person, cluster: a.checkout ?? '', w: dims.w, h: dims.h }));
      grid = gridLayout(nodes, width, { pad: hullPad + 4, gap: 14 });
      need = Math.max(380, Math.ceil(grid.height));
    } else {
      // Room for every card plus the gaps and outlines around each person; the page scrolls if it is more than the window.
      const people = Math.max(1, vm.people.length);
      const cell = (dims.w + nodeGap + 2 * hullPad) * (dims.h + nodeGap + 2 * hullPad);
      need = Math.ceil((count * cell * 1.45 + people * 9000) / Math.max(1, width));
      need = need > 460 ? need : 0;
    }
    if (narrow) stage.style.height = `${need}px`;
    else {
      stage.style.height = '';
      stage.style.minHeight = need > 0 ? `${need}px` : '';
    }
    frame = { width: stage.clientWidth || width, height: stage.clientHeight || 600 };
  }

  function layoutLinks(edges: EdgeVM[]): LayoutLink[] {
    return edges.filter((e) => e.to !== null && e.kind !== 'nearby').map((e) => ({ a: e.from, b: e.to! }));
  }

  function nodeCenter(id: string): Point | undefined {
    return positions.get(id);
  }

  function edgeGeometry(e: EdgeVM): { a: Point; c: Point; b: Point } | null {
    if (e.to === null) return null;
    const pa = nodeCenter(e.from);
    const pb = nodeCenter(e.to);
    if (!pa || !pb) return null;
    const a = rectEdgePoint(pa, dims.w, dims.h, pb, 5);
    const b = rectEdgePoint(pb, dims.w, dims.h, pa, 7);
    return { a, b, c: bowControl(a, b, BOW[e.kind] ?? 0) };
  }

  function drawEdges(vm: ViewModel): void {
    hulls.replaceChildren();
    links.replaceChildren();
    labels.replaceChildren();
    const byPerson = new Map<string, { x: number; y: number; w: number; h: number }[]>();
    const byCluster = new Map<string, { person: string; label: string; rects: { x: number; y: number; w: number; h: number }[] }>();
    for (const a of vm.agents) {
      const p = positions.get(a.callsign);
      if (!p) continue;
      const rect = { x: p.x, y: p.y, w: dims.w, h: dims.h };
      const list = byPerson.get(a.person) ?? [];
      list.push(rect);
      byPerson.set(a.person, list);
      if (a.checkoutLabel) {
        const ck = `${a.person}|${a.checkout}`;
        const c = byCluster.get(ck) ?? { person: a.person, label: a.checkoutLabel, rects: [] };
        c.rects.push(rect);
        byCluster.set(ck, c);
      }
    }
    for (const c of byCluster.values()) {
      const outline = groupOutline(c.rects, 6);
      if (outline.length < 3) continue;
      // The checkout label sits under its outline, so it never meets the person's label above.
      const bottom = outline.reduce((m, p) => (p.y > m.y || (p.y === m.y && p.x < m.x) ? p : m), outline[0]!);
      hulls.append(s('path', { class: 'cluster', d: roundedPath(outline, 12) }));
      labels.append(s('text', { class: 'cluster-label', x: bottom.x + 10, y: bottom.y + 11 }, c.label));
    }
    for (const [person, rects] of byPerson) {
      const outline = groupOutline(rects, hullPad);
      if (outline.length < 3) continue;
      const top = outline.reduce((m, p) => (p.y < m.y || (p.y === m.y && p.x < m.x) ? p : m), outline[0]!);
      hulls.append(s('path', { class: 'hull', d: roundedPath(outline, 22) }));
      labels.append(s('text', { class: 'hull-label', x: top.x + 22, y: top.y + 15 }, person));
    }
    const order = ['nearby', 'waiting', 'message', 'blocked'];
    for (const kind of order) {
      for (const e of vm.edges.filter((x) => x.kind === kind)) {
        const g = edgeGeometry(e);
        if (!g) continue;
        const d = `M${g.a.x.toFixed(1)} ${g.a.y.toFixed(1)} Q${g.c.x.toFixed(1)} ${g.c.y.toFixed(1)} ${g.b.x.toFixed(1)} ${g.b.y.toFixed(1)}`;
        const path = s('path', { class: `edge edge-${kind}`, d });
        if (kind === 'blocked') path.setAttribute('marker-end', 'url(#arrow-blocked)');
        if (kind === 'waiting') path.setAttribute('marker-end', 'url(#arrow-waiting)');
        links.append(path);
        if (kind === 'blocked' && e.label) {
          const mid = pointOnQuad(g.a, g.c, g.b, 0.5);
          links.append(s('text', { class: 'edge-label', x: mid.x.toFixed(1), y: (mid.y - 7).toFixed(1), 'text-anchor': 'middle' }, `blocked: ${truncate(e.label, 28)}`));
        }
      }
    }
    for (const e of vm.edges.filter((x) => x.kind === 'broadcast')) {
      const p = positions.get(e.from);
      if (!p) continue;
      links.append(
        s('rect', {
          class: 'edge edge-broadcast',
          x: (p.x - dims.w / 2 - 7).toFixed(1),
          y: (p.y - dims.h / 2 - 7).toFixed(1),
          width: dims.w + 14,
          height: dims.h + 14,
          rx: 17,
        }),
      );
    }
  }

  function place(): void {
    for (const [id, v] of views) {
      const p = positions.get(id);
      if (!p) continue;
      v.el.style.width = `${dims.w}px`;
      v.el.style.height = `${dims.h}px`;
      v.el.style.transform = `translate(${(p.x - dims.w / 2).toFixed(1)}px, ${(p.y - dims.h / 2).toFixed(1)}px)`;
    }
  }

  function update(vm: ViewModel): void {
    last = vm;
    measure(vm);
    setClass(empty, 'show', vm.agents.length === 0);
    const described = vm.edges.map(describeEdge);
    const describedKey = described.join('|');
    if (describedKey !== connectionsKey) {
      connectionsKey = describedKey;
      connections.replaceChildren(...described.map((d) => h('li', undefined, d)));
    }

    const ids = new Set(vm.agents.map((a) => a.callsign));
    for (const [id, v] of views) {
      if (!ids.has(id)) {
        v.el.remove();
        views.delete(id);
      }
    }
    for (const a of vm.agents) {
      let v = views.get(a.callsign);
      if (!v) {
        v = createNode(a);
        views.set(a.callsign, v);
        nodesLayer.append(v.el);
      }
      setText(v.callsign, a.callsign);
      setText(v.sub, [a.person, a.branch].filter(Boolean).join(' · '));
      v.sub.title = a.checkoutLabel ?? '';
      setText(v.state, a.stateLabel);
      setText(v.locks, a.lockCount > 0 ? `${a.lockCount} ${a.lockCount === 1 ? 'lock' : 'locks'}` : '');
      const flagText = [a.takeable ? 'takeable' : '', a.enforced ? '' : 'not enforced'].filter(Boolean).join(' · ');
      setText(v.flags, flagText);
      setText(v.task, a.taskLabel ?? 'No task');
      setClass(v.task, 'none', a.taskLabel === null);
      setText(v.activity, a.activityLine);
      v.el.className = `node state-${a.state}${a.enforced ? '' : ' unenforced'}${a.takeable ? ' takeable' : ''}${v.el.classList.contains('pulsed') ? ' pulsed' : ''}`;
      v.el.setAttribute('aria-label', `${a.callsign}, ${a.person}${a.checkoutLabel ? `, ${a.checkoutLabel}` : ''}, ${a.state}, ${a.stateLabel}${a.enforced ? '' : ', not enforced'}`);
    }

    const key = JSON.stringify([
      vm.agents.map((a) => [a.callsign, a.person, a.checkout]),
      layoutLinks(vm.edges).map((l) => [l.a, l.b]),
      frame,
      dims,
    ]);
    if (key !== layoutKey) {
      layoutKey = key;
      const nodes: LayoutNode[] = vm.agents.map((a) => ({ id: a.callsign, group: a.person, cluster: a.checkout ?? '', w: dims.w, h: dims.h }));
      positions = grid ? grid.positions : forceLayout(nodes, layoutLinks(vm.edges), frame, { previous: positions, pad: hullPad + 18, gap: nodeGap, groupGap: 2 * hullPad + 8 });
      drawKey = '';
    }
    place();
    const edgesKey = JSON.stringify([...positions].map(([k, p]) => [k, Math.round(p.x), Math.round(p.y)])) + JSON.stringify(vm.edges.map((e) => e.key + (e.label ?? '')));
    if (edgesKey !== drawKey) {
      drawKey = edgesKey;
      svg.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
      drawEdges(vm);
    }
  }

  function flash(id: string): void {
    const v = views.get(id);
    if (!v) return;
    v.el.classList.add('pulsed');
    setTimeout(() => v.el.classList.remove('pulsed'), 1400);
  }

  function ripple(at: Point, tone: 'accent' | 'danger'): void {
    for (let i = 0; i < 3; i++) {
      const c = s('circle', { class: `ripple ripple-${tone}`, cx: at.x.toFixed(1), cy: at.y.toFixed(1), r: 34 });
      c.style.animationDelay = `${i * 380}ms`;
      fx.append(c);
      setTimeout(() => c.remove(), 3200 + i * 380);
    }
  }

  function travel(a: Point, c: Point, b: Point, tone: 'accent' | 'danger', ms: number, onDone: () => void): void {
    const dot = s('circle', { class: `dot dot-${tone}`, r: 4.5, cx: a.x, cy: a.y });
    fx.append(dot);
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const p = pointOnQuad(a, c, b, eased);
      dot.setAttribute('cx', p.x.toFixed(1));
      dot.setAttribute('cy', p.y.toFixed(1));
      dot.setAttribute('opacity', String(t > 0.85 ? (1 - t) / 0.15 : 1));
      if (t < 1) requestAnimationFrame(step);
      else {
        dot.remove();
        onDone();
      }
    };
    requestAnimationFrame(step);
  }

  function pulse(p: Pulse): void {
    const from = positions.get(p.from);
    if (!from) return;
    const reduced = prefersReducedMotion();
    if (p.kind === 'broadcast' || p.kind === 'push') {
      flash(p.from);
      if (!reduced) ripple(from, 'accent');
      return;
    }
    if (!p.to) return;
    const to = positions.get(p.to);
    if (!to) return;
    flash(p.from);
    if (reduced || typeof requestAnimationFrame !== 'function') {
      flash(p.to);
      return;
    }
    const denied = p.kind === 'denied';
    const a = rectEdgePoint(from, dims.w, dims.h, to, 5);
    const b = rectEdgePoint(to, dims.w, dims.h, from, 7);
    travel(a, bowControl(a, b, denied ? BOW.blocked! : BOW.message!), b, denied ? 'danger' : 'accent', denied ? 1100 : 1000, () => flash(p.to!));
  }

  function resize(): void {
    if (last) {
      layoutKey = '';
      measuredKey = '';
      update(last);
    }
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0 && w !== boxW) {
        boxW = w;
        resize();
      } else if (w > 0) {
        // Height may have changed (window resize): refresh the frame.
        resize();
      }
    }).observe(el);
  }

  return { el, update, pulse, resize };
}
