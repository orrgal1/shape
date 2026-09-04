/**
 * Single-layer navigation: the canvas shows exactly the children of the focused
 * bubble (top-level bubbles when nothing is focused), and never more than
 * `LAYER_CAP` of them. This is a pure rendering policy over `GraphDoc` — no
 * wire messages, no mutation.
 *
 * One layer only stays readable because of three rollups:
 *  - the fold: a layer wider than the cap keeps its `LAYER_CAP - 1` most
 *    load-bearing bubbles and collapses the tail into a single "N more parts"
 *    bubble, which is drilled into like any other bubble (and folds again if
 *    what it holds is itself wider than the cap);
 *  - edge lifting: a relation touching a hidden descendant — or a folded
 *    sibling — is drawn between the nearest visible bubbles, deduped, with
 *    self-lifts dropped;
 *  - liveness bubbling: activity, drift and failure on anything hidden mark the
 *    visible bubble that stands for it, folded siblings included.
 */
import {
  capabilityVerification,
  emptyGraph,
  hostsOf,
  layerOf,
  linkGapsOf,
  productRootOf,
  realizersOf,
  servesOf,
  symbolRefOf,
  verificationOf,
  verifiedOf,
  type EdgeKind,
  type GraphDoc,
  type GraphEdge,
  type IntentNode,
  type Layer as GraphLayer,
  type LinkGap,
  type NodeKind,
  type Phase,
  type RealityEdge,
  type RealitySymbol,
  type RealityVerification,
} from "../../shared/src/index.ts";
import { canonicalJson, canonicalNode } from "../../shared/src/delta.ts";

/**
 * Which variations hold one merged bubble, and where it is not the same bubble.
 * `differs` is the canonical comparison the snapshot store uses: a reworded
 * promise, a different phase or a different status is a difference; a different
 * key order in the stored JSON is not.
 */
export interface WhereMark {
  worktree: string;
  differs: boolean;
}

export interface MergeInput {
  /** every variation's canvas, keyed by worktree id */
  graphs: Record<string, GraphDoc>;
  /** the variations being read, or null for all of them */
  filter: ReadonlySet<string> | null;
  /** the main worktree's id: its copy of a bubble is the one drawn */
  main: string | null;
}

export interface MergedGraph {
  /** the one document every reading of the canvas is written against */
  doc: GraphDoc;
  /**
   * Per merged node id, the variations that hold it. Edges are merged the same
   * way but carry no marks: a stroke has no room for a pip, and a relation that
   * exists in one variation and not another is already visible as the stroke
   * itself.
   */
  where: Record<string, readonly WhereMark[]>;
}

/** stable empty marks: identity matters, a fresh object would re-render forever */
const NO_WHERE: Record<string, readonly WhereMark[]> = {};

/**
 * One canvas out of every variation's canvas.
 *
 * The variations of a repo are the same project with the same bubbles in it, so
 * they are read as one graph rather than switched between: nodes and edges are
 * unioned by id, and the copy that gets drawn — the primary — is the main
 * worktree's when it has one, else the first filtered variation's in id order.
 * Everything a bubble says (its phase, its promise, its status) therefore comes
 * from one variation, and the pips say where else it lives and where it says
 * something else.
 *
 * `rev`, reality and drift are the primary's alone: a revision number counted
 * across two variations would name no snapshot, and extracted code describes
 * one checkout's HEAD.
 */
export function mergeGraphs({ graphs, filter, main }: MergeInput): MergedGraph {
  const ids = Object.keys(graphs)
    .filter((id) => filter === null || filter.has(id))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  // the main worktree's copy is the primary wherever it sits in id order
  const ordered = main !== null && ids.includes(main) ? [main, ...ids.filter((id) => id !== main)] : ids;
  const primaryId = ordered[0];
  const primary = primaryId === undefined ? undefined : graphs[primaryId];
  if (primary === undefined) return { doc: emptyGraph(), where: NO_WHERE };
  if (ordered.length === 1) {
    // one variation on screen is the whole document: no pips to draw, and no
    // copy of a graph that can be handed to the renderer as it stands
    return { doc: primary, where: NO_WHERE };
  }

  const nodes: IntentNode[] = [];
  const edges: GraphEdge[] = [];
  /** canonical form of the drawn copy, so "differs" is asked once per bubble */
  const canonical = new Map<string, string>();
  const edgeSeen = new Set<string>();
  const where: Record<string, WhereMark[]> = {};

  for (const worktree of ordered) {
    const graph = graphs[worktree];
    if (graph === undefined) continue;
    for (const node of graph.nodes) {
      const drawn = canonical.get(node.id);
      if (drawn === undefined) {
        nodes.push(node);
        canonical.set(node.id, canonicalJson(canonicalNode(node)));
        where[node.id] = [{ worktree, differs: false }];
        continue;
      }
      where[node.id]?.push({ worktree, differs: drawn !== canonicalJson(canonicalNode(node)) });
    }
    for (const edge of graph.edges) {
      if (edgeSeen.has(edge.id)) continue;
      edgeSeen.add(edge.id);
      edges.push(edge);
    }
  }

  return {
    doc: { rev: primary.rev, nodes, edges, reality: primary.reality, drift: primary.drift },
    where,
  };
}

/** guards against a malformed parent chain looping forever */
const MAX_NESTING = 32;

/**
 * How many bubbles one layer may draw. Five is what a reader can hold at once:
 * the real survey of a nine-package project drew nine bubbles and eighteen
 * labelled strokes, which is a diagram nobody reads. Four of the five slots go
 * to real bubbles and the fifth to the fold, so a layer never shows less than
 * it could have without offering the way to the rest.
 */
export const LAYER_CAP = 5;

const MORE_PREFIX = "__more__:";
/** stands in for "no focus" inside a fold id, since the root layer has no bubble */
const ROOT_KEY = "root";

