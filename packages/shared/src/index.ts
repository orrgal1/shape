/**
 * Shape shared contract — the machine-readable half of ../../../CONTRACTS.md.
 *
 * Imported by RELATIVE PATH with explicit .ts extension from both the bridge
 * (Node 26 type-stripping) and the web client (Vite). Must remain erasable-syntax
 * TypeScript (no enums, no namespaces) and dependency-free.
 */

import type { PtyClientMsg, PtyServerMsg } from "./pty.ts";

export type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentToServerMsg,
  LinkClientMsg,
  LinkServerMsg,
  ServerToAgentMsg,
} from "./link.ts";
export type { PtyClientMsg, PtyServerMsg } from "./pty.ts";

// ---------------------------------------------------------------------------
// Graph document
// ---------------------------------------------------------------------------

export type Phase = "idea" | "concept" | "component" | "building" | "built" | "failed";
export type EdgeKind = "depends" | "dataflow" | "relates";
export type ModelRole = "explore" | "build" | "small";
export type NodeKind = "ui" | "service" | "api" | "store" | "queue" | "external" | "security";
/**
 * Which half of the canvas a bubble lives on. "product" bubbles are the
 * capabilities a person gets; "build" bubbles are the parts that exist as code.
 */
export type Layer = "product" | "build";

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

export interface RealityLayer {
  nodes: RealityNode[];
  edges: RealityEdge[];
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
}

export function emptyGraph(): GraphDoc {
  return {
    rev: 0,
    nodes: [],
    edges: [],
    reality: { nodes: [], edges: [], extractedAt: null, head: null },
    drift: {},
  };
}

// ---------------------------------------------------------------------------
// Layers: product (capabilities) and build (parts that exist as code)
// ---------------------------------------------------------------------------

export const LAYERS: readonly Layer[] = ["product", "build"];

