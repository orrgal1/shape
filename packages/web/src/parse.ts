/**
 * The one network boundary of this package: JSON off the bridge socket in,
 * `ServerMsg` (or null) out. Nothing else in the app inspects untrusted shapes,
 * and `isRecord` lives here only — this is the package's canonical guard module.
 */
import {
  EDGE_KINDS,
  LAYERS,
  MODEL_ROLES,
  NODE_KINDS,
  PHASES,
  type Layer,
  type NodeKind,
  type AgentSession,
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
  type ManagerHandle,
  type ModelRole,
  type Next,
  type NextChoice,
  type Phase,
  type ProjectSummary,
  type ProjectTools,
  type RealityEdge,
  type RealityInfra,
  type RealityLayer,
  type RealityNode,
  type RealitySymbol,
  type RealityVerification,
  type RevisionInfo,
  type ServerMsg,
  type SessionInfo,
  type ToolInfo,
  type WorktreeInfo,
  type WorktreeSession,
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
  // unknown kinds are tolerated (older/newer bridges), the bubble just goes plain
  for (const kind of NODE_KINDS) if (kind === value.kind) node.kind = kind as NodeKind;
  if (value.layer !== undefined) {
    // A snapshot written before the layer was renamed still says "verify"; it
    // reads as the correctness layer rather than being dropped, the same
    // tolerance an unknown kind gets.
    const stored = value.layer === "verify" ? "correctness" : value.layer;
    let layer: Layer | null = null;
    for (const known of LAYERS) if (known === stored) layer = known;
    if (layer === null) return null;
    node.layer = layer;
  }
  if (value.realizes !== undefined) {
    const realizes = asStrArray(value.realizes);
    if (realizes === null) return null;
    node.realizes = realizes;
  }
  if (value.hosts !== undefined) {
    const hosts = asStrArray(value.hosts);
    if (hosts === null) return null;
    node.hosts = hosts;
  }
  if (value.verifies !== undefined) {
    const verifies = asStrArray(value.verifies);
    if (verifies === null) return null;
    node.verifies = verifies;
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

function asRealitySymbol(value: unknown): RealitySymbol | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const file = asStr(value.file);
  const name = asStr(value.name);
  const pkg = asNullableStr(value.pkg);
  if (id === null || file === null || name === null || pkg === undefined) return null;
  if (value.kind !== "class" && value.kind !== "function") return null;
  if (typeof value.exported !== "boolean" || typeof value.line !== "number") return null;
  return { id, file, name, kind: value.kind, exported: value.exported, line: value.line, pkg };
}

function asRealityInfra(value: unknown): RealityInfra | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const label = asStr(value.label);
  const hint = asStr(value.hint);
  const evidence = asStrArray(value.evidence);
  if (id === null || label === null || hint === null || evidence === null) return null;
  // the kind decides a glyph and nothing else, so an unknown one is drawn plain
  // rather than taking the whole frame down
  let kind: NodeKind = "external";
  for (const known of NODE_KINDS) if (known === value.kind) kind = known;
  return { id, label, kind, evidence, hint };
}

function asRealityVerification(value: unknown): RealityVerification | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const label = asStr(value.label);
  const hint = asStr(value.hint);
  const evidence = asStrArray(value.evidence);
  const covers = asStrArray(value.covers);
  if (id === null || label === null || hint === null || evidence === null || covers === null) return null;
  // same tolerance as infrastructure: the kind is a glyph, so an unknown one
  // costs a sigil rather than the whole frame
  let kind: NodeKind = "check";
  for (const known of NODE_KINDS) if (known === value.kind) kind = known;
  return { id, label, kind, evidence, hint, covers };
}

/**
 * Symbols, infrastructure and verification arrive from bridges that know how to
 * extract them; an older bridge simply does not send the fields, and an empty
 * listing is the honest reading of that — the canvas then draws no ghosts, no
 * "inside" listing and no filled shield it cannot account for, which is exactly
 * what a bridge that cannot see them means.
 */
