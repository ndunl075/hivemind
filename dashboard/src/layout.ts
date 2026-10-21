/**
 * Graph layout (ARCHITECTURE.md §14.5). A small, deterministic force layout: nodes repel, agents of one person
 * and agents joined by an edge attract, a weak pull keeps everything near the middle, and rectangles never
 * overlap or leave the frame. `ringLayout` is the simple fallback (§20.6).
 */

export interface LayoutNode {
  id: string;
  /** Agents of the same person share a group and pull together. */
  group: string;
  /** Agents of one checkout inside a person's group stay closer together. */
  cluster?: string;
  w: number;
  h: number;
}

export interface LayoutLink {
  a: string;
  b: string;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  /** Positions from the previous layout, so the graph stays put when a snapshot changes. */
  previous?: ReadonlyMap<string, Point>;
  iterations?: number;
  /** Space kept free around the frame, for the person outlines. */
  pad?: number;
  /** Space kept between node rectangles. */
  gap?: number;
  /** Extra space kept between nodes of different people, so their outlines don't touch. */
  groupGap?: number;
}

/** Stable pseudo-random number in [0, 1) from a string, so layouts are reproducible. */
export function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function clampNode(p: Point, n: LayoutNode, size: Size, pad: number): void {
  const minX = pad + n.w / 2;
  const maxX = size.width - pad - n.w / 2;
  const minY = pad + n.h / 2;
  const maxY = size.height - pad - n.h / 2;
  p.x = minX > maxX ? size.width / 2 : Math.min(maxX, Math.max(minX, p.x));
  p.y = minY > maxY ? size.height / 2 : Math.min(maxY, Math.max(minY, p.y));
}

/** Nodes evenly around an ellipse, grouped by person. */
export function ringLayout(nodes: readonly LayoutNode[], size: Size, pad = 24): Map<string, Point> {
  const ordered = [...nodes].sort((a, b) => a.group.localeCompare(b.group) || (a.cluster ?? '').localeCompare(b.cluster ?? '') || a.id.localeCompare(b.id));
  const out = new Map<string, Point>();
  const rx = Math.max(0, size.width / 2 - pad - Math.max(0, ...nodes.map((n) => n.w)) / 2);
  const ry = Math.max(0, size.height / 2 - pad - Math.max(0, ...nodes.map((n) => n.h)) / 2);
  ordered.forEach((n, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, ordered.length)) * Math.PI * 2;
    const p = ordered.length === 1 ? { x: size.width / 2, y: size.height / 2 } : { x: size.width / 2 + Math.cos(angle) * rx, y: size.height / 2 + Math.sin(angle) * ry };
    clampNode(p, n, size, pad);
    out.set(n.id, p);
  });
  return out;
}

