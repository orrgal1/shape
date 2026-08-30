/**
 * Pure snapshot canonicalization + diff for the intent layer.
 *
 * Imported by RELATIVE PATH with explicit .ts extension from both the bridge
 * (Node 26 type-stripping) and the web client (Vite). No I/O, no dependencies,
 * no clock reads except the `at` default of `snapshotGraph`.
 *
 * Canonical form is the whole point: two structurally equal graphs must produce
 * byte-identical `canonicalJson`, so "changed" means changed and not reordered.
 */

import type { EntityDelta, GraphDelta, GraphDoc, GraphEdge, GraphSnapshot, IntentNode } from "./index.ts";

/** codepoint (not locale) ordering — stable across engines and locales */
function codepointOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => codepointOrder(left.id, right.id));
}

/**
 * Deterministic stringify: object keys sorted in codepoint order, arrays kept in
 * order, scalars via JSON.stringify. Undefined-valued keys are dropped (as
 * JSON.stringify does); a bare `undefined` reads as `null`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const parts: string[] = [];
    for (const key of Object.keys(value as Record<string, unknown>).sort(codepointOrder)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
    }
    return `{${parts.join(",")}}`;
  }
  const scalar = JSON.stringify(value);
  return scalar === undefined ? "null" : scalar;
}

function canonicalNode(node: IntentNode): IntentNode {
  const out: IntentNode = {
    id: node.id,
    parentId: node.parentId ?? null,
    label: node.label,
    summary: node.summary,
    phase: node.phase,
  };
  if (node.status !== undefined) out.status = node.status;
  if (node.modelRole !== undefined) out.modelRole = node.modelRole;
  if (node.codeRefs !== undefined) out.codeRefs = [...node.codeRefs].sort(codepointOrder);
  return out;
}

function canonicalEdge(edge: GraphEdge): GraphEdge {
  const out: GraphEdge = {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
  };
  if (edge.label !== undefined) out.label = edge.label;
  return out;
}

/**
 * Deep canonical copy of a doc's intent layer: nodes and edges sorted by id,
 * stable key order per object, undefined optionals omitted, `codeRefs` sorted.
 * `at` defaults to now.
 */
export function snapshotGraph(doc: Pick<GraphDoc, "rev" | "nodes" | "edges">, at?: string): GraphSnapshot {
  return {
    rev: doc.rev,
    at: at ?? new Date().toISOString(),
    nodes: sortedById(doc.nodes).map(canonicalNode),
    edges: sortedById(doc.edges).map(canonicalEdge),
  };
}

function diffEntities<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): EntityDelta<T> {
  const beforeById = new Map<string, T>(before.map((item) => [item.id, item]));
  const afterById = new Map<string, T>(after.map((item) => [item.id, item]));

  const added: T[] = [];
  const removed: T[] = [];
  const changed: Array<{ before: T; after: T }> = [];

  for (const [id, item] of beforeById) {
    const next = afterById.get(id);
    if (next === undefined) {
      removed.push(item);
    } else if (canonicalJson(item) !== canonicalJson(next)) {
      changed.push({ before: item, after: next });
    }
  }
  for (const [id, item] of afterById) {
    if (!beforeById.has(id)) added.push(item);
  }

  return {
    added: sortedById(added),
    removed: sortedById(removed),
    changed: [...changed].sort((left, right) => codepointOrder(left.before.id, right.before.id)),
  };
}

/** Pure diff of two snapshots keyed by id; `a` is the before side, `b` the after. */
export function diffSnapshots(a: GraphSnapshot, b: GraphSnapshot): GraphDelta {
  return {
    revA: a.rev,
    revB: b.rev,
    nodes: diffEntities(a.nodes, b.nodes),
    edges: diffEntities(a.edges, b.edges),
  };
}
