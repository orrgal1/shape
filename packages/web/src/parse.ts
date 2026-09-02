/**
 * The one network boundary of this package: JSON off the bridge socket in,
 * `ServerMsg` (or null) out. Nothing else in the app inspects untrusted shapes,
 * and `isRecord` lives here only — this is the package's canonical guard module.
 */
import {
  EDGE_KINDS,
  MODEL_ROLES,
  PHASES,
  type AgentState,
  type BackendInfo,
  type DiscoveredSession,
  type DriftMap,
  type EdgeKind,
  type EntityDelta,
  type GraphDelta,
  type GraphDoc,
  type GraphEdge,
  type Harness,
  type IntentNode,
  type ModelRole,
  type Phase,
  type RealityEdge,
  type RealityLayer,
  type RealityNode,
  type RevisionInfo,
  type ServerMsg,
  type SessionInfo,
  type WorktreeInfo,
} from "../../shared/src/index.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Nullable string field. Returns `undefined` for "present but wrong type", so
 * callers can tell a legitimate null apart from a contract violation.
 */
function asNullableStr(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function asStrArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** narrow to one of a closed literal union without casting */
function asPhase(value: unknown): Phase | null {
  for (const phase of PHASES) if (phase === value) return phase;
  return null;
}

function asEdgeKind(value: unknown): EdgeKind | null {
  for (const kind of EDGE_KINDS) if (kind === value) return kind;
  return null;
}

function asModelRole(value: unknown): ModelRole | null {
  for (const role of MODEL_ROLES) if (role === value) return role;
  return null;
}

const AGENT_STATES: readonly AgentState[] = ["idle", "streaming", "compacting"];

function asAgentState(value: unknown): AgentState | null {
  for (const state of AGENT_STATES) if (state === value) return state;
  return null;
}

const TRANSCRIPT_ROLES = ["assistant", "user", "tool"] as const;

function asTranscriptRole(value: unknown): (typeof TRANSCRIPT_ROLES)[number] | null {
  for (const role of TRANSCRIPT_ROLES) if (role === value) return role;
  return null;
}

/** all-or-nothing list parse: one bad element invalidates the frame */
function mapAll<T>(value: unknown, one: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const item of value) {
    const parsed = one(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function asIntentNode(value: unknown): IntentNode | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const label = asStr(value.label);
  const summary = asStr(value.summary);
  const phase = asPhase(value.phase);
  const parentId = asNullableStr(value.parentId);
  if (id === null || label === null || summary === null || phase === null || parentId === undefined) {
    return null;
  }
  const node: IntentNode = { id, parentId, label, summary, phase };
  const modelRole = asModelRole(value.modelRole);
  if (modelRole !== null) node.modelRole = modelRole;
  if (value.status !== undefined) {
    const status = asStr(value.status);
    if (status === null) return null;
    if (status.trim().length > 0) node.status = status;
  }
  if (value.codeRefs !== undefined) {
    const codeRefs = asStrArray(value.codeRefs);
    if (codeRefs === null) return null;
    node.codeRefs = codeRefs;
  }
  return node;
}

function asGraphEdge(value: unknown): GraphEdge | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const source = asStr(value.source);
  const target = asStr(value.target);
  const kind = asEdgeKind(value.kind);
  if (id === null || source === null || target === null || kind === null) return null;
  const edge: GraphEdge = { id, source, target, kind };
  if (value.label !== undefined) {
    const label = asStr(value.label);
    if (label === null) return null;
    edge.label = label;
  }
  return edge;
}

function asRealityNode(value: unknown): RealityNode | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const label = asStr(value.label);
  const dir = asStr(value.dir);
  if (id === null || label === null || dir === null) return null;
  return { id, label, dir };
}

function asRealityEdge(value: unknown): RealityEdge | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const source = asStr(value.source);
  const target = asStr(value.target);
  if (id === null || source === null || target === null) return null;
  return { id, source, target };
}

