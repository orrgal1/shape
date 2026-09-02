import ELK, { type ElkNode, type LayoutOptions } from "elkjs/lib/elk.bundled.js";
import type { RealityLayer } from "../../shared/src/index.ts";
import type { Layer } from "./layer.ts";
import { routingCost } from "./canvas/geometry.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * id -> box in absolute canvas coordinates. Holds bubbles, reality ghosts, the
 * reality caption and the reality ghosts.
 */
export type BoxMap = Record<string, Box>;

/** synthetic node id for the caption that heads the reality column */
export const STRIP_ID = "strip:reality";

const NODE_W = 236;
const NODE_H = 98;
const GHOST_W = 178;
const GHOST_H = 54;
const STRIP_GAP = 150;
const STRIP_CAPTION_H = 20;
const STRIP_CAPTION_W = 300;

const elk = new ELK();

/**
 * A flat layered DAG, top-down, over one layer of the decomposition.
 *
 * Because the canvas only ever draws siblings, there is no containment and no
 * hierarchy edge to route: every edge here is a relation (or a bundle of lifted
 * relations), and `nodeNodeBetweenLayers` doubles as the minimum edge length.
 */
const ROOT_OPTIONS: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "104",
  "elk.spacing.nodeNode": "52",
  "elk.spacing.edgeNode": "34",
  "elk.spacing.edgeEdge": "22",
  "elk.layered.spacing.edgeNodeBetweenLayers": "36",
  "elk.layered.spacing.edgeEdgeBetweenLayers": "22",
  // labels are declared with real sizes below, so elk reserves space for them
  // and hands back collision-free positions instead of us guessing a midpoint
  "elk.edgeLabels.placement": "CENTER",
  "elk.spacing.edgeLabel": "12",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
};

const STRIP_OPTIONS: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "54",
  "elk.spacing.nodeNode": "22",
};

export interface LayoutInput {
  layer: Layer;
  reality: RealityLayer;
  /** canvas width / height, quantised; spread arrangements use both axes */
  aspect: number;
}

/** air left between bubbles in the arrangements this module places by hand */
const SPREAD_GAP = 96;

export type Arrangement = "flow" | "layered" | "spread" | "grid";

/**
 * Longest directed path, in nodes, over the relations that imply a direction.
 * A layer whose relations form a real chain reads better as a column; a sparse
 * sibling set does not, and elk layered turns it into one anyway.
 */
function longestChain(layer: Layer): number {
  const next = new Map<string, string[]>();
  const ids = layer.nodes.map((entry) => entry.node.id);
  for (const edge of layer.edges) {
    if (edge.kind === "relates") continue;
    const list = next.get(edge.source);
    if (list === undefined) next.set(edge.source, [edge.target]);
    else list.push(edge.target);
  }
  const depth = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 1;
    seen.add(id);
    let best = 1;
    for (const target of next.get(id) ?? []) best = Math.max(best, 1 + walk(target, seen));
    seen.delete(id);
    depth.set(id, best);
    return best;
  };
  let longest = 0;
  for (const id of ids) longest = Math.max(longest, walk(id, new Set<string>()));
  return longest;
}

/** a layer this big with at least one relation per bubble is a graph, not a set */
const FLOW_MIN_NODES = 6;
const FLOW_MIN_DENSITY = 1;

/**
 * The single-layer view produces small sibling sets, so the algorithm is chosen
 * per layer rather than fixed — and by the shape of the relations, not just by
 * how many bubbles there are.
 *
 * Three or fewer bubbles are always spread: elk layered renders a three-node
 * chain as a strict vertical column, which wastes the width, stacks the two
 * relations on top of each other and routes one of them straight through the
 * middle bubble. A triangle has none of those problems.
 *
 * A big, densely related layer is the opposite case: the nine packages of a
 * real monorepo with eighteen relations between them. Placed on a grid, which
 * is what a count-only rule chose, the strokes have to find their own way
 * through the rows and the longest ran 3173px to cross a 1100px composition.
 * Handing that layer to elk layered costs the ring's symmetry and buys short
 * strokes, which is the better trade once there are more relations than
 * bubbles. Below that density the relations are sparse enough that a chain, an
 * ellipse or a grid still reads.
 */
