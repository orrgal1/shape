/**
 * Everything the side panel shows is derived here, from data the store already
 * holds. No new wire messages: the panel is a reading of the graph plus the
 * transcript stream, not another channel.
 */
import { PHASES, type GraphDoc, type GraphEdge, type IntentNode, type Phase } from "../../shared/src/index.ts";
import type { TranscriptEntry } from "./store.ts";

/** transcript lines shown per subject before older ones are dropped */
const RELEVANT_LINES = 4;
/** assistant paragraphs kept as "latest narration" */
const NARRATION_LINES = 2;

export interface WorkingBubble {
  id: string;
  label: string;
  status: string | null;
  phase: Phase;
  /**
   * The visible bubble that stands for this one in the current layer, when the
   * working bubble is itself hidden below it. Null when it is on screen.
   */
  insideOf: { id: string; label: string } | null;
}

export interface PhaseTally {
  phase: Phase;
  count: number;
}

export interface ProjectTldr {
  working: WorkingBubble[];
  tallies: PhaseTally[];
  nodeCount: number;
  driftNodes: number;
  driftNotes: number;
  narration: TranscriptEntry[];
}

export interface NeighbourLink {
  id: string;
  label: string;
  phase: Phase;
}

export interface RelationLink {
  edgeId: string;
  kind: GraphEdge["kind"];
  label: string | null;
  /** "out" = this node is the source */
  direction: "out" | "in";
  other: NeighbourLink;
}

export interface NodeTldr {
  node: IntentNode;
  working: boolean;
  parent: NeighbourLink | null;
  children: NeighbourLink[];
  relations: RelationLink[];
  drift: readonly string[];
  lines: TranscriptEntry[];
}

export interface EdgeTldr {
  edge: GraphEdge;
  source: NeighbourLink | null;
  target: NeighbourLink | null;
  /** drift notes on either endpoint — the pair is what the user is steering */
  drift: { nodeId: string; note: string }[];
  lines: TranscriptEntry[];
}

function link(node: IntentNode): NeighbourLink {
  return { id: node.id, label: node.label, phase: node.phase };
}

export function projectTldr(
  doc: GraphDoc,
  activity: ReadonlySet<string>,
  transcript: TranscriptEntry[],
  /** node id -> the bubble currently standing for it on the canvas */
  liftOf: Record<string, string>,
  /**
   * Visible bubble id -> label. The canvas can be standing for a node with a
   * bubble the document has never heard of — the fold — so the label of a lift
   * target comes from the layer, not from `doc`.
   */
  labelOf: Record<string, string>,
): ProjectTldr {
  const working: WorkingBubble[] = [];
  const counts: Record<string, number> = {};
  let driftNodes = 0;
  let driftNotes = 0;

  const nameOf = new Map<string, string>();
  for (const node of doc.nodes) nameOf.set(node.id, node.label);

  for (const node of doc.nodes) {
    counts[node.phase] = (counts[node.phase] ?? 0) + 1;
    if (activity.has(node.id)) {
      const owner = liftOf[node.id];
      const insideOf =
        owner === undefined || owner === node.id
          ? null
          : { id: owner, label: labelOf[owner] ?? nameOf.get(owner) ?? owner };
      working.push({ id: node.id, label: node.label, status: node.status ?? null, phase: node.phase, insideOf });
    }
    const notes = doc.drift[node.id];
    if (notes !== undefined && notes.length > 0) {
      driftNodes += 1;
      driftNotes += notes.length;
    }
  }

  const tallies: PhaseTally[] = [];
  for (const phase of PHASES) {
    const count = counts[phase] ?? 0;
    if (count > 0) tallies.push({ phase, count });
  }

  const narration: TranscriptEntry[] = [];
  for (let i = transcript.length - 1; i >= 0 && narration.length < NARRATION_LINES; i -= 1) {
    const entry = transcript[i];
    if (entry === undefined || entry.role !== "assistant") continue;
    narration.unshift(entry);
  }

  return { working, tallies, nodeCount: doc.nodes.length, driftNodes, driftNotes, narration };
}

/**
 * Transcript lines that plausibly concern one bubble: tool lines that touch a
 * path the bubble claims, and narration that names it. Cheap heuristics on the
 * text we already have — the alternative is asking the bridge to tag lines,
 * which is a wire change for a side panel.
 */
function linesAbout(node: IntentNode, transcript: TranscriptEntry[]): TranscriptEntry[] {
  const label = node.label.toLowerCase();
  const refs = node.codeRefs ?? [];
  const found: TranscriptEntry[] = [];

  for (let i = transcript.length - 1; i >= 0 && found.length < RELEVANT_LINES; i -= 1) {
    const entry = transcript[i];
    if (entry === undefined) continue;
    const text = entry.text.toLowerCase();
    const hit =
      entry.role === "tool"
        ? refs.some((ref) => entry.text.includes(ref)) || text.includes(node.id)
        : text.includes(label) || text.includes(node.id);
    if (hit) found.unshift(entry);
  }
  return found;
}

export function nodeTldr(
  doc: GraphDoc,
  nodeId: string,
  activity: ReadonlySet<string>,
  transcript: TranscriptEntry[],
): NodeTldr | null {
  const byId = new Map<string, IntentNode>();
  for (const candidate of doc.nodes) byId.set(candidate.id, candidate);

  const node = byId.get(nodeId);
  if (node === undefined) return null;

  const parentNode = node.parentId === null ? undefined : byId.get(node.parentId);
  const children: NeighbourLink[] = [];
  for (const candidate of doc.nodes) {
    if (candidate.parentId === nodeId) children.push(link(candidate));
  }

  const relations: RelationLink[] = [];
  for (const edge of doc.edges) {
    const outgoing = edge.source === nodeId;
    const incoming = edge.target === nodeId;
    if (!outgoing && !incoming) continue;
    const other = byId.get(outgoing ? edge.target : edge.source);
    if (other === undefined) continue;
    relations.push({
      edgeId: edge.id,
      kind: edge.kind,
      label: edge.label ?? null,
      direction: outgoing ? "out" : "in",
      other: link(other),
    });
  }

  return {
    node,
    working: activity.has(nodeId),
    parent: parentNode === undefined ? null : link(parentNode),
    children,
    relations,
    drift: doc.drift[nodeId] ?? [],
    lines: linesAbout(node, transcript),
  };
}

export function edgeTldr(doc: GraphDoc, edgeId: string, transcript: TranscriptEntry[]): EdgeTldr | null {
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  if (edge === undefined) return null;

  const byId = new Map<string, IntentNode>();
  for (const candidate of doc.nodes) byId.set(candidate.id, candidate);
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);

  const drift: EdgeTldr["drift"] = [];
  for (const endpoint of [edge.source, edge.target]) {
    for (const note of doc.drift[endpoint] ?? []) drift.push({ nodeId: endpoint, note });
  }

  const lines: TranscriptEntry[] = [];
  for (const endpoint of [source, target]) {
    if (endpoint === undefined) continue;
    for (const entry of linesAbout(endpoint, transcript)) {
      if (!lines.some((existing) => existing.seq === entry.seq)) lines.push(entry);
    }
  }
  lines.sort((a, b) => a.seq - b.seq);

  return {
    edge,
    source: source === undefined ? null : link(source),
    target: target === undefined ? null : link(target),
    drift,
    lines: lines.slice(-RELEVANT_LINES),
  };
}
