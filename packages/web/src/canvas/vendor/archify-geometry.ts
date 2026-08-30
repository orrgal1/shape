/**
 * Vendored from archify — https://github.com/tt-a1i/archify @ 5de7275,
 * `archify/renderers/shared/geometry.mjs`. Only the pieces the canvas uses:
 * `automaticPortSpread` (deterministic per-side fan-out of edge anchors),
 * `labelPoint`, `collectLabelRouteClearance` and the internal helpers they
 * need, ported to TypeScript. Behaviour is kept identical to upstream; only
 * types were added and the unused remainder of the module dropped.
 *
 * MIT License
 *
 * Copyright (c) 2026 tt-a1i (Archify)
 * Copyright (c) 2025 Cocoon AI (original "architecture-diagram-generator")
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

export type Vec2 = [number, number];

/** measured rect the way archify renderers pass them in */
export interface SpreadRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export type SpreadSide = "left" | "right" | "top" | "bottom";

/** the relation fields the vendored helpers look at; extra fields are fine */
export interface SpreadRelation {
  id?: string;
  from: string;
  to: string;
  label?: string;
  route?: string;
  via?: unknown;
  channelX?: number;
  channelY?: number;
  labelAt?: Vec2;
  fromSide?: string;
  toSide?: string;
}

export interface SpreadEndpoints {
  from?: Vec2;
  to?: Vec2;
}

interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Segment {
  start: Vec2;
  end: Vec2;
}

/** identity fields collectLabelRouteClearance uses to pair labels and routes */
export interface RouteRelationRef {
  key?: unknown;
  id?: string;
  from?: string;
  to?: string;
  routePoints?: readonly Vec2[];
}

export interface RoutedRelationEntry {
  relation?: RouteRelationRef;
  points?: readonly Vec2[];
  relationIndex?: number;
}

export interface LabelEntry {
  rect?: RectLike;
  relation?: RouteRelationRef;
  relationIndex?: number;
}

export interface LabelRouteHit {
  label: LabelEntry;
  labelRelation: RouteRelationRef | undefined;
  labelRelationIndex: number;
  otherRelation: RouteRelationRef;
  otherRelationIndex: number;
  rect: RectLike;
  clearance: number;
  intersectionLength: number | null;
  segmentIndex: number;
  start: Vec2;
  end: Vec2;
  threshold: number;
}

// In degraded mode (no ajv) a type-wrong top-level field reaches the renderer.
// Coerce non-arrays to [] so the module-level Maps build without throwing.
function asArray<T>(value: readonly T[] | undefined | null): readonly T[] {
  return Array.isArray(value) ? value : [];
}

// A computed coordinate must be a finite number; NaN/undefined would silently
// write `<rect x="NaN">` into the output.
function isFinitePoint(...coords: number[]): boolean {
  return coords.every((c) => Number.isFinite(c));
}

function segmentIntersectsRect(segment: Segment, rect: RectLike, gap = 0): boolean {
  const box = {
    x1: rect.x - gap,
    y1: rect.y - gap,
    x2: rect.x + rect.width + gap,
    y2: rect.y + rect.height + gap,
  };
  const [a, b] = [segment.start, segment.end];
  if (pointInBox(a, box) || pointInBox(b, box)) return true;
  return (
    segmentsIntersect(a, b, [box.x1, box.y1], [box.x2, box.y1]) ||
    segmentsIntersect(a, b, [box.x2, box.y1], [box.x2, box.y2]) ||
    segmentsIntersect(a, b, [box.x2, box.y2], [box.x1, box.y2]) ||
    segmentsIntersect(a, b, [box.x1, box.y2], [box.x1, box.y1])
  );
}

function segmentRectClearance(segment: Segment | null, rect: RectLike | null): number | null {
  if (!segment || !rect) return null;
  const { start, end } = segment;
  if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2) return null;
  if (!isFinitePoint(...start, ...end, rect.x, rect.y, rect.width, rect.height)) return null;
  if (rect.width < 0 || rect.height < 0) return null;
  if (segmentIntersectsRect(segment, rect)) return 0;

  const corners: Vec2[] = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height],
  ];
  return Math.min(
    pointRectDistance(start, rect),
    pointRectDistance(end, rect),
    ...corners.map((corner) => pointSegmentDistance(corner, start, end)),
  );
}

