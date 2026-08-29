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

export interface OpRejection {
  index: number;
  reason: string;
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

  ops.forEach((raw, index) => {
    const reject = (reason: string) => rejections.push({ index, reason });
    switch (raw?.op) {
      case "upsert_node": {
        const n = raw.node;
        if (!n || typeof n !== "object") return reject("missing node");
        if (typeof n.id !== "string" || !NODE_ID_RE.test(n.id)) return reject(`bad node id ${JSON.stringify(n?.id)}: want ^[a-z0-9][a-z0-9-]*$`);
        if (n.parentId !== null && !nodeById.has(n.parentId)) return reject(`parent "${n.parentId}" does not exist`);
        if (n.parentId !== null && wouldCycle(n.id, n.parentId)) return reject(`parent "${n.parentId}" would create a cycle`);
        if (typeof n.label !== "string" || n.label.length === 0 || n.label.length > 60) return reject("label required, <= 60 chars");
        if (typeof n.summary !== "string" || n.summary.trim().length === 0 || n.summary.length > 200)
          return reject("summary (the node's one-sentence promise) required, <= 200 chars");
        if (!PHASES.includes(n.phase)) return reject(`bad phase "${n.phase}"`);
        if (n.status !== undefined && (typeof n.status !== "string" || n.status.length > 140)) return reject("status <= 140 chars");
        const clean: IntentNode = {
          id: n.id,
          parentId: n.parentId,
          label: n.label,
          summary: n.summary,
          phase: n.phase,
          ...(typeof n.status === "string" && n.status.trim().length > 0 ? { status: n.status } : {}),
          ...(n.modelRole !== undefined && MODEL_ROLES.includes(n.modelRole) ? { modelRole: n.modelRole } : {}),
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
        if (!node) return reject(`node "${raw.id}" does not exist`);
        if (doc.nodes.some((n) => n.parentId === raw.id)) return reject(`node "${raw.id}" has children; remove or re-parent them first`);
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
        if (!e || typeof e !== "object") return reject("missing edge");
        if (typeof e.id !== "string" || !/^[a-z0-9][a-z0-9-]*(--[a-z0-9][a-z0-9-]*)?$/.test(e.id)) return reject(`bad edge id ${JSON.stringify(e?.id)}`);
        if (!nodeById.has(e.source)) return reject(`edge source "${e.source}" does not exist`);
        if (!nodeById.has(e.target)) return reject(`edge target "${e.target}" does not exist`);
        if (e.source === e.target) return reject("self-edges are not allowed");
        if (!EDGE_KINDS.includes(e.kind)) return reject(`bad edge kind "${e.kind}"`);
        if (e.label !== undefined && (typeof e.label !== "string" || e.label.length > 60)) return reject("edge label <= 60 chars");
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
        if (!edge) return reject(`edge "${raw.id}" does not exist`);
        doc.edges.splice(doc.edges.indexOf(edge), 1);
        edgeById.delete(raw.id);
        applied++;
        return;
      }
      case "set_phase": {
        const node = nodeById.get(raw.id);
        if (!node) return reject(`node "${raw.id}" does not exist`);
        if (!PHASES.includes(raw.phase)) return reject(`bad phase "${raw.phase}"`);
        node.phase = raw.phase;
        applied++;
        return;
      }
      default: {
        const u: unknown = raw;
        const name = u !== null && typeof u === "object" && "op" in u ? String(u.op) : "missing";
        return reject(`unknown op "${name}"`);
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
