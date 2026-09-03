/**
 * Boundary validators for the agent link (agent ↔ Shape server). The two ends
 * are separate processes in remote mode, so both halves import from here: the
 * server narrows what an agent sends, the agent narrows what a server sends.
 *
 * Style is `server/ws.ts`'s `parseClientMsg`: narrow by `type`, read every
 * field as `unknown`, return null on the first mismatch. The object
 * `JSON.parse` produced is the only cast in the file — plus the two element
 * arrays the spec leaves unchecked (`reality.nodes`/`edges`, `skeleton_result
 * .ops`), because the store and `applyOps` already validate what is in them.
 */

import type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentToServerMsg,
  BackendCapabilities,
  BackendInfo,
  CanvasOp,
  DiscoveredSession,
  Harness,
  RealityEdge,
  RealityLayer,
  RealityNode,
  ServerToAgentMsg,
  WorktreeInfo,
} from "../../shared/src/index.ts";

/** every nullable label on this wire: a string, or an explicit null */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** a request/response correlation id, and the only string that may not be empty */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** the six event kinds the link may report, validated field by field */
export function parseAgentEvent(value: unknown): AgentEvent | null {
  if (value === null || typeof value !== "object" || !("kind" in value)) return null;
  // an object from JSON.parse, checked immediately above; every field below is
  // read as `unknown` and validated before it reaches the union
  const ev = value as Record<string, unknown>;
  switch (ev.kind) {
    case "state":
      if (ev.state !== "idle" && ev.state !== "streaming" && ev.state !== "compacting") return null;
      return { kind: "state", state: ev.state };
    case "text":
      if (typeof ev.text !== "string") return null;
      return { kind: "text", text: ev.text };
    case "tool_start": {
      if (typeof ev.name !== "string" || typeof ev.summary !== "string") return null;
      if (!Array.isArray(ev.paths) || ev.paths.some((p) => typeof p !== "string")) return null;
      // every element was just checked to be a string
      const paths = ev.paths as string[];
      return { kind: "tool_start", name: ev.name, paths, summary: ev.summary };
    }
    case "tool_end":
      if (typeof ev.name !== "string" || typeof ev.isError !== "boolean") return null;
      return { kind: "tool_end", name: ev.name, isError: ev.isError };
    case "turn_end":
      return { kind: "turn_end" };
    case "session": {
      if (ev.sessionId !== null && typeof ev.sessionId !== "string") return null;
      const raw = ev.model;
      let model: { provider: string; id: string } | null = null;
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== "object") return null;
        // non-null object, checked immediately above
        const m = raw as Record<string, unknown>;
        if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
        model = { provider: m.provider, id: m.id };
      }
      return { kind: "session", sessionId: ev.sessionId ?? null, model };
    }
    default:
      return null;
  }
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const rows: unknown[] = value;
  const out: string[] = [];
  for (const row of rows) {
    if (typeof row !== "string") return null;
    out.push(row);
  }
  return out;
}

function parseCapabilities(value: unknown): BackendCapabilities | null {
  if (value === null || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.steerMidTurn !== "boolean" || typeof c.hostTool !== "boolean") return null;
  if (typeof c.resume !== "boolean") return null;
  const events = c.events;
  if (events !== "native" && events !== "hooks" && events !== "transcript" && events !== "none") {
    return null;
  }
  const terminal = c.terminal;
  if (terminal !== "tui" && terminal !== "shell" && terminal !== "none") return null;
  return {
    steerMidTurn: c.steerMidTurn,
    hostTool: c.hostTool,
    events,
    resume: c.resume,
    terminal,
  };
}

function parseBackend(value: unknown): BackendInfo | null {
  if (value === null || typeof value !== "object") return null;
  const b = value as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.label !== "string") return null;
  const capabilities = parseCapabilities(b.capabilities);
  if (capabilities === null) return null;
  return { id: b.id, label: b.label, capabilities };
}

/** the project half of an `attach`; also one row's project in the server's registry */
export function parseProject(value: unknown): AgentProject | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  // the key is the room's identity: an empty one would merge unrelated projects
  if (!isId(p.key)) return null;
  if (typeof p.label !== "string" || typeof p.cwd !== "string") return null;
  if (typeof p.targetHasCode !== "boolean") return null;
  const backend = parseBackend(p.backend);
  if (backend === null) return null;
  return { key: p.key, label: p.label, cwd: p.cwd, backend, targetHasCode: p.targetHasCode };
}

export function parseSession(value: unknown): AgentSession | null {
  if (value === null || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  const sessionId = s.sessionId ?? null;
  const sessionName = s.sessionName ?? null;
  if (!isNullableString(sessionId) || !isNullableString(sessionName)) return null;
  const raw = s.model;
  let model: { provider: string; id: string } | null = null;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== "object") return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
    model = { provider: m.provider, id: m.id };
  }
  return { sessionId, sessionName, model };
}

