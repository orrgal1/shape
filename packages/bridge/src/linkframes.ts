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
  DiscoveredSession,
  Harness,
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
  if (terminal !== "external" && terminal !== "pane" && terminal !== "none") return null;
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
 * "what can I start": the agent re-sends its tools on every attach. A present
 * but malformed value is a malformed frame.
 */
function parseTools(value: unknown): ProjectTools | null {
  if (value === undefined) return { launcher: "pty", launchers: [], harnesses: [] };
  if (value === null || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (t.launcher !== "herdr" && t.launcher !== "pty") return null;
  const launchers = parseToolList(t.launchers);
  if (launchers === null) return null;
  const harnesses = parseToolList(t.harnesses);
  if (harnesses === null) return null;
  return { launcher: t.launcher, launchers, harnesses };
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

/** the project half of an `attach`; also one row's project in the server's registry */
export function parseProject(value: unknown): AgentProject | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  // the key is the room's identity: an empty one would merge unrelated projects
  if (!isId(p.key)) return null;
  if (typeof p.label !== "string" || typeof p.cwd !== "string") return null;
  if (typeof p.targetHasCode !== "boolean") return null;
  // a registry row written before publishing existed still parses: the machine
  // that wrote it never claimed it could publish
  const canPublish = p.canPublish === true;
  // older registry rows and older agents never wrote a directive: null means
  // "no file to point a launcher at", which is a real state, not a bad frame
  const directivePath =
    typeof p.directivePath === "string" && p.directivePath.length > 0 ? p.directivePath : null;
  // a project with no harness running is a real state (nothing resolved, or
  // nothing installed): the room opens on the "start a session" card
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
    canPublish,
    directivePath,
    legacyKeys: parseLegacyKeys(p.legacyKeys),
  };
}

/**
 * The publish half of a create, both ways on the wire. Absent and null are the
 * same request — "just the folder" — so a client that omits the field is not a
 * malformed frame.
 */