function asRealityLayer(value: unknown): RealityLayer | null {
  if (!isRecord(value)) return null;
  const nodes = mapAll(value.nodes, asRealityNode);
  const edges = mapAll(value.edges, asRealityEdge);
  const extractedAt = asNullableStr(value.extractedAt);
  const head = asNullableStr(value.head);
  if (nodes === null || edges === null || extractedAt === undefined || head === undefined) return null;
  return { nodes, edges, extractedAt, head };
}

function asDriftMap(value: unknown): DriftMap | null {
  if (!isRecord(value)) return null;
  const drift: DriftMap = {};
  for (const [nodeId, notes] of Object.entries(value)) {
    const list = asStrArray(notes);
    if (list === null) return null;
    drift[nodeId] = list;
  }
  return drift;
}

function asGraphDoc(value: unknown): GraphDoc | null {
  if (!isRecord(value)) return null;
  if (typeof value.rev !== "number") return null;
  const nodes = mapAll(value.nodes, asIntentNode);
  const edges = mapAll(value.edges, asGraphEdge);
  const reality = asRealityLayer(value.reality);
  const drift = asDriftMap(value.drift);
  if (nodes === null || edges === null || reality === null || drift === null) return null;
  return { rev: value.rev, nodes, edges, reality, drift };
}

function asRevisionInfo(value: unknown): RevisionInfo | null {
  if (!isRecord(value)) return null;
  const at = asStr(value.at);
  if (typeof value.rev !== "number" || at === null) return null;
  return { rev: value.rev, at };
}

/** the three buckets for one entity kind, each element parsed by its own guard */
function asEntityDelta<T>(value: unknown, one: (item: unknown) => T | null): EntityDelta<T> | null {
  if (!isRecord(value)) return null;
  const added = mapAll(value.added, one);
  const removed = mapAll(value.removed, one);
  const changed = mapAll(value.changed, (item) => {
    if (!isRecord(item)) return null;
    const before = one(item.before);
    const after = one(item.after);
    if (before === null || after === null) return null;
    return { before, after };
  });
  if (added === null || removed === null || changed === null) return null;
  return { added, removed, changed };
}

function asGraphDelta(value: unknown): GraphDelta | null {
  if (!isRecord(value)) return null;
  if (typeof value.revA !== "number" || typeof value.revB !== "number") return null;
  const nodes = asEntityDelta(value.nodes, asIntentNode);
  const edges = asEntityDelta(value.edges, asGraphEdge);
  if (nodes === null || edges === null) return null;
  return { revA: value.revA, revB: value.revB, nodes, edges };
}

function asWorktree(value: unknown): WorktreeInfo | null {
  if (!isRecord(value)) return null;
  const path = asStr(value.path);
  const branch = asNullableStr(value.branch);
  const head = asNullableStr(value.head);
  if (path === null || branch === undefined || head === undefined) return null;
  if (typeof value.current !== "boolean") return null;
  return { path, branch, head, current: value.current };
}

const BACKEND_EVENT_KINDS: readonly string[] = ["native", "hooks", "transcript", "none"];
const BACKEND_TERMINALS: readonly string[] = ["tui", "shell", "none"];

function asBackendInfo(value: unknown): BackendInfo | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const label = asStr(value.label);
  const caps = value.capabilities;
  if (id === null || label === null || !isRecord(caps)) return null;
  if (typeof caps.steerMidTurn !== "boolean" || typeof caps.hostTool !== "boolean") return null;
  if (typeof caps.resume !== "boolean") return null;
  if (typeof caps.events !== "string" || !BACKEND_EVENT_KINDS.includes(caps.events)) return null;
  if (typeof caps.terminal !== "string" || !BACKEND_TERMINALS.includes(caps.terminal)) return null;
  return {
    id,
    label,
    capabilities: {
      steerMidTurn: caps.steerMidTurn,
      hostTool: caps.hostTool,
      // membership checked above; the cast only names the narrowed unions
      events: caps.events as BackendInfo["capabilities"]["events"],
      resume: caps.resume,
      terminal: caps.terminal as BackendInfo["capabilities"]["terminal"],
    },
  };
}