function segmentRectIntersectionLength(segment: Segment | null, rect: RectLike | null): number | null {
  if (!segment || !rect) return null;
  const { start, end } = segment;
  if (!Array.isArray(start) || !Array.isArray(end) || start.length !== 2 || end.length !== 2) return null;
  if (!isFinitePoint(...start, ...end, rect.x, rect.y, rect.width, rect.height)) return null;
  if (rect.width < 0 || rect.height < 0) return null;

  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const length = Math.hypot(dx, dy);
  if (length <= 0.0000001) return 0;
  const bounds: Array<[number, number]> = [
    [-dx, start[0] - rect.x],
    [dx, rect.x + rect.width - start[0]],
    [-dy, start[1] - rect.y],
    [dy, rect.y + rect.height - start[1]],
  ];
  let enter = 0;
  let leave = 1;
  for (const [direction, distance] of bounds) {
    if (Math.abs(direction) <= 0.0000001) {
      if (distance < -0.0000001) return 0;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) enter = Math.max(enter, ratio);
    else leave = Math.min(leave, ratio);
    if (enter > leave + 0.0000001) return 0;
  }
  return length * Math.max(0, leave - enter);
}

export function collectLabelRouteClearance({
  labels,
  routedRelations,
  threshold,
}: {
  labels: readonly LabelEntry[];
  routedRelations: readonly RoutedRelationEntry[];
  threshold: number;
}): LabelRouteHit[] {
  if (!Number.isFinite(threshold) || threshold < 0) return [];
  const routeCandidates = asArray(routedRelations)
    .map((entry, fallbackIndex) => {
      const relation = entry?.relation || (entry as RouteRelationRef);
      const points = normalizeRoutePoints(entry?.points || relation?.routePoints);
      if (!relation || points.length < 2) return null;
      return {
        relation,
        relationIndex: Number.isInteger(entry?.relationIndex) ? (entry.relationIndex as number) : fallbackIndex,
        points,
      };
    })
    .filter((route): route is NonNullable<typeof route> => route !== null);
  const seenRoutes = new Set<string>();
  const routes = routeCandidates.filter((route) => {
    const identity = relationshipIdentity(route.relation, route.relationIndex);
    if (seenRoutes.has(identity)) return false;
    seenRoutes.add(identity);
    return true;
  });
  const hits: LabelRouteHit[] = [];
  const seenLabels = new Set<string>();

  for (const [fallbackIndex, label] of asArray(labels).entries()) {
    const rect = label?.rect || (label as unknown as RectLike);
    if (!rect || !isFinitePoint(rect.x, rect.y, rect.width, rect.height) || rect.width < 0 || rect.height < 0) continue;
    const relationIndex = Number.isInteger(label?.relationIndex) ? (label.relationIndex as number) : fallbackIndex;
    const labelIdentity = relationshipIdentity(label?.relation, relationIndex);
    if (seenLabels.has(labelIdentity)) continue;
    seenLabels.add(labelIdentity);
    for (const route of routes) {
      if (relationIndex === route.relationIndex || sameRelationship(label?.relation, route.relation)) continue;
      let nearest: { clearance: number; intersectionLength: number | null; segmentIndex: number; start: Vec2; end: Vec2 } | null = null;
      for (let segmentIndex = 0; segmentIndex < route.points.length - 1; segmentIndex += 1) {
        const start = route.points[segmentIndex];
        const end = route.points[segmentIndex + 1];
        if (start === undefined || end === undefined) continue;
        const clearance = segmentRectClearance({ start, end }, rect);
        if (clearance == null) continue;
        if (!nearest || clearance < nearest.clearance) {
          nearest = {
            clearance,
            intersectionLength: segmentRectIntersectionLength({ start, end }, rect),
            segmentIndex,
            start,
            end,
          };
        }
      }
      if (!nearest || nearest.clearance + 0.0001 >= threshold) continue;
      hits.push({
        label,
        labelRelation: label?.relation,
        labelRelationIndex: relationIndex,
        otherRelation: route.relation,
        otherRelationIndex: route.relationIndex,
        rect,
        ...nearest,
        threshold,
      });
    }
  }
  return hits;
}

