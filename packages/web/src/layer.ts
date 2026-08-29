/**
 * Single-layer navigation: the canvas shows exactly the children of the focused
 * bubble (top-level bubbles when nothing is focused). This is a pure rendering
 * policy over `GraphDoc` — no wire messages, no mutation.
 *
 * One layer only stays honest because of two rollups:
 *  - edge lifting: a relation touching a hidden descendant is drawn between the
 *    nearest visible ancestors, deduped, with self-lifts dropped;
 *  - liveness bubbling: activity, drift and failure on hidden descendants mark
 *    the visible ancestor that contains them.
 */
import type { EdgeKind, GraphDoc, GraphEdge, IntentNode, Phase } from "../../shared/src/index.ts";

/** guards against a malformed parent chain looping forever */
const MAX_NESTING = 32;

export interface InsideRef {
  id: string;
  label: string;
  status: string | null;
  phase: Phase;
}

export interface LayerNode {
  node: IntentNode;
  /** direct children, i.e. what drilling in would reveal */
  childCount: number;
  /** everything under it, for the drill affordance's tooltip */
  descendantCount: number;
  /** the agent is working in this bubble itself */
  activeSelf: boolean;
  /** the agent is working in something hidden underneath it */
  activeInside: InsideRef[];
  /** drift notes on this bubble */
  driftOwn: readonly string[];
  /** drift notes on hidden descendants */
  driftInside: number;
  /** hidden descendants in the `failed` phase */
  failedInside: number;
}

export interface LayerEdge {
  /** render id; synthetic when several relations collapse into one line */
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label: string | null;
  /**
   * The document relation this line stands for, and therefore a legitimate
   * steering referent. A single relation stays steerable even when it is drawn
   * between ancestors — it exists, it is merely rendered one level up. Null only
   * when several relations collapse into one line, where no single referent
   * exists and offering one would be a lie.
   */
  edgeId: string | null;
  /** true when the line is drawn between bubbles that are not its real endpoints */
  lifted: boolean;
  /** document relations collapsed into this line; 1 unless it is a bundle */
  count: number;
  /** one line per collapsed relation, for the tooltip */
  parts: string[];
}

export interface Layer {
  /** the focused bubble, or null at the project root */
  focus: IntentNode | null;
  /** root -> focus inclusive, for the breadcrumb */
  trail: IntentNode[];
  nodes: LayerNode[];
  edges: LayerEdge[];
  /** node id -> the visible bubble that represents it (itself, if visible) */
  liftOf: Record<string, string>;
  /** bubbles in the whole document, for the header count */
  total: number;
  /** relations dropped because an endpoint lives outside the focused subtree */
  offLayer: number;
}

export interface LayerInput {
  doc: GraphDoc;
  focus: string | null;
  activity: ReadonlySet<string>;
}

function kindOf(edges: GraphEdge[]): EdgeKind {
  const first = edges[0];
  if (first === undefined) return "relates";
  return edges.every((edge) => edge.kind === first.kind) ? first.kind : "relates";
}