function parseGithubRequest(value: unknown): { visibility: "public" | "private" } | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  if (g.visibility !== "public" && g.visibility !== "private") return undefined;
  return { visibility: g.visibility };
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
 * The harnesses an agent is running, one per opened worktree. Every field is
 * load-bearing where this lands: the room keys its per-worktree state by
 * `worktree`, the client renders from `backend.capabilities`, and `state`
 * decides whether a worktree can be steered at all.
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
      const worktrees = parseWorktrees(m.worktrees);
      if (worktrees === null) return null;
      const sessions = parseWorktreeSessions(m.sessions);
      if (sessions === null) return null;
      const realities = parseRealities(m.realities);
      if (realities === null) return null;
      const discovered = parseSessions(m.discovered);
      if (discovered === null) return null;
      const recentProjects = parseStringArray(m.recentProjects);
      if (recentProjects === null) return null;
      return { type: "attach", project, worktrees, sessions, realities, discovered, recentProjects };
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
    case "folder_picked":
      // `null` IS the answer — the user closed the chooser — but an empty
      // string is neither an answer nor a path anybody could open
      if (m.path === null) return { type: "folder_picked", path: null };
      if (!isId(m.path)) return null;
      return { type: "folder_picked", path: m.path };
    case "delivered":
      if (!isWorktree(m.worktree) || !isId(m.id)) return null;
      if (m.mode !== "prompt" && m.mode !== "steer") return null;
      if (typeof m.queued !== "boolean") return null;
      return { type: "delivered", worktree: m.worktree, id: m.id, mode: m.mode, queued: m.queued };
    case "skeleton_result":
      if (!isWorktree(m.worktree) || !isId(m.id) || !Array.isArray(m.ops)) return null;
      // every op is validated by `applyOps`; a non-array is what it cannot survive
      return { type: "skeleton_result", worktree: m.worktree, id: m.id, ops: m.ops as CanvasOp[] };
    case "file_index": {
      if (!isWorktree(m.worktree) || !isId(m.id)) return null;
      const files = parseStringArray(m.files);
      if (files === null) return null;
      return { type: "file_index", worktree: m.worktree, id: m.id, files };
    }
    case "agent_error":
      if (typeof m.message !== "string") return null;
      return { type: "agent_error", message: m.message };
    case "created": {
      if (typeof m.path !== "string" || m.path.length === 0) return null;
      if (m.repo !== "initialized" && m.repo !== "existing") return null;
      let github: { url: string } | null = null;
      if (m.github !== null && m.github !== undefined) {
        if (typeof m.github !== "object") return null;
        const url = (m.github as Record<string, unknown>).url;
        if (typeof url !== "string" || url.length === 0) return null;
        github = { url };
      }
      const warnings = parseStringArray(m.warnings);
      if (warnings === null) return null;
      return { type: "created", path: m.path, repo: m.repo, github, warnings };
    }
    case "agent_exit":
    case "detached":
      if (typeof m.reason !== "string") return null;
      return { type: m.type, reason: m.reason };
    case "terminal":
      if (!isWorktree(m.worktree) || typeof m.open !== "boolean") return null;
      return { type: "terminal", worktree: m.worktree, open: m.open };
    case "pty_data":
      if (!isWorktree(m.worktree) || typeof m.data !== "string") return null;
      return { type: "pty_data", worktree: m.worktree, data: m.data };
    case "pty_exit": {
      if (!isWorktree(m.worktree)) return null;
      const code = m.code ?? null;
      if (code !== null && (typeof code !== "number" || !Number.isInteger(code))) return null;
      return { type: "pty_exit", worktree: m.worktree, code };
    }
    case "pty_state":
      if (!isWorktree(m.worktree)) return null;
      if (typeof m.open !== "boolean" || typeof m.shell !== "string") return null;
      if (typeof m.cwd !== "string") return null;
      return { type: "pty_state", worktree: m.worktree, open: m.open, shell: m.shell, cwd: m.cwd };
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
      if (!isWorktree(m.worktree) || !isId(m.id) || typeof m.body !== "string") return null;
      return { type: "deliver", worktree: m.worktree, id: m.id, body: m.body };
    case "abort":
      if (!isWorktree(m.worktree)) return null;
      return { type: "abort", worktree: m.worktree };
    case "open_worktree": {
      // a worktree is opened BY PATH: its id is the realpath the agent resolves
      if (typeof m.path !== "string" || m.path.trim().length === 0) return null;
      const backend = m.backend;
      if (backend !== undefined && typeof backend !== "string") return null;
      const resumeSessionId = m.resumeSessionId;
      if (resumeSessionId !== undefined && typeof resumeSessionId !== "string") return null;
      // both flags come off a checkbox: absent is false, and anything that is
      // not a boolean is a frame nobody meant to send
      const autonomous = m.autonomous;
      if (autonomous !== undefined && typeof autonomous !== "boolean") return null;
      const remember = m.remember;
      if (remember !== undefined && typeof remember !== "boolean") return null;
      const msg: Extract<ServerToAgentMsg, { type: "open_worktree" }> = {
        type: "open_worktree",
        path: m.path.trim(),
      };
      if (backend !== undefined) msg.backend = backend;
      if (resumeSessionId !== undefined) msg.resumeSessionId = resumeSessionId;
      if (autonomous !== undefined) msg.autonomous = autonomous;
      if (remember !== undefined) msg.remember = remember;
      return msg;
    }
    case "focus_terminal":
      if (!isWorktree(m.worktree)) return null;
      return { type: "focus_terminal", worktree: m.worktree };
    case "close_worktree":
      if (!isWorktree(m.worktree)) return null;
      return { type: "close_worktree", worktree: m.worktree };
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
    case "create": {
      if (typeof m.path !== "string" || m.path.trim().length === 0) return null;
      const github = parseGithubRequest(m.github);
      if (github === undefined) return null;
      return { type: "create", path: m.path.trim(), github };
    }
    case "adopt":
      if (typeof m.pid !== "number" || !Number.isInteger(m.pid) || m.pid <= 0) return null;
      return { type: "adopt", pid: m.pid };
    case "pick_folder":
      // nothing to carry: the agent's machine is the one with the dialog
      return { type: "pick_folder" };
    case "discover":
    case "list_worktrees":
      if (!isId(m.id)) return null;
      return { type: m.type, id: m.id };
    case "synthesize_skeleton":
    case "file_index":
      if (!isWorktree(m.worktree) || !isId(m.id)) return null;
      return { type: m.type, worktree: m.worktree, id: m.id };
    case "extract_reality":
      if (!isWorktree(m.worktree)) return null;
      return { type: "extract_reality", worktree: m.worktree };
    case "pty_open":
    case "pty_resize": {
      if (!isWorktree(m.worktree)) return null;
      // a terminal size must be a real geometry: the pty is resized with it
      const { cols, rows } = m;
      if (typeof cols !== "number" || !Number.isInteger(cols) || cols <= 0) return null;
      if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 0) return null;
      return { type: m.type, worktree: m.worktree, cols, rows };
    }
    case "pty_input":
      if (!isWorktree(m.worktree) || typeof m.data !== "string") return null;
      return { type: "pty_input", worktree: m.worktree, data: m.data };
    case "pty_close":
      if (!isWorktree(m.worktree)) return null;
      return { type: "pty_close", worktree: m.worktree };
    default:
      return null;
  }
}
