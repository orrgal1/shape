/**
 * Everything the side panel shows is derived here, from data the store already
 * holds. No new wire messages: the panel is a reading of the graph plus the
 * transcript stream, not another channel.
 */
import {
  PHASES,
  capabilityVerification,
  hostsOf,
  layerOf,
  linkGapsOf,
  realizersOf,
  runsOnOf,
  servesOf,
  verifiedOf,
  verificationOf,
  verifiersOf,
  type GraphDoc,
  type GraphEdge,
  type IntentNode,
  type Layer,
  type LinkGap,
  type Phase,
  type RealitySymbol,
  type RealityVerification,
  type WorktreeInfo,
} from "../../shared/src/index.ts";
import { coveringVerification, symbolsInside } from "./layer.ts";
import { branchOf, toneOf, type TranscriptEntry } from "./store.ts";

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
  /** which layer it lives in, since the two say different things about a bubble */
  layer: Layer;
  working: boolean;
  parent: NeighbourLink | null;
  children: NeighbourLink[];
  relations: RelationLink[];
  /**
   * The cross-layer link, read from whichever end is selected: for a capability,
   * the build bubbles that make it real; for a build bubble, the capabilities it
   * (or one of its ancestors) serves. Only one of the two is ever populated.
   */
  realizers: NeighbourLink[];
  serves: NeighbourLink[];
  /**
   * Where this bubble runs, whichever end is selected: for a build bubble the
   * infrastructure its own `hosts` links name (its ancestors' included); for a
   * capability the same list rolled up through everything that realizes it,
   * because "where does this promise run" is a question about its build side;
   * for a piece of infrastructure, the parts that run on it.
   */
  runsOn: NeighbourLink[];
  /**
   * What attests this bubble, read from whichever end is selected. On a build
   * bubble: the verifications whose `verifies` names it or an ancestor — the
   * authored half. On a verification: the parts it attests, which is the same
   * link read backwards. Only one of the two is ever populated.
   */
  verifiers: NeighbourLink[];
  verifies: NeighbourLink[];
  /**
   * The mechanical half, build bubbles only: extracted verification whose
   * `covers` reaches this bubble's own or an ancestor's code. Nobody wrote these
   * down, so they are not chips to follow — they are evidence, listed with the
   * files they were read from.
   */
  covering: readonly RealityVerification[];
  /**
   * A capability's verification rolled up over its realizers, and — when that
   * is not "verified" — exactly which of them nothing attests, because "partly
   * verified" is only useful if it says which part is missing. "none" means the
   * capability names no build bubble at all, which `unrealized` already covers.
   */
  verification: "verified" | "partial" | "unverified" | "none";
  unverifiedParts: NeighbourLink[];
  /**
   * The mechanical inside of a leaf build bubble: every class and function of
   * its own code that no bubble has claimed, in full. The canvas caps what it
   * draws; the panel is where the whole list belongs.
   */
  inside: readonly RealitySymbol[];
  /**
   * What this bubble should be connected to across the layers and is not, in
   * `linkGapsOf`'s order. The panel spends a row on each one that is not
   * `unrealized`, saying which link would close it — the loud one keeps the
   * block it already has.
   */
  gaps: readonly LinkGap[];
  /** a capability past `concept` with nothing realizing it; read out of `gaps` */
  unrealized: boolean;
  drift: readonly string[];
  lines: TranscriptEntry[];
}

export interface EdgeTldr {
  edge: GraphEdge;
  source: NeighbourLink | null;
  target: NeighbourLink | null;
  /** drift notes on either endpoint — what the code says about the pair */
  drift: { nodeId: string; note: string }[];
  lines: TranscriptEntry[];
}

/** what one bubble says in one variation, for the side panel's "where" section */
export interface WherePlace {
  worktree: string;
  /** what a person calls the variation: its branch */
  branch: string;
  /** colour slot, so the row agrees with the pip on the bubble */
  tone: number;
  /** this variation has the bubble at all */
  present: boolean;
  phase: Phase | null;
  status: string | null;
}

export interface WhereInput {
  /** every variation's canvas, keyed by worktree id */
  graphs: Record<string, GraphDoc>;
  worktrees: readonly WorktreeInfo[];
  /** the variations on the canvas, or null for all of them */
  filter: ReadonlySet<string> | null;
  /** every variation's id in colour order */
  worktreeIds: readonly string[];
  nodeId: string;
}