/** the synthetic bubble a fold is drawn as, and the focus id drilling into it sets */
export function isMoreId(id: string): boolean {
  return id.startsWith(MORE_PREFIX);
}

interface MoreRef {
  /** the bubble whose layer folded, or null for the project root layer */
  base: string | null;
  /** 1 for the first fold of that layer, 2 for the fold inside it, and so on */
  depth: number;
}

function parseMoreId(id: string): MoreRef | null {
  if (!isMoreId(id)) return null;
  const rest = id.slice(MORE_PREFIX.length);
  const nested = /^(.*):(\d+)$/.exec(rest);
  const base = nested === null ? rest : (nested[1] ?? "");
  const depth = nested === null ? 1 : Number.parseInt(nested[2] ?? "1", 10);
  return { base: base === ROOT_KEY ? null : base, depth: Math.max(1, depth) };
}

function moreIdOf(base: string | null, depth: number): string {
  const head = `${MORE_PREFIX}${base ?? ROOT_KEY}`;
  return depth <= 1 ? head : `${head}:${depth}`;
}

/**
 * The document bubble a fold id hangs under, or null when it folds the root
 * layer. Only meaningful for an id `isMoreId` accepts — it is what tells a
 * stored focus or selection whether the thing it names can still exist.
 */
export function moreBaseOf(id: string): string | null {
  return parseMoreId(id)?.base ?? null;
}

/**
 * The cross-layer drill: a product bubble's "built by" chip focuses one flat
 * layer of the build bubbles that make that capability real. Like a fold this
 * id is synthetic — the document has never heard of it — but unlike a fold it
 * names a set the parent chain cannot describe, since realizers may sit at any
 * depth and under different parents.
 */
const REALIZES_PREFIX = "__realizes__:";

export function isRealizesId(id: string): boolean {
  return id.startsWith(REALIZES_PREFIX);
}

export function realizesIdOf(productId: string): string {
  return `${REALIZES_PREFIX}${productId}`;
}

/**
 * The product bubble a focus is asking "built by what?" about — through a fold
 * of that layer too, so a stored focus can always be checked against the
 * document the same way a fold's base can.
 */
export function realizesProductOf(focus: string | null): string | null {
  if (focus === null) return null;
  const base = isMoreId(focus) ? moreBaseOf(focus) : focus;
  if (base === null || !isRealizesId(base)) return null;
  const id = base.slice(REALIZES_PREFIX.length);
  return id.length === 0 ? null : id;
}

/**
 * The other cross-layer drill, read from the infrastructure end: an infra
 * bubble's "runs N parts" chip focuses one flat layer of the build bubbles that
 * run on it. Synthetic exactly like `__realizes__:`, and for the same reason —
 * `hosts` names a set no parent chain describes.
 */
const HOSTS_PREFIX = "__hosts__:";

export function isHostsId(id: string): boolean {
  return id.startsWith(HOSTS_PREFIX);
}

export function hostsIdOf(infraId: string): string {
  return `${HOSTS_PREFIX}${infraId}`;
}

/** the infra bubble a focus is asking "what runs on this?" about, folds included */
export function hostsInfraOf(focus: string | null): string | null {
  if (focus === null) return null;
  const base = isMoreId(focus) ? moreBaseOf(focus) : focus;
  if (base === null || !isHostsId(base)) return null;
  const id = base.slice(HOSTS_PREFIX.length);
  return id.length === 0 ? null : id;
}

/**
 * The third cross-layer drill: a verification bubble's "verifies N parts" chip
 * focuses one flat layer of the build bubbles it attests. Synthetic like the
 * other two, and for the same reason — `verifies` names a set no parent chain
 * describes.
 */
const VERIFIES_PREFIX = "__verifies__:";

export function isVerifiesId(id: string): boolean {
  return id.startsWith(VERIFIES_PREFIX);
}

export function verifiesIdOf(verifyId: string): string {
  return `${VERIFIES_PREFIX}${verifyId}`;
}

/** the correctness bubble a focus is asking "what does this attest?" about, folds included */
export function verifiesVerifyOf(focus: string | null): string | null {
  if (focus === null) return null;
  const base = isMoreId(focus) ? moreBaseOf(focus) : focus;
  if (base === null || !isVerifiesId(base)) return null;
  const id = base.slice(VERIFIES_PREFIX.length);
  return id.length === 0 ? null : id;
}

/** one level up from a focus: the parent bubble, or the fold this one nests in */
export function focusParentOf(doc: GraphDoc, focus: string): string | null {
  const more = parseMoreId(focus);
  if (more !== null) return more.depth <= 1 ? more.base : moreIdOf(more.base, more.depth - 1);
  return doc.nodes.find((node) => node.id === focus)?.parentId ?? null;
}

/**
 * Whether the focus is the product itself — the one bubble the whole graph
 * starts from. Nothing sits above it: the product view has no altitude wider
 * than the product, so both ways up (the focus card's ‹ and Backspace) are
 * absent there rather than offered and then doing nothing. False in the build
 * view and on a legacy graph with several top-level capabilities, which has no
 * root and reads flat.
 */
export function isProductRoot(doc: GraphDoc, view: GraphLayer, focus: string | null): boolean {
  if (view !== "product" || focus === null) return false;
  return productRootOf(doc)?.id === focus;
}

/**
 * The lifecycle progression, used to give a fold the phase of the most advanced
 * thing inside it. `failed` sits last on purpose: a fold holding a failure must
 * not read as quietly built.
 */
const PHASE_ORDER: readonly Phase[] = ["idea", "concept", "component", "building", "built", "failed"];

function mostAdvanced(nodes: readonly IntentNode[]): Phase {
  let best: Phase = "idea";
  let rank = -1;
  for (const node of nodes) {
    const at = PHASE_ORDER.indexOf(node.phase);
    if (at > rank) {
      rank = at;
      best = node.phase;
    }
  }
  return best;
}