function relationshipIdentity(relation: RouteRelationRef | undefined, relationIndex: number): string {
  if (relation?.key !== undefined) return `key:${String(relation.key)}`;
  if (relation?.id) return `id:${relation.from || ""}\u0000${relation.to || ""}\u0000${relation.id}`;
  return `index:${relationIndex}`;
}

function sameRelationship(left: RouteRelationRef | undefined, right: RouteRelationRef | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.key !== undefined && right.key !== undefined) return left.key === right.key;
  return Boolean(left.id && right.id && left.id === right.id && left.from === right.from && left.to === right.to);
}

function normalizeRoutePoints(points: readonly Vec2[] | undefined): Vec2[] {
  const finite = asArray(points).filter(
    (point): point is Vec2 => Array.isArray(point) && point.length === 2 && isFinitePoint(...point),
  );
  const deduped: Vec2[] = [];
  for (const point of finite) {
    const previous = deduped.at(-1);
    if (!previous || Math.abs(point[0] - previous[0]) > 0.0001 || Math.abs(point[1] - previous[1]) > 0.0001)
      deduped.push(point);
  }
  const normalized: Vec2[] = [];
  for (const point of deduped) {
    while (normalized.length >= 2 && collinearForward(normalized.at(-2) as Vec2, normalized.at(-1) as Vec2, point))
      normalized.pop();
    normalized.push(point);
  }
  return normalized;
}

function pointRectDistance(point: Vec2, rect: RectLike): number {
  const dx = Math.max(rect.x - point[0], 0, point[0] - (rect.x + rect.width));
  const dy = Math.max(rect.y - point[1], 0, point[1] - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.0000001) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const projection = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + projection * dx), point[1] - (start[1] + projection * dy));
}

function collinearForward(a: Vec2, b: Vec2, c: Vec2): boolean {
  if (Math.abs(crossProduct(a, b, c)) > 0.0001) return false;
  return (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= -0.0001;
}

function crossProduct(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInBox(point: Vec2, box: { x1: number; y1: number; x2: number; y2: number }): boolean {
  return point[0] >= box.x1 && point[0] <= box.x2 && point[1] >= box.y1 && point[1] <= box.y2;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 === 0 && onSegment(a, c, b)) return true;
  if (o2 === 0 && onSegment(a, d, b)) return true;
  if (o3 === 0 && onSegment(c, a, d)) return true;
  if (o4 === 0 && onSegment(c, b, d)) return true;

  return o1 !== o2 && o3 !== o4;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) < 0.0001) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a: Vec2, b: Vec2, c: Vec2): boolean {
  return (
    b[0] <= Math.max(a[0], c[0]) &&
    b[0] >= Math.min(a[0], c[0]) &&
    b[1] <= Math.max(a[1], c[1]) &&
    b[1] >= Math.min(a[1], c[1])
  );
}

function anchor(rect: SpreadRect, side: SpreadSide | string): Vec2 {
  switch (side) {
    case "left":
      return [rect.x, rect.cy];
    case "right":
      return [rect.x + rect.width, rect.cy];
    case "top":
      return [rect.cx, rect.y];
    case "bottom":
      return [rect.cx, rect.y + rect.height];
    default:
      return [rect.x + rect.width, rect.cy];
  }
}

