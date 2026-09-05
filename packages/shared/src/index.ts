/**
 * Shape shared contract — the machine-readable half of ../../../CONTRACTS.md.
 *
 * Imported by RELATIVE PATH with explicit .ts extension from both the bridge
 * (Node 26 type-stripping) and the web client (Vite). Must remain erasable-syntax
 * TypeScript (no enums, no namespaces) and dependency-free.
 */

import type { AgentSession, WorktreeSession } from "./link.ts";

export type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentToServerMsg,
  LinkClientMsg,
  LinkServerMsg,
  ServerToAgentMsg,
  WorktreeSession,
} from "./link.ts";

// ---------------------------------------------------------------------------
// Graph document
// ---------------------------------------------------------------------------

export type Phase = "idea" | "concept" | "component" | "building" | "built" | "failed";
export type EdgeKind = "depends" | "dataflow" | "relates";
export type ModelRole = "explore" | "build" | "small";
export type NodeKind =
  | "ui"
  | "service"
  | "api"
  | "store"
  | "queue"
  | "external"
  | "security"
  /** these five read as infrastructure, but any layer may use any kind */
  | "host"
  | "database"
  | "cache"
  | "cdn"
  | "ci"
  /** an automated test suite */
  | "test"
  /** an end-to-end or smoke script */
  | "smoke"
  /** a static check such as a typecheck or a lint pass */
  | "check"
  /** human or manual verification: a checklist, a screenshot review */
  | "review"
  /** production monitoring or alerts */
  | "monitor";
/**
 * Which part of the canvas a bubble lives on. "product" bubbles are the
 * capabilities a person gets; "build" bubbles are the parts that exist as code;
 * "infra" bubbles are where the code runs and what it leans on outside itself;
 * "correctness" bubbles are what proves the code correct.
 */
export type Layer = "product" | "build" | "infra" | "correctness";

export interface IntentNode {
  /** slug: ^[a-z0-9][a-z0-9-]*$ */
  id: string;
  /** hierarchy; null = root bubble */
  parentId: string | null;
  /** short display name, <= 60 chars */
  label: string;
  /** the node's one-sentence promise (boundary test); required, <= 200 chars */
  summary: string;
  phase: Phase;
  /** one-line CURRENT state ("what's happening here now"), <= 140 chars; agent-refreshed while building */
  status?: string;
  modelRole?: ModelRole;
  /** component type shown as a symbol on the bubble; unknown values fall back to the plain bubble */
  kind?: NodeKind;
  /** workspace-relative path prefixes once code exists, e.g. ["packages/bridge"] */
  codeRefs?: string[];
  /** which layer the bubble belongs to; ABSENT MEANS "build" (back-compat, and canonical form omits it) */
  layer?: Layer;
  /** product nodes only: ids of BUILD nodes that make this capability real (sorted in canonical form) */
  realizes?: string[];
  /** infra nodes only: ids of BUILD nodes that run on / use this piece of infrastructure (sorted in canonical form) */
  hosts?: string[];
  /** correctness nodes only: ids of BUILD nodes this verification attests (sorted in canonical form) */
  verifies?: string[];
}

export interface GraphEdge {
  /** slug, conventionally `${source}--${target}` */
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** optional relation description, <= 60 chars */
  label?: string;
}

export interface RealityNode {
  /** `r:${pkgName}` */
  id: string;
  label: string;
  /** workspace-relative package dir */
  dir: string;
}

export interface RealityEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * One top-level class or function the bridge found in the code — the mechanical
 * "inside" of a leaf build bubble, addressable as the `${file}#${name}` codeRef
 * a child bubble uses to claim it.
 */
export interface RealitySymbol {
  /** `s:${file}#${name}` */
  id: string;
  /** workspace-relative file it is declared in */
  file: string;
  name: string;
  kind: "class" | "function";
  exported: boolean;
  /** 1-based declaration line */
  line: number;
  /** reality package id (`r:${pkgName}`) the file belongs to, null outside every package */
  pkg: string | null;
}

/**
 * One piece of infrastructure the bridge read out of configuration — a
 * database, a host, a pipeline. Claimed once some infra bubble's `codeRefs`
 * cover one of its `evidence` files; unclaimed ones render as ghosts.
 */
export interface RealityInfra {
  /** `i:${slug}` */
  id: string;
  label: string;
  kind: NodeKind;
  /** workspace-relative config files it was read from */
  evidence: string[];
  /** one plain-English line, e.g. "a Postgres database from docker-compose.yml" */
  hint: string;
}

/**
 * One piece of verification the bridge found in the code — a test suite, a
 * smoke script, a static check, a pipeline. Claimed once some correctness
 * bubble's `codeRefs` cover one of its `evidence` files, exactly as an infra
 * item is; `covers` is the other half, the root-relative files and directories
 * the verification actually exercises, which is how a build bubble that no
 * correctness bubble names can still read as verified.
 */
export interface RealityVerification {
  /** `v:${slug}` */
  id: string;
  label: string;
  kind: NodeKind;
  /** workspace-relative files it was read from (the test files, the config, the workflow) */
  evidence: string[];
  /** one plain-English line, e.g. "34 test files under packages/bridge" */
  hint: string;
  /** workspace-relative files/dirs the verification exercises */
  covers: string[];
}

export interface RealityLayer {
  nodes: RealityNode[];
  edges: RealityEdge[];
  symbols: RealitySymbol[];
  infra: RealityInfra[];
  verification: RealityVerification[];
  /** ISO timestamp, null before first extraction */
  extractedAt: string | null;
  /** git HEAD the layer was derived from */
  head: string | null;
}

/** intent node id -> human-readable drift descriptions */
export type DriftMap = Record<string, string[]>;

export interface GraphDoc {
  rev: number;
  nodes: IntentNode[];
  edges: GraphEdge[];
  reality: RealityLayer;
  drift: DriftMap;
  /**
   * When this canvas was last mapped against the code, and the git HEAD it was
   * mapped at: written by the server the moment it seeds the mechanical
   * skeleton onto an empty canvas. It is what keeps the automatic map from
   * seeding the same project again on every reconnect. Absent on a canvas
   * nothing ever mapped.
   */
  surveyed?: { head: string | null; at: string };
}

export function emptyGraph(): GraphDoc {
  return {
    rev: 0,
    nodes: [],
    edges: [],
    reality: { nodes: [], edges: [], symbols: [], infra: [], verification: [], extractedAt: null, head: null },
    drift: {},
  };
}

// ---------------------------------------------------------------------------
// Layers: product (capabilities), build (parts that exist as code),
// infra (where it runs and what it leans on), correctness (what proves it works)
// ---------------------------------------------------------------------------

export const LAYERS: readonly Layer[] = ["product", "build", "infra", "correctness"];

/** a `layer` value off the wire is only a layer when it is one of the four */
function isLayer(value: unknown): value is Layer {
  return value === "product" || value === "build" || value === "infra" || value === "correctness";
}

/** A bubble with no `layer` is a build bubble — every graph written before layers existed. */
export function layerOf(node: Pick<IntentNode, "layer">): Layer {
  return isLayer(node.layer) ? node.layer : "build";
}

/**
 * The product root: the single top-level product bubble the whole graph starts
 * from — its label is the product's name, its summary the promise of the whole
 * thing. Returns null when there is none, and also when a legacy graph has
 * several top-level product bubbles (no root to speak of; the client renders
 * them flat). `op/second-root` keeps new graphs at exactly one.
 */
export function productRootOf(doc: Pick<GraphDoc, "nodes">): IntentNode | null {
  let root: IntentNode | null = null;
  for (const node of doc.nodes) {
    if (node.parentId !== null || layerOf(node) !== "product") continue;
    if (root !== null) return null;
    root = node;
  }
  return root;
}