/**
 * Nodes and edges stay unchecked on purpose: they are the agent's extraction
 * output and the store already tolerates whatever shape it gets. The layer
 * being an object with both arrays is what the room depends on.
 */
function parseReality(value: unknown): RealityLayer | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const extractedAt = r.extractedAt ?? null;
  const head = r.head ?? null;
  if (!isNullableString(extractedAt) || !isNullableString(head)) return null;
  return {
    nodes: r.nodes as RealityNode[],
    edges: r.edges as RealityEdge[],
    extractedAt,
    head,
  };
}

export function parseWorktrees(value: unknown): WorktreeInfo[] | null {
  if (!Array.isArray(value)) return null;
  const rows: unknown[] = value;
  const out: WorktreeInfo[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") return null;
    const w = row as Record<string, unknown>;
    if (typeof w.path !== "string" || typeof w.current !== "boolean") return null;
    const branch = w.branch ?? null;
    const head = w.head ?? null;
    if (!isNullableString(branch) || !isNullableString(head)) return null;
    out.push({ path: w.path, branch, head, current: w.current });
  }
  return out;
}

function parseSessions(value: unknown): DiscoveredSession[] | null {
  if (!Array.isArray(value)) return null;
  const rows: unknown[] = value;
  const out: DiscoveredSession[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") return null;
    const s = row as Record<string, unknown>;
    // harness ids ARE backend ids; an id with no adapter is rejected by name
    // where a session is adopted, not here
    if (typeof s.harness !== "string" || typeof s.pid !== "number" || !Number.isInteger(s.pid)) {
      return null;
    }
    const cwd = s.cwd ?? null;
    const sessionId = s.sessionId ?? null;
    if (!isNullableString(cwd) || !isNullableString(sessionId)) return null;
    // the rest are labels: absent is empty, present must be the declared type
    const command = s.command ?? "";
    if (typeof command !== "string") return null;
    const sessionFile = s.sessionFile ?? null;
    const startedAt = s.startedAt ?? null;
    if (!isNullableString(sessionFile) || !isNullableString(startedAt)) return null;
    const spawnedByShape = s.spawnedByShape ?? false;
    if (typeof spawnedByShape !== "boolean") return null;
    const attach = s.attach ?? "none";
    if (attach !== "socket" && attach !== "daemon" && attach !== "http" && attach !== "none") {
      return null;
    }
    let resumeCommand: string[] | null = null;
    if (s.resumeCommand !== null && s.resumeCommand !== undefined) {
      resumeCommand = parseStringArray(s.resumeCommand);
      if (resumeCommand === null) return null;
    }
    out.push({
      harness: s.harness as Harness,
      pid: s.pid,
      command,
      cwd,
      sessionId,
      sessionFile,
      startedAt,
      resumeCommand,
      attach,
      spawnedByShape,
    });
  }
  return out;
}