// Keep conservative auto-routed fan-out/fan-in relationships visually
// distinct without changing authored route controls. The returned map only
// contains endpoints that belong to a shared automatic midpoint anchor.
export function automaticPortSpread(
  relations: readonly SpreadRelation[],
  boxes: ReadonlyMap<string, SpreadRect>,
  {
    gutter = 16,
    maxSpacing = 14,
    sideFor,
  }: {
    gutter?: number;
    maxSpacing?: number;
    sideFor?: (relation: SpreadRelation, endpoint: "source" | "target") => SpreadSide | string | undefined;
  } = {},
): Map<SpreadRelation, SpreadEndpoints> {
  interface GroupItem {
    relation: SpreadRelation;
    endpoint: "from" | "to";
    rect: SpreadRect;
    side: string;
    counterpart: SpreadRect;
  }
  const groups = new Map<string, GroupItem[]>();
  const spread = new Map<SpreadRelation, SpreadEndpoints>();

  const add = (
    relation: SpreadRelation,
    endpoint: "from" | "to",
    rect: SpreadRect,
    side: string,
    counterpart: SpreadRect,
  ): void => {
    const key = `${rect.id}\u0000${side}`;
    const items = groups.get(key) || [];
    items.push({ relation, endpoint, rect, side, counterpart });
    groups.set(key, items);
  };

  const authored = (side: string | undefined, fallback: string): string =>
    side && side !== "auto" ? side : fallback;

  for (const relation of asArray(relations)) {
    if (!relation || (relation.route && relation.route !== "auto")) continue;
    if (relation.via || relation.channelX !== undefined || relation.channelY !== undefined || relation.labelAt)
      continue;
    const from = boxes.get(relation.from);
    const to = boxes.get(relation.to);
    if (!from || !to) continue;
    const fromSide = authored(relation.fromSide, sideFor?.(relation, "source") || defaultFromSide(from, to));
    const toSide = authored(relation.toSide, sideFor?.(relation, "target") || defaultToSide(from, to));
    add(relation, "from", from, fromSide, to);
    add(relation, "to", to, toSide, from);
  }

  for (const items of groups.values()) {
    const first = items[0];
    if (first === undefined || items.length < 2) continue;
    const verticalSide = first.side === "left" || first.side === "right";
    items.sort((a, b) => {
      const aCoordinate = verticalSide ? a.counterpart.cy : a.counterpart.cx;
      const bCoordinate = verticalSide ? b.counterpart.cy : b.counterpart.cx;
      if (aCoordinate !== bCoordinate) return aCoordinate - bCoordinate;
      const aKey = `${a.relation.id || ""}\u0000${a.relation.from}\u0000${a.relation.to}\u0000${a.relation.label || ""}`;
      const bKey = `${b.relation.id || ""}\u0000${b.relation.from}\u0000${b.relation.to}\u0000${b.relation.label || ""}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });

    const extent = verticalSide ? first.rect.height : first.rect.width;
    const usable = Math.max(0, extent - gutter * 2);
    const spacing = Math.min(maxSpacing, usable / (items.length - 1));
    if (!(spacing > 0)) continue;

    for (const [index, item] of items.entries()) {
      const offset = (index - (items.length - 1) / 2) * spacing;
      const point = anchor(item.rect, item.side);
      if (verticalSide) point[1] += offset;
      else point[0] += offset;
      const endpoints = spread.get(item.relation) || {};
      endpoints[item.endpoint] = point;
      spread.set(item.relation, endpoints);
    }
  }

  return spread;
}

function defaultFromSide(from: SpreadRect, to: SpreadRect): SpreadSide {
  if (to.cx < from.cx) return "left";
  if (to.cx > from.cx) return "right";
  if (to.cy > from.cy) return "bottom";
  return "top";
}

function defaultToSide(from: SpreadRect, to: SpreadRect): SpreadSide {
  if (to.cx < from.cx) return "right";
  if (to.cx > from.cx) return "left";
  if (to.cy > from.cy) return "top";
  return "bottom";
}


// Shared by edges/flows/transitions: all carry the same optional
// labelAt/labelDx/labelDy/labelSegment knobs.
export function labelPoint(
  item: { labelAt?: Vec2; labelDx?: number; labelDy?: number; labelSegment?: number },
  points: readonly Vec2[],
): Vec2 {
  if (item.labelAt) return item.labelAt;
  const segmentIndex = points.length === 2 ? 0 : Math.min(points.length - 2, Math.max(0, item.labelSegment ?? 1));
  const a = points[segmentIndex];
  const b = points[segmentIndex + 1];
  if (a === undefined || b === undefined) return [item.labelDx || 0, item.labelDy || 0];
  if (points.length === 2) {
    return [(a[0] + b[0]) / 2 + (item.labelDx || 0), a[1] - 10 + (item.labelDy || 0)];
  }
  return [(a[0] + b[0]) / 2 + (item.labelDx || 0), (a[1] + b[1]) / 2 - 10 + (item.labelDy || 0)];
}