/** ids of the build nodes a product node claims to be realized by, deduped and existing-only */
export function realizersOf(doc: Pick<GraphDoc, "nodes">, productId: string): string[] {
  const node = doc.nodes.find((n) => n.id === productId);
  if (!node || layerOf(node) !== "product" || !node.realizes) return [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const id of node.realizes) {
    const target = byId.get(id);
    if (!target || layerOf(target) !== "build") continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Product ids served by a build node: those whose `realizes` names it OR any of
 * its ancestors — a capability realized by a parent is realized by its children.
 */
export function servesOf(doc: Pick<GraphDoc, "nodes">, buildId: string): string[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const start = byId.get(buildId);
  if (!start || layerOf(start) !== "build") return [];
  const chain = ancestorChain(byId, start);
  const out: string[] = [];
  for (const node of doc.nodes) {
    if (layerOf(node) !== "product" || !node.realizes) continue;
    if (node.realizes.some((id) => chain.has(id))) out.push(node.id);
  }
  return out;
}

/** a node's own id plus every ancestor id, cycle-safe */
function ancestorChain(byId: Map<string, IntentNode>, start: IntentNode): Set<string> {
  const chain = new Set<string>();
  let cur: IntentNode | undefined = start;
  while (cur && !chain.has(cur.id)) {
    chain.add(cur.id);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return chain;
}

/**
 * The build bubbles that run on a piece of infrastructure: its `hosts` resolved
 * to existing build nodes, deduped. Returns the nodes rather than ids (unlike
 * `realizersOf`) because every caller — the "runs N parts" chip, the hosts
 * drill, the side panel — needs the label and kind right away.
 */
export function hostsOf(doc: Pick<GraphDoc, "nodes">, infraId: string): IntentNode[] {
  const node = doc.nodes.find((n) => n.id === infraId);
  if (!node || layerOf(node) !== "infra" || !node.hosts) return [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: IntentNode[] = [];
  for (const id of node.hosts) {
    const target = byId.get(id);
    if (!target || layerOf(target) !== "build") continue;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * The infrastructure a build node runs on: infra nodes whose `hosts` names it
 * OR any of its ancestors — infra that runs a parent runs its children, the
 * same ancestor rule `servesOf` uses.
 */
export function runsOnOf(doc: Pick<GraphDoc, "nodes">, buildId: string): IntentNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const start = byId.get(buildId);
  if (!start || layerOf(start) !== "build") return [];
  const chain = ancestorChain(byId, start);
  const out: IntentNode[] = [];
  for (const node of doc.nodes) {
    if (layerOf(node) !== "infra" || !node.hosts) continue;
    if (node.hosts.some((id) => chain.has(id))) out.push(node);
  }
  return out;
}

/**
 * The build bubbles a verification attests: its `verifies` resolved to existing
 * build nodes, deduped. Nodes rather than ids, for the same reason `hostsOf`
 * returns nodes — the "verifies N parts" chip, the drill and the side panel all
 * need the label and kind right away.
 */
export function verifiedOf(doc: Pick<GraphDoc, "nodes">, verifyId: string): IntentNode[] {
  const node = doc.nodes.find((n) => n.id === verifyId);
  if (!node || layerOf(node) !== "correctness" || !node.verifies) return [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const out: IntentNode[] = [];
  for (const id of node.verifies) {
    const target = byId.get(id);
    if (!target || layerOf(target) !== "build") continue;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * What attests a build node: correctness nodes whose `verifies` names it OR any
 * of its ancestors — a check that attests a parent attests its children, the
 * same ancestor rule `servesOf` and `runsOnOf` use.
 */
export function verifiersOf(doc: Pick<GraphDoc, "nodes">, buildId: string): IntentNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const start = byId.get(buildId);
  if (!start || layerOf(start) !== "build") return [];
  const chain = ancestorChain(byId, start);
  const out: IntentNode[] = [];
  for (const node of doc.nodes) {
    if (layerOf(node) !== "correctness" || !node.verifies) continue;
    if (node.verifies.some((id) => chain.has(id))) out.push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// codeRefs: path prefixes and symbol refs
// ---------------------------------------------------------------------------

/**
 * A codeRef is either a path prefix ("packages/bridge") or a symbol ref
 * ("packages/bridge/src/room.ts#Room") naming ONE top-level class or function
 * inside that file. Returns null for a plain path ref and for a malformed one,
 * so no caller has to split on "#" itself.
 */
export function symbolRefOf(ref: string): { path: string; name: string } | null {
  const hash = ref.indexOf("#");
  if (hash < 0) return null;
  const path = ref.slice(0, hash);
  const name = ref.slice(hash + 1);
  if (path.length === 0 || name.length === 0 || name.includes("#")) return null;
  return { path, name };
}

/**
 * What a codeRef claims: the path, with a symbol name dropped. A `file#Name`
 * ref claims that file, because the part it names lives in it.
 */
function refPath(ref: string): string {
  const symbol = symbolRefOf(ref);
  return (symbol === null ? ref : symbol.path).replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * The prefix rule, by path SEGMENT: "packages/auth" claims
 * "packages/auth/src/index.ts" and does not claim "packages/authz".
 */
function inside(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The code no bubble on this canvas claims: the reality packages nothing points
 * at, and the files reality parsed that nothing points at either, each with the
 * parts it declares. This is the other half of drift — drift says what the map
 * gets WRONG, this says what the map is MISSING — and the web renders it as the
 * dim code column beside the layer.
 *
 * A package counts as claimed the moment a codeRef touches it from either
 * direction: a bubble owning "packages/auth" claims it, and so does a child
 * bubble owning one part of one file inside it, because the package is then
 * already on the canvas at some altitude. A file counts as claimed only when a
 * codeRef is at or above it, which is the ordinary prefix rule — a bubble that
 * owns the package owns its files, and listing them again would be depth the
 * altitude rules already govern.
 *
 * Pure, and layer-blind: a path claimed by an infra or correctness bubble is
 * claimed, since the question is whether the canvas mentions that code at all.
 */
export function unclaimedReality(doc: Pick<GraphDoc, "nodes" | "reality">): {
  packages: RealityNode[];
  files: Array<{ file: string; symbols: RealitySymbol[] }>;
} {
  const prefixes: string[] = [];
  for (const node of doc.nodes) {
    for (const ref of node.codeRefs ?? []) {
      const path = refPath(ref);
      if (path.length > 0) prefixes.push(path);
    }
  }
  const packages = doc.reality.nodes.filter(
    (pkg) => !prefixes.some((prefix) => inside(prefix, pkg.dir) || inside(pkg.dir, prefix)),
  );
  const files: Array<{ file: string; symbols: RealitySymbol[] }> = [];
  const byFile = new Map<string, RealitySymbol[]>();
  for (const symbol of doc.reality.symbols) {
    if (prefixes.some((prefix) => inside(prefix, symbol.file))) continue;
    const bucket = byFile.get(symbol.file);
    if (bucket === undefined) {
      const fresh = [symbol];
      byFile.set(symbol.file, fresh);
      files.push({ file: symbol.file, symbols: fresh });
    } else bucket.push(symbol);
  }
  // one order every time, whatever order the extraction happened to be in:
  // callers compare this listing byte for byte in the smokes
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { packages, files };
}

// ---------------------------------------------------------------------------
// Verification status: what a build bubble can show for "is this attested?"
// ---------------------------------------------------------------------------

/**
 * Whether anything attests a build bubble — the shield pip on the canvas, and
 * the same answer drift and the side panel read.
 *
 * Two ways to be verified, and either is enough. Authored: some correctness
 * bubble's `verifies` names this node or an ancestor of it (`verifiersOf`).
 * Mechanical: some extracted verification `covers` a path that meets this
 * node's own or an ancestor's `codeRefs`. "Meets" is the prefix rule in BOTH
 * directions, because the two sides are written at different altitudes: a
 * cover of "packages/x/src" attests a bubble that owns "packages/x/src/a.ts",
 * and a cover of "packages/x/src/a.ts" attests a bubble that owns "packages/x".
 */
export function verificationOf(
  doc: Pick<GraphDoc, "nodes" | "reality">,
  buildId: string,
): "verified" | "unverified" {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const start = byId.get(buildId);
  if (!start || layerOf(start) !== "build") return "unverified";
  if (verifiersOf(doc, buildId).length > 0) return "verified";
  // a symbol ref stands for its file here: a cover reaching the file reaches
  // whatever inside it a bubble claimed
  const refs: string[] = [];
  for (const id of ancestorChain(byId, start)) {
    for (const ref of byId.get(id)?.codeRefs ?? []) refs.push(symbolRefOf(ref)?.path ?? ref);
  }
  if (refs.length === 0) return "unverified";
  for (const item of doc.reality.verification) {
    for (const cover of item.covers) {
      for (const ref of refs) {
        if (cover === ref || cover.startsWith(`${ref}/`) || ref.startsWith(`${cover}/`)) return "verified";
      }
    }
  }
  return "unverified";
}

/**
 * A capability's verification rolled up over its realizers, because a promise
 * is only as attested as the parts keeping it. "none" is not a verdict: the
 * capability names no build bubble yet, so there is nothing to roll up (the
 * unrealized case the canvas already renders on its own).
 */
export function capabilityVerification(
  doc: Pick<GraphDoc, "nodes" | "reality">,
  productId: string,
): "verified" | "partial" | "unverified" | "none" {
  const realizers = realizersOf(doc, productId);
  if (realizers.length === 0) return "none";
  let verified = 0;
  for (const id of realizers) if (verificationOf(doc, id) === "verified") verified++;
  if (verified === 0) return "unverified";
  return verified === realizers.length ? "verified" : "partial";
}

// ---------------------------------------------------------------------------
// Link gaps: cross-layer connection is the default
// ---------------------------------------------------------------------------

/** What a bubble should be connected to and is not. */
export type LinkGap =
  | "unrealized"
  | "unserved"
  | "unhosted"
  | "unattested"
  | "hosts-nothing"
  | "attests-nothing";

/**
 * The phases at which a bubble is expected to be wired. An idea or a concept
 * may stand alone — nobody knows yet what would realize it or run it. A
 * component, something under construction and something finished may not.
 * `failed` is never asked: a dead end owes no links.
 */
export const LINKED_PHASES: readonly Phase[] = ["component", "building", "built"];

/**
 * What `id` should be connected to across the layers and is not (user decision
 * 2026-09-04: connection is the default, not an extra — whatever can be
 * connected to something in another layer should be). Empty for an unknown id,
 * for a bubble too early to be asked, and for a fully connected one.
 *
 * A gap is only ever raised when the other side exists to link to: nobody owes
 * infra links in a graph with no infra. The ancestor rule already lives in
 * `servesOf` / `runsOnOf` / `verifiersOf`, so a child of a connected parent is
 * connected and reads clean.
 *
 * Returned in the fixed order of the `LinkGap` union so every reader — the
 * canvas, the side panel, the tool receipt — lists them the same way.
 */
export function linkGapsOf(doc: Pick<GraphDoc, "nodes" | "reality">, id: string): LinkGap[] {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || !LINKED_PHASES.includes(node.phase)) return [];
  // one pass for the "is there anything on that side to link to?" questions
  let hasBuild = false;
  let hasInfra = false;
  let hasNonRootProduct = false;
  const root = productRootOf(doc);
  for (const other of doc.nodes) {
    switch (layerOf(other)) {
      case "build":
        hasBuild = true;
        break;
      case "infra":
        hasInfra = true;
        break;
      case "product":
        if (other.id !== root?.id) hasNonRootProduct = true;
        break;
    }
  }
  const gaps: LinkGap[] = [];
  switch (layerOf(node)) {
    case "product":
      // the root spans the whole build layer by construction, so it is never
      // asked what realizes it; every other capability is
      if (node.id !== root?.id && realizersOf(doc, id).length === 0) gaps.push("unrealized");
      break;
    case "build":
      if (hasNonRootProduct && servesOf(doc, id).length === 0) gaps.push("unserved");
      if (hasInfra && runsOnOf(doc, id).length === 0) gaps.push("unhosted");
      // a finished part nothing attests is a claim
      if (node.phase === "built" && verificationOf(doc, id) === "unverified") gaps.push("unattested");
      break;
    case "infra":
      if (hasBuild && hostsOf(doc, id).length === 0) gaps.push("hosts-nothing");
      break;
    case "correctness":
      if (hasBuild && verifiedOf(doc, id).length === 0) gaps.push("attests-nothing");
      break;
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Revision snapshots + delta
// ---------------------------------------------------------------------------

/** one persisted snapshot, identified by the `rev` it captured */
export interface RevisionInfo {
  rev: number;
  /** ISO timestamp of the snapshot */
  at: string;
}

/** the intent layer as it stood at `rev` — canonical (sorted, undefined optionals omitted) */
export interface GraphSnapshot {
  rev: number;
  at: string;
  nodes: IntentNode[];
  edges: GraphEdge[];
}

/** added/removed/changed buckets for one entity kind; all arrays sorted by id */
export interface EntityDelta<T> {
  added: T[];
  removed: T[];
  changed: Array<{ before: T; after: T }>;
}

/** what changed between two revisions; `revA` is the before side, `revB` the after */
export interface GraphDelta {
  revA: number;
  revB: number;
  nodes: EntityDelta<IntentNode>;
  edges: EntityDelta<GraphEdge>;
}

// ---------------------------------------------------------------------------
// End of turn: where things stand, and what the user can do about it
// ---------------------------------------------------------------------------

/** one one-click continuation: what the button says, and what clicking it says */
export interface NextChoice {
  /** the words on the button, <= NEXT_LABEL_MAX chars */
  label: string;
  /** the exact sentence sent to the harness when it is clicked */
  say: string;
}

/**
 * The call to action a turn ends on. A turn that stops with nothing on screen
 * but a canvas leaves the user guessing what to type; this is the agent saying
 * where things stand and offering the two or three ways on, each as a sentence
 * the user would have had to dictate themselves.
 *
 * Ephemeral by design: it belongs to the turn that produced it, never to the
 * document, so it is not in `GraphDoc`, not in a revision, and not diffable.
 */
export interface Next {
  /** one sentence on where things stand, <= NEXT_SUMMARY_MAX chars */
  summary: string;
  /** 0 to NEXT_CHOICES_MAX ways on; none means the work is finished */
  choices: NextChoice[];
  /** the decision the user has to make, or null when there is none */
  question: string | null;
}

export const NEXT_SUMMARY_MAX = 200;
export const NEXT_LABEL_MAX = 40;
export const NEXT_CHOICES_MAX = 4;

/**
 * Boundary validator for the `next` half of a `canvas` call: it comes off the
 * wire from the model like the ops do. Returns the value, or the one-line
 * reason it was refused — the caller is what turns that into a receipt.
 */
export function parseNext(raw: unknown): Next | string {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "`next` must be an object";
  if (!("summary" in raw) || typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
    return "`next.summary` must be one non-empty sentence saying where things stand";
  }
  if (raw.summary.length > NEXT_SUMMARY_MAX) {
    return `\`next.summary\` must be <= ${NEXT_SUMMARY_MAX} chars, got ${raw.summary.length}`;
  }
  if (!("choices" in raw) || !Array.isArray(raw.choices)) return "`next.choices` must be an array of choices";
  if (raw.choices.length > NEXT_CHOICES_MAX) {
    return `\`next.choices\` must have at most ${NEXT_CHOICES_MAX} entries, got ${raw.choices.length}`;
  }
  const choices: NextChoice[] = [];
  for (const [index, choice] of raw.choices.entries()) {
    if (choice === null || typeof choice !== "object") return `\`next.choices[${index}]\` must be an object`;
    if (!("label" in choice) || typeof choice.label !== "string" || choice.label.trim().length === 0) {
      return `\`next.choices[${index}].label\` must be the words on the button`;
    }
    if (choice.label.length > NEXT_LABEL_MAX) {
      return `\`next.choices[${index}].label\` must be <= ${NEXT_LABEL_MAX} chars, got ${choice.label.length}`;
    }
    if (!("say" in choice) || typeof choice.say !== "string" || choice.say.trim().length === 0) {
      return `\`next.choices[${index}].say\` must be the exact sentence the click sends`;
    }
    choices.push({ label: choice.label, say: choice.say });
  }
  // absent and null are the same thing: this turn ends on no decision
  const question = "question" in raw ? raw.question : null;
  if (question !== null && question !== undefined && typeof question !== "string") {
    return "`next.question` must be the decision the user has to make, or null";
  }
  const asked = typeof question === "string" && question.trim().length > 0 ? question : null;
  return { summary: raw.summary, choices, question: asked };
}

// ---------------------------------------------------------------------------
// canvas tool: mutation ops
// ---------------------------------------------------------------------------

export type CanvasOp =
  | { op: "upsert_node"; node: IntentNode }
  | { op: "remove_node"; id: string }
  | { op: "upsert_edge"; edge: GraphEdge }
  | { op: "remove_edge"; id: string }
  | { op: "set_phase"; id: string; phase: Phase };

export interface CanvasArgs {
  ops: CanvasOp[];
  /** one-line rationale, echoed to the transcript panel */
  note?: string;
  /**
   * Where the turn leaves things and how the user carries on. Never touches the
   * graph: the bridge takes it off the call, shows it as the turn's card, and
   * forgets it the moment anything is said (see `Next`).
   */
  next?: Next;
}

export const PHASES: readonly Phase[] = ["idea", "concept", "component", "building", "built", "failed"];
export const EDGE_KINDS: readonly EdgeKind[] = ["depends", "dataflow", "relates"];
export const MODEL_ROLES: readonly ModelRole[] = ["explore", "build", "small"];
export const NODE_KINDS: readonly NodeKind[] = [
  "ui",
  "service",
  "api",
  "store",
  "queue",
  "external",
  "security",
  "host",
  "database",
  "cache",
  "cdn",
  "ci",
  "test",
  "smoke",
  "check",
  "review",
  "monitor",
];

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The links that point AT build nodes, in the order their receipts are checked:
 * a build node held by more than one of them hears about the product side
 * first, then infra, then correctness. One table, so a link cannot end up with
 * half a guard — both the layer-flip check on `upsert_node` and the removal
 * check on `remove_node` walk it.
 */
const BUILD_LINKS: readonly {
  /** the field on the node that owns the link */
  field: "realizes" | "hosts" | "verifies";
  /** the only layer allowed to carry it */
  owner: Layer;
  /** receipt code for a build node the link still names */
  code: string;
  /** evidence key that lists the holders */
  key: string;
  /** what the holder itself is, for the fix that removes it instead */
  holds: string;
}[] = [
  { field: "realizes", owner: "product", code: "op/node-realized", key: "realizedBy", holds: "capability" },
  { field: "hosts", owner: "infra", code: "op/node-hosted", key: "hostedBy", holds: "infrastructure" },
  { field: "verifies", owner: "correctness", code: "op/node-verified", key: "verifiedBy", holds: "verification" },
];

/**
 * Description of the `canvas` tool, shared by both channels it is exposed
 * through: the host tool a native adapter registers, and the MCP server the
 * link ships. One text, or the two channels would drift apart.
 */
export const CANVAS_TOOL_DESCRIPTION = `Maintain the visual canvas the user is watching — this is their only view of your work. They read it; nothing they do there reaches you, so the picture has to say where things stand on its own.

ops (batch, applied per-op): upsert_node, remove_node (rejected while it has children), upsert_edge, remove_edge, set_phase.
ids are slugs: ^[a-z0-9][a-z0-9-]*$. Node summary is REQUIRED: one sentence stating what the bubble promises, <= 200 chars; a bubble that cannot be summarized in one sentence is at the wrong altitude.
Hierarchy is parentId (null = root); edges are ONLY non-hierarchical relations (depends | dataflow | relates) — never an edge to mean "contains". A parent and both ends of an edge must be on the same layer.
Phases: idea -> concept -> component -> building -> built | failed. Set codeRefs (workspace-relative path prefixes) once a bubble owns files. A codeRef may also name one thing inside a file — "path/to/file.ts#Name" points at a single top-level class or function in that file, which is how a small bubble claims one part of a bigger file. One "#" only, a real path on the left and the exact name on the right.
FOUR LAYERS, set with layer on each node. layer "product" = what the person gets: the capabilities and surfaces they can name and use, no file names. layer "build" (the default when layer is omitted) = the parts that exist as code: services, stores, screens, jobs. layer "infra" = where it runs and what it leans on outside the code. layer "correctness" = what proves it works: the tests, checks and reviews that attest a part is correct. realizes (product nodes only, up to 20 existing build node ids) is the link from product to build — it says which build bubbles make that capability real; keep it current as build bubbles appear. CONNECTING THE LAYERS IS THE DEFAULT, not an extra: a capability names what realizes it, an infra bubble names what runs on it, a check names what it attests, so every build part ends up reached by a capability, by infra, and — once it is built — by a check. A bubble past the idea stage missing one of those comes back as a link/<gap> warning naming the link to write; the op still applies, and you are expected to close the gap in the same turn.
THE INFRA LAYER is the things the running product needs that are not code you wrote: databases, hosting, queues, third-party services, and the pipeline that builds and tests it. Give each one a plain-English bubble ("the main database", "where the app runs", "the build-and-test pipeline") with kind set to host | database | cache | cdn | queue | store | external | ci, codeRefs pointing at the configuration files that prove it exists, and hosts (up to 40 existing build node ids) naming the build bubbles that run on or use it. hosts is the link from infra to build; it belongs on infra nodes only, and infrastructure running nothing is either unlinked or not real. The infra layer has no single root bubble — a handful of top-level ones is normal.
THE CORRECTNESS LAYER is what shows the parts are correct rather than just written: test suites, smoke or end-to-end runs, checks like typechecking and linting, review passes a person does, and monitoring that watches the thing in production. Give each one a plain-English bubble ("the protocol checks", "checks that run on every push") with kind set to test | smoke | check | review | monitor, codeRefs pointing at the files that ARE the verification, and verifies (up to 40 existing build node ids) naming the build bubbles it attests. verifies is the link from correctness to build; it belongs on correctness nodes only, and like infra this layer has no single root bubble. A finished part nothing attests is a claim, so when you finish one, add or extend what proves it and say so with verifies.
THE PRODUCT LAYER STARTS FROM ONE BUBBLE: the product itself, the only product node with parentId null — its label is the product's name and its summary the one-sentence promise of the whole thing. Create it before anything else, then hang the 3-5 capabilities under it as its children, and deeper capabilities under those. A second top-level product bubble is rejected with op/second-root, whose evidence names the root to parent it under. The root spans the whole build layer, so realizes on it is optional; every capability below it still needs one.
summary = the bubble's stable promise. status (optional, <= 140 chars) = what is happening in it RIGHT NOW; refresh it on bubbles you are building and omit it when done — an upsert without status clears it.
PLAIN ENGLISH, NO JARGON: every label, summary, status, edge label and note is read by a non-programmer reading the picture, not a programmer reading code — everyday words, outcomes not mechanisms, no acronyms or protocol/library/file-format names or code identifiers unless the bubble is literally about that thing. Only codeRefs stay technical.
next (optional, accepted for compatibility): { summary, choices, question } — still validated, but the canvas does not show it and a choice is never sent back to you, so nothing is waiting on it and you may leave it out. Say where things stand in the bubbles themselves: summary for the promise, status for what is happening in it right now.
Call this as you think and work, in the same turn your understanding changes. The result tells you what applied; rejections come back as JSON repair receipts ({code, subject, evidence, supportedFixes}) — apply a supported fix and resend just the rejected ops.`;

/**
 * JSON-Schema of the canvas tool, exactly as every harness is handed it: the
 * omp extension registers it inside omp, the link's MCP server serves it to
 * Claude Code, and neither may re-describe it.
 */
export const CANVAS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["upsert_node", "remove_node", "upsert_edge", "remove_edge", "set_phase"],
          },
          node: {
            type: "object",
            properties: {
              id: { type: "string" },
              parentId: { type: ["string", "null"] },
              label: { type: "string" },
              summary: { type: "string" },
              phase: { type: "string", enum: [...PHASES] },
              status: { type: "string" },
              modelRole: { type: "string", enum: [...MODEL_ROLES] },
              kind: { type: "string", enum: [...NODE_KINDS] },
              codeRefs: { type: "array", items: { type: "string" } },
              layer: { type: "string", enum: [...LAYERS] },
              realizes: { type: "array", items: { type: "string" }, maxItems: 20 },
              hosts: {
                type: "array",
                items: { type: "string" },
                maxItems: 40,
                description: "infra nodes only: ids of the build nodes that run on or use this piece of infrastructure",
              },
              verifies: {
                type: "array",
                items: { type: "string" },
                maxItems: 40,
                description: "correctness nodes only: ids of the build nodes this verification attests",
              },
            },
            required: ["id", "parentId", "label", "summary", "phase"],
            additionalProperties: false,
          },
          edge: {
            type: "object",
            properties: {
              id: { type: "string" },
              source: { type: "string" },
              target: { type: "string" },
              kind: { type: "string", enum: [...EDGE_KINDS] },
              label: { type: "string" },
            },
            required: ["id", "source", "target", "kind"],
            additionalProperties: false,
          },
          id: { type: "string" },
          phase: { type: "string", enum: [...PHASES] },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
    next: {
      type: "object",
      description: "how this turn ends: where things stand, the one-click ways on, and the decision the user has to make",
      properties: {
        summary: { type: "string", maxLength: NEXT_SUMMARY_MAX },
        choices: {
          type: "array",
          maxItems: NEXT_CHOICES_MAX,
          items: {
            type: "object",
            properties: {
              label: { type: "string", maxLength: NEXT_LABEL_MAX, description: "the words on the button" },
              say: { type: "string", description: "the exact sentence sent to you when it is clicked" },
            },
            required: ["label", "say"],
            additionalProperties: false,
          },
        },
        question: { type: ["string", "null"] },
      },
      required: ["summary", "choices"],
      additionalProperties: false,
    },
  },
  required: ["ops"],
  additionalProperties: false,
} as const;

/**
 * Structured repair receipt for a rejected op — machine-actionable so the
 * model can self-correct without re-reading docs (shape follows archify's
 * renderer diagnostics: code/severity/message/subject/evidence/supportedFixes).
 */
export interface OpRejection {
  /** index of the rejected op in the submitted `ops` batch */
  index: number;
  /** namespaced machine code, e.g. "op/unknown-parent" */
  code: string;
  severity: "error" | "warning";
  /** one-line human summary */
  message: string;
  /** where: path into the batch ("/ops/3/node/parentId"), annotated with the nearest enclosing node/edge id + label */
  subject: { path: string; id?: string; label?: string };
  /** observed values behind the rejection */
  evidence: Record<string, unknown>;
  /** 1-3 concrete repairs the model can apply mechanically */
  supportedFixes: string[];
}

export interface ApplyResult {
  applied: number;
  rejections: OpRejection[];
}

/**
 * Validate and apply ops to `doc` IN PLACE (per-op accept/reject; not
 * all-or-nothing). Bumps `rev` once when anything applied.
 */
export function applyOps(doc: GraphDoc, ops: CanvasOp[]): ApplyResult {
  const rejections: OpRejection[] = [];
  let applied = 0;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(doc.edges.map((e) => [e.id, e]));

  const wouldCycle = (id: string, parentId: string | null): boolean => {
    let cur = parentId;
    while (cur !== null) {
      if (cur === id) return true;
      cur = nodeById.get(cur)?.parentId ?? null;
    }
    return false;
  };

  /** first few known ids — enough for the model to pick a real one */
  const sample = (ids: Iterable<string>): string[] => [...ids].slice(0, 20);

  ops.forEach((raw, index) => {
    const reject = (
      code: string,
      message: string,
      detail: { at?: string; id?: unknown; label?: unknown; evidence?: Record<string, unknown>; fixes: string[] },
    ) => {
      const subject: OpRejection["subject"] = { path: `/ops/${index}${detail.at ?? ""}` };
      if (typeof detail.id === "string") subject.id = detail.id;
      if (typeof detail.label === "string") subject.label = detail.label;
      rejections.push({
        index,
        code,
        severity: "error",
        message,
        subject,
        evidence: detail.evidence ?? {},
        supportedFixes: detail.fixes,
      });
    };
    switch (raw?.op) {
      case "upsert_node": {
        const n = raw.node;
        if (!n || typeof n !== "object")
          return reject("op/missing-node", "missing node", {
            at: "/node",
            evidence: { node: n ?? null },
            fixes: ["provide a `node` object with id, parentId, label, summary, phase"],
          });
        if (typeof n.id !== "string" || !NODE_ID_RE.test(n.id))
          return reject("op/bad-slug", `bad node id ${JSON.stringify(n?.id)}: want ^[a-z0-9][a-z0-9-]*$`, {
            at: "/node/id",
            label: n.label,
            evidence: { id: n.id ?? null, pattern: NODE_ID_RE.source },
            fixes: ['use a lowercase slug matching ^[a-z0-9][a-z0-9-]*$, e.g. "auth-service"'],
          });
        // A bubble's layer sticks once set: an upsert that omits `layer` keeps the
        // bubble where it is, and a brand-new bubble with no `layer` is a build bubble.
        const askedLayer: unknown = n.layer;
        const prior = nodeById.get(n.id);
        const layer: Layer = isLayer(askedLayer) ? askedLayer : prior ? layerOf(prior) : "build";
        const parent = n.parentId === null ? null : (nodeById.get(n.parentId) ?? null);
        if (n.parentId !== null && parent === null)
          return reject("op/unknown-parent", `parent "${n.parentId}" does not exist`, {
            at: "/node/parentId",
            id: n.id,
            label: n.label,
            evidence: { parentId: n.parentId, knownNodeIds: sample(nodeById.keys()) },
            fixes: [
              "use an existing node id as parentId",
              "upsert the parent earlier in the same ops batch",
              "set parentId to null to make this a root bubble",
            ],
          });
        if (parent && layerOf(parent) !== layer)
          return reject("op/cross-layer-parent", `parent "${n.parentId}" is on a different layer`, {
            at: "/node/parentId",
            id: n.id,
            label: n.label,
            evidence: { parentId: n.parentId, nodeLayer: layer, parentLayer: layerOf(parent) },
            fixes: [
              `pick a parent that is also on the ${layer} layer`,
              "set parentId to null to make this a root bubble",
              "link layers with `realizes` on the product node, `hosts` on the infra node or `verifies` on the correctness node instead",
            ],
          });
        if (n.parentId !== null && wouldCycle(n.id, n.parentId))
          return reject("op/cycle", `parent "${n.parentId}" would create a cycle`, {
            at: "/node/parentId",
            id: n.id,
            label: n.label,
            evidence: { parentId: n.parentId },
            fixes: ["pick a parentId outside this node's own subtree", "set parentId to null"],
          });
        if (typeof n.label !== "string" || n.label.length === 0 || n.label.length > 60)
          return reject("op/bad-label", "label required, <= 60 chars", {
            at: "/node/label",
            id: n.id,
            evidence: { label: n.label ?? null, length: typeof n.label === "string" ? n.label.length : 0 },
            fixes: ["set label to a non-empty string of at most 60 characters"],
          });
        if (typeof n.summary !== "string" || n.summary.trim().length === 0 || n.summary.length > 200)
          return reject("op/bad-summary", "summary (the node's one-sentence promise) required, <= 200 chars", {
            at: "/node/summary",
            id: n.id,
            label: n.label,
            evidence: { length: typeof n.summary === "string" ? n.summary.length : 0 },
            fixes: ["set summary to the node's one-sentence promise, 1-200 characters"],
          });
        if (!PHASES.includes(n.phase))
          return reject("op/bad-phase", `bad phase "${n.phase}"`, {
            at: "/node/phase",
            id: n.id,
            label: n.label,
            evidence: { phase: n.phase ?? null, allowed: PHASES },
            fixes: [`choose one of: ${PHASES.join(", ")}`],
          });
        if (n.status !== undefined && (typeof n.status !== "string" || n.status.length > 140))
          return reject("op/bad-status", "status <= 140 chars", {
            at: "/node/status",
            id: n.id,
            label: n.label,
            evidence: { length: typeof n.status === "string" ? n.status.length : 0 },
            fixes: ["set status to a string of at most 140 characters, or omit it to clear"],
          });
        if (Array.isArray(n.codeRefs)) {
          // a codeRef that reaches for a symbol and misses ("#Name", "file.ts#",
          // "a#b#c") would silently claim nothing, so it comes back as a receipt
          const badRef = n.codeRefs.find((r) => typeof r === "string" && r.includes("#") && symbolRefOf(r) === null);
          if (typeof badRef === "string")
            return reject("op/bad-coderefs", `codeRef "${badRef}" is neither a path nor a "<file>#<Name>" symbol ref`, {
              at: "/node/codeRefs",
              id: n.id,
              label: n.label,
              evidence: { codeRef: badRef, codeRefs: n.codeRefs },
              fixes: [
                'point at a file or folder, e.g. "packages/bridge/src"',
                'name one top-level class or function after a single "#", e.g. "packages/bridge/src/room.ts#Room"',
              ],
            });
        }
        if (n.realizes !== undefined) {
          const list: unknown = n.realizes;
          const bad = (message: string, evidence: Record<string, unknown>, fixes: string[]) =>
            reject("op/bad-realizes", message, { at: "/node/realizes", id: n.id, label: n.label, evidence, fixes });
          if (!Array.isArray(list) || list.some((id) => typeof id !== "string"))
            return bad("realizes must be an array of node ids", { realizes: list ?? null }, [
              "pass realizes as an array of build node ids",
              "omit realizes",
            ]);
          if (layer !== "product")
            return bad("realizes belongs on product nodes only", { realizes: list, layer }, [
              'set layer to "product" on this node',
              `drop realizes from this ${layer} node`,
            ]);
          if (list.length > 20)
            return bad("realizes lists at most 20 build nodes", { count: list.length, max: 20 }, [
              "keep the few build bubbles that really make this capability work",
              "point at a parent build bubble instead of each of its children",
            ]);
          const seen: string[] = [];
          for (const id of list as string[]) {
            if (seen.includes(id))
              return bad(`realizes lists "${id}" twice`, { realizes: list, duplicate: id }, [
                "list each build node id once",
              ]);
            seen.push(id);
            const target = nodeById.get(id);
            if (!target)
              return bad(`realizes target "${id}" does not exist`, { nodeId: id, knownNodeIds: sample(nodeById.keys()) }, [
                "use an existing build node id",
                "upsert the build node earlier in the same ops batch",
              ]);
            if (layerOf(target) !== "build")
              return bad(`realizes target "${id}" is a ${layerOf(target)} node, not a build node`, { nodeId: id, targetLayer: layerOf(target) }, [
                "point realizes at the build bubbles that make this capability real",
                "drop that id from realizes",
              ]);
          }
        }
        if (n.hosts !== undefined) {
          const list: unknown = n.hosts;
          const bad = (message: string, evidence: Record<string, unknown>, fixes: string[]) =>
            reject("op/bad-hosts", message, { at: "/node/hosts", id: n.id, label: n.label, evidence, fixes });
          if (!Array.isArray(list) || list.some((id) => typeof id !== "string"))
            return bad("hosts must be an array of node ids", { hosts: list ?? null }, [
              "pass hosts as an array of build node ids",
              "omit hosts",
            ]);
          if (layer !== "infra")
            return bad("hosts belongs on infra nodes only", { hosts: list, layer }, [
              'set layer to "infra" on this node',
              `drop hosts from this ${layer} node`,
            ]);
          if (list.length > 40)
            return bad("hosts lists at most 40 build nodes", { count: list.length, max: 40 }, [
              "keep the build bubbles that really run on this piece of infrastructure",
              "point at a parent build bubble instead of each of its children",
            ]);
          const seen: string[] = [];
          for (const id of list as string[]) {
            if (seen.includes(id))
              return bad(`hosts lists "${id}" twice`, { hosts: list, duplicate: id }, ["list each build node id once"]);
            seen.push(id);
            const target = nodeById.get(id);
            if (!target)
              return bad(`hosts target "${id}" does not exist`, { nodeId: id, knownNodeIds: sample(nodeById.keys()) }, [
                "use an existing build node id",
                "upsert the build node earlier in the same ops batch",
              ]);
            if (layerOf(target) !== "build")
              return bad(`hosts target "${id}" is a ${layerOf(target)} node, not a build node`, { nodeId: id, targetLayer: layerOf(target) }, [
                "point hosts at the build bubbles that run on this piece of infrastructure",
                "drop that id from hosts",
              ]);
          }
        }
        if (n.verifies !== undefined) {
          const list: unknown = n.verifies;
          const bad = (message: string, evidence: Record<string, unknown>, fixes: string[]) =>
            reject("op/bad-verifies", message, { at: "/node/verifies", id: n.id, label: n.label, evidence, fixes });
          if (!Array.isArray(list) || list.some((id) => typeof id !== "string"))
            return bad("verifies must be an array of node ids", { verifies: list ?? null }, [
              "pass verifies as an array of build node ids",
              "omit verifies",
            ]);
          if (layer !== "correctness")
            return bad("verifies belongs on correctness nodes only", { verifies: list, layer }, [
              'set layer to "correctness" on this node',
              `drop verifies from this ${layer} node`,
            ]);
          if (list.length > 40)
            return bad("verifies lists at most 40 build nodes", { count: list.length, max: 40 }, [
              "keep the build bubbles this verification really attests",
              "point at a parent build bubble instead of each of its children",
            ]);
          const seen: string[] = [];
          for (const id of list as string[]) {
            if (seen.includes(id))
              return bad(`verifies lists "${id}" twice`, { verifies: list, duplicate: id }, ["list each build node id once"]);
            seen.push(id);
            const target = nodeById.get(id);
            if (!target)
              return bad(`verifies target "${id}" does not exist`, { nodeId: id, knownNodeIds: sample(nodeById.keys()) }, [
                "use an existing build node id",
                "upsert the build node earlier in the same ops batch",
              ]);
            if (layerOf(target) !== "build")
              return bad(`verifies target "${id}" is a ${layerOf(target)} node, not a build node`, { nodeId: id, targetLayer: layerOf(target) }, [
                "point verifies at the build bubbles this verification attests",
                "drop that id from verifies",
              ]);
          }
        }
        // a build node other bubbles point AT cannot leave the build layer while
        // the links still name it — whichever layer it is heading for
        if (prior && layerOf(prior) === "build" && layer !== "build") {
          for (const link of BUILD_LINKS) {
            const holders = doc.nodes
              .filter((other) => layerOf(other) === link.owner && other[link.field]?.includes(n.id))
              .map((other) => other.id);
            if (holders.length > 0)
              return reject(link.code, `build node "${n.id}" is still listed in another node's ${link.field}`, {
                at: "/node/layer",
                id: n.id,
                label: n.label,
                evidence: { [link.key]: sample(holders) },
                fixes: [
                  `drop this id from the listed ${link.owner} nodes' ${link.field} first (earlier in the same batch works)`,
                ],
              });
          }
        }
        // the product layer starts from ONE bubble: the product itself. A second
        // top-level product bubble is a capability that forgot its parent.
        if (layer === "product" && n.parentId === null) {
          const root = doc.nodes.find(
            (other) => other.id !== n.id && other.parentId === null && layerOf(other) === "product",
          );
          if (root)
            return reject("op/second-root", `the product layer already starts from "${root.id}"`, {
              at: "/node/parentId",
              id: n.id,
              label: n.label,
              evidence: { rootId: root.id, rootLabel: root.label },
              fixes: [
                `set parentId to "${root.id}" — the product bubble everything else hangs under`,
                `make this a child of one of "${root.id}"'s capabilities instead`,
              ],
            });
        }
        const clean: IntentNode = {
          id: n.id,
          parentId: n.parentId,
          label: n.label,
          summary: n.summary,
          phase: n.phase,
          ...(typeof n.status === "string" && n.status.trim().length > 0 ? { status: n.status } : {}),
          ...(n.modelRole !== undefined && MODEL_ROLES.includes(n.modelRole) ? { modelRole: n.modelRole } : {}),
          ...(n.kind !== undefined && NODE_KINDS.includes(n.kind) ? { kind: n.kind } : {}),
          ...(Array.isArray(n.codeRefs) ? { codeRefs: n.codeRefs.filter((r) => typeof r === "string") } : {}),
          // build is the default layer, so it is stored as the absence of a marker
          ...(layer === "build" ? {} : { layer }),
        };
        // the cross-layer links each live on exactly one layer, and each sticks
        // across an upsert that omits it
        for (const link of BUILD_LINKS) {
          const list = n[link.field];
          if (layer === link.owner && Array.isArray(list)) clean[link.field] = [...list];
        }
        if (prior) {
          Object.assign(prior, clean);
          // status is "what's happening NOW" — an upsert that omits it clears it
          if (clean.status === undefined) delete prior.status;
          if (clean.layer === undefined) delete prior.layer;
          // the cross-layer links only exist on the layer that owns them
          for (const link of BUILD_LINKS) if (layer !== link.owner) delete prior[link.field];
        }
        else {
          doc.nodes.push(clean);
          nodeById.set(clean.id, clean);
        }
        applied++;
        return;
      }
      case "remove_node": {
        const node = nodeById.get(raw.id);
        if (!node)
          return reject("op/unknown-node", `node "${raw.id}" does not exist`, {
            at: "/id",
            evidence: { id: raw.id, knownNodeIds: sample(nodeById.keys()) },
            fixes: ["use an existing node id", "drop this op if the node is already gone"],
          });
        const children = doc.nodes.filter((n) => n.parentId === raw.id).map((n) => n.id);
        if (children.length > 0)
          return reject("op/has-children", `node "${raw.id}" has children; remove or re-parent them first`, {
            at: "/id",
            id: node.id,
            label: node.label,
            evidence: { children: sample(children) },
            fixes: ["remove or re-parent the listed children first (earlier in the same batch works)"],
          });
        for (const link of BUILD_LINKS) {
          const holders = doc.nodes
            .filter((other) => layerOf(other) === link.owner && other[link.field]?.includes(raw.id))
            .map((other) => other.id);
          if (holders.length > 0)
            return reject(link.code, `node "${raw.id}" is still listed in another node's ${link.field}`, {
              at: "/id",
              id: node.id,
              label: node.label,
              evidence: { [link.key]: sample(holders) },
              fixes: [
                `drop this id from the listed ${link.owner} nodes' ${link.field} first (earlier in the same batch works)`,
                `remove those ${link.owner} nodes instead if the ${link.holds} is gone too`,
              ],
            });
        }
        doc.nodes.splice(doc.nodes.indexOf(node), 1);
        nodeById.delete(raw.id);
        for (const e of [...doc.edges]) {
          if (e.source === raw.id || e.target === raw.id) {
            doc.edges.splice(doc.edges.indexOf(e), 1);
            edgeById.delete(e.id);
          }
        }
        delete doc.drift[raw.id];
        applied++;
        return;
      }
      case "upsert_edge": {
        const e = raw.edge;
        if (!e || typeof e !== "object")
          return reject("op/missing-edge", "missing edge", {
            at: "/edge",
            evidence: { edge: e ?? null },
            fixes: ["provide an `edge` object with id, source, target, kind"],
          });
        if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9-]*(--[a-z0-9][a-z0-9-]*)?$/.test(e.id))
          return reject("op/bad-slug", `bad edge id ${JSON.stringify(e?.id)}`, {
            at: "/edge/id",
            evidence: { id: e.id ?? null },
            fixes: ['use a "source--target" style slug, e.g. "auth-service--user-db"'],
          });
        const source = nodeById.get(e.source);
        const target = nodeById.get(e.target);
        if (!source)
          return reject("op/unknown-endpoint", `edge source "${e.source}" does not exist`, {
            at: "/edge/source",
            id: e.id,
            evidence: { role: "source", nodeId: e.source, knownNodeIds: sample(nodeById.keys()) },
            fixes: ["use an existing node id as source", "upsert the missing node earlier in the same batch"],
          });
        if (!target)
          return reject("op/unknown-endpoint", `edge target "${e.target}" does not exist`, {
            at: "/edge/target",
            id: e.id,
            evidence: { role: "target", nodeId: e.target, knownNodeIds: sample(nodeById.keys()) },
            fixes: ["use an existing node id as target", "upsert the missing node earlier in the same batch"],
          });
        if (layerOf(source) !== layerOf(target))
          return reject("op/cross-layer-edge", "an edge cannot cross between the product, build, infra and correctness layers", {
            at: "/edge",
            id: e.id,
            evidence: {
              source: e.source,
              sourceLayer: layerOf(source),
              target: e.target,
              targetLayer: layerOf(target),
            },
            fixes: [
              "connect two bubbles on the same layer",
              "link layers with `realizes` on the product node, `hosts` on the infra node or `verifies` on the correctness node instead",
            ],
          });
        if (e.source === e.target)
          return reject("op/self-edge", "self-edges are not allowed", {
            at: "/edge",
            id: e.id,
            evidence: { source: e.source },
            fixes: ["connect two different nodes", "drop the op — containment is parentId, not an edge"],
          });
        if (!EDGE_KINDS.includes(e.kind))
          return reject("op/bad-edge-kind", `bad edge kind "${e.kind}"`, {
            at: "/edge/kind",
            id: e.id,
            evidence: { kind: e.kind ?? null, allowed: EDGE_KINDS },
            fixes: [`choose one of: ${EDGE_KINDS.join(", ")}`],
          });
        if (e.label !== undefined && (typeof e.label !== "string" || e.label.length > 60))
          return reject("op/bad-edge-label", "edge label <= 60 chars", {
            at: "/edge/label",
            id: e.id,
            evidence: { length: typeof e.label === "string" ? e.label.length : 0 },
            fixes: ["use a label of at most 60 characters, or omit it"],
          });
        const clean: GraphEdge = {
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
          ...(e.label !== undefined ? { label: e.label } : {}),
        };
        const existing = edgeById.get(e.id);
        if (existing) Object.assign(existing, clean);
        else {
          doc.edges.push(clean);
          edgeById.set(clean.id, clean);
        }
        applied++;
        return;
      }
      case "remove_edge": {
        const edge = edgeById.get(raw.id);
        if (!edge)
          return reject("op/unknown-edge", `edge "${raw.id}" does not exist`, {
            at: "/id",
            evidence: { id: raw.id, knownEdgeIds: sample(edgeById.keys()) },
            fixes: ["use an existing edge id", "drop this op if the edge is already gone"],
          });
        doc.edges.splice(doc.edges.indexOf(edge), 1);
        edgeById.delete(raw.id);
        applied++;
        return;
      }
      case "set_phase": {
        const node = nodeById.get(raw.id);
        if (!node)
          return reject("op/unknown-node", `node "${raw.id}" does not exist`, {
            at: "/id",
            evidence: { id: raw.id, knownNodeIds: sample(nodeById.keys()) },
            fixes: ["use an existing node id", "upsert the node first"],
          });
        if (!PHASES.includes(raw.phase))
          return reject("op/bad-phase", `bad phase "${raw.phase}"`, {
            at: "/phase",
            id: node.id,
            label: node.label,
            evidence: { phase: raw.phase ?? null, allowed: PHASES },
            fixes: [`choose one of: ${PHASES.join(", ")}`],
          });
        node.phase = raw.phase;
        applied++;
        return;
      }
      default: {
        const u: unknown = raw;
        const name = u !== null && typeof u === "object" && "op" in u ? String(u.op) : "missing";
        return reject("op/unknown-op", `unknown op "${name}"`, {
          at: "/op",
          evidence: { op: name, supported: ["upsert_node", "remove_node", "upsert_edge", "remove_edge", "set_phase"] },
          fixes: ["use one of: upsert_node, remove_node, upsert_edge, remove_edge, set_phase"],
        });
      }
    }
  });

  if (applied > 0) doc.rev++;
  return { applied, rejections };
}

// ---------------------------------------------------------------------------
// WebSocket protocol (bridge <-> browser)
// ---------------------------------------------------------------------------

export const BRIDGE_PORT = 4400;
/** browsers */
export const BRIDGE_WS_PATH = "/ws";
/** harness-side processes (MCP server, hooks) → the agent, loopback only */
export const LINK_WS_PATH = "/link";
/** agents → a Shape server (remote mode) */
export const AGENT_WS_PATH = "/agent";

/**
 * One git worktree of the target's repository — one architecture variation,
 * with its own canvas state and (when the user opened one) its own harness.
 * Every worktree of a repo shares the project key, so the canvas can merge
 * them; `id` is what tells them apart on the wire and in storage.
 */
export interface WorktreeInfo {
  /**
   * Stable identity of this worktree: the realpath of its directory. Symlinked
   * and relative spellings of the same directory must be one worktree, or the
   * same canvas would be stored twice.
   */
  id: string;
  /** absolute worktree directory as git reports it */
  path: string;
  /** checked-out branch, or null when detached */
  branch: string | null;
  /** commit the worktree is at, null when unborn */
  head: string | null;
}

// ---------------------------------------------------------------------------
// Session discovery / adopt
// ---------------------------------------------------------------------------

/**
 * A coding agent Shape knows how to look for. Harness ids ARE backend ids: a
 * discovered `claude` session adopts onto the `claude` backend, and a harness
 * with no adapter registered is rejected by name.
 */
export type Harness = "omp" | "claude" | "codex" | "opencode" | "cursor";

/**
 * A harness Shape can LAUNCH, by the id the "start a session" card, the
 * `--backend` flag and `.shape/config.json` all spell it with.
 *
 * Deliberately a different set from `Harness` above: that one classifies
 * RUNNING processes for adoption (an older, smaller list that spells Cursor's
 * CLI "cursor"), while these are the ids Shape knows a harness by. Detection
 * (bridge agent/detect.ts) reports which of them is installed on the machine;
 * nothing starts one.
 */
export type HarnessId =
  | "omp"
  | "claude"
  | "codex"
  | "opencode"
  | "gemini"
  | "cursor-agent"
  | "amp"
  | "copilot";

/** one agent session already running on this machine (bridge/src/discover.ts) */
export interface DiscoveredSession {
  harness: Harness;
  pid: number;
  command: string;
  cwd: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  startedAt: string | null;
  resumeCommand: string[] | null;
  attach: "socket" | "daemon" | "http" | "none";
}

/**
 * What the bridge knows about the harness it is observing. The client renders
 * from this instead of assuming omp: `terminal: "none"` hides the "go to
 * terminal" affordance.
 */
export interface BackendCapabilities {
  /** whether a message could be injected into a running turn — always false: Shape sends none */
  steerMidTurn: boolean;
  /** the harness can call a host-provided tool (the canvas) */
  hostTool: boolean;
  /** how the bridge learns what the agent is doing */
  events: "native" | "hooks" | "transcript" | "none";
  /** a previous session can be resumed */
  resume: boolean;
  /**
   * Where the harness's terminal is. `external` ⇒ it runs in the user's own
   * terminal (a herdr tab): Shape can ask for it to be focused. `none` ⇒ there
   * is no way to reach it (no herdr, or a remote agent).
   */
  terminal: "external" | "none";
}

/**
 * One tool Shape found on the agent's machine — a launcher (herdr) or a coding
 * harness (omp, claude, …). `path` is what would be executed; `version` is
 * null when the tool answered `--version` with nothing usable, which is a
 * detected tool all the same.
 */
export interface ToolInfo {
  id: string;
  /** what the picker shows: the tool's own name, not its path */
  label: string;
  path: string;
  version: string | null;
}

/**
 * What is installed where this project's agent runs. Project-wide, not per
 * worktree: one agent process sees one PATH. `launcher` is herdr when it is
 * installed and its socket answers — the one way Shape can reach a session's
 * terminal — else null.
 */
export interface ProjectTools {
  launcher: "herdr" | null;
  launchers: ToolInfo[];
  /** every harness detected on PATH */
  harnesses: ToolInfo[];
}

/**
 * The project's manager session in the user's herdr, as Shape attached to it:
 * one `omp` tab per project, prompted to act as the manager, whose harness
 * config Shape keeps pointed at this bridge. Null when there is none — no
 * herdr, or Shape could not find or open one (issue #3).
 */
export interface ManagerHandle {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agentName: string;
  /** "found": a manager tab was already there; "opened": Shape opened one */
  origin: "found" | "opened";
  /** the pane is linked to this bridge's loopback link (Shape extension loaded) */
  shapeAware: boolean;
}

export interface BackendInfo {
  id: string;
  label: string;
  capabilities: BackendCapabilities;
}

/**
 * What the browser knows about the project as a whole. The harness facts that
 * used to live here (session id, model, backend) are per worktree now and live
 * in `sessions`: one project has as many sessions as worktrees with a harness
 * reporting in, and none of them is "the" session.
 */
export interface SessionInfo {
  /** the MAIN worktree's path — the project's label and its default target */
  cwd: string;
  /** target repo already contains source code (automatic map gate) */
  targetHasCode: boolean;
  /**
   * every worktree of the target's repo (`git worktree list`), each an
   * architecture variation with its own canvas state; a non-git target has the
   * single pseudo-worktree of its own directory.
   */
  worktrees: WorktreeInfo[];
  /**
   * the harnesses reporting in right now, one per worktree with a session on
   * the link. A worktree with no entry here is visible on the canvas; nothing
   * is running in it that Shape can see.
   */
  sessions: WorktreeSession[];
  /** an agent is attached to this project right now; false ⇒ the picture is frozen */
  agentConnected: boolean;
  /**
   * Where a launcher can read Shape's directive for this project — the file
   * the agent wrote naming the link URL and the `canvas` contract, e.g. to
   * append to a builder's brief. Null when the agent could not write it.
   */
  directivePath: string | null;
  /**
   * The manager session Shape found or opened for this project, or null when
   * the project has none (its launcher is not herdr, or the manager could not
   * be reached). Absent on the wire from an older agent ⇒ null.
   */
  manager: ManagerHandle | null;
}

/** one project the server knows, for the picker */
export interface ProjectSummary {
  projectId: string;
  label: string;
  cwd: string;
  /** backend id of the agent that last attached */
  harness: string;
  agentConnected: boolean;
  /** ISO time of the last attach or detach */
  lastSeen: string;
}

export type AgentState = "idle" | "streaming" | "compacting";

/**
 * Bridge → browser. Every frame that is about ONE worktree names it: the
 * canvas merges the worktrees of a repo into one view, so a graph or a state
 * that did not say where it came from could not be placed. Project-wide
 * frames (`session`, `projects`, `sessions`, `error`) carry none.
 */
export type ServerMsg =
  | {
      type: "hello";
      /** every worktree's canvas, keyed by worktree id; the view merges them */
      graphs: Record<string, GraphDoc>;
      session: SessionInfo;
      /** what each worktree's harness is doing; a worktree with no session has no entry */
      agents: Record<string, AgentState>;
      recentProjects: string[];
      /** every project this server hosts; local mode has exactly one */
      projects: ProjectSummary[];
      /** the project this socket is joined to */
      projectId: string;
      /** available snapshots per worktree, each ascending by rev */
      revisions: Record<string, RevisionInfo[]>;
      /** agent sessions running on this machine, newest first */
      sessions: DiscoveredSession[];
      /** what is installed where this project's agent runs */
      tools: ProjectTools;
    }
  | { type: "graph"; worktree: string; graph: GraphDoc }
  | { type: "agent"; worktree: string; state: AgentState }
  /** session facts changed without any graph changing (agent attached/detached, worktrees appeared) — no client state reset */
  | { type: "session"; session: SessionInfo }
  /** a harness started reporting in from `worktree` */
  | { type: "session_started"; worktree: string; session: AgentSession; backend: BackendInfo }
  /** that worktree's harness is gone */
  | { type: "session_stopped"; worktree: string; reason: string }
  /** broadcast whenever the project list changes (attach, detach) */
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "activity"; worktree: string; nodeIds: string[] }
  | { type: "transcript"; worktree: string; role: "assistant" | "user" | "tool"; text: string }
  /** broadcast whenever a new snapshot is written; ascending by rev */
  | { type: "revisions"; worktree: string; revisions: RevisionInfo[] }
  /** broadcast reply to a `diff` request, over the worktree it asked about */
  | { type: "delta"; worktree: string; delta: GraphDelta }
  /** broadcast answer to `discover`, and re-broadcast whenever the bridge re-scans */
  | { type: "sessions"; sessions: DiscoveredSession[] }
  /**
   * The sentence being written right now, folded from the harness's text
   * deltas — the last of it, throttled, and never stored. `null` at the end of
   * a turn (and when the session stops): there is nothing being said.
   */
  | { type: "now"; worktree: string; text: string | null }
  /**
   * The folder the user chose in the native chooser a `pick_folder` opened, or
   * `null` when they closed it without choosing. An answer, not news: it goes
   * to the socket that asked and to nobody else — another browser watching the
   * project did not open a dialog and has nothing to do with the reply.
   */
  | { type: "folder_picked"; path: string | null }
  | { type: "error"; message: string };

/**
 * Browser → bridge. Shape is a read-only picture: nothing here instructs,
 * starts, stops or types into an agent. What the browser can ask for is which
 * project to look at, another look at what is running, a comparison of two
 * snapshots, and — under herdr — for a session's own terminal to be raised.
 * A frame that acts on a canvas names the worktree it acts on: with several
 * worktrees merged into one view, "the current one" is a property of the
 * click, not of the connection.
 */
export type ClientMsg =
  /** ask THIS project's agent to retarget onto `path` (local mode; the agent decides) */
  | { type: "switch_project"; path: string }
  /**
   * Show the native folder chooser on the machine this project's agent runs
   * on, and answer this socket with `folder_picked`. It lives over the wire
   * because no web API hands a browser an absolute path: the folder the user
   * points at is only a path on the machine the dialog opened on.
   */
  | { type: "pick_folder" }
  /** join another project this server hosts; answered with a fresh `hello` to this socket only */
  | { type: "select_project"; projectId: string }
  /** take the user to the harness's terminal: its herdr tab is switched to and the app raised */
  | { type: "focus_terminal"; worktree: string }
  /** compare two snapshots of one worktree; `revA` = before, `revB` = after. Unknown rev → `error` frame */
  | { type: "diff"; worktree: string; revA: number; revB: number }
  /** re-scan running agent sessions; answered with a `sessions` broadcast */
  | { type: "discover" }
  /** retarget this bridge onto the repo a discovered session (by pid) runs in, and watch it there */
  | { type: "adopt"; pid: number };