export function forceLayout(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[],
  size: Size,
  options: LayoutOptions = {},
): Map<string, Point> {
  const pad = options.pad ?? 28;
  const gap = options.gap ?? 22;
  const groupGap = options.groupGap ?? 0;
  const sameCluster = (a: LayoutNode, b: LayoutNode) => (a.cluster ?? '') === (b.cluster ?? '');
  // Different checkouts of one person get a little extra room so their inner outlines don't touch.
  const gapFor = (a: LayoutNode, b: LayoutNode) => (a.group !== b.group ? gap + groupGap : sameCluster(a, b) ? gap : gap + 14);
  const iterations = options.iterations ?? (options.previous && options.previous.size > 0 ? 140 : 320);
  const ordered = [...nodes].sort((a, b) => a.group.localeCompare(b.group) || (a.cluster ?? '').localeCompare(b.cluster ?? '') || a.id.localeCompare(b.id));
  const cx = size.width / 2;
  const cy = size.height / 2;

  const seed = ringLayout(ordered, size, pad);
  const pos = new Map<string, Point>();
  const vel = new Map<string, Point>();
  for (const n of ordered) {
    const prev = options.previous?.get(n.id);
    const s = seed.get(n.id) ?? { x: cx, y: cy };
    // A new node starts near its person's other agents if any are already placed; otherwise on the ring.
    const mate = ordered.find((m) => m.group === n.group && m.id !== n.id && options.previous?.has(m.id));
    const mp = mate ? options.previous?.get(mate.id) : undefined;
    const start = prev ?? (mp ? { x: mp.x + (hash01(n.id) - 0.5) * 80, y: mp.y + 90 } : s);
    pos.set(n.id, { x: start.x + (hash01(`x${n.id}`) - 0.5) * 2, y: start.y + (hash01(`y${n.id}`) - 0.5) * 2 });
    vel.set(n.id, { x: 0, y: 0 });
  }

  const byId = new Map(ordered.map((n) => [n.id, n]));
  const linkPairs = links.filter((l) => byId.has(l.a) && byId.has(l.b) && l.a !== l.b);

  /** Rectangle collisions: push apart along the axis with the smaller overlap. */
  const separate = (passes: number): void => {
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < ordered.length; i++) {
        for (let j = i + 1; j < ordered.length; j++) {
          const a = ordered[i]!;
          const b = ordered[j]!;
          const pa = pos.get(a.id)!;
          const pb = pos.get(b.id)!;
          const g = gapFor(a, b);
          const ox = (a.w + b.w) / 2 + g - Math.abs(pb.x - pa.x);
          const oy = (a.h + b.h) / 2 + g - Math.abs(pb.y - pa.y);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const s = (pb.x >= pa.x ? 1 : -1) * (ox / 2);
            pa.x -= s;
            pb.x += s;
          } else {
            const s = (pb.y >= pa.y ? 1 : -1) * (oy / 2);
            pa.y -= s;
            pb.y += s;
          }
          clampNode(pa, a, size, pad);
          clampNode(pb, b, size, pad);
        }
      }
    }
  };

  for (let step = 0; step < iterations; step++) {
    const alpha = 1 - step / iterations;
    const force = new Map<string, Point>(ordered.map((n) => [n.id, { x: 0, y: 0 }]));
    const add = (id: string, fx: number, fy: number) => {
      const f = force.get(id);
      if (f) {
        f.x += fx;
        f.y += fy;
      }
    };

    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i]!;
        const b = ordered[j]!;
        const pa = pos.get(a.id)!;
        const pb = pos.get(b.id)!;
        let dx = pb.x - pa.x;
        let dy = pb.y - pa.y;
        const d2 = Math.max(dx * dx + dy * dy, 1);
        const d = Math.sqrt(d2);
        // Repulsion between everyone.
        const rep = (a.group === b.group ? 20000 : 70000) / d2;
        dx /= d;
        dy /= d;
        add(a.id, -dx * rep, -dy * rep);
        add(b.id, dx * rep, dy * rep);
        // Springs: same person pulls tight, linked agents pull gently.
        const same = a.group === b.group;
        const linked = linkPairs.some((l) => (l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id));
        if (same || linked) {
          const tight = same && sameCluster(a, b);
          const rest = (a.w + b.w) / 2 + (same ? gap + (tight ? 14 : 34) : gap * 4 + groupGap);
          const k = tight ? 0.03 : same ? 0.012 : 0.006;
          const pull = (d - rest) * k;
          add(a.id, dx * pull, dy * pull);
          add(b.id, -dx * pull, -dy * pull);
        }
      }
    }

    for (const n of ordered) {
      const p = pos.get(n.id)!;
      const v = vel.get(n.id)!;
      const f = force.get(n.id)!;
      f.x += (cx - p.x) * 0.004;
      f.y += (cy - p.y) * 0.004;
      v.x = (v.x + f.x * alpha) * 0.78;
      v.y = (v.y + f.y * alpha) * 0.78;
      p.x += Math.max(-40, Math.min(40, v.x));
      p.y += Math.max(-40, Math.min(40, v.y));
      clampNode(p, n, size, pad);
    }

    separate(3);
  }

  // Last, settle any rectangles that are still touching once the forces have died down.
  separate(60);

  return new Map(ordered.map((n) => [n.id, { ...pos.get(n.id)! }]));
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: readonly Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The outline around a person's nodes: the hull of their padded rectangle corners. */
export function groupOutline(nodes: readonly { x: number; y: number; w: number; h: number }[], pad: number): Point[] {
  const corners: Point[] = [];
  for (const n of nodes) {
    const hw = n.w / 2 + pad;
    const hh = n.h / 2 + pad;
    corners.push({ x: n.x - hw, y: n.y - hh }, { x: n.x + hw, y: n.y - hh }, { x: n.x + hw, y: n.y + hh }, { x: n.x - hw, y: n.y + hh });
  }
  return convexHull(corners);
}