function asRealityLayer(value: unknown): RealityLayer | null {
  if (!isRecord(value)) return null;
  const nodes = mapAll(value.nodes, asRealityNode);
  const edges = mapAll(value.edges, asRealityEdge);
  const symbols = value.symbols === undefined ? [] : mapAll(value.symbols, asRealitySymbol);
  const infra = value.infra === undefined ? [] : mapAll(value.infra, asRealityInfra);
  const verification = value.verification === undefined ? [] : mapAll(value.verification, asRealityVerification);
  const extractedAt = asNullableStr(value.extractedAt);
  const head = asNullableStr(value.head);
  if (nodes === null || edges === null || symbols === null || infra === null || verification === null) return null;
  if (extractedAt === undefined || head === undefined) return null;
  return { nodes, edges, symbols, infra, verification, extractedAt, head };
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
  const id = asStr(value.id);
  const path = asStr(value.path);
  const branch = asNullableStr(value.branch);
  const head = asNullableStr(value.head);
  if (id === null || id === "" || path === null) return null;
  if (branch === undefined || head === undefined) return null;
  return { id, path, branch, head };
}

const BACKEND_EVENT_KINDS: readonly string[] = ["native", "hooks", "transcript", "none"];
const BACKEND_TERMINALS: readonly string[] = ["external", "pane", "none"];

/** one tool found on the machine the agent runs on: a launcher or a harness */
function asToolInfo(value: unknown): ToolInfo | null {
  if (!isRecord(value)) return null;
  const id = asStr(value.id);
  const label = asStr(value.label);
  const path = asStr(value.path);
  const version = asNullableStr(value.version);
  if (id === null || id === "" || label === null || path === null || version === undefined) return null;
  return { id, label, path, version };
}

/** what is installed where this project's agent runs, and how it starts a harness */
function asProjectTools(value: unknown): ProjectTools | null {
  if (!isRecord(value)) return null;
  const launchers = mapAll(value.launchers, asToolInfo);
  const harnesses = mapAll(value.harnesses, asToolInfo);
  if (launchers === null || harnesses === null) return null;
  if (value.launcher !== "herdr" && value.launcher !== "pty") return null;
  return { launcher: value.launcher, launchers, harnesses };
}

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

/** the harness facts of one variation: what it is, what drives it, what it is doing */
function asAgentSession(value: unknown): AgentSession | null {
  if (!isRecord(value)) return null;
  const sessionId = asNullableStr(value.sessionId);
  const sessionName = asNullableStr(value.sessionName);
  if (sessionId === undefined || sessionName === undefined) return null;
  let model: AgentSession["model"] = null;
  if (isRecord(value.model)) {
    const provider = asStr(value.model.provider);
    const id = asStr(value.model.id);
    if (provider !== null && id !== null) model = { provider, id };
  }
  return { sessionId, sessionName, model };
}

function asWorktreeSession(value: unknown): WorktreeSession | null {
  if (!isRecord(value)) return null;
  const worktree = asStr(value.worktree);
  const session = asAgentSession(value.session);
  const backend = asBackendInfo(value.backend);
  const state = asAgentState(value.state);
  if (worktree === null || worktree === "" || session === null || backend === null || state === null) return null;
  return { worktree, session, backend, state };
}

/**
 * The project's manager session, as the agent reported it. Absent (an older
 * bridge, or a project whose launcher is not herdr) is "no manager", which the
 * header shows as such; a value that is not a whole handle is unusable for the
 * one thing the browser does with it — naming the pane — so it reads as none.
 */
function asManagerHandle(value: unknown): ManagerHandle | null {
  if (!isRecord(value)) return null;
  const paneId = asStr(value.paneId);
  const tabId = asStr(value.tabId);
  const workspaceId = asStr(value.workspaceId);
  const agentName = asStr(value.agentName);
  if (paneId === null || tabId === null || workspaceId === null || agentName === null) return null;
  if (paneId === "" || tabId === "" || workspaceId === "" || agentName === "") return null;
  if (value.origin !== "found" && value.origin !== "opened") return null;
  if (typeof value.shapeAware !== "boolean") return null;
  return { paneId, tabId, workspaceId, agentName, origin: value.origin, shapeAware: value.shapeAware };
}

