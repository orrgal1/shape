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
import type {
  EdgeKind,
  GraphDoc,
  GraphEdge,
  IntentNode,
  NodeKind,
  Phase,
  RealityLayer,
} from "../../shared/src/index.ts";

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

/** one level up from a focus: the parent bubble, or the fold this one nests in */
export function focusParentOf(doc: GraphDoc, focus: string): string | null {
  const more = parseMoreId(focus);
  if (more !== null) return more.depth <= 1 ? more.base : moreIdOf(more.base, more.depth - 1);
  return doc.nodes.find((node) => node.id === focus)?.parentId ?? null;
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
 * a service, an interface), then what they hold (a store, a queue), then what
 * is either not ours or a warning about one of the above.
 */
const KIND_WEIGHT: Record<NodeKind, number> = {
  ui: 3,
  service: 3,
  api: 3,
  store: 2,
  queue: 2,
  external: 1,
  security: 1,
};

/** a fold's promise is the list of what it holds, cut to a sentence's worth */
const FOLD_SUMMARY_MAX = 160;

function foldSummary(folded: readonly IntentNode[]): string {
  const all = folded.map((node) => node.label).join(", ");
  return all.length <= FOLD_SUMMARY_MAX ? all : `${all.slice(0, FOLD_SUMMARY_MAX - 1).trimEnd()}…`;
}

/** stable empty list: a fresh array per bubble would churn React Flow's data */
const NO_DRIFT: readonly string[] = [];

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
  /** bubbles in the whole document, for the header count */
  total: number;
  /** relations dropped because an endpoint lives outside the focused subtree */
  offLayer: number;
}

export interface LayerInput {
  doc: GraphDoc;
  focus: string | null;
  activity: ReadonlySet<string>;
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

export function selectLayer({ doc, focus, activity, fold = true }: LayerInput): Layer {
  const byId = new Map<string, IntentNode>();
  for (const node of doc.nodes) byId.set(node.id, node);

  /** a parent the agent never created is treated as no parent at all */
  const parentOf = (node: IntentNode): string | null =>
    node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;

  // A focus is either a real bubble or one of the folds under it. A fold whose
  // base bubble is gone addresses nothing, so it falls back to the root layer,
  // the same way a deleted bubble does.
  const more = focus === null ? null : parseMoreId(focus);
  const baseId = more === null ? focus : more.base;
  const focusNode = baseId === null ? null : (byId.get(baseId) ?? null);
  const focusId = focusNode === null ? null : focusNode.id;
  const wantedDepth = more === null || (more.base !== null && focusNode === null) ? 0 : more.depth;

  const childCount: Record<string, number> = {};
  for (const node of doc.nodes) {
    const parent = parentOf(node);
    if (parent !== null) childCount[parent] = (childCount[parent] ?? 0) + 1;
  }

  const members = doc.nodes.filter((node) => parentOf(node) === focusId);

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

  const moreId = folded.length === 0 ? null : moreIdOf(focusId, depth + 1);
  const moreBubble: IntentNode | null =
    moreId === null
      ? null
      : {
          id: moreId,
          parentId: focusId,
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
  // one crumb per fold walked into; only the last one is ever the focus card,
  // so the intermediate crumbs need a label and a hue, nothing more
  const insidePhase = mostAdvanced(shown.length > 0 ? shown : folded);
  for (let level = 1; level <= depth; level += 1) {
    trail.push({
      id: moreIdOf(focusId, level),
      parentId: level === 1 ? focusId : moreIdOf(focusId, level - 1),
      label: "more parts",
      summary: `the parts folded out of ${focusNode === null ? "the project" : focusNode.label} to keep the layer readable`,
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

  const nodes: LayerNode[] = shown.map((node) => ({
    node,
    isMore: false,
    childCount: childCount[node.id] ?? 0,
    descendantCount: descendantCount[node.id] ?? 0,
    activeSelf: activity.has(node.id),
    activeInside: activeInside[node.id] ?? [],
    driftOwn: doc.drift[node.id] ?? NO_DRIFT,
    driftInside: driftInside[node.id] ?? 0,
    failedInside: failedInside[node.id] ?? 0,
  }));
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
    offLayer: drawn.offLayer,
  };
}

/**
 * The reality ghosts still worth drawing.
 *
 * A ghost's whole job is to say "this exists in the code and nothing on the
 * canvas admits it". Once a bubble names the package in its `codeRefs` the
 * ghost has nothing left to say: the bubble is already on screen, and whatever
 * disagrees between the two is the drift glow's story, not a second card's.
 * Ghosting claimed packages anyway is what made the band eat half the width of
 * a nine-package project and squeeze the bubbles it was meant to annotate.
 *
 * The claim test is the same prefix rule the bridge attributes activity with
 * (bridge/src/index.ts), so a package claimed for the purpose of the pulse is
 * claimed here too. Depth is deliberately ignored: a hidden child's `codeRefs`
 * claim just as well, because its drift bubbles up to the bubble on screen.
 */
export function selectReality(doc: GraphDoc): RealityLayer {
  const prefixes: string[] = [];
  for (const node of doc.nodes) {
    for (const ref of node.codeRefs ?? []) {
      const prefix = ref.replace(/^\.\//, "").replace(/\/+$/, "");
      if (prefix.length > 0) prefixes.push(prefix);
    }
  }

  const unclaimed = doc.reality.nodes.filter(
    (node) => !prefixes.some((prefix) => node.dir === prefix || node.dir.startsWith(`${prefix}/`)),
  );
  // identity is preserved when nothing is claimed: layout is memoised on it
  if (unclaimed.length === doc.reality.nodes.length) return doc.reality;

  const kept = new Set(unclaimed.map((node) => node.id));
  return {
    ...doc.reality,
    nodes: unclaimed,
    edges: doc.reality.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
  };
}
