/**
 * Edge geometry: where a relation's stroke starts, how it curves, and where its
 * label sits.
 *
 * This is the single source of truth for both. Previously elk placed labels
 * while the renderer drew its own bezier, so labels ended up floating in space
 * with no stroke beneath them. Here one function computes anchors, a curve and a
 * point along it; the renderer evaluates the same cubic, so the clearance checks
 * reason about exactly the stroke the user sees.
 *
 * Two invariants it enforces:
 *  - no stroke passes through a bubble it does not terminate at;
 *  - a label sits on its own curve (or a hair off it, with a tether) and never
 *    on top of a bubble or another label.
 */
import type { LayerEdge } from "../layer.ts";
import type { Box, BoxMap } from "../layout.ts";

export interface Point {
  x: number;
  y: number;
}

/** perpendicular offsets of the two control points; 0,0 is a straight line */
export interface Bow {
  b1: number;
  b2: number;
}

export interface EdgeGeom {
  /** anchor on the source bubble's edge */
  ax: number;
  ay: number;
  /** anchor on the target bubble's edge */
  bx: number;
  by: number;
  bow: Bow;
  /** where along the curve the label sits */
  labelT: number;
  /** small perpendicular nudge for the label, kept tiny so it stays anchored */
  labelOff: number;
}

export type Side = "t" | "r" | "b" | "l";

/** label box estimate: 11px Avenir Next plus the kind swatch, gap and padding */
const LABEL_CHAR_W = 5.7;
const LABEL_CHROME_W = 40;
const LABEL_MAX_W = 190;
const LABEL_H = 24;

/** clearance kept between a stroke and a bubble it merely passes */
const STROKE_MARGIN = 10;
/** clearance kept between a label and a bubble or another label */
const LABEL_MARGIN = 5;
/**
 * A cubic with both controls pushed out by B deviates from its chord by about
 * 0.75B at the midpoint, so a required clearance of D needs B ≈ 1.34D. Getting
 * this factor wrong is why an earlier ladder of bends kept failing on long
 * strokes: the curve only bowed half as far as the numbers suggested.
 */
const BOW_PER_DEVIATION = 1.34;
/** how much further to reach when the solved curve still grazes something */
const REACH = [1, 1.45, 2.1, 3] as const;
/** where along the chord the two control points sit */
const C1_T = 0.28;
const C2_T = 0.72;
/** points sampled along a curve when testing it against bubbles */
const STROKE_SAMPLES = 28;
/** positions along the curve a label may slide to */
const LABEL_TS: readonly number[] = [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73];
/** and how far off it, as a last resort, so it still reads as attached */
const LABEL_OFFSETS: readonly number[] = [0, -22, 22];

export function labelWidth(text: string): number {
  return Math.min(LABEL_MAX_W, text.length * LABEL_CHAR_W + LABEL_CHROME_W);
}

interface Frame {
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  len: number;
}

function frameOf(a: Point, b: Point): Frame {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return { ux, uy, nx: -uy, ny: ux, len };
}

/** control points of the cubic the renderer draws; shared on purpose */
export function cubicControls(a: Point, b: Point, bow: Bow): [Point, Point] {
  const f = frameOf(a, b);
  return [
    { x: a.x + f.ux * f.len * C1_T + f.nx * bow.b1, y: a.y + f.uy * f.len * C1_T + f.ny * bow.b1 },
    { x: a.x + f.ux * f.len * C2_T + f.nx * bow.b2, y: a.y + f.uy * f.len * C2_T + f.ny * bow.b2 },
  ];
}

export function cubicPoint(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * a.x + w1 * c1.x + w2 * c2.x + w3 * b.x,
    y: w0 * a.y + w1 * c1.y + w2 * c2.y + w3 * b.y,
  };
}

/** normal of the curve at `t`, for nudging a label off it without detaching it */
export function cubicNormal(a: Point, c1: Point, c2: Point, b: Point, t: number): Point {
  const u = 1 - t;
  const dx = 3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x);
  const dy = 3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y);
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