function asSessionInfo(value: unknown): SessionInfo | null {
  if (!isRecord(value)) return null;
  const cwd = asStr(value.cwd);
  const worktrees = mapAll(value.worktrees, asWorktree);
  const sessions = mapAll(value.sessions, asWorktreeSession);
  if (cwd === null || worktrees === null || sessions === null) return null;
  if (typeof value.targetHasCode !== "boolean") return null;
  if (typeof value.agentConnected !== "boolean") return null;
  // an older bridge simply cannot publish: the form then offers the folder only
  const canPublish = value.canPublish === true;
  // an older bridge wrote no directive: nothing for a launcher to read
  const directivePath =
    typeof value.directivePath === "string" && value.directivePath.length > 0 ? value.directivePath : null;
  return {
    cwd,
    targetHasCode: value.targetHasCode,
    worktrees,
    sessions,
    agentConnected: value.agentConnected,
    canPublish,
    directivePath,
    manager: asManagerHandle(value.manager),
  };
}

/** one row of the project picker: a room this server hosts */
function asProjectSummary(value: unknown): ProjectSummary | null {
  if (!isRecord(value)) return null;
  const projectId = asStr(value.projectId);
  const label = asStr(value.label);
  const cwd = asStr(value.cwd);
  const harness = asStr(value.harness);
  const lastSeen = asStr(value.lastSeen);
  if (projectId === null || label === null || cwd === null || harness === null || lastSeen === null) return null;
  if (typeof value.agentConnected !== "boolean") return null;
  return { projectId, label, cwd, harness, agentConnected: value.agentConnected, lastSeen };
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

/**
 * A worktree-keyed map: one graph, one revision list or one agent state per
 * variation. All-or-nothing like `mapAll` — a frame this client cannot place on
 * the canvas must not be half-applied.
 */
function mapValues<T>(value: unknown, one: (item: unknown) => T | null): Record<string, T> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "") return null;
    const parsed = one(item);
    if (parsed === null) return null;
    out[key] = parsed;
  }
  return out;
}

/** the variation a canvas-scoped frame is about; an empty string is not an id */
function asWorktreeId(value: unknown): string | null {
  const id = asStr(value);
  return id === null || id === "" ? null : id;
}

/**
 * The card a turn ended on. Its own boundary check rather than the shared
 * validator's: the bridge has already refused a malformed one, and what arrives
 * here is a frame this client either draws whole or ignores.
 */
function asNext(value: unknown): Next | null {
  if (!isRecord(value)) return null;
  const summary = asStr(value.summary);
  const question = asNullableStr(value.question);
  if (summary === null || question === undefined) return null;
  const choices = mapAll(value.choices, (item): NextChoice | null => {
    if (!isRecord(item)) return null;
    const label = asStr(item.label);
    const say = asStr(item.say);
    return label === null || say === null ? null : { label, say };
  });
  return choices === null ? null : { summary, choices, question };
}

/**
 * The card each variation is offering. `mapValues` cannot carry this: a null
 * value here is a legitimate "no card", not a value that failed to parse, and
 * that is exactly the distinction the generic map has no room for.
 */
function asNextMap(value: unknown): Record<string, Next | null> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, Next | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "") return null;
    if (item === null) {
      out[key] = null;
      continue;
    }
    const next = asNext(item);
    if (next === null) return null;
    out[key] = next;
  }
  return out;
}

/** which variations are running on their own: one flag per worktree id */
function asAutonomousMap(value: unknown): Record<string, boolean> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "" || typeof item !== "boolean") return null;
    out[key] = item;
  }
  return out;
}