/**
 * How much of a layer's story a bubble's kind carries, for the last tie-break
 * before document order. The things a reader navigates by come first (a screen,
 * a service, an interface, the place the thing runs), then what they hold (a
 * store, a queue, a database, a cache, an edge cache), then what is either not
 * ours or a warning about one of the above. The pipeline that builds the
 * project sits last: it is true of every part at once, so it is the least
 * useful thing to lead an infra layer with.
 *
 * The correctness kinds are ranked by the same reading. What actually exercises
 * the project comes first — a test suite, a smoke run — then what watches it in
 * production, and last the two that are true of everything at once: a static
 * check over the whole tree and a human pass over the whole release.
 */
const KIND_WEIGHT: Record<NodeKind, number> = {
  ui: 3,
  service: 3,
  api: 3,
  host: 3,
  test: 3,
  smoke: 3,
  store: 2,
  queue: 2,
  database: 2,
  cache: 2,
  cdn: 2,
  monitor: 2,
  external: 1,
  security: 1,
  ci: 1,
  check: 1,
  review: 1,
};

/** a fold's promise is the list of what it holds, cut to a sentence's worth */
const FOLD_SUMMARY_MAX = 160;

function foldSummary(folded: readonly IntentNode[]): string {
  const all = folded.map((node) => node.label).join(", ");
  return all.length <= FOLD_SUMMARY_MAX ? all : `${all.slice(0, FOLD_SUMMARY_MAX - 1).trimEnd()}…`;
}

/** stable empty lists: a fresh array per bubble would churn React Flow's data */
const NO_DRIFT: readonly string[] = [];
const NO_GAPS: readonly LinkGap[] = [];

/**
 * What the shield pip on a bubble says. Three readings and no fourth: a part
 * either has something attesting it or it does not, and a capability can also
 * be attested in part, because it is a rollup over several parts. A bubble with
 * no shield at all (null in `LayerNode`) is a bubble the question is not asked
 * of — a piece of infrastructure, a verification itself, a fold, or a
 * capability nothing builds yet.
 */
export type Shield = "verified" | "partial" | "unverified";

export interface InsideRef {
  id: string;
  label: string;
  status: string | null;
  phase: Phase;
}

export interface LayerNode {
  node: IntentNode;
  /** the synthetic fold bubble, which has no referent and no document identity */
  isMore: boolean;
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
  /**
   * Product bubbles only: how many build bubbles claim to make this capability
   * real. Zero is what the "built by" chip is hidden for — and, past the idea
   * stage, what `unrealized` is about.
   */
  realizerCount: number;
  /** build bubbles only: how many capabilities this bubble (or an ancestor) serves */
  serveCount: number;
  /**
   * Infra bubbles only: how many build bubbles run on this piece of
   * infrastructure. Zero is what the "runs N parts" chip is hidden for — a
   * database nothing admits to using is still a database, so unlike a
   * capability with no realizers this is not drawn as a problem.
   */
  hostCount: number;
  /**
   * Correctness bubbles only: how many build bubbles this verification attests.
   * Zero hides the "verifies N parts" chip — a check that names nothing is
   * still a check, and like a database nobody admits to using that is quiet
   * rather than loud.
   */
  verifyCount: number;
  /**
   * The shield pip, or null where the question is not asked. On a build bubble
   * it is `verificationOf`: something attests this, or nothing does. On a
   * capability it is `capabilityVerification` rolled up over its realizers,
   * where "partial" is the reading only a product layer can have.
   */
  shield: Shield | null;
  /**
   * Build bubbles with no children only: how many top-level classes and
   * functions the code under this bubble's own `codeRefs` holds that no bubble
   * has claimed. This is what gives a leaf a drill affordance at all — what is
   * "inside" it is mechanical rather than authored.
   */
  symbolCount: number;
  /**
   * What this bubble should be connected to across the layers and is not, in
   * `linkGapsOf`'s fixed order (user decision 2026-09-04: connection is the
   * default, so the silence is drawn rather than left to be noticed). The
   * canvas marks these quietly; the side panel says which link closes each one.
   * Empty on a fold, which has no document identity to be connected by.
   */
  gaps: readonly LinkGap[];
  /**
   * A capability the build side does not answer: past `concept`, with nothing
   * realizing it. The one gap loud enough to be its own field — the one thing a
   * product layer can say that a build layer cannot, so it is drawn loudly
   * rather than counted. Read out of `gaps`, never derived a second time.
   */
  unrealized: boolean;
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
  /**
   * Every document relation this line stands for — one id normally, several for
   * a bundle. `parts` is the prose version for a tooltip; this is the machine
   * one, so a renderer can look each relation up (the comparison view marks a
   * line by what happened to the relations inside it).
   */
  edgeIds: string[];
  /** true when the line is drawn between bubbles that are not its real endpoints */
  lifted: boolean;
  /** document relations collapsed into this line; 1 unless it is a bundle */
  count: number;
  /** one line per collapsed relation, for the tooltip */
  parts: string[];
}

export interface Layer {
  /** the focused bubble, the fold being looked inside, or null at the project root */
  focus: IntentNode | null;
  /** root -> focus inclusive, for the breadcrumb */
  trail: IntentNode[];
  nodes: LayerNode[];
  edges: LayerEdge[];
  /** node id -> the visible bubble that represents it (itself, if visible) */
  liftOf: Record<string, string>;
  /** visible bubble id -> label, so a lift target can be named without the document */
  labelOf: Record<string, string>;
  /** the fold bubble on this layer, or null when everything fits */
  moreId: string | null;
  /** the bubbles the fold stands for, in document order */
  folded: string[];
  /** bubbles in this layer of the document, for the header count */
  total: number;
  /**
   * The product bubble this layer was opened to answer for — set only while the
   * focus is a `__realizes__:` drill, where the bubbles on screen are the build
   * side of one capability rather than the children of anything.
   */
  product: IntentNode | null;
  /**
   * The infra bubble this layer was opened to answer for — set only while the
   * focus is a `__hosts__:` drill, where the bubbles on screen are the parts
   * that run on one piece of infrastructure.
   */
  infra: IntentNode | null;
  /**
   * The correctness bubble this layer was opened to answer for — set only while
   * the focus is a `__verifies__:` drill, where the bubbles on screen are the
   * parts one verification attests.
   */
  correctness: IntentNode | null;
  /**
   * The mechanical "inside" of the focused bubble: the classes and functions of
   * its own code, in full and uncapped, when the focus is a build leaf. Empty
   * everywhere else — a bubble with children answers "what is inside" with
   * those children.
   */
  symbols: readonly RealitySymbol[];
  /** relations dropped because an endpoint lives outside the focused subtree */
  offLayer: number;
}

