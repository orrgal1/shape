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
 *  - parallel strokes into one bubble fan out along its side (vendored archify
 *    port spread) instead of stacking on the midpoint;
 *  - a label sits on its own curve (or a hair off it, with a tether) and never
 *    on top of a bubble, another label, or another relation's stroke.
 */
import type { LayerEdge } from "../layer.ts";
import type { Box, BoxMap } from "../layout.ts";
import {
  automaticPortSpread,
  collectLabelRouteClearance,
  type SpreadRect,
  type SpreadRelation,
  type Vec2,
} from "./vendor/archify-geometry.ts";

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
  /**
   * Width the pill is allowed, which is what the placement was solved for. On
   * a dense layer a full-width pill has nowhere clear to sit at all; a narrower
   * one does, and the text ellipsises into it with the whole relation still in
   * the tooltip. Full width whenever full width fits.
   */
  labelMax: number;
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
/** a bow smaller than this is not worth drawing as a bend at all */
const MIN_REACH = 40;
/** re-measurements of what a candidate still runs into before giving up */
const ROUNDS = 4;
/** segments the drawn length of a curve is measured over */
const LENGTH_SAMPLES = 24;
/** where along the chord the two control points sit */
const C1_T = 0.28;
const C2_T = 0.72;
/** points sampled along a curve when testing it against bubbles */
const STROKE_SAMPLES = 28;
/**
 * Positions along the curve a label may slide to, and how far off it — with a
 * tether drawn for anything but zero, so an offset label still reads as
 * attached. A dense layer needs the far offsets: on the nine-package fixture
 * they are the difference between two truncated pills and five, because the
 * only clear air is a whole row-gap away from the curve.
 */
const LABEL_TS: readonly number[] = [0.5, 0.42, 0.58, 0.34, 0.66, 0.27, 0.73];
const LABEL_OFFSETS: readonly number[] = [0, -22, 22, -36, 36, -54, 54];
/**
 * Widths a pill will settle for, tried widest first. A dense layer leaves gaps
 * of a few dozen pixels between rows and a full pill is nearly two hundred
 * wide: with one width to try, a third of the labels on the nine-package
 * fixture ended up parked on top of a bubble, which is worse than an ellipsis.
 */
const LABEL_WIDTHS: readonly number[] = [LABEL_MAX_W, 132, 92, 58];

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

/** which blockers this curve actually runs into — the ones worth bowing around */
function hitBy(a: Point, b: Point, bow: Bow, blockers: readonly Obstacle[]): Obstacle[] {
  const [c1, c2] = cubicControls(a, b, bow);
  const hit: Obstacle[] = [];
  for (const entry of blockers) {
    for (let i = 1; i < STROKE_SAMPLES; i += 1) {
      if (!inside(cubicPoint(a, c1, c2, b, i / STROKE_SAMPLES), entry.box, STROKE_MARGIN)) continue;
      hit.push(entry);
      break;
    }
  }
  return hit;
}