export function chooseArrangement(layer: Layer, chain = longestChain(layer)): Arrangement {
  const n = layer.nodes.length;
  if (n <= 3) return "spread";
  if (n >= FLOW_MIN_NODES && layer.edges.length >= n * FLOW_MIN_DENSITY) return "flow";
  if (chain >= Math.max(3, Math.ceil(n * 0.5))) return "layered";
  return n <= 6 ? "spread" : "grid";
}

/** rank by distance from a source, so an arrangement still reads in flow order */
function rankOrder(layer: Layer): string[] {
  const incoming = new Map<string, number>();
  for (const entry of layer.nodes) incoming.set(entry.node.id, 0);
  for (const edge of layer.edges) {
    if (edge.kind === "relates") continue;
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  return layer.nodes
    .map((entry) => entry.node.id)
    .sort((a, b) => (incoming.get(a) ?? 0) - (incoming.get(b) ?? 0));
}

/**
 * Bubbles on an ellipse whose radii follow the viewport, so a wide window gets a
 * wide triangle and a tall one gets a tall triangle. The radius is derived from
 * the bubble size and the count, which is what keeps them from touching.
 */
function spreadLayout(layer: Layer, aspect: number): BoxMap {
  const ids = rankOrder(layer);
  const n = ids.length;
  const boxes: BoxMap = {};
  const put = (id: string, cx: number, cy: number): void => {
    boxes[id] = { x: cx - NODE_W / 2, y: cy - NODE_H / 2, w: NODE_W, h: NODE_H };
  };

  const first = ids[0];
  if (n === 0 || first === undefined) return boxes;
  if (n === 1) {
    put(first, 0, 0);
    return boxes;
  }

  const stretch = Math.sqrt(Math.max(0.45, Math.min(2.2, aspect)));
  if (n === 2) {
    const second = ids[1];
    if (second === undefined) return boxes;
    // side by side when there is width for it, stacked when the window is tall
    if (aspect >= 1) {
      const half = (NODE_W + SPREAD_GAP) / 2;
      put(first, -half, 0);
      put(second, half, 0);
    } else {
      const half = (NODE_H + SPREAD_GAP) / 2;
      put(first, 0, -half);
      put(second, 0, half);
    }
    return boxes;
  }

  const radius = Math.max(NODE_W * 0.8, (NODE_W + SPREAD_GAP) / (2 * Math.sin(Math.PI / n)));
  const rx = radius * stretch;
  const ry = Math.max(NODE_H * 1.1, radius / stretch);

  if (n === 3) {
    // an explicit triangle rather than a third of a circle: the ranked bubble
    // sits on top and the other two open out beneath it
    const second = ids[1];
    const third = ids[2];
    if (second === undefined || third === undefined) return boxes;
    put(first, 0, -ry);
    put(second, -rx, ry * 0.62);
    put(third, rx, ry * 0.62);
    return boxes;
  }

  for (const [index, id] of ids.entries()) {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
    put(id, Math.cos(angle) * rx, Math.sin(angle) * ry);
  }
  return boxes;
}

/** rows and columns proportioned to the viewport; deterministic and never overlapping */
function gridLayout(layer: Layer, aspect: number): BoxMap {
  const ids = rankOrder(layer);
  const n = ids.length;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * Math.max(0.4, aspect)))));
  const cellW = NODE_W + SPREAD_GAP;
  const cellH = NODE_H + SPREAD_GAP;
  const boxes: BoxMap = {};
  for (const [index, id] of ids.entries()) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    boxes[id] = { x: col * cellW, y: row * cellH, w: NODE_W, h: NODE_H };
  }
  return boxes;
}

function boxesOf(laid: ElkNode): BoxMap {
  const boxes: BoxMap = {};
  for (const node of laid.children ?? []) {
    boxes[node.id] = {
      x: node.x ?? 0,
      y: node.y ?? 0,
      w: node.width ?? NODE_W,
      h: node.height ?? NODE_H,
    };
  }
  return boxes;
}