export interface LayerInput {
  doc: GraphDoc;
  focus: string | null;
  activity: ReadonlySet<string>;
  /**
   * Which layer of the document to draw: the four never mix, so this filters
   * before anything else happens. Null draws all of them, which only a
   * comparison asks for — it is a flat reading of what changed, wherever it
   * changed.
   */
  layer: GraphLayer | null;
  /**
   * Whether a layer wider than the cap folds. On by default; the comparison
   * view turns it off, because a comparison is one flat layer of exactly what
   * changed and folding it would hide the very thing it was opened to show.
   */
  fold?: boolean;
}

function kindOf(edges: GraphEdge[]): EdgeKind {
  const first = edges[0];
  if (first === undefined) return "relates";
  return edges.every((edge) => edge.kind === first.kind) ? first.kind : "relates";
}

export function selectLayer({ doc: whole, focus, activity, layer: view, fold = true }: LayerInput): Layer {
  const wholeById = new Map<string, IntentNode>();
  for (const node of whole.nodes) wholeById.set(node.id, node);

  // The three cross-layer drills are the questions asked across the layers:
  // which build bubbles make this capability real, which build bubbles run on
  // this piece of infrastructure, and which build bubbles one verification
  // attests. All three are asked of the whole document and answered inside the
  // build layer, so the bubble being asked about is resolved before the
  // document is narrowed to a layer.
  const askedFor = realizesProductOf(focus);
  const asked = askedFor === null ? undefined : wholeById.get(askedFor);
  const product = asked !== undefined && layerOf(asked) === "product" ? asked : null;

  const askedHost = hostsInfraOf(focus);
  const hosting = askedHost === null ? undefined : wholeById.get(askedHost);
  const infra = hosting !== undefined && layerOf(hosting) === "infra" ? hosting : null;

  const askedVerify = verifiesVerifyOf(focus);
  const attesting = askedVerify === null ? undefined : wholeById.get(askedVerify);
  const correctness = attesting !== undefined && layerOf(attesting) === "correctness" ? attesting : null;

  // One layer at a time. Hierarchy and relations are same-layer by
  // construction, so this single filter is what keeps the product view from
  // ever drawing a build bubble, and the fold, the lifting and the rollups from
  // ever counting one. A comparison passes null: it is a flat reading of what
  // changed, in whichever layer it changed.
  let doc = whole;
  if (view !== null) {
    const scoped = whole.nodes.filter((node) => layerOf(node) === view);
    if (scoped.length !== whole.nodes.length) {
      const kept = new Set(scoped.map((node) => node.id));
      doc = {
        ...whole,
        nodes: scoped,
        edges: whole.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
      };
    }
  }

  let byId = wholeById;
  if (doc !== whole) {
    byId = new Map<string, IntentNode>();
    for (const node of doc.nodes) byId.set(node.id, node);
  }

  /** a parent the agent never created is treated as no parent at all */
  const parentOf = (node: IntentNode): string | null =>
    node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;

  // A focus is either a real bubble, one of the three cross-layer drills, or one
  // of the folds under any of them. A focus whose base is gone addresses
  // nothing, so it falls back to the root layer, the same way a deleted bubble
  // does.
  const more = focus === null ? null : parseMoreId(focus);
  const baseId = more === null ? focus : more.base;
  const realizesBase = baseId !== null && isRealizesId(baseId);
  const hostsBase = baseId !== null && isHostsId(baseId);
  const verifiesBase = baseId !== null && isVerifiesId(baseId);
  const crossBase = realizesBase || hostsBase || verifiesBase;
  const focusNode = baseId === null || crossBase ? null : (byId.get(baseId) ?? null);
  const focusId = focusNode === null ? null : focusNode.id;
  /**
   * The fold namespace of this layer. A cross-layer drill folds under its own
   * synthetic id rather than under the root, so walking out of that fold lands
   * back on the realizers — or the hosted parts, or the attested parts —
   * instead of on the whole build layer.
   */
  const foldBase =
    (realizesBase && product !== null) || (hostsBase && infra !== null) || (verifiesBase && correctness !== null)
      ? baseId
      : focusId;
  const baseAlive = realizesBase
    ? product !== null
    : hostsBase
      ? infra !== null
      : verifiesBase
        ? correctness !== null
        : baseId === null || focusNode !== null;
  const wantedDepth = more === null || !baseAlive ? 0 : more.depth;

  const childCount: Record<string, number> = {};
  for (const node of doc.nodes) {
    const parent = parentOf(node);
    if (parent !== null) childCount[parent] = (childCount[parent] ?? 0) + 1;
  }

  // A capability's realizers, the parts running on one piece of infrastructure
  // and the parts one verification attests are sets, not subtrees: they may sit
  // at any depth and under different parents, which is exactly why these layers
  // are flat.
  const members =
    product !== null
      ? realizersOf(whole, product.id)
          .map((id) => byId.get(id))
          .filter((node): node is IntentNode => node !== undefined)
      : infra !== null
        ? hostsOf(whole, infra.id).filter((node) => byId.has(node.id))
        : correctness !== null
          ? verifiedOf(whole, correctness.id).filter((node) => byId.has(node.id))
          : doc.nodes.filter((node) => parentOf(node) === focusId);

  /**
   * Every node maps to the visible bubble that stands for it, or to nothing when
   * it lives outside the focused subtree. `representative` is what "visible"
   * means for one pass: the layer's own bubbles for the drawn layer, and just a
   * candidate set while the fold is being ranked.
   */
  const liftWith = (representative: (id: string) => string | null): Record<string, string> => {
    const liftOf: Record<string, string> = {};
    const cache = new Map<string, string | null>();
    const lift = (id: string): string | null => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const chain: string[] = [];
      let cursor: IntentNode | undefined = byId.get(id);
      let answer: string | null = null;
      for (let hop = 0; cursor !== undefined && hop <= MAX_NESTING; hop += 1) {
        chain.push(cursor.id);
        const stands = representative(cursor.id);
        if (stands !== null) {
          answer = stands;
          break;
        }
        const parent = parentOf(cursor);
        if (parent === null) break;
        cursor = byId.get(parent);
      }
      for (const step of chain) {
        cache.set(step, answer);
        if (answer !== null) liftOf[step] = answer;
      }
      return answer;
    };
    for (const node of doc.nodes) lift(node.id);
    return liftOf;
  };

  /** group relations by the visible pair they end up drawn between */
  const drawnEdges = (liftOf: Record<string, string>): { edges: LayerEdge[]; offLayer: number } => {
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
          edgeIds: [only.id],
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
        edgeIds: group.edges.map((edge) => edge.id),
        // a bundle is only an approximation of WHERE if something it collapses
        // actually lives further down; two relations between this very pair are
        // drawn exactly where they belong, so they get a solid stroke
        lifted: group.edges.some((edge) => edge.source !== group.source || edge.target !== group.target),
        count: group.edges.length,
        parts,
      });
    }
    return { edges, offLayer };
  };

  /**
   * Which bubbles of an over-wide layer keep their own slot. The order is a
   * claim about what a reader navigates by: a bubble that contains work is a
   * destination, then how much of the layer's wiring runs through it, then what
   * kind of part it is, and document order last so the answer never moves on
   * its own. Degree is measured on the strokes this very set would draw — the
   * lifted, deduped lines, not the raw relations — so a bubble is credited for
   * the wiring the reader can actually see.
   */
  const splitFold = (pool: IntentNode[]): { kept: IntentNode[]; folded: IntentNode[] } => {
    const inPool = new Set(pool.map((node) => node.id));
    const degree: Record<string, number> = {};
    for (const edge of drawnEdges(liftWith((id) => (inPool.has(id) ? id : null))).edges) {
      degree[edge.source] = (degree[edge.source] ?? 0) + 1;
      degree[edge.target] = (degree[edge.target] ?? 0) + 1;
    }

    const weightOf = (node: IntentNode): number => (node.kind === undefined ? 0 : KIND_WEIGHT[node.kind]);
    const ranked = pool.map((node, index) => ({ node, index }));
    ranked.sort((a, b) => {
      const parentA = (childCount[a.node.id] ?? 0) > 0 ? 1 : 0;
      const parentB = (childCount[b.node.id] ?? 0) > 0 ? 1 : 0;
      if (parentA !== parentB) return parentB - parentA;
      const degreeA = degree[a.node.id] ?? 0;
      const degreeB = degree[b.node.id] ?? 0;
      if (degreeA !== degreeB) return degreeB - degreeA;
      const kindA = weightOf(a.node);
      const kindB = weightOf(b.node);
      if (kindA !== kindB) return kindB - kindA;
      return a.index - b.index;
    });

    const kept = new Set(ranked.slice(0, LAYER_CAP - 1).map((entry) => entry.node.id));
    return {
      kept: pool.filter((node) => kept.has(node.id)),
      folded: pool.filter((node) => !kept.has(node.id)),
    };
  };

  // The fold is recursive: drilling into it shows what it held, which folds
  // again if that is still wider than the cap. `depth` is how many folds deep
  // the focus actually is, which is not always what it asked for — the layer
  // may have shrunk since.
  let shown = members;
  let folded: IntentNode[] = [];
  let depth = 0;
  while (fold && shown.length > LAYER_CAP) {
    const split = splitFold(shown);
    if (depth >= wantedDepth) {
      shown = split.kept;
      folded = split.folded;
      break;
    }
    shown = split.folded;
    depth += 1;
  }

  const moreId = folded.length === 0 ? null : moreIdOf(foldBase, depth + 1);
  const moreBubble: IntentNode | null =
    moreId === null
      ? null
      : {
          id: moreId,
          parentId: foldBase,
          label: `${folded.length} more parts`,
          summary: foldSummary(folded),
          phase: mostAdvanced(folded),
        };

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
  // A cross-layer drill has no bubble of its own — it is a question about one in
  // another layer — so it gets a crumb that says what is on screen. The
  // breadcrumb names the bubble it is asking about in front of it, and that
  // crumb is also the way back to it.
  if (product !== null) {
    trail.push({
      id: realizesIdOf(product.id),
      parentId: null,
      label: "built by",
      summary: `the build bubbles that make “${product.label}” real`,
      phase: product.phase,
    });
  }
  // The hosts crumb names the infrastructure outright rather than saying "runs":
  // this layer is read after clicking a chip on that very bubble, and "running
  // on the main database" is the whole sentence a reader needs.
  if (infra !== null) {
    trail.push({
      id: hostsIdOf(infra.id),
      parentId: null,
      label: `running on ${infra.label}`,
      summary: `the parts that run on or use “${infra.label}”`,
      phase: infra.phase,
    });
  }
  // The correctness crumb says who is doing the attesting, in the same voice:
  // this layer is read after clicking a chip on that very verification, and
  // "attested by the capture test suite" is the whole sentence.
  if (correctness !== null) {
    trail.push({
      id: verifiesIdOf(correctness.id),
      parentId: null,
      label: `attested by ${correctness.label}`,
      summary: `the parts “${correctness.label}” attests`,
      phase: correctness.phase,
    });
  }
  // one crumb per fold walked into; only the last one is ever the focus card,
  // so the intermediate crumbs need a label and a hue, nothing more
  const insidePhase = mostAdvanced(shown.length > 0 ? shown : folded);
  const insideName =
    product !== null
      ? `what builds ${product.label}`
      : infra !== null
        ? `what runs on ${infra.label}`
        : correctness !== null
          ? `what ${correctness.label} attests`
          : focusNode === null
            ? "the project"
            : focusNode.label;
  for (let level = 1; level <= depth; level += 1) {
    trail.push({
      id: moreIdOf(foldBase, level),
      parentId: level === 1 ? foldBase : moreIdOf(foldBase, level - 1),
      label: "more parts",
      summary: `the parts folded out of ${insideName} to keep the layer readable`,
      phase: insidePhase,
    });
  }

  const visible = new Set(shown.map((node) => node.id));
  const foldedRoots = new Set(folded.map((node) => node.id));
  const liftOf = liftWith((id) =>
    visible.has(id) ? id : moreId !== null && foldedRoots.has(id) ? moreId : null,
  );

  // rollups, attributed to the visible bubble — the fold included, which is what
  // keeps a pulse, a drift note or a failure inside it from going quiet
  const descendantCount: Record<string, number> = {};
  const activeInside: Record<string, InsideRef[]> = {};
  const driftInside: Record<string, number> = {};
  const failedInside: Record<string, number> = {};

  for (const node of doc.nodes) {
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

  /**
   * A capability has nothing under it in its own layer: what is "inside" it is
   * the build work that makes it real. Activity, drift and failure therefore
   * roll up across the realizes link — a capability reads as live while the
   * agent is anywhere in the code that answers it — which is the whole reason
   * the product layer can be trusted as a place to watch from.
   */
  const realizedSpan = (productId: string): string[] => {
    const span: string[] = [];
    const seen = new Set<string>();
    const stack = realizersOf(whole, productId);
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      span.push(id);
      for (const node of whole.nodes) {
        if (node.parentId === id) stack.push(node.id);
      }
    }
    return span;
  };

  const nodes: LayerNode[] = shown.map((node) => {
    const own = layerOf(node);
    const isProduct = own === "product";
    const realizers = isProduct ? realizersOf(whole, node.id) : [];
    // One reading of "what should this be connected to and is not", shared with
    // the side panel and the agent's tool receipt: `unrealized` below is read
    // out of it rather than worked out a second time here.
    const gaps = linkGapsOf(whole, node.id);
    // "none" is not a verdict — the capability names no build bubble yet — so it
    // is the one rollup that draws no pip at all
    const rollup = isProduct ? capabilityVerification(whole, node.id) : "none";
    const kids = childCount[node.id] ?? 0;
    let activeIn = activeInside[node.id] ?? [];
    let driftIn = driftInside[node.id] ?? 0;
    let failedIn = failedInside[node.id] ?? 0;

    if (realizers.length > 0) {
      const live: InsideRef[] = [];
      for (const id of realizedSpan(node.id)) {
        const built = wholeById.get(id);
        if (built === undefined) continue;
        if (activity.has(id)) {
          live.push({ id, label: built.label, status: built.status ?? null, phase: built.phase });
        }
        driftIn += whole.drift[id]?.length ?? 0;
        if (built.phase === "failed") failedIn += 1;
      }
      if (live.length > 0) activeIn = [...activeIn, ...live];
    }

    return {
      node,
      isMore: false,
      childCount: kids,
      descendantCount: descendantCount[node.id] ?? 0,
      activeSelf: activity.has(node.id),
      activeInside: activeIn,
      driftOwn: doc.drift[node.id] ?? NO_DRIFT,
      driftInside: driftIn,
      failedInside: failedIn,
      realizerCount: realizers.length,
      serveCount: isProduct ? 0 : servesOf(whole, node.id).length,
      hostCount: own === "infra" ? hostsOf(whole, node.id).length : 0,
      verifyCount: own === "correctness" ? verifiedOf(whole, node.id).length : 0,
      // Two ends of the same question and no third: a part says whether
      // anything attests it, a capability says how much of what keeps it is
      // attested. Infrastructure and the verifications themselves are not
      // asked — the ground a project stands on is not a claim about
      // correctness, and a check that checked itself would prove nothing.
      shield: isProduct
        ? rollup === "none"
          ? null
          : rollup
        : own === "build"
          ? verificationOf(whole, node.id)
          : null,
      // only a leaf is ever asked: a bubble with children already answers
      // "what is inside" with bubbles somebody wrote on purpose
      symbolCount: own === "build" && kids === 0 ? symbolsInside(whole, node.id).length : 0,
      gaps: gaps.length === 0 ? NO_GAPS : gaps,
      unrealized: gaps.includes("unrealized"),
    };
  });
  if (moreBubble !== null) {
    nodes.push({
      node: moreBubble,
      isMore: true,
      // what drilling in reveals: the folded bubbles themselves
      childCount: folded.length,
      descendantCount: descendantCount[moreBubble.id] ?? folded.length,
      // a fold is not a place work happens, only a place work can be inside
      activeSelf: false,
      activeInside: activeInside[moreBubble.id] ?? [],
      driftOwn: NO_DRIFT,
      driftInside: driftInside[moreBubble.id] ?? 0,
      failedInside: failedInside[moreBubble.id] ?? 0,
      realizerCount: 0,
      serveCount: 0,
      hostCount: 0,
      verifyCount: 0,
      // the fold stands for a mixed bag; one shield over several answers would
      // be a claim about none of them
      shield: null,
      symbolCount: 0,
      // a fold has no document identity, so nothing across the layers could
      // have been pointed at it in the first place
      gaps: NO_GAPS,
      unrealized: false,
    });
  }

  const labelOf: Record<string, string> = {};
  for (const entry of nodes) labelOf[entry.node.id] = entry.node.label;

  const drawn = drawnEdges(liftOf);
  const focusEntry = trail.length === 0 ? null : (trail[trail.length - 1] ?? null);

  return {
    focus: focusEntry,
    trail,
    nodes,
    edges: drawn.edges,
    liftOf,
    labelOf,
    moreId,
    folded: folded.map((node) => node.id),
    total: doc.nodes.length,
    product,
    infra,
    correctness,
    // the mechanical inside of a leaf, which is what the ghost bubbles on an
    // otherwise empty layer are drawn from
    symbols:
      focusNode !== null && layerOf(focusNode) === "build" && (childCount[focusNode.id] ?? 0) === 0
        ? symbolsInside(whole, focusNode.id)
        : NO_SYMBOLS,
    offLayer: drawn.offLayer,
  };
}