export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (!isRecord(raw)) return null;
  switch (raw.type) {
    case "hello": {
      const graphs = mapValues(raw.graphs, asGraphDoc);
      const session = asSessionInfo(raw.session);
      const agents = mapValues(raw.agents, asAgentState);
      const recentProjects = asStrArray(raw.recentProjects);
      const projects = mapAll(raw.projects, asProjectSummary);
      const projectId = asStr(raw.projectId);
      const revisions = mapValues(raw.revisions, (item) => mapAll(item, asRevisionInfo));
      const sessions = mapAll(raw.sessions, asDiscoveredSession);
      const tools = asProjectTools(raw.tools);
      // A bridge that predates the end-of-turn card sends neither field, and
      // "no card anywhere, nothing running on its own" is the honest reading of
      // that — the same tolerance the reality lists get.
      const nexts = raw.nexts === undefined ? {} : asNextMap(raw.nexts);
      const autonomous = raw.autonomous === undefined ? {} : asAutonomousMap(raw.autonomous);
      if (graphs === null || session === null || agents === null || recentProjects === null) return null;
      if (revisions === null || sessions === null || projects === null || projectId === null) return null;
      if (nexts === null || autonomous === null || tools === null) return null;
      return {
        type: "hello",
        graphs,
        session,
        agents,
        recentProjects,
        projects,
        projectId,
        revisions,
        sessions,
        nexts,
        autonomous,
        tools,
      };
    }
    case "session": {
      const session = asSessionInfo(raw.session);
      return session === null ? null : { type: "session", session };
    }
    case "session_started": {
      const worktree = asWorktreeId(raw.worktree);
      const session = asAgentSession(raw.session);
      const backend = asBackendInfo(raw.backend);
      if (worktree === null || session === null || backend === null) return null;
      return { type: "session_started", worktree, session, backend };
    }
    case "session_stopped": {
      const worktree = asWorktreeId(raw.worktree);
      const reason = asStr(raw.reason);
      if (worktree === null || reason === null) return null;
      return { type: "session_stopped", worktree, reason };
    }
    case "folder_picked": {
      // null is the answer, not a missing field: it is how the agent reports
      // that the person closed the chooser. An empty string is neither an
      // answer nor a path, so it is a malformed frame like any other.
      if (raw.path === null) return { type: "folder_picked", path: null };
      const path = asStr(raw.path);
      return path === null || path === "" ? null : { type: "folder_picked", path };
    }
    case "projects": {
      const projects = mapAll(raw.projects, asProjectSummary);
      return projects === null ? null : { type: "projects", projects };
    }
    case "sessions": {
      const sessions = mapAll(raw.sessions, asDiscoveredSession);
      return sessions === null ? null : { type: "sessions", sessions };
    }
    case "graph": {
      const worktree = asWorktreeId(raw.worktree);
      const graph = asGraphDoc(raw.graph);
      if (worktree === null || graph === null) return null;
      return { type: "graph", worktree, graph };
    }
    case "agent": {
      const worktree = asWorktreeId(raw.worktree);
      const state = asAgentState(raw.state);
      if (worktree === null || state === null) return null;
      return { type: "agent", worktree, state };
    }
    case "next": {
      const worktree = asWorktreeId(raw.worktree);
      if (worktree === null) return null;
      // an explicit null is the frame that takes the card down
      if (raw.next === null) return { type: "next", worktree, next: null };
      const next = asNext(raw.next);
      return next === null ? null : { type: "next", worktree, next };
    }
    case "autonomous": {
      const worktree = asWorktreeId(raw.worktree);
      if (worktree === null || typeof raw.on !== "boolean") return null;
      return { type: "autonomous", worktree, on: raw.on };
    }
    case "activity": {
      const worktree = asWorktreeId(raw.worktree);
      const nodeIds = asStrArray(raw.nodeIds);
      if (worktree === null || nodeIds === null) return null;
      return { type: "activity", worktree, nodeIds };
    }
    case "transcript": {
      const worktree = asWorktreeId(raw.worktree);
      const role = asTranscriptRole(raw.role);
      const text = asStr(raw.text);
      if (worktree === null || role === null || text === null) return null;
      return { type: "transcript", worktree, role, text };
    }
    case "terminal": {
      const worktree = asWorktreeId(raw.worktree);
      if (worktree === null || typeof raw.open !== "boolean") return null;
      return { type: "terminal", worktree, open: raw.open };
    }
    case "now": {
      const worktree = asWorktreeId(raw.worktree);
      // null is the frame that clears the line, not a missing field
      const text = asNullableStr(raw.text);
      if (worktree === null || text === undefined) return null;
      return { type: "now", worktree, text };
    }
    case "error": {
      const message = asStr(raw.message);
      return message === null ? null : { type: "error", message };
    }
    case "revisions": {
      const worktree = asWorktreeId(raw.worktree);
      const revisions = mapAll(raw.revisions, asRevisionInfo);
      if (worktree === null || revisions === null) return null;
      return { type: "revisions", worktree, revisions };
    }
    case "delta": {
      const worktree = asWorktreeId(raw.worktree);
      const delta = asGraphDelta(raw.delta);
      if (worktree === null || delta === null) return null;
      return { type: "delta", worktree, delta };
    }
    default:
      return null;
  }
}
