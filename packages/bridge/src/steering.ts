/**
 * Steering composition (CONTRACTS.md § Steering composition): a click referent
 * plus an utterance become one addressed instruction for the running session.
 */

import { layerOf, productRootOf, realizersOf, servesOf } from "../../shared/src/index.ts";
import type { Referent } from "../../shared/src/index.ts";
import type { GraphStore } from "./store.ts";

const REMINDER = "Apply the change and keep the canvas current via the canvas tool.";

function neighborsOfNode(store: GraphStore, id: string, isProductRoot: boolean): string[] {
  const out: string[] = [];
  const node = store.node(id);
  if (node?.parentId != null) out.push(`${node.parentId} [parent]`);
  for (const child of store.doc.nodes) {
    if (child.parentId !== id) continue;
    // the product root's children ARE the product's capabilities, so name them
    out.push(isProductRoot ? `${nameOf(store, child.id)} [capability]` : `${child.id} [child]`);
  }
  for (const edge of store.doc.edges) {
    const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
    if (other === null) continue;
    const rel = edge.label === undefined ? edge.kind : `${edge.kind} "${edge.label}"`;
    out.push(`${other} [${rel}]`);
  }
  return out;
}

/** `id "Label"` — the agent needs the id to act and the user's words to understand. */
function nameOf(store: GraphStore, id: string): string {
  const node = store.node(id);
  return node === undefined ? id : `${id} "${node.label}"`;
}

/**
 * The one cross-layer line: a capability names the parts that make it real, a
 * part names the capabilities it serves. Kept out of `Neighbors` on purpose —
 * neighbors are same-layer relations, this is the bridge between the layers.
 * The product root gets none: it stands for the whole build layer, and its
 * capabilities are already listed as its neighbors.
 */
function layerLines(store: GraphStore, id: string, isProductRoot: boolean): string[] {
  if (isProductRoot) return [];
  if (layerOf(store.node(id) ?? {}) === "product") {
    const realizers = realizersOf(store.doc, id);
    return [
      realizers.length > 0
        ? `Realized by: ${realizers.map((r) => nameOf(store, r)).join(", ")}`
        : "Realized by: nothing yet — no part on the build side makes this capability real, so building it is the work.",
    ];
  }
  const serves = servesOf(store.doc, id);
  return serves.length > 0 ? [`Serves: ${serves.map((s) => nameOf(store, s)).join(", ")}`] : [];
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
      const isProductRoot = productRootOf(store.doc)?.id === node.id;
      const neighbors = neighborsOfNode(store, node.id, isProductRoot);
      const kind = isProductRoot ? "the product" : layerOf(node) === "product" ? "product capability" : "component";
      return [
        "<canvas-steering>",
        `Referent: ${kind} "${node.label}" (id: ${node.id}) — "${node.summary}" (phase: ${node.phase})`,
        ...layerLines(store, node.id, isProductRoot),
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