/** drawn length of the curve; the quantity a long detour shows up in */
function curveLength(a: Point, b: Point, bow: Bow): number {
  const [c1, c2] = cubicControls(a, b, bow);
  let length = 0;
  let previous = a;
  for (let i = 1; i <= LENGTH_SAMPLES; i += 1) {
    const point = cubicPoint(a, c1, c2, b, i / LENGTH_SAMPLES);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return length;
}

/**
 * Finds the shortest curve that clears every bubble the stroke merely passes.
 *
 * Two things make this hard, and an earlier version got both wrong by measuring
 * every blocker whose *projection onto the chord* fell within the run. On a
 * dense layer that includes bubbles sitting hundreds of pixels off to the side
 * which the stroke was never going to touch, so the reach was computed to clear
 * the whole neighbourhood: strokes ballooned to 3000px arcs around compositions
 * a quarter that size. So the reach is measured from the bubbles the curve
 * genuinely runs into, found by sampling, and re-measured against the union
 * after each attempt — swinging clear of one bubble can push a curve into
 * another, and that one then joins the set the next reach has to clear.
 *
 * The second is that the first curve to come back clean is not the best one. A
 * bow that clears by a mile clears, and looks absurd. Every clean candidate is
 * measured and the shortest wins, which is the same quantity a reader perceives
 * as "that line went the long way round".
 */
function solveBow(a: Point, b: Point, blockers: readonly Obstacle[], base: number): Bow {
  const flat: Bow = { b1: base, b2: base };
  if (blockers.length === 0) return flat;
  let hit = hitBy(a, b, flat, blockers);
  if (hit.length === 0) return flat;

  const f = frameOf(a, b);
  const offending = new Map<string, Obstacle>();

  let best = flat;
  let bestHits = strikes(a, b, flat, blockers);
  let bestLength = Number.POSITIVE_INFINITY;

  for (let round = 0; round < ROUNDS; round += 1) {
    for (const entry of hit) offending.set(entry.id, entry);

    // how far off the chord, to each side, the offenders reach
    let needPos = 0;
    let needNeg = 0;
    for (const entry of offending.values()) {
      const { box } = entry;
      for (const corner of [
        { x: box.x, y: box.y },
        { x: box.x + box.w, y: box.y },
        { x: box.x, y: box.y + box.h },
        { x: box.x + box.w, y: box.y + box.h },
      ]) {
        const d = (corner.x - a.x) * f.nx + (corner.y - a.y) * f.ny;
        needPos = Math.max(needPos, d + STROKE_MARGIN);
        needNeg = Math.max(needNeg, -d + STROKE_MARGIN);
      }
    }

    const cheaper = needNeg < needPos ? -1 : 1;
    const candidates: Bow[] = [];
    for (const side of [cheaper, -cheaper]) {
      const reach = Math.max(MIN_REACH, (side > 0 ? needPos : needNeg) * BOW_PER_DEVIATION);
      for (const factor of REACH) {
        const magnitude = reach * factor * side;
        candidates.push({ b1: base + magnitude, b2: base + magnitude });
        // S-shapes: swing wide at one end and stay tight at the other, for the
        // cases where something sits near one end only
        candidates.push({ b1: base + magnitude, b2: base + magnitude * 0.15 });
        candidates.push({ b1: base + magnitude * 0.15, b2: base + magnitude });
        candidates.push({ b1: base + magnitude, b2: base - magnitude * 0.6 });
        candidates.push({ b1: base - magnitude * 0.6, b2: base + magnitude });
      }
    }

    let clean: Bow | null = null;
    for (const bow of candidates) {
      const hits = strikes(a, b, bow, blockers);
      if (hits > 0) {
        if (hits < bestHits) {
          bestHits = hits;
          best = bow;
          bestLength = Number.POSITIVE_INFINITY;
        }
        continue;
      }
      const length = curveLength(a, b, bow);
      if (bestHits === 0 && length >= bestLength) continue;
      bestHits = 0;
      bestLength = length;
      best = bow;
      clean = bow;
    }
    if (clean !== null) return best;

    // nothing clean yet: whatever the best attempt still runs into joins the
    // set the next round has to clear
    hit = hitBy(a, b, best, blockers);
    if (hit.every((entry) => offending.has(entry.id))) break;
  }

  return best;
}

export interface GeometryInput {
  edges: readonly LayerEdge[];
  boxes: BoxMap;
  /** bubbles a stroke must not pass through */
  obstacles: readonly Obstacle[];
}

/** sides in the vocabulary the vendored archify helpers speak */
const SIDE_NAME: Record<Side, "top" | "right" | "bottom" | "left"> = {
  t: "top",
  r: "right",
  b: "bottom",
  l: "left",
};

/** points sampled along a curve when testing labels against other strokes */
const ROUTE_SAMPLES = 16;

/** one stroke, anchored, bowed and sampled */
export interface SolvedEdge {
  edge: LayerEdge;
  a: Point;
  b: Point;
  bow: Bow;
  c1: Point;
  c2: Point;
  route: Vec2[];
}

/**
 * Anchors and bows for every edge, plus a sampled polyline of each stroke so
 * the label pass can keep labels off the other relations' routes.
 *
 * Separate from the label pass because a layout candidate is judged on its
 * strokes alone: `layout.ts` runs this over each arrangement it is considering
 * and keeps the one whose strokes come out shortest and clean, which would be
 * absurdly expensive if choosing also meant placing every label.
 */
export function solveRoutes({ edges, boxes, obstacles }: GeometryInput): SolvedEdge[] {
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

  // vendored archify port spread: edges sharing a bubble side fan out along it,
  // ordered by where their counterpart sits, instead of piling on the midpoint
  const rects = new Map<string, SpreadRect>();
  for (const [id, box] of Object.entries(boxes)) {
    rects.set(id, {
      id,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
    });
  }
  const relationById = new Map<string, SpreadRelation>();
  const sidesByRelation = new Map<SpreadRelation, { source: Side; target: Side }>();
  for (const edge of edges) {
    const source = boxes[edge.source];
    const target = boxes[edge.target];
    if (source === undefined || target === undefined) continue;
    const relation: SpreadRelation = { id: edge.id, from: edge.source, to: edge.target };
    relationById.set(edge.id, relation);
    sidesByRelation.set(relation, sidesFor(source, target));
  }
  const ports = automaticPortSpread([...relationById.values()], rects, {
    sideFor: (relation, endpoint) => {
      const sides = sidesByRelation.get(relation);
      if (sides === undefined) return undefined;
      return SIDE_NAME[endpoint === "source" ? sides.source : sides.target];
    },
  });

  const solved: SolvedEdge[] = [];
  for (const edge of edges) {
    const source = boxes[edge.source];
    const target = boxes[edge.target];
    if (source === undefined || target === undefined) continue;

    const relation = relationById.get(edge.id);
    if (relation === undefined) continue;
    const sides = sidesByRelation.get(relation);
    if (sides === undefined) continue;
    const spread = ports.get(relation);
    const a = spread?.from !== undefined ? { x: spread.from[0], y: spread.from[1] } : anchorOf(source, sides.source);
    const b = spread?.to !== undefined ? { x: spread.to[0], y: spread.to[1] } : anchorOf(target, sides.target);
    const blockers = obstacles.filter((entry) => entry.id !== edge.source && entry.id !== edge.target);

    const base = opposed.has(`${edge.source}\u0000${edge.target}`) ? 58 : 0;
    const bow = solveBow(a, b, blockers, base);
    const [c1, c2] = cubicControls(a, b, bow);

    const route: Vec2[] = [];
    for (let i = 0; i <= ROUTE_SAMPLES; i += 1) {
      const point = cubicPoint(a, c1, c2, b, i / ROUTE_SAMPLES);
      route.push([point.x, point.y]);
    }
    solved.push({ edge, a, b, bow, c1, c2, route });
  }
  return solved;
}

/** what an arrangement's strokes cost the reader */
export interface RoutingCost {
  /** sampled points landing inside a bubble the stroke does not terminate at */
  strikes: number;
  /** the drawn length of the worst stroke */
  longest: number;
  /** and of all of them, as a tie-break between otherwise equal arrangements */
  total: number;
}

export function routingCost(input: GeometryInput): RoutingCost {
  let hits = 0;
  let longest = 0;
  let total = 0;
  for (const solved of solveRoutes(input)) {
    const blockers = input.obstacles.filter(
      (entry) => entry.id !== solved.edge.source && entry.id !== solved.edge.target,
    );
    hits += strikes(solved.a, solved.b, solved.bow, blockers);
    const length = curveLength(solved.a, solved.b, solved.bow);
    longest = Math.max(longest, length);
    total += length;
  }
  return { strikes: hits, longest, total };
}

export function computeEdgeGeometry(input: GeometryInput): Record<string, EdgeGeom> {
  const out: Record<string, EdgeGeom> = {};
  const { obstacles } = input;
  const solved = solveRoutes(input);

  // each entry's index doubles as its relationIndex, so the vendored clearance
  // check skips a label's own stroke without any filtering
  const routes = solved.map((entry) => ({
    relation: { id: entry.edge.id, from: entry.edge.source, to: entry.edge.target },
    points: entry.route,
  }));

  const placedLabels: Box[] = [];
  // widest labels choose first; they are the hardest to fit
  const order = solved
    .map((entry, index) => ({ entry, index }))
    .sort(({ entry: a }, { entry: b }) => {
      const at = a.edge.label !== null && a.edge.label.length > 0 ? a.edge.label : a.edge.kind;
      const bt = b.edge.label !== null && b.edge.label.length > 0 ? b.edge.label : b.edge.kind;
      return labelWidth(bt) - labelWidth(at);
    });

  for (const { entry, index } of order) {
    const { edge, a, b, bow, c1, c2 } = entry;
    const text = edge.label !== null && edge.label.length > 0 ? edge.label : edge.kind;
    const natural = labelWidth(text);

    /**
     * Bubbles and other labels are hard constraints: a pill on either is
     * unreadable, so the pill gives up characters instead. Another relation's
     * stroke is a soft one — the pill is opaque, so it hides a few pixels of a
     * line, and the tether plus its position still say which relation it
     * belongs to. Preferring a narrower pill over one crossing a stroke is how
     * this pass ended up truncating seven of eighteen labels on a dense layer
     * to two characters, which is a far worse trade than an occluded line.
     */
    let placed: { t: number; off: number; width: number; rect: Box } | null = null;
    let fallback: Box | null = null;
    for (const budget of LABEL_WIDTHS) {
      const width = Math.min(natural, budget);
      let bestCrossings = Number.POSITIVE_INFINITY;
      for (const t of LABEL_TS) {
        for (const off of LABEL_OFFSETS) {
          const point = cubicPoint(a, c1, c2, b, t);
          const normal = cubicNormal(a, c1, c2, b, t);
          const centre = { x: point.x + normal.x * off, y: point.y + normal.y * off };
          const rect: Box = { x: centre.x - width / 2, y: centre.y - LABEL_H / 2, w: width, h: LABEL_H };
          if (fallback === null) fallback = rect;
          if (obstacles.some((blocker) => rectsOverlap(rect, blocker.box, LABEL_MARGIN))) continue;
          if (placedLabels.some((other) => rectsOverlap(rect, other, LABEL_MARGIN))) continue;
          // vendored archify clearance: how many other relations' strokes run
          // under this spot, so the least ambiguous one can be preferred
          const crossings = collectLabelRouteClearance({
            labels: [{ rect: { x: rect.x, y: rect.y, width: rect.w, height: rect.h }, relationIndex: index }],
            routedRelations: routes,
            threshold: LABEL_MARGIN,
          }).length;
          if (crossings >= bestCrossings) continue;
          bestCrossings = crossings;
          placed = { t, off, width, rect };
          if (crossings === 0) break;
        }
        if (bestCrossings === 0) break;
      }
      // the widest width with anywhere to sit wins; narrower is a last resort
      if (placed !== null) break;
    }

    const rect = placed?.rect ?? fallback;
    if (rect !== null) placedLabels.push(rect);
    out[edge.id] = {
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      bow,
      labelT: placed?.t ?? 0.5,
      labelOff: placed?.off ?? 0,
      labelMax: placed?.width ?? Math.min(natural, LABEL_WIDTHS[LABEL_WIDTHS.length - 1] ?? natural),
    };
  }

  return out;
}