function asSessionInfo(value: unknown): SessionInfo | null {
  if (!isRecord(value)) return null;
  const sessionId = asNullableStr(value.sessionId);
  const sessionName = asNullableStr(value.sessionName);
  const cwd = asStr(value.cwd);
  const worktrees = mapAll(value.worktrees, asWorktree);
  const backend = asBackendInfo(value.backend);
  if (sessionId === undefined || sessionName === undefined || cwd === null || worktrees === null) return null;
  if (typeof value.targetHasCode !== "boolean" || backend === null) return null;
  let model: SessionInfo["model"] = null;
  if (isRecord(value.model)) {
    const provider = asStr(value.model.provider);
    const id = asStr(value.model.id);
    if (provider !== null && id !== null) model = { provider, id };
  }
  return { sessionId, sessionName, model, cwd, targetHasCode: value.targetHasCode, worktrees, backend };
}

const HARNESSES: readonly string[] = ["omp", "claude", "codex", "opencode", "cursor"];
const SESSION_ATTACH: readonly string[] = ["socket", "daemon", "http", "none"];

/** one row of the bridge's `discoverSessions()` scan */
function asDiscoveredSession(value: unknown): DiscoveredSession | null {
  if (!isRecord(value)) return null;
  const harness = asStr(value.harness);
  const command = asStr(value.command);
  const attach = asStr(value.attach);
  const cwd = asNullableStr(value.cwd);
  const sessionId = asNullableStr(value.sessionId);
  const sessionFile = asNullableStr(value.sessionFile);
  const startedAt = asNullableStr(value.startedAt);
  if (harness === null || !HARNESSES.includes(harness)) return null;
  if (command === null || attach === null || !SESSION_ATTACH.includes(attach)) return null;
  if (cwd === undefined || sessionId === undefined || sessionFile === undefined || startedAt === undefined) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid)) return null;
  if (typeof value.spawnedByShape !== "boolean") return null;
  // null is a legitimate value here: not every harness can be resumed
  const resumeCommand = value.resumeCommand === null ? null : asStrArray(value.resumeCommand);
  if (resumeCommand === null && value.resumeCommand !== null) return null;
  return {
    // membership checked above; the casts only name the narrowed unions
    harness: harness as Harness,
    pid: value.pid,
    command,
    cwd,
    sessionId,
    sessionFile,
    startedAt,
    resumeCommand,
    attach: attach as DiscoveredSession["attach"],
    spawnedByShape: value.spawnedByShape,
  };
}

export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "hello": {
      const graph = asGraphDoc(raw.graph);
      const session = asSessionInfo(raw.session);
      const agent = asAgentState(raw.agent);
      const recentProjects = asStrArray(raw.recentProjects);
      const revisions = mapAll(raw.revisions, asRevisionInfo);
      const sessions = mapAll(raw.sessions, asDiscoveredSession);
      if (graph === null || session === null || agent === null || recentProjects === null || revisions === null) {
        return null;
      }
      if (sessions === null) return null;
      return { type: "hello", graph, session, agent, recentProjects, revisions, sessions };
    }
    case "sessions": {
      const sessions = mapAll(raw.sessions, asDiscoveredSession);
      return sessions === null ? null : { type: "sessions", sessions };
    }
    case "graph": {
      const graph = asGraphDoc(raw.graph);
      return graph === null ? null : { type: "graph", graph };
    }
    case "agent": {
      const state = asAgentState(raw.state);
      return state === null ? null : { type: "agent", state };
    }
    case "activity": {
      const nodeIds = asStrArray(raw.nodeIds);
      return nodeIds === null ? null : { type: "activity", nodeIds };
    }
    case "transcript": {
      const role = asTranscriptRole(raw.role);
      const text = asStr(raw.text);
      if (role === null || text === null) return null;
      return { type: "transcript", role, text };
    }
    case "error": {
      const message = asStr(raw.message);
      return message === null ? null : { type: "error", message };
    }
    case "revisions": {
      const revisions = mapAll(raw.revisions, asRevisionInfo);
      return revisions === null ? null : { type: "revisions", revisions };
    }
    case "delta": {
      const delta = asGraphDelta(raw.delta);
      return delta === null ? null : { type: "delta", delta };
    }
    default:
      return null;
  }
}