async function layeredLayout(layer: Layer): Promise<BoxMap> {
  // `relates` is an association, not a flow. Letting it assign layers
  // nearly doubles the height of the fixture (1174px -> 2020px, fit zoom
  // 0.54 -> 0.31, which drops every bubble to the label-only tier), so it
  // is routed after the fact instead.
  const graph: ElkNode = {
    id: "root",
    layoutOptions: ROOT_OPTIONS,
    children: layer.nodes.map((entry) => ({ id: entry.node.id, width: NODE_W, height: NODE_H })),
    // no labels are declared: strokes and labels are placed together from
    // the final boxes in canvas/geometry.ts, so that elk cannot put a label
    // somewhere the curve it belongs to never goes
    edges: layer.edges
      .filter((edge) => edge.kind !== "relates")
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
  return boxesOf(await elk.layout(graph));
}

/**
 * elk is asked for one arrangement per candidate; these are the knobs that
 * change the answer materially on a dense layer.
 *
 * `direction` decides which axis the layers stack on. Bubbles are two and a
 * half times wider than they are tall, so which axis yields the wide
 * composition a wide window wants is not obvious from the node count — it
 * depends on how many layers there are and how full the widest one is.
 *
 * `alignment` decides where a layer's nodes sit within it, and `layering` how
 * many layers there are at all: `NETWORK_SIMPLEX` minimises total edge span,
 * `LONGEST_PATH` pushes every node as late as it can, which packs the sinks
 * together and is sometimes the shorter-stroked of the two. Neither wins in
 * general, which is why they are measured rather than chosen.
 */
interface FlowCandidate {
  direction: "DOWN" | "RIGHT";
  alignment: "BALANCED" | "RIGHTDOWN";
  layering: "NETWORK_SIMPLEX" | "LONGEST_PATH";
}

const FLOW_CANDIDATES: readonly FlowCandidate[] = [
  { direction: "DOWN", alignment: "BALANCED", layering: "NETWORK_SIMPLEX" },
  { direction: "DOWN", alignment: "RIGHTDOWN", layering: "LONGEST_PATH" },
  { direction: "RIGHT", alignment: "BALANCED", layering: "NETWORK_SIMPLEX" },
  { direction: "RIGHT", alignment: "RIGHTDOWN", layering: "LONGEST_PATH" },
];

/**
 * The gap between layers doubles as the minimum length of every stroke that
 * crosses it, so it is the number that decides how long the edges are. The edge
 * spacings are the opposite: elk reserves a lane per stroke in every gap it
 * crosses, which on a dense layer inflates the composition by hundreds of
 * pixels for routes nothing here uses — `canvas/geometry.ts` routes the strokes
 * itself, and it needs the bubbles close, not the lanes reserved.
 */
const FLOW_BETWEEN_LAYERS = 72;
const FLOW_GAP = 104;
const FLOW_EDGE_SPACING = 4;

function flowOptions({ direction, alignment, layering }: FlowCandidate): LayoutOptions {
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.layered.layering.strategy": layering,
    // straightens long edges, so the corridor elk keeps free for a stroke that
    // spans several layers stays close to that stroke's own chord
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": alignment,
    // a crossing costs pixels here, because the crossed stroke has to bow
    // around whatever it crossed; one layer is small enough to pay for passes
    "elk.layered.thoroughness": "24",
    "elk.layered.spacing.nodeNodeBetweenLayers": String(FLOW_BETWEEN_LAYERS),
    "elk.spacing.nodeNode": String(FLOW_GAP),
    "elk.spacing.edgeNode": String(FLOW_EDGE_SPACING),
    "elk.spacing.edgeEdge": String(FLOW_EDGE_SPACING),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(FLOW_EDGE_SPACING),
    "elk.layered.spacing.edgeEdgeBetweenLayers": String(FLOW_EDGE_SPACING),
  };
}

/**
 * elk layered for a layer whose relations carry the meaning.
 *
 * A dense layer has no single right layering, and the wrong one is what the
 * grid was: strokes 3000px long across a 1200px composition. So the candidates
 * are laid out and then *measured* on the thing that went wrong — the strokes
 * `canvas/geometry.ts` will actually draw through the boxes elk chose. Nine
 * nodes and eighteen relations cost elk a couple of milliseconds per candidate
 * and the routing pass about the same, and this runs once per layer change, not
 * per frame.
 *
 * The verdict is the length of the longest stroke *as the reader will see it*:
 * canvas pixels scaled by the zoom the framing pass will settle on for that
 * candidate's bounding box. That single number is what makes the choice of axis
 * follow the window's shape — a composition shaped like the pane is zoomed in
 * further, so its strokes read shorter — without trading away a layering whose
 * strokes are genuinely tighter. An arrangement whose strokes cannot clear the
 * bubbles they pass loses to any that can, whatever its lengths.
 */