export function selectLayer({ doc, focus, activity }: LayerInput): Layer {
  const byId = new Map<string, IntentNode>();
  for (const node of doc.nodes) byId.set(node.id, node);

  /** a parent the agent never created is treated as no parent at all */
  const parentOf = (node: IntentNode): string | null =>
    node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;

  const focusNode = focus === null ? null : (byId.get(focus) ?? null);
  const focusId = focusNode === null ? null : focusNode.id;

  const trail: IntentNode[] = [];
  if (focusNode !== null) {
    let cursor: IntentNode | undefined = focusNode;
    for (let hop = 0; cursor !== undefined && hop <= MAX_NESTING; hop += 1) {
      trail.unshift(cursor);
      const parent = parentOf(cursor);
      if (parent === null) break;
      cursor = byId.get(parent);
    }
  }

  const members = doc.nodes.filter((node) => parentOf(node) === focusId);
  const visible = new Set(members.map((node) => node.id));

  // every node maps to the visible bubble that stands for it, or to nothing when
  // it lives outside the focused subtree
  const liftOf: Record<string, string> = {};
  const liftCache = new Map<string, string | null>();
  const lift = (id: string): string | null => {
    const cached = liftCache.get(id);
    if (cached !== undefined) return cached;
    const chain: string[] = [];
    let cursor: IntentNode | undefined = byId.get(id);
    let answer: string | null = null;
    for (let hop = 0; cursor !== undefined && hop <= MAX_NESTING; hop += 1) {
      chain.push(cursor.id);
      if (visible.has(cursor.id)) {
        answer = cursor.id;
        break;
      }
      const parent = parentOf(cursor);
      if (parent === null) break;
      cursor = byId.get(parent);
    }
    for (const step of chain) {
      liftCache.set(step, answer);
      if (answer !== null) liftOf[step] = answer;
    }
    return answer;
  };
  for (const node of doc.nodes) lift(node.id);

  // rollups, attributed to the visible ancestor
  const childCount: Record<string, number> = {};
  const descendantCount: Record<string, number> = {};
  const activeInside: Record<string, InsideRef[]> = {};
  const driftInside: Record<string, number> = {};
  const failedInside: Record<string, number> = {};

  for (const node of doc.nodes) {
    const parent = parentOf(node);
    if (parent !== null) childCount[parent] = (childCount[parent] ?? 0) + 1;

    const owner = liftOf[node.id];
    if (owner === undefined) continue;
    if (owner === node.id) continue; // the bubble itself, not something inside it

    descendantCount[owner] = (descendantCount[owner] ?? 0) + 1;
    if (activity.has(node.id)) {
      const list = activeInside[owner] ?? [];
      list.push({ id: node.id, label: node.label, status: node.status ?? null, phase: node.phase });
      activeInside[owner] = list;
    }
    const notes = doc.drift[node.id];
    if (notes !== undefined && notes.length > 0) driftInside[owner] = (driftInside[owner] ?? 0) + notes.length;
    if (node.phase === "failed") failedInside[owner] = (failedInside[owner] ?? 0) + 1;
  }

  const nodes: LayerNode[] = members.map((node) => ({
    node,
    childCount: childCount[node.id] ?? 0,
    descendantCount: descendantCount[node.id] ?? 0,
    activeSelf: activity.has(node.id),
    activeInside: activeInside[node.id] ?? [],
    driftOwn: doc.drift[node.id] ?? [],
    driftInside: driftInside[node.id] ?? 0,
    failedInside: failedInside[node.id] ?? 0,
  }));

  // group relations by the visible pair they end up drawn between
  const groups = new Map<string, { source: string; target: string; edges: GraphEdge[] }>();
  let offLayer = 0;
  for (const edge of doc.edges) {
    const source = liftOf[edge.source];
    const target = liftOf[edge.target];
    if (source === undefined || target === undefined) {
      offLayer += 1;
      continue;
    }
    if (source === target) continue; // self-lift: both ends inside one bubble
    const key = `${source}\u0000${target}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { source, target, edges: [edge] });
    else group.edges.push(edge);
  }

  const edges: LayerEdge[] = [];
  for (const group of groups.values()) {
    const parts = group.edges.map((edge) => {
      const suffix = edge.label === undefined ? "" : ` — ${edge.label}`;
      return `${edge.source} → ${edge.target} [${edge.kind}]${suffix}`;
    });

    const only = group.edges.length === 1 ? group.edges[0] : undefined;
    if (only !== undefined) {
      edges.push({
        id: only.id,
        source: group.source,
        target: group.target,
        kind: only.kind,
        label: only.label ?? null,
        edgeId: only.id,
        lifted: only.source !== group.source || only.target !== group.target,
        count: 1,
        parts,
      });
      continue;
    }

    edges.push({
      id: `lift:${group.source}--${group.target}`,
      source: group.source,
      target: group.target,
      kind: kindOf(group.edges),
      label: null,
      edgeId: null,
      // a bundle is only an approximation of WHERE if something it collapses
      // actually lives further down; two relations between this very pair are
      // drawn exactly where they belong, so they get a solid stroke
      lifted: group.edges.some((edge) => edge.source !== group.source || edge.target !== group.target),
      count: group.edges.length,
      parts,
    });
  }

  return { focus: focusNode, trail, nodes, edges, liftOf, total: doc.nodes.length, offLayer };
}
