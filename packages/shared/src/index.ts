/**
 * visual-harness shared contract — the machine-readable half of ../../../CONTRACTS.md.
 *
 * Imported by RELATIVE PATH with explicit .ts extension from both the bridge
 * (Node 26 type-stripping) and the web client (Vite). Must remain erasable-syntax
 * TypeScript (no enums, no namespaces) and dependency-free.
 */

// ---------------------------------------------------------------------------
// Graph document
// ---------------------------------------------------------------------------

export type Phase = "idea" | "concept" | "component" | "building" | "built" | "failed";
export type EdgeKind = "depends" | "dataflow" | "relates";
export type ModelRole = "explore" | "build" | "small";
export type NodeKind = "ui" | "service" | "api" | "store" | "queue" | "external" | "security";

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
        if (n.parentId !== null && !nodeById.has(n.parentId))
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
        };
        const existing = nodeById.get(n.id);
        if (existing) {
          Object.assign(existing, clean);
          // status is "what's happening NOW" — an upsert that omits it clears it
          if (clean.status === undefined) delete existing.status;
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
        if (!nodeById.has(e.source))
          return reject("op/unknown-endpoint", `edge source "${e.source}" does not exist`, {
            at: "/edge/source",
            id: e.id,
            evidence: { role: "source", nodeId: e.source, knownNodeIds: sample(nodeById.keys()) },
            fixes: ["use an existing node id as source", "upsert the missing node earlier in the same batch"],
          });
        if (!nodeById.has(e.target))
          return reject("op/unknown-endpoint", `edge target "${e.target}" does not exist`, {
            at: "/edge/target",
            id: e.id,
            evidence: { role: "target", nodeId: e.target, knownNodeIds: sample(nodeById.keys()) },
            fixes: ["use an existing node id as target", "upsert the missing node earlier in the same batch"],
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
export const BRIDGE_WS_PATH = "/ws";

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
}

export type AgentState = "idle" | "streaming" | "compacting";

export interface Referent {
  kind: "node" | "edge";
  id: string;
}

export type ServerMsg =
  | { type: "hello"; graph: GraphDoc; session: SessionInfo; agent: AgentState; recentProjects: string[] }
  | { type: "graph"; graph: GraphDoc }
  | { type: "agent"; state: AgentState }
  | { type: "activity"; nodeIds: string[] }
  | { type: "transcript"; role: "assistant" | "user" | "tool"; text: string }
  | { type: "error"; message: string };

export type ClientMsg =
  | { type: "utterance"; referent: Referent | null; text: string }
  | { type: "onboard"; focus?: string }
  | { type: "switch_project"; path: string }
  | { type: "abort" };
