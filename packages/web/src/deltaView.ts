/**
 * A comparison, expressed as a document the ordinary canvas can already draw.
 *
 * A `GraphDelta` carries only what moved between two versions: added, removed
 * and changed entities. That is enough to draw, so this module projects it into
 * a synthetic `GraphDoc` — the after side of everything that changed, plus what
 * disappeared — and a set of marks saying which side of the comparison each
 * bubble and each line is on. The canvas then renders it through exactly the
 * same layer → layout → build pipeline as the live graph.
 *
 * Two deliberate simplifications:
 *
 *  - **Flat.** Every node in the projection is parentless, so one layer holds
 *    everything the comparison touched, and drill-down is suspended while a
 *    comparison is open (`Canvas` forces the focus to null). Nesting would hide
 *    behind a closed bubble exactly the change the comparison was opened to see.
 *
 *  - **Context is borrowed, never invented.** Unchanged entities are absent from
 *    a delta by construction, so the receded backdrop can only come from a live
 *    graph that *is* the after side. `context` is that graph or null; with null
 *    the view shows the changes alone and the comparison bar says so.
 */
import type { GraphDelta, GraphDoc, GraphEdge, IntentNode } from "../../shared/src/index.ts";

/** which side of the comparison an entity is on; `same` is receded backdrop */
export type DeltaStatus = "added" | "changed" | "removed" | "same";

export interface DeltaMarks {
  nodes: Record<string, DeltaStatus>;
  edges: Record<string, DeltaStatus>;
  /** plain-English lines saying what changed, for the tooltip on a marked bubble */
  nodeNotes: Record<string, string[]>;
  edgeNotes: Record<string, string[]>;
}

export interface DeltaView {
  /** synthetic: the after side plus what was removed, all at one level */
  doc: GraphDoc;
  marks: DeltaMarks;
}

/** an endpoint the comparison says nothing about, so an orphaned line still reads */
function stubNode(id: string): IntentNode {
  return { id, parentId: null, label: id, summary: "Not part of what changed.", phase: "component" };
}

/** what a person would say about a bubble that survived but is not the same */
function nodeNotes(before: IntentNode, after: IntentNode): string[] {
  const notes: string[] = [];
  if (before.label !== after.label) notes.push(`used to be called "${before.label}"`);
  if (before.phase !== after.phase) notes.push(`went from ${before.phase} to ${after.phase}`);
  if (before.summary !== after.summary) notes.push(`its promise was "${before.summary}"`);
  if ((before.status ?? null) !== (after.status ?? null)) notes.push("what it says it is doing now changed");
  if (before.parentId !== after.parentId) {
    notes.push(after.parentId === null ? "moved out on its own" : `moved inside ${after.parentId}`);
  }
  if ((before.modelRole ?? null) !== (after.modelRole ?? null)) notes.push("asks for a different model");
  const wasRefs = (before.codeRefs ?? []).join(", ");
  const nowRefs = (after.codeRefs ?? []).join(", ");
  if (wasRefs !== nowRefs) {
    notes.push(nowRefs.length === 0 ? "no longer points at any code" : `now points at ${nowRefs}`);
  }
  return notes;
}

function edgeNotes(before: GraphEdge, after: GraphEdge): string[] {
  const notes: string[] = [];
  if (before.source !== after.source || before.target !== after.target) {
    notes.push(`used to run ${before.source} → ${before.target}`);
  }
  if (before.kind !== after.kind) notes.push(`used to be a ${before.kind} relation`);
  const wasLabel = before.label ?? "";
  const nowLabel = after.label ?? "";
  if (wasLabel !== nowLabel) {
    notes.push(wasLabel.length === 0 ? `now reads "${nowLabel}"` : `used to read "${wasLabel}"`);
  }
  return notes;
}

export function buildDeltaView(delta: GraphDelta, context: GraphDoc | null): DeltaView {
  const nodes: IntentNode[] = [];
  const edges: GraphEdge[] = [];
  const marks: DeltaMarks = { nodes: {}, edges: {}, nodeNotes: {}, edgeNotes: {} };

  /** the projection is one flat layer, so a parent link would only hide bubbles */
  const flatten = (node: IntentNode): IntentNode => (node.parentId === null ? node : { ...node, parentId: null });

  // First verdict wins, and the delta always speaks before the context: a bubble
  // the delta calls added must not be demoted to backdrop by the live graph.
  const addNode = (node: IntentNode, status: DeltaStatus): void => {
    if (marks.nodes[node.id] !== undefined) return;
    marks.nodes[node.id] = status;
    nodes.push(flatten(node));
  };
  const addEdge = (edge: GraphEdge, status: DeltaStatus): void => {
    if (marks.edges[edge.id] !== undefined) return;
    marks.edges[edge.id] = status;
    edges.push(edge);
  };

  for (const node of delta.nodes.added) addNode(node, "added");
  for (const pair of delta.nodes.changed) {
    addNode(pair.after, "changed");
    marks.nodeNotes[pair.after.id] = nodeNotes(pair.before, pair.after);
  }
  for (const node of delta.nodes.removed) addNode(node, "removed");

  for (const edge of delta.edges.added) addEdge(edge, "added");
  for (const pair of delta.edges.changed) {
    addEdge(pair.after, "changed");
    marks.edgeNotes[pair.after.id] = edgeNotes(pair.before, pair.after);
  }
  for (const edge of delta.edges.removed) addEdge(edge, "removed");

  if (context !== null) {
    for (const node of context.nodes) addNode(node, "same");
    for (const edge of context.edges) addEdge(edge, "same");
  }

  // A relation is only legible between two bubbles. Without a context graph the
  // unchanged endpoints of a changed relation are absent, so they arrive as
  // receded stubs named after their id rather than dropping the relation.
  const ensure = (id: string): void => {
    if (marks.nodes[id] !== undefined) return;
    addNode(stubNode(id), "same");
  };
  for (const edge of edges) {
    ensure(edge.source);
    ensure(edge.target);
  }

  return {
    doc: {
      rev: delta.revB,
      nodes,
      edges,
      // a comparison is about what the canvas said, not about what the code does
      reality: { nodes: [], edges: [], symbols: [], infra: [], verification: [], extractedAt: null, head: null },
      drift: {},
    },
    marks,
  };
}
