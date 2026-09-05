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

import { NODE_KINDS } from "../../shared/src/index.ts";
import type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentState,
  AgentToServerMsg,
  BackendCapabilities,
  BackendInfo,
  CanvasOp,
  ManagerHandle,
  ProjectTools,
  RealityEdge,
  RealityInfra,
  RealityLayer,
  RealityNode,
  RealitySymbol,
  RealityVerification,
  ServerToAgentMsg,
  ToolInfo,
  WorktreeInfo,
  WorktreeSession,
} from "../../shared/src/index.ts";

/** every nullable label on this wire: a string, or an explicit null */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** a request/response correlation id, and the only string that may not be empty */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The worktree a frame is about: the realpath of a worktree directory. An
 * empty one would be a frame nobody can place — the room would have to guess
 * which of a project's canvases it belongs to — so it is a malformed frame.
 */
function isWorktree(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** the three states a harness can report */
function isAgentState(value: unknown): value is AgentState {
  return value === "idle" || value === "streaming" || value === "compacting";
}

/**
 * The model a harness names. Every wire that carries one carries the same two
 * strings, and a harness that has not resolved one yet says so with `null`.
 */
export function isModel(value: unknown): value is { provider: string; id: string } {
  if (value === null || typeof value !== "object") return false;
  // a non-null object, checked immediately above
  const m = value as Record<string, unknown>;
  return typeof m.provider === "string" && typeof m.id === "string";
}

/** the seven event kinds the link may report, validated field by field */
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
    case "text_delta":
      if (typeof ev.delta !== "string") return null;
      return { kind: "text_delta", delta: ev.delta };
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
      // the file is optional: only a harness that logs to disk has one, and
      // both `null` and an absent field mean the same "there is none"
      if (ev.sessionFile !== undefined && ev.sessionFile !== null && typeof ev.sessionFile !== "string") return null;
      const sessionFile = typeof ev.sessionFile === "string" ? ev.sessionFile : null;
      // absent and null are one answer — "it did not say" — so only a
      // malformed object refuses the frame
      const model = ev.model ?? null;
      if (model !== null && !isModel(model)) return null;
      return { kind: "session", sessionId: ev.sessionId ?? null, sessionFile, model };
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
  // a registry row written by an older Shape can say `pane`: it described a
  // terminal Shape hosted itself, and there is none to render any more
  if (terminal !== "external" && terminal !== "pane" && terminal !== "none") return null;
  return {
    steerMidTurn: c.steerMidTurn,
    hostTool: c.hostTool,
    events,
    resume: c.resume,
    terminal: terminal === "external" ? "external" : "none",
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

/** one detected tool: its id, what a picker calls it, and where it lives */
function parseTool(value: unknown): ToolInfo | null {
  if (value === null || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (!isId(t.id) || typeof t.label !== "string" || typeof t.path !== "string") return null;
  const version = t.version ?? null;
  if (!isNullableString(version)) return null;
  return { id: t.id, label: t.label, path: t.path, version };
}

function parseToolList(value: unknown): ToolInfo[] | null {
  if (!Array.isArray(value)) return null;
  const tools: ToolInfo[] = [];
  for (const entry of value) {
    const tool = parseTool(entry);
    // a malformed entry is a malformed list: the picker must not offer half of
    // what the agent found and call it what is installed
    if (tool === null) return null;
    tools.push(tool);
  }
  return tools;
}

/**
 * What is installed where the agent runs. Absent means a REGISTRY ROW written
 * before detection existed (the same validator reads stored projects), which
 * reads as "nothing known" — harmless, because a row is never the answer to
 * "what is on this machine": the agent re-sends its tools on every attach. A
 * present but malformed value is a malformed frame.
 */
function parseTools(value: unknown): ProjectTools | null {
  if (value === undefined) return { launcher: null, launchers: [], harnesses: [] };
  if (value === null || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  // `pty` is how an older Shape named the terminal it hosted itself; a row
  // carrying it has no multiplexer Shape can reach, which is `null` now
  if (t.launcher !== "herdr" && t.launcher !== "pty" && t.launcher !== null) return null;
  const launchers = parseToolList(t.launchers);
  if (launchers === null) return null;
  const harnesses = parseToolList(t.harnesses);
  if (harnesses === null) return null;
  return { launcher: t.launcher === "herdr" ? "herdr" : null, launchers, harnesses };
}

/**
 * A worktree-id → project-key map: the keys an older Shape would have used.
 * Absent is the common case (a stored row or an agent from before adoption
 * existed) and reads as "nothing to adopt"; a malformed entry drops that
 * worktree alone, because one unusable spelling must not cost the others
 * their canvas.
 */
function parseLegacyKeys(value: unknown): Record<string, string> {
  if (value === null || value === undefined || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [worktree, key] of Object.entries(value as Record<string, unknown>)) {
    if (worktree.length === 0 || typeof key !== "string" || key.length === 0) continue;
    out[worktree] = key;
  }
  return out;
}

/**
 * The manager Shape found in the project's herdr workspace. Absent (an older
 * agent, a stored row, or a project with no herdr) reads as "no manager",
 * which is a real state — so is a value that does not describe a live pane,
 * because the only thing downstream does with it is show it. `origin` is the
 * literal `"found"`: Shape opens no session, and a row written by a Shape that
 * did is not a manager this one may claim.
 */
function parseManager(value: unknown): ManagerHandle | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (!isId(m.paneId) || !isId(m.tabId) || !isId(m.workspaceId) || !isId(m.agentName)) return null;
  if (m.origin !== "found") return null;
  if (typeof m.shapeAware !== "boolean") return null;
  return {
    paneId: m.paneId,
    tabId: m.tabId,
    workspaceId: m.workspaceId,
    agentName: m.agentName,
    origin: "found",
    shapeAware: m.shapeAware,
  };
}

/** the project half of an `attach`; also one row's project in the server's registry */
export function parseProject(value: unknown): AgentProject | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  // the key is the room's identity: an empty one would merge unrelated projects
  if (!isId(p.key)) return null;
  if (typeof p.label !== "string" || typeof p.cwd !== "string") return null;
  if (typeof p.targetHasCode !== "boolean") return null;
  // older registry rows and older agents never wrote a directive: null means
  // "no file to point a launcher at", which is a real state, not a bad frame
  const directivePath =
    typeof p.directivePath === "string" && p.directivePath.length > 0 ? p.directivePath : null;
  // a project with no session reporting in is the ordinary state: the room
  // opens on the canvas and waits for one to speak
  const backend = p.backend === null || p.backend === undefined ? null : parseBackend(p.backend);
  if (p.backend !== null && p.backend !== undefined && backend === null) return null;
  const tools = parseTools(p.tools);
  if (tools === null) return null;
  return {
    key: p.key,
    label: p.label,
    cwd: p.cwd,
    backend,
    tools,
    targetHasCode: p.targetHasCode,
    directivePath,
    manager: parseManager(p.manager),
    legacyKeys: parseLegacyKeys(p.legacyKeys),
  };
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
 *
 * `symbols`, `infra` and `verification` are checked field by field, because
 * they are read where a wrong shape would be a lie rather than a blank: the
 * onboarding gate resolves `file#Name` refs against `symbols`, drift reports a
 * symbol that is gone, the client renders unclaimed `infra` and `verification`
 * as ghosts, and a build bubble reads as verified because some verification
 * `covers` its code. A missing array is simply an older agent (or a row stored
 * before this existed), which is not a malformed frame — it reads as "nothing
 * found", so the frame is accepted with an empty list. A malformed ENTRY, on
 * the other hand, drops that entry: one bad symbol never costs the whole
 * extraction.
 */
function parseReality(value: unknown): RealityLayer | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null;
  const extractedAt = r.extractedAt ?? null;
  const head = r.head ?? null;
  if (!isNullableString(extractedAt) || !isNullableString(head)) return null;
  if (r.symbols !== undefined && !Array.isArray(r.symbols)) return null;
  if (r.infra !== undefined && !Array.isArray(r.infra)) return null;
  if (r.verification !== undefined && !Array.isArray(r.verification)) return null;

  const symbols: RealitySymbol[] = [];
  for (const row of (r.symbols ?? []) as unknown[]) {
    if (row === null || typeof row !== "object") continue;
    const s = row as Record<string, unknown>;
    if (!isId(s.id) || typeof s.file !== "string" || typeof s.name !== "string") continue;
    if (s.kind !== "class" && s.kind !== "function") continue;
    if (typeof s.exported !== "boolean" || typeof s.line !== "number" || !Number.isFinite(s.line)) continue;
    if (!isNullableString(s.pkg ?? null)) continue;
    symbols.push({
      id: s.id,
      file: s.file,
      name: s.name,
      kind: s.kind,
      exported: s.exported,
      line: s.line,
      pkg: (s.pkg ?? null) as string | null,
    });
  }

  const infra: RealityInfra[] = [];
  for (const row of (r.infra ?? []) as unknown[]) {
    if (row === null || typeof row !== "object") continue;
    const i = row as Record<string, unknown>;
    if (!isId(i.id) || typeof i.label !== "string" || typeof i.hint !== "string") continue;
    // the client draws a symbol per kind from an exhaustive switch, so a kind
    // it has never heard of would be a rendering hole, not a blank bubble
    const kind = NODE_KINDS.find((k) => k === i.kind);
    if (kind === undefined) continue;
    const evidence = parseStringArray(i.evidence);
    if (evidence === null) continue;
    infra.push({ id: i.id, label: i.label, kind, evidence, hint: i.hint });
  }

  const verification: RealityVerification[] = [];
  for (const row of (r.verification ?? []) as unknown[]) {
    if (row === null || typeof row !== "object") continue;
    const v = row as Record<string, unknown>;
    if (!isId(v.id) || typeof v.label !== "string" || typeof v.hint !== "string") continue;
    const kind = NODE_KINDS.find((k) => k === v.kind);
    if (kind === undefined) continue;
    const evidence = parseStringArray(v.evidence);
    if (evidence === null) continue;
    // `covers` is what makes a build bubble verified without anyone saying so,
    // so a row that cannot say what it exercises is not a usable row
    const covers = parseStringArray(v.covers);
    if (covers === null) continue;
    verification.push({ id: v.id, label: v.label, kind, evidence, hint: v.hint, covers });
  }

  return {
    nodes: r.nodes as RealityNode[],
    edges: r.edges as RealityEdge[],
    symbols,
    infra,
    verification,
    extractedAt,
    head,
  };
}

/**
 * The worktree list of a project. `id` is the row's identity — the key the
 * canvas, the storage and every worktree-scoped frame use — so a row without
 * one is not a usable worktree and costs the whole list rather than becoming a
 * row nothing can address.
 */
export function parseWorktrees(value: unknown): WorktreeInfo[] | null {
  if (!Array.isArray(value)) return null;
  const rows: unknown[] = value;
  const out: WorktreeInfo[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") return null;
    const w = row as Record<string, unknown>;
    if (!isWorktree(w.id) || typeof w.path !== "string") return null;
    const branch = w.branch ?? null;
    const head = w.head ?? null;
    if (!isNullableString(branch) || !isNullableString(head)) return null;
    out.push({ id: w.id, path: w.path, branch, head });
  }
  return out;
}

/**
 * The sessions an agent is watching, one per worktree with one reporting in.
 * Every field is load-bearing where this lands: the room keys its per-worktree
 * state by `worktree`, the client renders from `backend.capabilities`, and
 * `state` is what the canvas draws as the session working or idle.
 */
export function parseWorktreeSessions(value: unknown): WorktreeSession[] | null {
  if (!Array.isArray(value)) return null;
  const rows: unknown[] = value;
  const out: WorktreeSession[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") return null;
    const s = row as Record<string, unknown>;
    if (!isWorktree(s.worktree)) return null;
    const session = parseSession(s.session);
    if (session === null) return null;
    const backend = parseBackend(s.backend);
    if (backend === null) return null;
    if (!isAgentState(s.state)) return null;
    out.push({ worktree: s.worktree, session, backend, state: s.state });
  }
  return out;
}

/**
 * Reality per worktree, as `attach` carries it: a plain object keyed by
 * worktree id. A malformed entry drops that worktree's reality (it re-derives
 * on the next extraction) rather than the whole attach.
 */
function parseRealities(value: unknown): Record<string, RealityLayer> | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, RealityLayer> = {};
  for (const [worktree, raw] of Object.entries(value as Record<string, unknown>)) {
    if (worktree.length === 0) continue;
    const reality = parseReality(raw);
    if (reality !== null) out[worktree] = reality;
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
      const worktrees = parseWorktrees(m.worktrees);
      if (worktrees === null) return null;
      const sessions = parseWorktreeSessions(m.sessions);
      if (sessions === null) return null;
      const realities = parseRealities(m.realities);
      if (realities === null) return null;
      return { type: "attach", project, worktrees, sessions, realities };
    }
    case "session_started": {
      if (!isWorktree(m.worktree)) return null;
      const session = parseSession(m.session);
      if (session === null) return null;
      const backend = parseBackend(m.backend);
      if (backend === null) return null;
      return { type: "session_started", worktree: m.worktree, session, backend };
    }
    case "session_stopped":
      if (!isWorktree(m.worktree) || typeof m.reason !== "string") return null;
      return { type: "session_stopped", worktree: m.worktree, reason: m.reason };
    case "agent_event": {
      if (!isWorktree(m.worktree)) return null;
      const event = parseAgentEvent(m.event);
      if (event === null) return null;
      return { type: "agent_event", worktree: m.worktree, event };
    }
    case "canvas_call":
      if (!isWorktree(m.worktree) || !isId(m.id)) return null;
      // `args` is the harness's tool payload: validated by the canvas, not here
      return { type: "canvas_call", worktree: m.worktree, id: m.id, args: m.args };
    case "reality": {
      if (!isWorktree(m.worktree)) return null;
      const reality = parseReality(m.reality);
      if (reality === null) return null;
      const head = m.head ?? null;
      if (!isNullableString(head)) return null;
      return { type: "reality", worktree: m.worktree, reality, head };
    }
    case "worktrees": {
      const id = m.id ?? null;
      if (!isNullableString(id)) return null;
      const worktrees = parseWorktrees(m.worktrees);
      if (worktrees === null) return null;
      return { type: "worktrees", id, worktrees };
    }
    case "skeleton_result":
      if (!isWorktree(m.worktree) || !isId(m.id) || !Array.isArray(m.ops)) return null;
      // every op is validated by `applyOps`; a non-array is what it cannot survive
      return { type: "skeleton_result", worktree: m.worktree, id: m.id, ops: m.ops as CanvasOp[] };
    case "agent_error":
      if (typeof m.message !== "string") return null;
      return { type: "agent_error", message: m.message };
    case "agent_exit":
    case "detached":
      if (typeof m.reason !== "string") return null;
      return { type: m.type, reason: m.reason };
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
      if (!isId(m.projectId)) return null;
      return { type: "attached", projectId: m.projectId };
    case "error":
      if (typeof m.message !== "string") return null;
      return { type: "error", message: m.message };
    case "canvas_result":
      if (!isId(m.id) || typeof m.text !== "string" || typeof m.isError !== "boolean") return null;
      return { type: "canvas_result", id: m.id, text: m.text, isError: m.isError };
    case "focus_terminal":
      if (!isWorktree(m.worktree)) return null;
      return { type: "focus_terminal", worktree: m.worktree };
    case "list_worktrees":
      if (!isId(m.id)) return null;
      return { type: "list_worktrees", id: m.id };
    case "synthesize_skeleton":
      if (!isWorktree(m.worktree) || !isId(m.id)) return null;
      return { type: "synthesize_skeleton", worktree: m.worktree, id: m.id };
    case "extract_reality":
      if (!isWorktree(m.worktree)) return null;
      return { type: "extract_reality", worktree: m.worktree };
    default:
      return null;
  }
}
