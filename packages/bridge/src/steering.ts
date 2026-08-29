/**
 * Steering composition (CONTRACTS.md § Steering composition): a click referent
 * plus an utterance become one addressed instruction for the running session.
 */

import type { Referent } from "../../shared/src/index.ts";
import type { GraphStore } from "./store.ts";

const REMINDER = "Apply the change and keep the canvas current via the canvas tool.";

function neighborsOfNode(store: GraphStore, id: string): string[] {
  const out: string[] = [];
  const node = store.node(id);
  if (node?.parentId != null) out.push(`${node.parentId} [parent]`);
  for (const child of store.doc.nodes) {
    if (child.parentId === id) out.push(`${child.id} [child]`);
  }
  for (const edge of store.doc.edges) {
    const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
    if (other === null) continue;
    const rel = edge.label === undefined ? edge.kind : `${edge.kind} "${edge.label}"`;
    out.push(`${other} [${rel}]`);
  }
  return out;
}

/**
 * Renders the `<canvas-steering>` block when a referent resolves, otherwise the
 * raw utterance plus the one-line canvas reminder.
 */
export function composeUtterance(store: GraphStore, text: string, referent: Referent | null): string {
  const said = `User said: "${text}"`;

  if (referent !== null && referent.kind === "node") {
    const node = store.node(referent.id);
    if (node !== undefined) {
      const neighbors = neighborsOfNode(store, node.id);
      return [
        "<canvas-steering>",
        `Referent: component "${node.label}" (id: ${node.id}) — "${node.summary}" (phase: ${node.phase})`,
        `Neighbors: ${neighbors.length > 0 ? neighbors.join(", ") : "none"}`,
        said,
        REMINDER,
        "</canvas-steering>",
      ].join("\n");
    }
  }

  if (referent !== null && referent.kind === "edge") {
    const edge = store.edge(referent.id);
    if (edge !== undefined) {
      const source = store.node(edge.source);
      const target = store.node(edge.target);
      const label = edge.label === undefined ? "" : ` "${edge.label}"`;
      const endpoints = [source, target]
        .filter((n) => n !== undefined)
        .map((n) => `${n.id} "${n.label}" — "${n.summary}" (phase: ${n.phase})`);
      return [
        "<canvas-steering>",
        `Referent: edge${label} (id: ${edge.id}) — ${edge.kind} from ${edge.source} to ${edge.target}`,
        `Neighbors: ${endpoints.length > 0 ? endpoints.join("; ") : "none"}`,
        said,
        REMINDER,
        "</canvas-steering>",
      ].join("\n");
    }
  }

  if (referent !== null) {
    return [
      "<canvas-steering>",
      `Referent: ${referent.kind} "${referent.id}" — NOT FOUND on the canvas; the user clicked something the graph no longer describes.`,
      said,
      REMINDER,
      "</canvas-steering>",
    ].join("\n");
  }

  return `${text}\n\n${REMINDER}`;
}