/** Boundary validator for everything an agent sends over the agent link. */
export function parseAgentToServerMsg(raw: string): AgentToServerMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null;
  // an object from JSON.parse, checked immediately above; every field below is
  // read as `unknown` and validated before it reaches the union
  const m = parsed as Record<string, unknown>;
  switch (m.type) {
    case "attach": {
      const project = parseProject(m.project);
      if (project === null) return null;
      const session = parseSession(m.session);
      if (session === null) return null;
      let reality: RealityLayer | null = null;
      if (m.reality !== null && m.reality !== undefined) {
        reality = parseReality(m.reality);
        if (reality === null) return null;
      }
      const worktrees = parseWorktrees(m.worktrees);
      if (worktrees === null) return null;
      const sessions = parseSessions(m.sessions);
      if (sessions === null) return null;
      const recentProjects = parseStringArray(m.recentProjects);
      if (recentProjects === null) return null;
      const token = m.token;
      if (token !== undefined && typeof token !== "string") return null;
      const attach: Extract<AgentToServerMsg, { type: "attach" }> = {
        type: "attach",
        project,
        session,
        reality,
        worktrees,
        sessions,
        recentProjects,
      };
      if (token !== undefined) attach.token = token;
      return attach;
    }
    case "agent_event": {
      const event = parseAgentEvent(m.event);
      if (event === null) return null;
      return { type: "agent_event", event };
    }
    case "canvas_call":
      if (!isId(m.id)) return null;
      // `args` is the harness's tool payload: validated by the canvas, not here
      return { type: "canvas_call", id: m.id, args: m.args };
    case "reality": {
      const reality = parseReality(m.reality);
      if (reality === null) return null;
      const head = m.head ?? null;
      if (!isNullableString(head)) return null;
      return { type: "reality", reality, head };
    }
    case "worktrees": {
      const id = m.id ?? null;
      if (!isNullableString(id)) return null;
      const worktrees = parseWorktrees(m.worktrees);
      if (worktrees === null) return null;
      return { type: "worktrees", id, worktrees };
    }
    case "sessions": {
      const id = m.id ?? null;
      if (!isNullableString(id)) return null;
      const sessions = parseSessions(m.sessions);
      if (sessions === null) return null;
      return { type: "sessions", id, sessions };
    }
    case "recents": {
      const paths = parseStringArray(m.paths);
      if (paths === null) return null;
      return { type: "recents", paths };
    }
    case "delivered":
      if (!isId(m.id)) return null;
      if (m.mode !== "prompt" && m.mode !== "steer") return null;
      if (typeof m.queued !== "boolean") return null;
      return { type: "delivered", id: m.id, mode: m.mode, queued: m.queued };
    case "skeleton_result":
      if (!isId(m.id) || !Array.isArray(m.ops)) return null;
      // every op is validated by `applyOps`; a non-array is what it cannot survive
      return { type: "skeleton_result", id: m.id, ops: m.ops as CanvasOp[] };
    case "file_index": {
      if (!isId(m.id)) return null;
      const files = parseStringArray(m.files);
      if (files === null) return null;
      return { type: "file_index", id: m.id, files };
    }
    case "agent_error":
      if (typeof m.message !== "string") return null;
      return { type: "agent_error", message: m.message };
    case "agent_exit":
    case "detached":
      if (typeof m.reason !== "string") return null;
      return { type: m.type, reason: m.reason };
    case "pty_data":
      if (typeof m.data !== "string") return null;
      return { type: "pty_data", data: m.data };
    case "pty_exit": {
      const code = m.code ?? null;
      if (code !== null && (typeof code !== "number" || !Number.isInteger(code))) return null;
      return { type: "pty_exit", code };
    }
    case "pty_state":
      if (typeof m.open !== "boolean" || typeof m.shell !== "string") return null;
      if (typeof m.cwd !== "string") return null;
      return { type: "pty_state", open: m.open, shell: m.shell, cwd: m.cwd };
    default:
      return null;
  }
}

/** Boundary validator for everything a server sends over the agent link. */
export function parseServerToAgentMsg(raw: string): ServerToAgentMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null;
  const m = parsed as Record<string, unknown>;
  switch (m.type) {
    case "attached":
      if (!isId(m.projectId) || typeof m.preamble !== "string") return null;
      return { type: "attached", projectId: m.projectId, preamble: m.preamble };
    case "error":
      if (typeof m.message !== "string") return null;
      return { type: "error", message: m.message };
    case "canvas_result":
      if (!isId(m.id) || typeof m.text !== "string" || typeof m.isError !== "boolean") return null;
      return { type: "canvas_result", id: m.id, text: m.text, isError: m.isError };
    case "deliver":
      if (!isId(m.id) || typeof m.body !== "string") return null;
      return { type: "deliver", id: m.id, body: m.body };
    case "abort":
      return { type: "abort" };
    case "switch": {
      if (typeof m.path !== "string" || m.path.trim().length === 0) return null;
      const backend = m.backend;
      if (backend !== undefined && typeof backend !== "string") return null;
      const resumeSessionId = m.resumeSessionId;
      if (resumeSessionId !== undefined && typeof resumeSessionId !== "string") return null;
      const msg: Extract<ServerToAgentMsg, { type: "switch" }> = {
        type: "switch",
        path: m.path.trim(),
      };
      if (backend !== undefined) msg.backend = backend;
      if (resumeSessionId !== undefined) msg.resumeSessionId = resumeSessionId;
      return msg;
    }
    case "adopt":
      if (typeof m.pid !== "number" || !Number.isInteger(m.pid) || m.pid <= 0) return null;
      return { type: "adopt", pid: m.pid };
    case "discover":
    case "list_worktrees":
    case "synthesize_skeleton":
    case "file_index":
      if (!isId(m.id)) return null;
      return { type: m.type, id: m.id };
    case "extract_reality":
      return { type: "extract_reality" };
    case "pty_open":
    case "pty_resize": {
      // a terminal size must be a real geometry: the pty is resized with it
      const { cols, rows } = m;
      if (typeof cols !== "number" || !Number.isInteger(cols) || cols <= 0) return null;
      if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0) return null;
      return { type: m.type, cols, rows };
    }
    case "pty_input":
      if (typeof m.data !== "string") return null;
      return { type: "pty_input", data: m.data };
    case "pty_close":
      return { type: "pty_close" };
    default:
      return null;
  }
}