/**
 * Where one bubble stands, variation by variation — but only when they do not
 * all say the same thing. A canvas merging three branches that agree about a
 * bubble has nothing to report about it: the pips already say it is in all
 * three, and a section repeating "building" three times would be noise. A
 * different phase, a different status, or a variation that does not have the
 * bubble at all is the case this section exists for.
 */
export function nodeWhere({ graphs, worktrees, filter, worktreeIds, nodeId }: WhereInput): WherePlace[] {
  const shown = worktrees.filter((entry) => filter === null || filter.has(entry.id));
  if (shown.length < 2) return [];
  const places: WherePlace[] = [];
  for (const entry of shown) {
    const node = graphs[entry.id]?.nodes.find((item) => item.id === nodeId);
    places.push({
      worktree: entry.id,
      branch: branchOf(worktrees, entry.id),
      tone: toneOf(worktreeIds, entry.id),
      present: node !== undefined,
      phase: node?.phase ?? null,
      status: node?.status ?? null,
    });
  }
  const first = places[0];
  if (first === undefined) return [];
  const agree = places.every(
    (place) => place.present === first.present && place.phase === first.phase && place.status === first.status,
  );
  return agree ? [] : places;
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

  // The cross-layer links are read from the selected end only: a capability
  // lists what makes it real, a build bubble lists what it is part of. Both
  // lists come from the same `realizes` field — there is no second relation to
  // keep in step.
  const layer = layerOf(node);
  const realizers: NeighbourLink[] = [];
  const serves: NeighbourLink[] = [];
  if (layer === "product") {
    for (const id of realizersOf(doc, nodeId)) {
      const built = byId.get(id);
      if (built !== undefined) realizers.push(link(built));
    }
  } else {
    for (const id of servesOf(doc, nodeId)) {
      const capability = byId.get(id);
      if (capability !== undefined) serves.push(link(capability));
    }
  }

  /**
   * Where it runs. A capability owns no code, so it can only answer through the
   * build bubbles that realize it — the same rollup the product layer uses for
   * activity and drift, deduped because two realizers commonly share one host.
   */
  const runsOn: NeighbourLink[] = [];
  const seenHost = new Set<string>();
  const addHost = (infra: IntentNode): void => {
    if (seenHost.has(infra.id)) return;
    seenHost.add(infra.id);
    runsOn.push(link(infra));
  };
  if (layer === "build") {
    for (const infra of runsOnOf(doc, nodeId)) addHost(infra);
  } else if (layer === "product") {
    for (const id of realizersOf(doc, nodeId)) {
      for (const infra of runsOnOf(doc, id)) addHost(infra);
    }
  } else if (layer === "infra") {
    // read from the infrastructure end, "runs on" is "runs": the parts on it
    for (const built of hostsOf(doc, nodeId)) addHost(built);
  }

  // What attests it, read from whichever end is selected — and on a build
  // bubble both halves, because a filled shield the panel could not account for
  // is worse than no shield: the authored verifications, then the extracted
  // ones whose covers reach this bubble's code.
  const verifiers: NeighbourLink[] = [];
  const verifies: NeighbourLink[] = [];
  if (layer === "build") {
    for (const check of verifiersOf(doc, nodeId)) verifiers.push(link(check));
  } else if (layer === "correctness") {
    for (const part of verifiedOf(doc, nodeId)) verifies.push(link(part));
  }

  // A promise is only as attested as the parts keeping it, so a capability that
  // is not fully verified names the parts that are missing: "partly verified"
  // is only useful when it says which part.
  const verification = layer === "product" ? capabilityVerification(doc, nodeId) : "none";
  const unverifiedParts: NeighbourLink[] = [];
  if (verification === "partial" || verification === "unverified") {
    for (const id of realizersOf(doc, nodeId)) {
      const built = byId.get(id);
      if (built !== undefined && verificationOf(doc, id) === "unverified") unverifiedParts.push(link(built));
    }
  }

  // The one reading of "what should this be connected to and is not" — the same
  // call the canvas and the agent's tool receipt make, so all three say the
  // same thing about the same bubble.
  const gaps = linkGapsOf(doc, nodeId);

  return {
    node,
    layer,
    working: activity.has(nodeId),
    parent: parentNode === undefined ? null : link(parentNode),
    children,
    relations,
    realizers,
    serves,
    runsOn,
    verifiers,
    verifies,
    covering: coveringVerification(doc, nodeId),
    verification,
    unverifiedParts,
    inside: symbolsInside(doc, nodeId),
    gaps,
    unrealized: gaps.includes("unrealized"),
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