/**
 * What a `codeRefs` entry claims a piece of ground: the path, with a symbol
 * name dropped. `packages/store/src/room.ts#Room` claims that file — and
 * therefore the package around it — as surely as `packages/store` does, so a
 * bubble that only ever names symbols still claims its package's ghost.
 */
function refPrefix(ref: string): string {
  const symbol = symbolRefOf(ref);
  return (symbol === null ? ref : symbol.path).replace(/^\.\//, "").replace(/\/+$/, "");
}

/** the prefix rule the bridge attributes activity with (bridge/src/index.ts) */
function covered(prefixes: readonly string[], path: string): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** every path any bubble of the given layers claims, symbol refs included */
function claimedPrefixes(doc: GraphDoc, layers: readonly GraphLayer[]): string[] {
  const prefixes: string[] = [];
  for (const node of doc.nodes) {
    if (!layers.includes(layerOf(node))) continue;
    for (const ref of node.codeRefs ?? []) {
      const prefix = refPrefix(ref);
      if (prefix.length > 0) prefixes.push(prefix);
    }
  }
  return prefixes;
}

/** stable empty listing: a fresh array per call would re-run layout forever */
const NO_SYMBOLS: readonly RealitySymbol[] = [];

/**
 * The mechanical "inside" of a leaf build bubble: the top-level classes and
 * functions of the files its OWN `codeRefs` cover, exported first.
 *
 * This is the depth the canvas never asks an agent to write down. A part that
 * has been decomposed answers "what is inside" with the bubbles somebody wrote;
 * a leaf has no such answer, and the code does — so the code answers, quietly,
 * as ghosts. A symbol some bubble already names with a `file#Name` ref is left
 * out: it has a card of its own, and listing it twice would make the authored
 * bubble look like a duplicate of a mechanical one.
 */
export function symbolsInside(doc: GraphDoc, nodeId: string): readonly RealitySymbol[] {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || layerOf(node) !== "build") return NO_SYMBOLS;
  if (doc.nodes.some((other) => other.parentId === nodeId)) return NO_SYMBOLS;

  const prefixes: string[] = [];
  for (const ref of node.codeRefs ?? []) {
    const prefix = refPrefix(ref);
    if (prefix.length > 0) prefixes.push(prefix);
  }
  if (prefixes.length === 0) return NO_SYMBOLS;

  const claimed = new Set<string>();
  for (const other of doc.nodes) {
    for (const ref of other.codeRefs ?? []) {
      const symbol = symbolRefOf(ref);
      if (symbol !== null) claimed.add(`${symbol.path}#${symbol.name}`);
    }
  }

  const inside = doc.reality.symbols.filter(
    (symbol) => covered(prefixes, symbol.file) && !claimed.has(`${symbol.file}#${symbol.name}`),
  );
  if (inside.length === 0) return NO_SYMBOLS;
  // what the module means to the outside comes first; within one file, source
  // order, which is the order a reader of that file would meet them in
  return inside.sort((a, b) => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.line - b.line;
  });
}