export function pathOf(a: Point, b: Point, bow: Bow): string {
  const [c1, c2] = cubicControls(a, b, bow);
  return `M ${a.x},${a.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
}

function anchorOf(box: Box, side: Side): Point {
  switch (side) {
    case "t":
      return { x: box.x + box.w / 2, y: box.y };
    case "b":
      return { x: box.x + box.w / 2, y: box.y + box.h };
    case "l":
      return { x: box.x, y: box.y + box.h / 2 };
    case "r":
      return { x: box.x + box.w, y: box.y + box.h / 2 };
  }
}

function inside(point: Point, box: Box, margin: number): boolean {
  return (
    point.x > box.x - margin &&
    point.x < box.x + box.w + margin &&
    point.y > box.y - margin &&
    point.y < box.y + box.h + margin
  );
}

function rectsOverlap(a: Box, b: Box, margin: number): boolean {
  return (
    a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin
  );
}

/** picks the facing sides, so a stroke leaves towards where it is going */
function sidesFor(source: Box, target: Box): { source: Side; target: Side } {
  const dx = target.x + target.w / 2 - (source.x + source.w / 2);
  const dy = target.y + target.h / 2 - (source.y + source.h / 2);
  // bubbles are wider than they are tall, so bias a little towards the vertical
  if (Math.abs(dx) > Math.abs(dy) * 1.6) {
    return dx > 0 ? { source: "r", target: "l" } : { source: "l", target: "r" };
  }
  return dy > 0 ? { source: "b", target: "t" } : { source: "t", target: "b" };
}

interface Obstacle {
  id: string;
  box: Box;
}

/** how many sampled points of this curve land inside something in the way */
function strikes(a: Point, b: Point, bow: Bow, blockers: readonly Obstacle[]): number {
  const [c1, c2] = cubicControls(a, b, bow);
  let count = 0;
  for (let i = 1; i < STROKE_SAMPLES; i += 1) {
    const point = cubicPoint(a, c1, c2, b, i / STROKE_SAMPLES);
    for (const entry of blockers) {
      if (inside(point, entry.box, STROKE_MARGIN)) count += 1;
    }
  }
  return count;
}

/**
 * Finds a curve that clears every bubble the stroke merely passes.
 *
 * The reach needed is measured, not guessed: each blocker alongside the run is
 * projected onto the chord's normal, which says how far the curve has to swing
 * to get by. Symmetric bows are tried first because they read as a simple arc;
 * S-shapes come next, for the cases where something sits near one end only. The
 * sampled count is authoritative — a measured reach can still graze a bubble the
 * projection did not consider, and the search keeps going until nothing is hit.
 */
function solveBow(a: Point, b: Point, blockers: readonly Obstacle[], base: number): Bow {
  const flat: Bow = { b1: base, b2: base };
  if (blockers.length === 0 || strikes(a, b, flat, blockers) === 0) return flat;

  const f = frameOf(a, b);
  let needPos = 0;
  let needNeg = 0;
  for (const entry of blockers) {
    const { box } = entry;
    const corners: Point[] = [
      { x: box.x, y: box.y },
      { x: box.x + box.w, y: box.y },
      { x: box.x, y: box.y + box.h },
      { x: box.x + box.w, y: box.y + box.h },
    ];
    let along = false;
    for (const corner of corners) {
      const t = ((corner.x - a.x) * f.ux + (corner.y - a.y) * f.uy) / f.len;
      if (t > -0.15 && t < 1.15) along = true;
    }
    if (!along) continue;
    for (const corner of corners) {
      const d = (corner.x - a.x) * f.nx + (corner.y - a.y) * f.ny;
      needPos = Math.max(needPos, d + STROKE_MARGIN);
      needNeg = Math.max(needNeg, -d + STROKE_MARGIN);
    }
  }

  const cheaper = needNeg < needPos ? -1 : 1;
  const reachOf = (side: number): number =>
    Math.max(60, (side > 0 ? needPos : needNeg) * BOW_PER_DEVIATION);

  const candidates: Bow[] = [];
  for (const side of [cheaper, -cheaper]) {
    const b0 = reachOf(side) * side;
    for (const factor of REACH) {
      const magnitude = b0 * factor;
      candidates.push({ b1: base + magnitude, b2: base + magnitude });
    }
  }
  // S-shapes: swing wide at one end and stay tight at the other
  for (const side of [cheaper, -cheaper]) {
    const b0 = reachOf(side) * side;
    for (const factor of REACH) {
      const magnitude = b0 * factor;
      candidates.push({ b1: base + magnitude, b2: base + magnitude * 0.15 });
      candidates.push({ b1: base + magnitude * 0.15, b2: base + magnitude });
      candidates.push({ b1: base + magnitude, b2: base - magnitude * 0.6 });
      candidates.push({ b1: base - magnitude * 0.6, b2: base + magnitude });
    }
  }

  let best = candidates[0] ?? flat;
  let bestHits = Number.POSITIVE_INFINITY;
  for (const bow of candidates) {
    const hits = strikes(a, b, bow, blockers);
    if (hits === 0) return bow;
    if (hits < bestHits) {
      bestHits = hits;
      best = bow;
    }
  }
  return best;
}

export interface GeometryInput {
  edges: readonly LayerEdge[];
  boxes: BoxMap;
  /** bubbles a stroke must not pass through */
  obstacles: readonly Obstacle[];
}

export function computeEdgeGeometry({ edges, boxes, obstacles }: GeometryInput): Record<string, EdgeGeom> {
  const out: Record<string, EdgeGeom> = {};

  // a pair with strokes in both directions must curve apart or they coincide
  const seen = new Set<string>();
  const opposed = new Set<string>();
  for (const edge of edges) {
    const forward = `${edge.source}\u0000${edge.target}`;
    const back = `${edge.target}\u0000${edge.source}`;
    if (seen.has(back)) {
      opposed.add(forward);
      opposed.add(back);
    }
    seen.add(forward);
  }

  const placedLabels: Box[] = [];
  // widest labels choose first; they are the hardest to fit
  const order = [...edges].sort((a, b) => {
    const at = a.label !== null && a.label.length > 0 ? a.label : a.kind;
    const bt = b.label !== null && b.label.length > 0 ? b.label : b.kind;
    return labelWidth(bt) - labelWidth(at);
  });

  for (const edge of order) {
    const source = boxes[edge.source];
    const target = boxes[edge.target];
    if (source === undefined || target === undefined) continue;

    const sides = sidesFor(source, target);
    const a = anchorOf(source, sides.source);
    const b = anchorOf(target, sides.target);
    const blockers = obstacles.filter((entry) => entry.id !== edge.source && entry.id !== edge.target);

    const base = opposed.has(`${edge.source}\u0000${edge.target}`) ? 58 : 0;
    const bow = solveBow(a, b, blockers, base);
    const [c1, c2] = cubicControls(a, b, bow);

    const text = edge.label !== null && edge.label.length > 0 ? edge.label : edge.kind;
    const width = labelWidth(text);

    let labelT = 0.5;
    let labelOff = 0;
    let settled = false;
    for (const t of LABEL_TS) {
      if (settled) break;
      for (const off of LABEL_OFFSETS) {
        const point = cubicPoint(a, c1, c2, b, t);
        const normal = cubicNormal(a, c1, c2, b, t);
        const centre = { x: point.x + normal.x * off, y: point.y + normal.y * off };
        const rect: Box = { x: centre.x - width / 2, y: centre.y - LABEL_H / 2, w: width, h: LABEL_H };
        if (obstacles.some((entry) => rectsOverlap(rect, entry.box, LABEL_MARGIN))) continue;
        if (placedLabels.some((other) => rectsOverlap(rect, other, LABEL_MARGIN))) continue;
        labelT = t;
        labelOff = off;
        placedLabels.push(rect);
        settled = true;
        break;
      }
    }
    if (!settled) {
      const point = cubicPoint(a, c1, c2, b, 0.5);
      placedLabels.push({ x: point.x - width / 2, y: point.y - LABEL_H / 2, w: width, h: LABEL_H });
    }

    out[edge.id] = { ax: a.x, ay: a.y, bx: b.x, by: b.y, bow, labelT, labelOff };
  }

  return out;
}