/** A bubble with no `layer` is a build bubble — every graph written before layers existed. */
export function layerOf(node: Pick<IntentNode, "layer">): Layer {
  return node.layer === "product" ? "product" : "build";
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
  const chain = new Set<string>();
  let cur: IntentNode | undefined = start;
  while (cur && !chain.has(cur.id)) {
    chain.add(cur.id);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  const out: string[] = [];
  for (const node of doc.nodes) {
    if (layerOf(node) !== "product" || !node.realizes) continue;
    if (node.realizes.some((id) => chain.has(id))) out.push(node.id);
  }
  return out;
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
}

export const PHASES: readonly Phase[] = ["idea", "concept", "component", "building", "built", "failed"];
export const EDGE_KINDS: readonly EdgeKind[] = ["depends", "dataflow", "relates"];
export const MODEL_ROLES: readonly ModelRole[] = ["explore", "build", "small"];
export const NODE_KINDS: readonly NodeKind[] = ["ui", "service", "api", "store", "queue", "external", "security"];

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Description of the `canvas` tool, shared by both channels it is exposed
 * through: the host tool a native adapter registers, and the MCP server the
 * link ships. One text, or the two channels would drift apart.
 */
export const CANVAS_TOOL_DESCRIPTION = `Maintain the visual canvas the user is watching — this is their only view of your work.

ops (batch, applied per-op): upsert_node, remove_node (rejected while it has children), upsert_edge, remove_edge, set_phase.
ids are slugs: ^[a-z0-9][a-z0-9-]*$. Node summary is REQUIRED: one sentence stating what the bubble promises, <= 200 chars; a bubble that cannot be summarized in one sentence is at the wrong altitude.
Hierarchy is parentId (null = root); edges are ONLY non-hierarchical relations (depends | dataflow | relates) — never an edge to mean "contains". A parent and both ends of an edge must be on the same layer.
Phases: idea -> concept -> component -> building -> built | failed. Set codeRefs (workspace-relative path prefixes) once a bubble owns files.
TWO LAYERS, set with layer on each node. layer "product" = what the person gets: the capabilities and surfaces they can name and use, no file names. layer "build" (the default when layer is omitted) = the parts that exist as code: services, stores, screens, jobs. realizes (product nodes only, up to 20 existing build node ids) is the ONLY link between the layers — it says which build bubbles make that capability real; keep it current as build bubbles appear, and give every capability at least one.
THE PRODUCT LAYER STARTS FROM ONE BUBBLE: the product itself, the only product node with parentId null — its label is the product's name and its summary the one-sentence promise of the whole thing. Create it before anything else, then hang the 3-5 capabilities under it as its children, and deeper capabilities under those. A second top-level product bubble is rejected with op/second-root, whose evidence names the root to parent it under. The root spans the whole build layer, so realizes on it is optional; every capability below it still needs one.
summary = the bubble's stable promise. status (optional, <= 140 chars) = what is happening in it RIGHT NOW; refresh it on bubbles you are building and omit it when done — an upsert without status clears it.
PLAIN ENGLISH, NO JARGON: every label, summary, status, edge label and note is read by a non-programmer steering by voice — everyday words, outcomes not mechanisms, no acronyms or protocol/library/file-format names or code identifiers unless the bubble is literally about that thing. Only codeRefs stay technical.
Call this as you think and work, in the same turn your understanding changes. The result tells you what applied; rejections come back as JSON repair receipts ({code, subject, evidence, supportedFixes}) — apply a supported fix and resend just the rejected ops.`;

/** JSON-Schema sent to omp via set_host_tools. */
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
        const layer: Layer =
          askedLayer === "product" || askedLayer === "build" ? askedLayer : prior ? layerOf(prior) : "build";
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
          return reject("op/cross-layer-parent", `parent "${n.parentId}" is on the other layer`, {
            at: "/node/parentId",
            id: n.id,
            label: n.label,
            evidence: { parentId: n.parentId, nodeLayer: layer, parentLayer: layerOf(parent) },
            fixes: [
              `pick a parent that is also on the ${layer} layer`,
              "set parentId to null to make this a root bubble",
              "link the two layers with `realizes` on the product node instead",
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
              "drop realizes from this build node",
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
              return bad(`realizes target "${id}" is a product node, not a build node`, { nodeId: id, targetLayer: "product" }, [
                "point realizes at the build bubbles that make this capability real",
                "drop that id from realizes",
              ]);
          }
        }
        if (prior && layerOf(prior) === "build" && layer === "product") {
          const servedProducts = doc.nodes
            .filter((other) => layerOf(other) === "product" && other.realizes?.includes(n.id))
            .map((other) => other.id);
          if (servedProducts.length > 0)
            return reject("op/node-realized", `build node "${n.id}" is still listed in another node's realizes`, {
              at: "/node/layer",
              id: n.id,
              label: n.label,
              evidence: { realizedBy: sample(servedProducts) },
              fixes: ["drop this id from the listed product nodes' realizes first (earlier in the same batch works)"],
            });
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
          ...(layer === "product" ? { layer } : {}),
          ...(layer === "product" && Array.isArray(n.realizes) ? { realizes: [...n.realizes] } : {}),
        };
        if (prior) {
          Object.assign(prior, clean);
          // status is "what's happening NOW" — an upsert that omits it clears it
          if (clean.status === undefined) delete prior.status;
          if (clean.layer === undefined) delete prior.layer;
          if (layer !== "product") delete prior.realizes;
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
        const realizedBy = doc.nodes
          .filter((other) => layerOf(other) === "product" && other.realizes?.includes(raw.id))
          .map((other) => other.id);
        if (realizedBy.length > 0)
          return reject("op/node-realized", `node "${raw.id}" is still listed in another node's realizes`, {
            at: "/id",
            id: node.id,
            label: node.label,
            evidence: { realizedBy: sample(realizedBy) },
            fixes: [
              "drop this id from the listed product nodes' realizes first (earlier in the same batch works)",
              "remove those product nodes instead if the capability is gone too",
            ],
          });
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
          return reject("op/cross-layer-edge", "an edge cannot cross between the product and build layers", {
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
              "link the layers with `realizes` on the product node instead",
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

/** one git worktree of the current target's repository */
export interface WorktreeInfo {
  /** absolute worktree directory */
  path: string;
  /** checked-out branch, or null when detached */
  branch: string | null;
  /** commit the worktree is at, null when unborn */
  head: string | null;
  /** true for the worktree the bridge currently targets */
  current: boolean;
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
  /** omp child spawned by a Shape bridge (`omp --mode rpc` under packages/bridge). */
  spawnedByShape: boolean;
}

/**
 * What the bridge can do with the backend it is driving. The client renders
 * from this instead of assuming omp: a backend that cannot steer mid-turn
 * queues instead, one with `terminal: "none"` hides the terminal pane.
 */
export interface BackendCapabilities {
  /** a message can be injected into a running turn */
  steerMidTurn: boolean;
  /** the harness can call a host-provided tool (the canvas) */
  hostTool: boolean;
  /** how the bridge learns what the agent is doing */
  events: "native" | "hooks" | "transcript" | "none";
  /** a previous session can be resumed */
  resume: boolean;
  /** what a terminal pane would attach to */
  terminal: "tui" | "shell" | "none";
}

export interface BackendInfo {
  id: string;
  label: string;
  capabilities: BackendCapabilities;
}

export interface SessionInfo {
  sessionId: string | null;
  sessionName: string | null;
  model: { provider: string; id: string } | null;
  cwd: string;
  /** target repo already contains source code (onboarding CTA gate) */
  targetHasCode: boolean;
  /**
   * worktrees of the target's repo (`git worktree list`), each an architecture
   * variation with its own canvas state; empty for non-git targets. Toggling =
   * `switch_project` to a worktree's path.
   */
  worktrees: WorktreeInfo[];
  /** the harness this session is running on, and what it can do */
  backend: BackendInfo;
  /**
   * an agent is attached to this project right now. False ⇒ the canvas is
   * read-only: steering, onboarding and the terminal are refused with a reason.
   */
  agentConnected: boolean;
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

export interface Referent {
  kind: "node" | "edge";
  id: string;
}

export type ServerMsg =
  | {
      type: "hello";
      graph: GraphDoc;
      session: SessionInfo;
      agent: AgentState;
      recentProjects: string[];
      /** every project this server hosts; local mode has exactly one */
      projects: ProjectSummary[];
      /** the project this socket is joined to */
      projectId: string;
      /** available snapshots, ascending by rev */
      revisions: RevisionInfo[];
      /** agent sessions running on this machine, newest first; Shape's own children excluded */
      sessions: DiscoveredSession[];
    }
  | { type: "graph"; graph: GraphDoc }
  | { type: "agent"; state: AgentState }
  /** session facts changed without the graph changing (agent attached/detached, harness session id) — no client state reset */
  | { type: "session"; session: SessionInfo }
  /** broadcast whenever the project list changes (attach, detach) */
  | { type: "projects"; projects: ProjectSummary[] }
  | { type: "activity"; nodeIds: string[] }
  | { type: "transcript"; role: "assistant" | "user" | "tool"; text: string }
  /** broadcast whenever a new snapshot is written; ascending by rev */
  | { type: "revisions"; revisions: RevisionInfo[] }
  /** broadcast reply to a `diff` request */
  | { type: "delta"; delta: GraphDelta }
  /** broadcast answer to `discover`, and re-broadcast whenever the bridge re-scans */
  | { type: "sessions"; sessions: DiscoveredSession[] }
  | { type: "error"; message: string }
  | PtyServerMsg;

export type ClientMsg =
  | { type: "utterance"; referent: Referent | null; text: string }
  | { type: "onboard"; focus?: string }
  /** ask THIS project's agent to retarget onto `path` (local mode; the agent decides) */
  | { type: "switch_project"; path: string }
  /** join another project this server hosts; answered with a fresh `hello` to this socket only */
  | { type: "select_project"; projectId: string }
  /** compare two snapshots; `revA` = before, `revB` = after. Unknown rev → `error` frame */
  | { type: "diff"; revA: number; revB: number }
  | { type: "abort" }
  /** re-scan running agent sessions; answered with a `sessions` broadcast */
  | { type: "discover" }
  /** retarget this bridge onto a discovered session (by pid), resuming it when it has an id */
  | { type: "adopt"; pid: number }
  | PtyClientMsg;