/** stable empty listing, for the same reason `NO_SYMBOLS` is one */
const NO_VERIFICATION: readonly RealityVerification[] = [];

/**
 * The mechanical half of "what attests this part": extracted verification whose
 * `covers` reaches the bubble's own or an ancestor's `codeRefs`. This is the
 * evidence behind a filled shield that no `verifies` link explains, so the side
 * panel can name it instead of leaving the reader to wonder.
 *
 * `verificationOf` in shared is the definition of "reaches" and answers
 * yes-or-no; this returns the items themselves under the identical rule — the
 * prefix compared in BOTH directions, because a cover and a `codeRefs` entry
 * are written at whatever altitude their author found natural.
 */
export function coveringVerification(doc: GraphDoc, nodeId: string): readonly RealityVerification[] {
  const byId = new Map<string, IntentNode>();
  for (const node of doc.nodes) byId.set(node.id, node);
  const start = byId.get(nodeId);
  if (start === undefined || layerOf(start) !== "build") return NO_VERIFICATION;

  const refs: string[] = [];
  for (let cursor: IntentNode | undefined = start, hop = 0; cursor !== undefined && hop <= MAX_NESTING; hop += 1) {
    for (const ref of cursor.codeRefs ?? []) {
      const prefix = refPrefix(ref);
      if (prefix.length > 0) refs.push(prefix);
    }
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  if (refs.length === 0) return NO_VERIFICATION;

  const found = doc.reality.verification.filter((item) =>
    item.covers.some((cover) =>
      refs.some((ref) => cover === ref || cover.startsWith(`${ref}/`) || ref.startsWith(`${cover}/`)),
    ),
  );
  return found.length === 0 ? NO_VERIFICATION : found;
}

/** a class or a function, else one of the node kinds */
export type GhostSigil = NodeKind | RealitySymbol["kind"];

/** one card in the ghost column: a label, a second line, and no interaction */
export interface GhostItem {
  id: string;
  label: string;
  /** the dim second line: a directory, a file, or one plain-English sentence */
  note: string;
  /** true when the note is a path and should be set in mono */
  mono: boolean;
  sigil: GhostSigil | null;
}

/**
 * The column of code-derived cards beside the authored layer, and what heads it.
 *
 * Four readings share one column because they make one claim in four places:
 * here is something the code contains that the canvas has not accounted for.
 * In the build view those are packages no bubble claims; in the infra view,
 * infrastructure no infra bubble claims; in the correctness view, verification
 * no correctness bubble claims; drilled into a leaf, the classes and functions
 * inside it, which nothing on the canvas was ever going to name.
 */
export interface GhostColumn {
  /** the caption above the column, or null when there is nothing to head */
  caption: string;
  nodes: GhostItem[];
  /** the extracted import graph, drawn only for the package reading */
  edges: readonly RealityEdge[];
}

const NO_GHOST_EDGES: readonly RealityEdge[] = [];
const EMPTY_COLUMN: GhostColumn = { caption: "", nodes: [], edges: NO_GHOST_EDGES };

export interface GhostInput {
  doc: GraphDoc;
  /** which reading is on the canvas; the product layer has no code column */
  view: GraphLayer | null;
  /** the drilled-into bubble, which is what turns the column into a listing */
  focus: string | null;
}

/**
 * A ghost's whole job is to say "this exists in the code and nothing on the
 * canvas admits it". Once a bubble names the package in its `codeRefs` the
 * ghost has nothing left to say: the bubble is already on screen, and whatever
 * disagrees between the two is the drift glow's story, not a second card's.
 * Ghosting claimed packages anyway is what made the band eat half the width of
 * a nine-package project and squeeze the bubbles it was meant to annotate.
 *
 * Depth is deliberately ignored for a claim: a hidden child's `codeRefs` claim
 * just as well, because its drift bubbles up to the bubble on screen. The
 * symbol listing is the one reading that is not about a claim at all — it is
 * the inside of the bubble you are standing in — so it wins wherever it exists.
 */
export function selectGhosts({ doc, view, focus }: GhostInput): GhostColumn {
  if (view === null || view === "product") return EMPTY_COLUMN;

  if (view === "build" && focus !== null) {
    const symbols = symbolsInside(doc, focus);
    if (symbols.length > 0) {
      return {
        caption: "inside — read from the code",
        nodes: foldGhosts(
          symbols.map((symbol) => ({
            id: symbol.id,
            label: symbol.name,
            note: `${symbol.file}:${symbol.line}`,
            mono: true,
            sigil: symbol.kind,
          })),
          "more inside",
        ),
        edges: NO_GHOST_EDGES,
      };
    }
  }

  if (view === "infra") {
    // a reality infra item is claimed once some infra bubble's codeRefs cover
    // one of the config files it was read from — the same prefix rule again
    const prefixes = claimedPrefixes(doc, ["infra"]);
    const unclaimed = doc.reality.infra.filter((item) => !item.evidence.some((file) => covered(prefixes, file)));
    if (unclaimed.length === 0) return EMPTY_COLUMN;
    return {
      caption: "found in the configuration",
      nodes: foldGhosts(
        unclaimed.map((item) => ({
          id: item.id,
          label: item.label,
          note: item.hint,
          mono: false,
          sigil: item.kind,
        })),
        "more found",
      ),
      edges: NO_GHOST_EDGES,
    };
  }

  if (view === "correctness") {
    // and a reality verification is claimed once some correctness bubble's
    // codeRefs cover one of the files it was read from. Note this is the claim
    // rule, not the cover rule: `covers` says what a verification exercises,
    // `evidence` says where it lives, and a bubble claims the thing by pointing
    // at where it lives — the same sentence the infra column just said.
    const prefixes = claimedPrefixes(doc, ["correctness"]);
    const unclaimed = doc.reality.verification.filter(
      (item) => !item.evidence.some((file) => covered(prefixes, file)),
    );
    if (unclaimed.length === 0) return EMPTY_COLUMN;
    return {
      caption: "found in the code",
      nodes: foldGhosts(
        unclaimed.map((item) => ({
          id: item.id,
          label: item.label,
          note: item.hint,
          mono: false,
          sigil: item.kind,
        })),
        "more found",
      ),
      edges: NO_GHOST_EDGES,
    };
  }

  const prefixes = claimedPrefixes(doc, ["product", "build", "infra", "correctness"]);
  const unclaimed = doc.reality.nodes.filter((node) => !covered(prefixes, node.dir));
  if (unclaimed.length === 0) return EMPTY_COLUMN;
  const kept = new Set(unclaimed.map((node) => node.id));
  const head = doc.reality.head;
  return {
    caption: head === null ? "reality — extracted from code" : `reality — extracted at ${head}`,
    nodes: unclaimed.map((node) => ({ id: node.id, label: node.label, note: node.dir, mono: true, sigil: null })),
    // the import graph is only true of packages, and only of the ones still drawn
    edges: doc.reality.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
  };
}

/** the fold bubble's id, reused for the ghost column's own overflow card */
const GHOST_MORE_ID = "ghost:more";

/**
 * The ghost column obeys the layer cap for the same reason the layer does: a
 * column of thirty cards is not a reading of anything. The overflow card is
 * inert rather than drillable — there is no layer under a ghost — and the full
 * list is one click away in the side panel, which is where a reader who wants
 * all thirty names is actually going.
 */
function foldGhosts(items: GhostItem[], word: string): GhostItem[] {
  if (items.length <= LAYER_CAP) return items;
  const kept = items.slice(0, LAYER_CAP - 1);
  kept.push({
    id: GHOST_MORE_ID,
    label: `${items.length - kept.length} ${word}`,
    note: "listed in the panel",
    mono: false,
    sigil: null,
  });
  return kept;
}
