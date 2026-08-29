import type { RealityLayer, Referent } from "../../../shared/src/index.ts";
import type { Layer, LayerNode } from "../layer.ts";
import { STRIP_ID, type Box, type BoxMap } from "../layout.ts";
import { computeEdgeGeometry } from "./geometry.ts";
import type { CanvasEdge, CanvasNode } from "./types.ts";

export interface CanvasModel {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface BuildInput {
  layer: Layer;
  reality: RealityLayer;
  boxes: BoxMap;
  selection: Referent | null;
  showReality: boolean;
  /** bubbles that just arrived: they fade and scale in rather than sliding */
  entering: ReadonlySet<string>;
  /** bubbles that left the layer, kept mounted only while they fade out */
  leaving: readonly LayerNode[];
}

/**
 * Projects one layer plus its layout into React Flow's shape. Every bubble is a
 * root-level node: the canvas draws siblings only, so there is no containment
 * and no parent-before-child ordering requirement.
 */
export function buildCanvas({
  layer,
  reality,
  boxes,
  selection,
  showReality,
  entering,
  leaving,
}: BuildInput): CanvasModel {
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;
  const selectedEdgeId = selection?.kind === "edge" ? selection.id : null;

  const nodes: CanvasNode[] = [];
  const bubble = (entry: LayerNode, motion: "enter" | "leave" | "none"): void => {
    const box = boxes[entry.node.id];
    if (box === undefined) return;
    nodes.push({
      id: entry.node.id,
      type: "bubble",
      position: { x: box.x, y: box.y },
      // Layout is authoritative, so the size is stated three ways on purpose.
      // `measured` is what React Flow's edge router reads: without it, edges are
      // gated on a ResizeObserver pass and every edge on the canvas blinks out
      // whenever nodes are re-adopted (drilling in, end of a framing move).
      width: box.w,
      height: box.h,
      measured: { width: box.w, height: box.h },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: {
        node: entry.node,
        phase: entry.node.phase,
        active: entry.activeSelf,
        activeInside: entry.activeInside,
        drift: entry.driftOwn,
        driftInside: entry.driftInside,
        failedInside: entry.failedInside,
        isSelected: entry.node.id === selectedNodeId,
        childCount: entry.childCount,
        descendantCount: entry.descendantCount,
        motion,
      },
    });
  };

  for (const entry of layer.nodes) bubble(entry, entering.has(entry.node.id) ? "enter" : "none");
  // departures stay mounted for the length of their fade, and never take part in
  // framing or edge routing again
  for (const entry of leaving) bubble(entry, "leave");

  // one geometry pass over the final boxes decides every stroke's anchors and
  // bow and every label's spot on its own curve
  const obstacles = layer.nodes
    .map((entry) => ({ id: entry.node.id, box: boxes[entry.node.id] }))
    .filter((entry): entry is { id: string; box: Box } => entry.box !== undefined);
  const geometry = computeEdgeGeometry({ edges: layer.edges, boxes, obstacles });

  const edges: CanvasEdge[] = [];
  for (const edge of layer.edges) {
    const geom = geometry[edge.id];
    if (geom === undefined) continue;
    const isSelected = edge.edgeId !== null && edge.edgeId === selectedEdgeId;
    const classes = [`rel-${edge.kind}`];
    if (isSelected) classes.push("rel-selected");
    // dashed whenever the line is an approximation of where the relation lives
    if (edge.lifted) classes.push("rel-lifted");
    edges.push({
      id: edge.id,
      type: "rel",
      source: edge.source,
      target: edge.target,
      className: classes.join(" "),
      selectable: false,
      deletable: false,
      data: {
        kind: edge.kind,
        label: edge.label ?? "",
        isSelected,
        geom,
        edgeId: edge.edgeId,
        count: edge.count,
        parts: edge.parts,
        lifted: edge.lifted,
        // only a bundle has no referent; clicking it drills toward the real ones
        drillId: edge.edgeId === null ? edge.source : null,
      },
    });
  }

  if (!showReality) return { nodes, edges };

  const stripBox = boxes[STRIP_ID];
  if (stripBox !== undefined && reality.nodes.length > 0) {
    const head = reality.head;
    nodes.push({
      id: STRIP_ID,
      type: "strip",
      position: { x: stripBox.x, y: stripBox.y },
      width: stripBox.w,
      height: stripBox.h,
      measured: { width: stripBox.w, height: stripBox.h },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: {
        phase: "reality",
        caption: head === null ? "reality — extracted from code" : `reality — extracted at ${head}`,
      },
    });
  }

  for (const node of reality.nodes) {
    const box = boxes[node.id];
    if (box === undefined) continue;
    nodes.push({
      id: node.id,
      type: "ghost",
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      measured: { width: box.w, height: box.h },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: { phase: "reality", label: node.label, dir: node.dir },
    });
  }

  for (const edge of reality.edges) {
    const source = boxes[edge.source];
    const target = boxes[edge.target];
    if (source === undefined || target === undefined) continue;
    edges.push({
      id: edge.id,
      type: "rel",
      source: edge.source,
      target: edge.target,
      className: "rel-ghost",
      selectable: false,
      deletable: false,
      data: {
        kind: null,
        label: "",
        isSelected: false,
        // the ghost column is a vertical chain, so a straight chord is right and
        // no clearance search is needed
        geom: {
          ax: source.x + source.w / 2,
          ay: source.y + source.h,
          bx: target.x + target.w / 2,
          by: target.y,
          bow: { b1: 0, b2: 0 },
          labelT: 0.5,
          labelOff: 0,
        },
        edgeId: null,
        count: 0,
        lifted: false,
        parts: [],
        drillId: null,
      },
    });
  }

  return { nodes, edges };
}
