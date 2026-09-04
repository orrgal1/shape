import { layerOf, type Referent } from "../../../shared/src/index.ts";
import type { DeltaMarks, DeltaStatus } from "../deltaView.ts";
import type { GhostColumn, Layer, LayerNode, WhereMark } from "../layer.ts";
import { STRIP_ID, type Box, type BoxMap } from "../layout.ts";
import type { HoverTarget } from "../store.ts";
import { computeEdgeGeometry } from "./geometry.ts";
import type { BranchPip, CanvasEdge, CanvasNode } from "./types.ts";

export interface CanvasModel {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/**
 * What the merged canvas needs to know about the variations it is merging: how
 * to name and colour each one, which of them hold each bubble, and what each
 * one is working on. `merged: false` — a single variation on screen, or a
 * comparison open — means no bubble carries pips at all.
 */
export interface VariationLook {
  merged: boolean;
  /** branch name and colour slot per worktree id */
  looks: Record<string, { branch: string; tone: number }>;
  /** which variations hold each merged node, primary copy first */
  where: Record<string, readonly WhereMark[]>;
  /** intent node ids each variation is working inside right now */
  activity: Record<string, ReadonlySet<string>>;
}

export interface BuildInput {
  layer: Layer;
  /** the code-derived cards beside the layer: packages, infrastructure or symbols */
  ghosts: GhostColumn;
  boxes: BoxMap;
  selection: Referent | null;
  /** what the pointer is over, which is what reveals a stroke's words */
  hover: HoverTarget | null;
  showReality: boolean;
  /** bubbles that just arrived: they fade and scale in rather than sliding */
  entering: ReadonlySet<string>;
  /** bubbles that left the layer, kept mounted only while they fade out */
  leaving: readonly LayerNode[];
  /**
   * The one bubble that breathes while the agent is working with nothing lit
   * yet, or null. Not part of the layer selection on purpose: a breath must
   * never re-run layout, and the reader is looking at this bubble either way.
   */
  thinking: string | null;
  /**
   * The agent is working with nothing lit at all. Every bubble on the layer
   * carries the same faint wash, staggered by its place in the layer, so the
   * canvas is alive in more than one corner while `thinking` says where the
   * reader's own attention should go.
   */
  pondering: boolean;
  /**
   * The bubble under the lens, or null. Its card is grown to fit its whole
   * promise and drawn above the layer — the lens is allowed to overlap its
   * neighbours, which is what keeps every other box exactly where it was.
   */
  lens: string | null;
  /**
   * Comparison verdicts, or null on the live canvas. When set, every bubble and
   * line carries one — anything the delta does not mention is backdrop.
   */
  marks: DeltaMarks | null;
  /** how the variations on screen are named, coloured and where their bubbles are */
  variations: VariationLook;
}

/** stable empty tooltip source: a fresh array per node would churn React Flow's data */
const NO_NOTES: readonly string[] = [];
const NO_PIPS: readonly BranchPip[] = [];
const NO_RINGS: readonly number[] = [];

/** above every other card and stroke: the lensed bubble is the one being read */
const LENS_Z = 1000;

/**
 * The verdict for a drawn line. A line usually stands for one relation, but a
 * bundle stands for several: when those disagree, the line as a whole is best
 * described as changed — something inside it is not what it was.
 */
function lineStatus(marks: DeltaMarks, edgeIds: string[]): DeltaStatus {
  let agreed: DeltaStatus | null = null;
  for (const id of edgeIds) {
    const status = marks.edges[id] ?? "same";
    if (agreed === null) agreed = status;
    else if (agreed !== status) return "changed";
  }
  return agreed ?? "same";
}

/**
 * Projects one layer plus its layout into React Flow's shape. Every bubble is a
 * root-level node: the canvas draws siblings only, so there is no containment
 * and no parent-before-child ordering requirement.
 */
export function buildCanvas({
  layer,
  ghosts,
  boxes,
  selection,
  hover,
  showReality,
  entering,
  leaving,
  marks,
  thinking,
  pondering,
  lens,
  variations,
}: BuildInput): CanvasModel {
  const selectedNodeId = selection?.kind === "node" ? selection.id : null;
  const selectedEdgeId = selection?.kind === "edge" ? selection.id : null;
  const hoveredNodeId = hover?.kind === "node" ? hover.id : null;
  const hoveredEdgeId = hover?.kind === "edge" ? hover.id : null;

  /**
   * Where this bubble lives, and which variations are working in it. A fold
   * stands for several bubbles and a comparison is one variation's history, so
   * neither gets pips — and both are answered by `variations.merged` being
   * false or by the fold having no document id in `where`.
   */
  const pipsOf = (entry: LayerNode): readonly BranchPip[] => {
    if (!variations.merged) return NO_PIPS;
    const marks = variations.where[entry.node.id];
    if (marks === undefined || marks.length < 2) return NO_PIPS;
    return marks.map((mark, index) => ({
      worktree: mark.worktree,
      branch: variations.looks[mark.worktree]?.branch ?? mark.worktree,
      differs: mark.differs,
      tone: variations.looks[mark.worktree]?.tone ?? 0,
      primary: index === 0,
    }));
  };

  const ringsOf = (entry: LayerNode): readonly number[] => {
    if (!variations.merged) return NO_RINGS;
    const tones: number[] = [];
    for (const [worktree, ids] of Object.entries(variations.activity)) {
      const look = variations.looks[worktree];
      if (look === undefined) continue;
      // the bubble itself, or whatever hidden descendant it stands for
      const lit = ids.has(entry.node.id) || entry.activeInside.some((ref) => ids.has(ref.id));
      if (lit) tones.push(look.tone);
    }
    return tones.length === 0 ? NO_RINGS : tones;
  };

  /**
   * Which bubbles the work is in right now, and in whose colour. Both answers
   * are needed by the lines rather than the cards: a stroke with a live end
   * flows, and a stroke arriving at one glows in that variation's colour. A
   * bubble the agent has not placed yet counts as live too — that is the whole
   * point of `thinking`, and the line into it is the reader's best guess about
   * where the turn is heading.
   */
  const liveTone = new Map<string, number>();
  for (const entry of layer.nodes) {
    const lit = entry.activeSelf || entry.activeInside.length > 0;
    if (!lit && entry.node.id !== thinking) continue;
    liveTone.set(entry.node.id, ringsOf(entry)[0] ?? 0);
  }

  const nodes: CanvasNode[] = [];
  const bubble = (entry: LayerNode, motion: "enter" | "leave" | "none", order: number): void => {
    const lensed = entry.node.id === lens;
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
      // the lens grows past its neighbours on purpose, so it is drawn over them
      ...(lensed ? { zIndex: LENS_Z } : null),
      data: {
        node: entry.node,
        phase: entry.node.phase,
        active: entry.activeSelf,
        activeInside: entry.activeInside,
        drift: entry.driftOwn,
        driftInside: entry.driftInside,
        failedInside: entry.failedInside,
        pips: pipsOf(entry),
        rings: ringsOf(entry),
        isSelected: entry.node.id === selectedNodeId,
        isMore: entry.isMore,
        childCount: entry.childCount,
        descendantCount: entry.descendantCount,
        solo: layer.nodes.length === 1,
        lens: lensed,
        // the fold is not a bubble in any layer, so it carries none of their
        // extra vocabulary
        layer: entry.isMore ? "build" : layerOf(entry.node),
        realizerCount: entry.realizerCount,
        serveCount: entry.serveCount,
        hostCount: entry.hostCount,
        verifyCount: entry.verifyCount,
        shield: entry.shield,
        symbolCount: entry.symbolCount,
        gaps: entry.gaps,
        unrealized: entry.unrealized,
        thinking: entry.node.id === thinking,
        // a bubble the work is already inside has a ring of its own; the wash is
        // for the ones with nothing to say yet
        pondering: pondering && !entry.activeSelf && entry.activeInside.length === 0,
        order,
        motion,
        deltaStatus: marks === null ? null : (marks.nodes[entry.node.id] ?? "same"),
        deltaNotes: marks === null ? NO_NOTES : (marks.nodeNotes[entry.node.id] ?? NO_NOTES),
      },
    });
  };

  layer.nodes.forEach((entry, index) => bubble(entry, entering.has(entry.node.id) ? "enter" : "none", index));
  // departures stay mounted for the length of their fade, and never take part in
  // framing or edge routing again
  leaving.forEach((entry, index) => bubble(entry, "leave", index));

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
    /**
     * A line with a live end is a line the work is travelling along, so it
     * flows; a line arriving at one glows in the colour of the variation doing
     * the arriving. Both are read off the endpoints, never authored, and
     * neither exists in a comparison — nothing is being worked on in a version
     * that already happened.
     */
    const liveSource = liveTone.has(edge.source);
    const liveTarget = liveTone.has(edge.target);
    const live = liveSource && liveTarget ? "both" : liveSource ? "source" : liveTarget ? "target" : "none";
    if (live !== "none") classes.push("rel-live");
    if (liveTarget) classes.push("rel-into-live");
    const tone = liveTarget ? (liveTone.get(edge.target) ?? 0) : null;
    // In a comparison what moved must read before what kind of relation it is,
    // so the verdict is its own class and outranks the kind's stroke colour.
    const deltaStatus = marks === null ? null : lineStatus(marks, edge.edgeIds);
    if (deltaStatus !== null) classes.push(`rel-delta-${deltaStatus}`);
    /**
     * Eighteen labelled strokes over nine bubbles is the spaghetti this policy
     * exists to undo, so the words are asked for rather than always on: the
     * line under the pointer, the lines of the bubble under the pointer, and
     * the lines of whatever is selected. A comparison is the exception — there
     * the label carries the verdict, which is the whole reason it is open.
     */
    const labelShown =
      deltaStatus !== null ||
      isSelected ||
      hoveredEdgeId === edge.id ||
      edge.source === hoveredNodeId ||
      edge.target === hoveredNodeId ||
      edge.source === selectedNodeId ||
      edge.target === selectedNodeId;
    if (labelShown) classes.push("rel-labelled");
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
        labelShown,
        isSelected,
        geom,
        edgeId: edge.edgeId,
        count: edge.count,
        parts: edge.parts,
        lifted: edge.lifted,
        live,
        tone,
        // only a bundle has no referent; clicking it drills toward the real ones
        drillId: edge.edgeId === null ? edge.source : null,
        deltaStatus,
        deltaNotes: marks === null || edge.edgeId === null ? NO_NOTES : (marks.edgeNotes[edge.edgeId] ?? NO_NOTES),
      },
    });
  }

  if (!showReality) return { nodes, edges };

  const stripBox = boxes[STRIP_ID];
  if (stripBox !== undefined && ghosts.nodes.length > 0) {
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
      data: { phase: "reality", caption: ghosts.caption },
    });
  }

  for (const item of ghosts.nodes) {
    const box = boxes[item.id];
    if (box === undefined) continue;
    nodes.push({
      id: item.id,
      type: "ghost",
      position: { x: box.x, y: box.y },
      width: box.w,
      height: box.h,
      measured: { width: box.w, height: box.h },
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      data: { phase: "reality", label: item.label, note: item.note, mono: item.mono, sigil: item.sigil },
    });
  }

  for (const edge of ghosts.edges) {
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
        // a ghost edge has no words to show at all
        labelShown: false,
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
          // a ghost edge is never labelled
          labelMax: 0,
        },
        edgeId: null,
        count: 0,
        lifted: false,
        // extracted code is not where an agent works, so a ghost never flows
        live: "none",
        tone: null,
        parts: [],
        drillId: null,
        // the reality column never appears in a comparison
        deltaStatus: null,
        deltaNotes: NO_NOTES,
      },
    });
  }

  return { nodes, edges };
}