/** Where the line from a rectangle's center toward `target` leaves the rectangle. */
export function rectEdgePoint(center: Point, w: number, h: number, target: Point, margin = 0): Point {
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { ...center };
  const sx = dx === 0 ? Infinity : (w / 2 + margin) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (h / 2 + margin) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: center.x + dx * s, y: center.y + dy * s };
}

/** Control point of a bowed edge: the midpoint pushed sideways by `bow` pixels. */
export function bowControl(a: Point, b: Point, bow: number): Point {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: mx + (-dy / len) * bow, y: my + (dx / len) * bow };
}

/** Point on a quadratic curve at t in [0, 1]. */
export function pointOnQuad(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export interface GridOptions {
  pad?: number;
  gap?: number;
  /** Extra space above each person, for the outline and its label. */
  personGap?: number;
  /** Extra space above each checkout of a person who has several. */
  clusterGap?: number;
}

/**
 * Narrow-screen layout: people one under another, each person's agents in rows of as many columns as fit, and a new
 * row for each of their checkouts. Deterministic, never overlaps, and its height is exact, so the stage can be sized
 * to fit.
 */
export function gridLayout(nodes: readonly LayoutNode[], width: number, options: GridOptions = {}): { positions: Map<string, Point>; height: number } {
  const pad = options.pad ?? 16;
  const gap = options.gap ?? 14;
  const personGap = options.personGap ?? 30;
  const clusterGap = options.clusterGap ?? 18;
  const ordered = [...nodes].sort((a, b) => a.group.localeCompare(b.group) || (a.cluster ?? '').localeCompare(b.cluster ?? '') || a.id.localeCompare(b.id));
  const nodeW = Math.max(0, ...nodes.map((n) => n.w));
  const cols = Math.max(1, Math.floor((width - 2 * pad + gap) / (nodeW + gap)));
  const left = Math.max(pad, (width - (cols * nodeW + (cols - 1) * gap)) / 2);
  const positions = new Map<string, Point>();
  let y = pad;
  let rowTop = y;
  let col = 0;
  let prev: LayoutNode | undefined;
  let rowH = 0;
  const newRow = (extra: number): void => {
    if (prev) y = rowTop + rowH + gap;
    y += extra;
    rowTop = y;
    col = 0;
    rowH = 0;
  };
  for (const n of ordered) {
    const samePerson = prev?.group === n.group;
    const sameCluster = samePerson && (prev?.cluster ?? '') === (n.cluster ?? '');
    if (!prev) newRow(personGap);
    else if (!samePerson) newRow(personGap);
    else if (!sameCluster) newRow(clusterGap);
    else if (col >= cols) newRow(0);
    positions.set(n.id, { x: left + col * (nodeW + gap) + n.w / 2, y: rowTop + n.h / 2 });
    rowH = Math.max(rowH, n.h);
    col++;
    prev = n;
  }
  return { positions, height: ordered.length === 0 ? 0 : rowTop + rowH + pad };
}

/** True when any two node rectangles intersect. */
export function hasOverlap(nodes: readonly LayoutNode[], positions: ReadonlyMap<string, Point>): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const p = positions.get(a.id);
      const q = positions.get(b.id);
      if (p && q && Math.abs(p.x - q.x) < (a.w + b.w) / 2 && Math.abs(p.y - q.y) < (a.h + b.h) / 2) return true;
    }
  }
  return false;
}

/**
 * `forceLayout`, and if the frame turned out too small for the cards (some still overlap), the frame grows taller by
 * 20% and the layout runs again, up to 10 times. Returns the positions and the frame they fit in.
 */
export function forceLayoutFit(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[],
  size: Size,
  options: LayoutOptions = {},
): { positions: Map<string, Point>; size: Size } {
  let frame = size;
  let positions = forceLayout(nodes, links, frame, options);
  for (let i = 0; i < 10 && hasOverlap(nodes, positions); i++) {
    frame = { width: frame.width, height: Math.ceil(frame.height * 1.2) };
    positions = forceLayout(nodes, links, frame, options);
  }
  return { positions, size: frame };
}