async function flowLayout(layer: Layer, aspect: number): Promise<BoxMap> {
  // Every stroke on screen is handed to elk here, `relates` included: a layer
  // this dense has no slack for a relation the layering never heard about, and
  // an unplanned stroke is precisely the one that ends up looping around the
  // whole composition to find a way through.
  const edges = layer.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }));
  const runs = await Promise.all(
    FLOW_CANDIDATES.map((candidate) =>
      elk.layout({
        id: `root-${candidate.direction}-${candidate.layering}`,
        layoutOptions: flowOptions(candidate),
        children: layer.nodes.map((entry) => ({ id: entry.node.id, width: NODE_W, height: NODE_H })),
        edges: edges.map((edge) => ({ ...edge })),
      }),
    ),
  );

  // pane in arbitrary units: only the ratio between candidates matters
  const paneW = Math.max(0.3, Math.min(3, aspect));
  let best: BoxMap = {};
  let bestCost = Number.POSITIVE_INFINITY;
  let bestStrikes = Number.POSITIVE_INFINITY;
  for (const laid of runs) {
    const boxes = boxesOf(laid);
    let width = 0;
    let height = 0;
    for (const box of Object.values(boxes)) {
      width = Math.max(width, box.x + box.w);
      height = Math.max(height, box.y + box.h);
    }
    if (width === 0 || height === 0) continue;

    const obstacles = layer.nodes
      .map((entry) => ({ id: entry.node.id, box: boxes[entry.node.id] }))
      .filter((entry): entry is { id: string; box: Box } => entry.box !== undefined);
    const cost = routingCost({ edges: layer.edges, boxes, obstacles });
    const zoom = Math.min(paneW / width, 1 / height);
    const seen = cost.longest * zoom;

    if (cost.strikes > bestStrikes) continue;
    if (cost.strikes === bestStrikes && seen >= bestCost) continue;
    bestStrikes = cost.strikes;
    bestCost = seen;
    best = boxes;
  }
  return best;
}

export async function computeLayout({ layer, reality, aspect }: LayoutInput): Promise<BoxMap> {
  let boxes: BoxMap = {};

  if (layer.nodes.length > 0) {
    const arrangement = chooseArrangement(layer);
    if (arrangement === "spread") boxes = spreadLayout(layer, aspect);
    else if (arrangement === "grid") boxes = gridLayout(layer, aspect);
    else if (arrangement === "flow") boxes = await flowLayout(layer, aspect);
    else boxes = await layeredLayout(layer);
  }

  if (reality.nodes.length === 0) return boxes;

  let intentRight = 0;
  let intentTop = Number.POSITIVE_INFINITY;
  for (const entry of layer.nodes) {
    const box = boxes[entry.node.id];
    if (box === undefined) continue;
    intentRight = Math.max(intentRight, box.x + box.w);
    intentTop = Math.min(intentTop, box.y);
  }
  if (!Number.isFinite(intentTop)) intentTop = 0;

  const stripGraph: ElkNode = {
    id: "reality",
    layoutOptions: STRIP_OPTIONS,
    children: reality.nodes.map((node) => ({ id: node.id, width: GHOST_W, height: GHOST_H })),
    edges: reality.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  };
  const laidStrip = await elk.layout(stripGraph);

  const originX = intentRight + STRIP_GAP;
  boxes[STRIP_ID] = { x: originX, y: intentTop - 44, w: STRIP_CAPTION_W, h: STRIP_CAPTION_H };
  for (const node of laidStrip.children ?? []) {
    boxes[node.id] = {
      x: originX + (node.x ?? 0),
      y: intentTop + (node.y ?? 0),
      w: node.width ?? GHOST_W,
      h: node.height ?? GHOST_H,
    };
  }

  return boxes;
}
