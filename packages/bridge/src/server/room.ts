/**
 * One project's canvases, server side: a graph per worktree with its own
 * revisions, the sessions reporting in from them, and the translation between
 * browser frames (`ClientMsg`) and agent link frames (`AgentToServerMsg` /
 * `ServerToAgentMsg`).
 *
 * A project is one repo, and every worktree of it is a variation with its own
 * canvas — the view merges them, the server keeps them apart. So the room is a
 * `Map<worktreeId, WorktreeState>`: graph, revisions, activity and session
 * state are all per worktree, and every frame about one of them names it. A
 * worktree no session ever reported from still has a state: its canvas is
 * readable like any other.
 *
 * Nothing here instructs a session. The room watches: it projects what the
 * harnesses do onto their canvases, and the one thing it writes by itself is
 * the mechanical skeleton of a project whose canvas is still empty.
 *
 * The room never touches the target repo. Everything that needs a filesystem —
 * reality extraction, worktrees, the mechanical skeleton — is asked of the
 * agent and awaited as a link answer, so a project on another machine is
 * served exactly like a local one.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { diffSnapshots } from "../../../shared/src/delta.ts";
import { symbolRefOf } from "../../../shared/src/index.ts";
import type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentState,
  AgentToServerMsg,
  BackendInfo,
  CanvasBranchInfo,
  CatchUpState,
  ClientMsg,
  ControlErrorResponse,
  GraphDoc,
  LiveUpdateRequest,
  LiveUpdatedResponse,
  MapCommitRequest,
  MapCommittedResponse,
  MapReadRequest,
  MapStateResponse,
  ProjectSummary,
  ProjectTools,
  RealityLayer,
  RevisionInfo,
  ServerMsg,
  ServerToAgentMsg,
  SessionInfo,
  WorktreeInfo,
  WatchedProjectCandidate,
  WorktreeSession,
} from "../../../shared/src/index.ts";
import type { ServerEnd } from "../transport.ts";
import { computeDrift } from "./drift.ts";
import { importLegacyProject } from "./legacy.ts";
import { SnapshotStore } from "./snapshots.ts";
import { type Storage, type StoredBranchState, type StoredProject } from "./storage.ts";
import { GraphStore } from "./store.ts";

/** the frame that opens a room, or re-binds the one its agent already holds */
export type AttachMsg = Extract<AgentToServerMsg, { type: "attach" }>;

/** everything else an agent sends; `attach` is the server's business, not a room's */
export type AgentFrame = Exclude<AgentToServerMsg, { type: "attach" }>;
/**
 * Browser frames one room answers directly. Project selection, status and
 * watched-project registration belong to the server that owns every room.
 */
export type RoomClientMsg = Extract<ClientMsg, { type: "focus_terminal" | "diff" }>;

/** Equality of extracted reality excluding its observation timestamp and nothing else. */
function sameReality(left: RealityLayer, right: RealityLayer): boolean {
  const leftSemantic: Partial<RealityLayer> = { ...left };
  const rightSemantic: Partial<RealityLayer> = { ...right };
  delete leftSemantic.extractedAt;
  delete rightSemantic.extractedAt;
  return JSON.stringify(leftSemantic) === JSON.stringify(rightSemantic);
}

/** Git's short branch spelling is physical metadata; canvas ids are full refs. */
function branchIdOf(branch: string | null): string | null {
  if (branch === null || branch.length === 0) return null;
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

const LIVE_BACKEND: BackendInfo = {
  id: "shape-live",
  label: "Shape live",
  capabilities: {
    steerMidTurn: false,
    hostTool: false,
    events: "reported",
    resume: false,
    terminal: "none",
  },
};

/**
 * One persistent branch canvas. Physical worktrees only supply routing and
 * checkout metadata; a branch can exist here without any checkout or agent.
 */
interface WorktreeState {
  /** opaque persistent branch id (normally a full refs/heads/* ref) */
  readonly id: string;
  /** display-only checkout path, null when this branch has no checkout */
  path: string | null;
  /** full branch ref */
  branch: string;
  head: string | null;
  mappedCommit: string | null;
  live: boolean;
  isDefault: boolean;
  store: GraphStore;
  snapshots: SnapshotStore;
  /** bubbles the harness is working in right now */
  activity: Set<string>;
  agent: AgentState;
  /** last state reported by the physical harness, independent of explicit live sessions */
  physicalAgent: AgentState;
  /** the harness reporting in from here, or null when none is */
  session: AgentSession | null;
  /** the harness's backend; null exactly when `session` is */
  backend: BackendInfo | null;
  catchUp: CatchUpState;
  /** serializes physical writes for this branch */
  writing: Promise<void>;
  /**
   * The assistant message being written right now, folded from `text_delta`.
   * Kept only until the turn ends: this is the live line under the canvas, not
   * a record of anything — the `text` frame is the message of record.
   */
  now: string;
  /** throttle timer of the live `now` line; null when nothing is waiting to go out */
  nowTimer: NodeJS.Timeout | null;
  /** deltas arrived since the last `now` went out */
  nowDirty: boolean;
  /** the last `now` text broadcast, so clearing an already-clear line says nothing */
  nowSent: string | null;
}

interface ControlSession {
  branch: string;
  state: AgentState;
}

export interface ProjectRoomOptions {
  /** reaches every browser watching this project */
  broadcast: (msg: ServerMsg) => void;
  /**
   * Every project the server hosts, for `hello`. A room knows nothing about
   * its siblings; the server that owns them all answers this.
   */
  projects: () => ProjectSummary[];
  /** this room lost its agent: every browser on the server owes a fresh list */
  onProjectsChanged: () => void;
  /** where this project's graphs, their revisions and its registry row are stored */
  storage: Storage;
  /**
   * The tenant this room belongs to: rooms are keyed `(tenant, projectKey)`, so
   * the same project key on two tenants is two rooms with two graphs. It is
   * part of every record's key and the audit's subject, never something a frame
   * says.
   */
  tenant: string;
  /**
   * Look for a pre-SQLite `<cwd>/.shape/graph.json` when a project is opened
   * for the first time, and take it over. Only local mode has repos to find one
   * in: a remote server's projects live on machines it cannot see.
   */
  importLegacy: boolean;
}

/**
 * How long a browser-facing answer waits on the agent. A hello must not hang on
 * a busy agent: it falls back to what the last attach told us.
 */
const REQUEST_TIMEOUT_MS = 3_000;
/** A native chooser may stay open while a person browses. */
const PICK_DIRECTORY_TIMEOUT_MS = 600_000;

const DIRECTORY_PICKER_UNAVAILABLE = "no connected local Shape agent can browse folders";

/** Refusal for everything that needs the agent while none is attached. */
const AGENT_GONE = "no agent is attached to this project — start `shape agent` in it";


/**
 * How often the live "now" line may go out. The deltas of one message arrive
 * dozens of times a second; a reader gains nothing from more than a handful of
 * updates a second and every browser on the project pays for each one.
 */
const NOW_THROTTLE_MS = 150;

/**
 * How much of the message being written the "now" line carries: its tail. It
 * is one line under a canvas, not a transcript — the whole message arrives as
 * `text` a moment later and is what the panel keeps.
 */
const NOW_TAIL = 120;

/**
 * What a room reports for a project whose agent never said. Only a registry
 * row written before Shape detected tools has none: no launcher and nothing
 * detected is exactly what such a machine could be, and the browser shows no
 * card it cannot honour.
 */
const NO_TOOLS: ProjectTools = { launcher: null, launchers: [], harnesses: [], directoryPicker: false };

interface PendingRequest {
  type: ServerToAgentMsg["type"];
  settle: (value: unknown) => void;
  fail: (err: Error) => void;
  timer: NodeJS.Timeout;
  stopListening: (() => void) | null;
}

/** Agent failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * What the project's agent found on its machine. A registry row written before
 * Shape detected tools has none — the field is missing from the stored JSON,
 * not null — and such a project reports the one thing it certainly could do.
 */
function toolsOf(project: AgentProject): ProjectTools {
  const tools: ProjectTools | undefined = project.tools;
  return tools ?? NO_TOOLS;
}

export class ProjectRoom {
  /** re-assigned by every attach: a reconnecting agent brings a new link to the same room */
  #link!: ServerEnd;
  readonly #broadcast: (msg: ServerMsg) => void;
  readonly #projects: () => ProjectSummary[];
  readonly #onProjectsChanged: () => void;
  readonly #storage: Storage;
  readonly #tenant: string;
  readonly #importLegacy: boolean;
  /** assigned by retarget() or restore(), which always run before anything else reaches the room */
  #project!: AgentProject;
  /** legacy project keys reported by the physical agent, including namespaced older generations */
  #legacyKeys: Record<string, string> = {};
  /** persistent branch states, keyed by opaque branch id */
  readonly #states = new Map<string, WorktreeState>();
  readonly #pendingStates = new Map<string, Promise<WorktreeState>>();
  /** current non-detached checkout route: physical worktree id -> branch id */
  readonly #worktreeBranches = new Map<string, string>();
  /** route captured when a physical session starts, so later checkout changes cannot retarget it */
  readonly #sessionBranches = new Map<string, string>();
  /** explicit remote live sessions, routed only by their caller-supplied id */
  readonly #controlSessions = new Map<string, ControlSession>();
  /** remote control-created rows keep repository.path inert until a real agent attaches */
  #controlOnly = false;
  /** every physical checkout refresh, in arrival order */
  #worktreeSync: Promise<void> = Promise.resolve();
  /** serializes control mutations and their browser broadcasts */
  #controlWriting: Promise<void> = Promise.resolve();
  #loaded = false;
  /** an agent link is bound to this room right now; false ⇒ the canvases are read-only */
  #agentConnected = false;
  /** ISO time of the last attach or detach */
  #lastSeen = new Date().toISOString();
  /** last values the agent reported; a hello the agent does not answer uses these */
  #worktrees: WorktreeInfo[] = [];
  /**
   * Worktree ids the last discovery scan found a live session in — a herdr
   * agent, or a caller on the loopback link. Those are the sessions only the
   * scan can see: the ones reporting in over this room's own link are in the
   * worktree states, and the live count is the union of the two.
   */
  #seenLive = new Set<string>();
  /**
   * When this project's status was last set. A room only ever holds an ACTIVE
   * project, so it carries the stamp it was restored with instead of deciding
   * one: the row it files must not move a status the registry owns.
   */
  #statusChangedAt = new Date().toISOString();
  /**
   * The row this room filed on its way out. A closed room has dropped its
   * canvases, so it can no longer count what was running in them: the row it
   * last wrote is the answer for the registry that outlives it.
   */
  #closed: StoredProject | null = null;
  readonly #pending = new Map<string, PendingRequest>();
  #requestSeq = 0;

  constructor(opts: ProjectRoomOptions) {
    this.#broadcast = opts.broadcast;
    this.#projects = opts.projects;
    this.#onProjectsChanged = opts.onProjectsChanged;
    this.#storage = opts.storage;
    this.#tenant = opts.tenant;
    this.#importLegacy = opts.importLegacy;
  }

  get agentConnected(): boolean {
    return this.#agentConnected;
  }

  /** stable project key, without the tenant prefix */
  get projectId(): string {
    return this.#project.key;
  }

  /** the tenant whose project list, default room and storage tree this room is in */
  get tenant(): string {
    return this.#tenant;
  }

  /** the room's agent arrived on `end`; a link it has moved off has no say here */
  attachedTo(end: ServerEnd): boolean {
    return this.#agentConnected && this.#link === end;
  }

  /** what the switcher shows for this project; a room means it is active */
  summary(): ProjectSummary {
    const precedence = { idle: 0, queued: 1, running: 2, failed: 3 };
    let catchUp: CatchUpState = { state: "idle", at: 0 };
    for (const state of this.#states.values()) {
      if (precedence[state.catchUp.state] > precedence[catchUp.state] ||
          (state.catchUp.state === catchUp.state && state.catchUp.at > catchUp.at)) catchUp = state.catchUp;
    }
    return {
      projectId: this.#project.key,
      label: this.#project.label,
      cwd: this.#project.cwd,
      status: "active",
      liveSessions: this.#liveSessions(),
      manager: this.#project.manager !== null,
      catchUp,
      caughtUp: catchUp.state === "idle",
      injected: this.#project.injected.length,
      lastSeen: this.#lastSeen,
    };
  }

  /** Count distinct persistent branches with a physical or explicit live session. */
  #liveSessions(): number {
    const live = new Set<string>();
    for (const worktree of this.#seenLive) {
      const branch = this.#worktreeBranches.get(worktree);
      if (branch !== undefined) live.add(branch);
    }
    for (const state of this.#states.values()) {
      if (state.session !== null) live.add(state.id);
    }
    for (const session of this.#controlSessions.values()) live.add(session.branch);
    return live.size;
  }

  /** Bind a physical agent while keeping persistent branch canvases authoritative. */
  async retarget(attach: AttachMsg, link: ServerEnd): Promise<void> {
    if (this.#loaded) await this.#closeStates();

    const project = attach.project;
    this.#controlOnly = false;
    this.#project = project;
    this.#legacyKeys = project.legacyKeys;
    this.#worktreeBranches.clear();
    this.#sessionBranches.clear();

    // Migrate each physical legacy graph before associating its checkout with
    // a branch. These rows remain uncommitted overlays; adoption never invents
    // a mapping baseline.
    for (const info of attach.worktrees) await this.#adoptLegacy(info.id);
    if (this.#importLegacy) await importLegacyProject(this.#storage, this.#tenant, project);

    await this.#loadPersistentBranches();
    await this.#scheduleWorktrees(attach.worktrees);

    for (const info of attach.worktrees) {
      const state = this.#stateForWorktree(info.id);
      if (state === null) continue;
      const reality = attach.realities[info.id];
      if (reality !== undefined && !sameReality(state.store.doc.reality, reality)) {
        state.store.setReality(reality, computeDrift(state.store.doc, reality));
        await this.#graphChanged(state);
      }
    }
    for (const running of attach.sessions) {
      const state = this.#stateForWorktree(running.worktree);
      if (state === null) continue;
      this.#sessionBranches.set(running.worktree, state.id);
      state.session = running.session;
      state.backend = running.backend;
      state.agent = running.state;
      state.physicalAgent = running.state;
    }

    this.#loaded = true;
    this.#agentConnected = true;
    this.#lastSeen = new Date().toISOString();
    this.#link = link;
    this.#link.send({ type: "attached", projectId: project.key });
  }

  /**
   * Reopen only durable branch records. Registry worktree paths are display
   * metadata, never filesystem authority; an agentless control-created room
   * with no worktrees therefore performs no path resolution or fallback load.
   */
  async restore(row: StoredProject): Promise<void> {
    this.#controlOnly = row.controlOnly;
    this.#project = row.project;
    await this.#loadPersistentBranches();
    await this.#scheduleWorktrees(row.worktrees);
    this.#loaded = true;
    this.#lastSeen = row.lastSeen;
    this.#statusChangedAt = row.statusChangedAt;
  }

  /**
   * What the last discovery scan found for this project: every worktree of the
   * repo, and which of them a session was seen in. The scan is the only source
   * for sessions this room has no link to (a herdr agent that never greeted),
   * so its live ids are kept as they are. A worktree list that says something
   * new is taken exactly like the agent's own re-listing — a variation that
   * appeared gets its canvas, and the browsers hear the new session facts.
   */
  noteSeen(worktrees: WorktreeInfo[], live: string[]): void {
    this.#seenLive = new Set(live);
    this.updateWorktrees(worktrees);
  }

  /** Refresh picker/discovery worktree facts without changing live-session evidence. */
  updateWorktrees(worktrees: WorktreeInfo[]): void {
    const known = new Map(this.#worktrees.map((info) => [info.id, info]));
    const same =
      worktrees.length === known.size &&
      worktrees.every((info) => {
        const previous = known.get(info.id);
        return (
          previous !== undefined &&
          previous.path === info.path &&
          previous.branch === info.branch &&
          previous.head === info.head
        );
      });
    if (same) return;
    void this.#scheduleWorktrees(worktrees).then(() => this.#broadcastSession());
  }

  /**
   * The registry row for this project as it stands: what a restarted server
   * reopens the room from, and what the server's in-memory registry holds for
   * it. `status` is always active — a room exists exactly while the project is
   * — and the storage refuses to move the status of an existing row anyway, so
   * this can never resurrect a project an operator has just parked. A closed
   * room answers with the row it filed on its way out: its canvases are gone,
   * so it cannot count what was running in them a second time.
   */
  row(): StoredProject {
    const closed = this.#closed;
    if (closed !== null) return closed;
    return {
      project: this.#project,
      tenant: this.#tenant,
      worktrees: this.#worktrees,
      sessions: this.#runningSessions(),
      controlOnly: this.#controlOnly,
      liveSessions: this.#liveSessions(),
      status: "active",
      statusChangedAt: this.#statusChangedAt,
      lastSeen: this.#lastSeen,
    };
  }

  /**
   * File this project in the registry: what a restarted server needs to reopen
   * the rooms without their agent. Called after every attach, and again when
   * the agent leaves so `lastSeen` is the departure. A registry that cannot be
   * written costs the next restart a project, never this session a turn.
   */
  saveProject(): Promise<void> {
    return this.#storage.saveProject(this.row()).catch((err: unknown) => {
      console.error(`[bridge] failed to save project registry: ${errText(err)}`);
    });
  }

  /**
   * Ask this room's attached agent to choose a repository. The room owns the
   * correlation because the link is scoped to this project; the server owns
   * registration because only it can mutate the tenant registry.
   */
  pickDirectory(signal?: AbortSignal): Promise<WatchedProjectCandidate | null> {
    if (!this.#agentConnected || !toolsOf(this.#project).directoryPicker) {
      return Promise.reject(new Error(DIRECTORY_PICKER_UNAVAILABLE));
    }
    if ([...this.#pending.values()].some((pending) => pending.type === "pick_directory")) {
      return Promise.reject(new Error("a directory picker is already open"));
    }
    return this.#request<WatchedProjectCandidate | null>(
      (id) => ({ type: "pick_directory", id }),
      PICK_DIRECTORY_TIMEOUT_MS,
      signal,
    );
  }

  /**
   * Ask the originating agent to open a separate observation-only runtime for
   * the selected repository. The acknowledgement means that runtime attached
   * to its own room; it never retargets this one.
   */
  async watchProject(project: WatchedProjectCandidate): Promise<void> {
    if (!this.#agentConnected || !toolsOf(this.#project).directoryPicker) {
      throw new Error(DIRECTORY_PICKER_UNAVAILABLE);
    }
    if ([...this.#pending.values()].some((pending) => pending.type === "watch_project")) {
      throw new Error("the agent is already activating a watched project");
    }
    const key = await this.#request<string>((id) => ({ type: "watch_project", id, project }), PICK_DIRECTORY_TIMEOUT_MS);
    if (key !== project.key) throw new Error(`agent activated unexpected project ${key}`);
  }

  /**
   * The worktrees are re-detected on every hello: listing them is a cheap `git
   * worktree list` on the agent side, worth it to have the variations right
   * the instant a browser opens. An agent too busy to answer in time does not
   * hold the browser up — the hello goes out with the values from the last
   * attach.
   */
  async hello(): Promise<ServerMsg> {
    const worktrees = await this.#request<WorktreeInfo[]>((id) => ({ type: "list_worktrees", id })).catch(
      () => this.#worktrees,
    );
    await this.#scheduleWorktrees(worktrees);

    const states = [...this.#states.values()];
    const lists = await Promise.all(states.map((state) => state.snapshots.list()));
    const graphs: Record<string, GraphDoc> = {};
    const agents: Record<string, AgentState> = {};
    const revisions: Record<string, RevisionInfo[]> = {};
    const catchUps: Record<string, CatchUpState> = {};
    states.forEach((state, index) => {
      graphs[state.id] = state.store.doc;
      catchUps[state.id] = state.catchUp;
      // Branch-keyed browser state includes physical sessions and explicit
      // remote live sessions; checkout ids never escape this room.
      const control = [...this.#controlSessions.values()].find((session) => session.branch === state.id);
      if (control !== undefined) agents[state.id] = control.state;
      else if (state.session !== null) agents[state.id] = state.agent;
      revisions[state.id] = lists[index] ?? [];
    });

    return {
      type: "hello",
      graphs,
      session: this.#sessionInfo(),
      agents,
      catchUps,
      projects: this.#projects(),
      projectId: this.#project.key,
      revisions,
      // project-wide: one agent process, one PATH, one chosen launcher
      tools: toolsOf(this.#project),
    };
  }

  /** Read the committed mapping baseline, never the live effective overlay. */
  async mapRead(request: MapReadRequest): Promise<MapStateResponse> {
    const stored = await this.#storage.readBranch(this.#tenant, this.#project.key, request.branch);
    return {
      type: "map_state",
      requestId: request.requestId,
      repository: request.repository,
      branch: request.branch,
      revision: stored?.effective.rev ?? 0,
      mappedCommit: stored?.info.mappedCommit ?? null,
      doc: stored?.baseline ?? null,
    };
  }
  mapCommit(request: MapCommitRequest): Promise<MapCommittedResponse | ControlErrorResponse> {
    return this.#serializeControl(async () => {
      const result = await this.#storage.mapCommit(this.#tenant, request, this.row());
      if (result.type === "control_error") return result;
      for (const [sessionId, session] of [...this.#controlSessions]) {
        if (session.branch !== request.branch) continue;
        this.#controlSessions.delete(sessionId);
        this.#broadcast({ type: "session_stopped", worktree: request.branch, reason: "mapping committed" });
      }
      const state = await this.#refreshBranch(request.branch);
      if (state !== null) {
        this.#setActivity(state, []);
        this.#setAgent(state, state.physicalAgent);
      }
      this.#broadcastSession();
      this.#onProjectsChanged();
      return result;
    });
  }

  liveUpdate(request: LiveUpdateRequest): Promise<LiveUpdatedResponse | ControlErrorResponse> {
    return this.#serializeControl(async () => {
      const previous = this.#controlSessions.get(request.sessionId);
      if (previous !== undefined && previous.branch !== request.branch) {
        return {
          type: "control_error",
          requestId: request.requestId,
          code: "invalid",
          message: `live session ${request.sessionId} is already bound to ${previous.branch}`,
        };
      }
      const result = await this.#storage.liveUpdate(this.#tenant, request);
      if (result.type === "control_error") return result;
      const state = await this.#refreshBranch(request.branch);
      if (state === null) {
        return {
          type: "control_error",
          requestId: request.requestId,
          code: "not_mapped",
          message: `branch ${request.branch} is not mapped; run shape map first`,
        };
      }

      if (request.state === "stop") {
        this.#controlSessions.delete(request.sessionId);
        if (previous !== undefined) {
          this.#broadcast({ type: "session_stopped", worktree: previous.branch, reason: "shape live stopped" });
        }
      } else {
        const agentState: AgentState = request.state === "working" ? "streaming" : "idle";
        this.#controlSessions.set(request.sessionId, { branch: request.branch, state: agentState });
        if (previous === undefined) {
          this.#broadcast({
            type: "session_started",
            worktree: request.branch,
            session: { sessionId: request.sessionId, sessionName: "shape live", model: null },
            backend: LIVE_BACKEND,
          });
        }
      }
      const explicit = [...this.#controlSessions.values()].find((session) => session.branch === state.id);
      this.#setAgent(state, explicit?.state ?? state.physicalAgent);

      if (request.state === "idle" || request.state === "stop") {
        this.#setActivity(state, []);
      } else {
        const active = new Set(request.files === undefined ? [] : this.#nodesForFiles(state, request.files));
        const existing = new Set(state.store.doc.nodes.map((node) => node.id));
        for (const op of request.ops ?? []) {
          if (op.op === "upsert_node" && existing.has(op.node.id)) active.add(op.node.id);
          else if (op.op === "set_phase" && existing.has(op.id)) active.add(op.id);
          else if (op.op === "upsert_edge") {
            if (existing.has(op.edge.source)) active.add(op.edge.source);
            if (existing.has(op.edge.target)) active.add(op.edge.target);
          }
        }
        this.#setActivity(state, [...active]);
      }
      const detail = request.note ?? request.tool;
      if (detail !== undefined && detail.length > 0) {
        this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: `shape live: ${detail}` });
      }
      this.#broadcastSession();
      this.#onProjectsChanged();
      return result;
    });
  }

  #serializeControl<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#controlWriting.then(run);
    this.#controlWriting = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #refreshBranch(branch: string): Promise<WorktreeState | null> {
    const stored = await this.#storage.readBranch(this.#tenant, this.#project.key, branch);
    if (stored === null) return null;
    const state = await this.#openState(stored);
    this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
    this.#broadcast({ type: "revisions", worktree: state.id, revisions: await state.snapshots.list() });
    return state;
  }
  /**
   * The link dropped, or the agent detached: nothing of this project reports in
   * any more, every canvas is frozen as it stands, and everything a browser was
   * waiting on fails with a line it can show instead of hanging until the
   * request timeout.
   */
  agentGone(line: string): void {
    console.error(`[bridge] ${line}`);
    // a `detached` frame already told us; the close that follows is not news
    if (!this.#agentConnected) return;

    this.#agentConnected = false;
    this.#lastSeen = new Date().toISOString();
    for (const state of this.#states.values()) {
      if (state.session === null) continue;
      state.session = null;
      state.backend = null;
      const explicit = [...this.#controlSessions.values()].find((session) => session.branch === state.id);
      this.#broadcast({ type: "session_stopped", worktree: state.id, reason: line });
      this.#setAgent(state, explicit?.state ?? "idle");
      if (explicit === undefined) this.#setActivity(state, []);
      this.#clearNow(state);
    }
    this.#sessionBranches.clear();
    this.#broadcastSession();
    for (const id of [...this.#pending.keys()]) {
      this.#cancelRequest(id, new Error(AGENT_GONE), false);
    }
    this.#onProjectsChanged();
    void this.saveProject();
  }

  /**
   * The project was marked inactive: its records are flushed, the row is filed
   * with this moment as `lastSeen`, and the agent behind it is told why its
   * link is going away — an inactive project has no room, so the runtime that
   * was feeding it has nothing to feed. Everything a browser was waiting on
   * fails with a line it can show, and the timers this room armed are stopped:
   * nothing may fire onto a room the server has let go of.
   */
  async close(): Promise<void> {
    const line = `project ${this.#project.label} is inactive`;
    // marking a project inactive is a detach, and `lastSeen` is what orders it
    // among the inactive rows the switcher reveals
    this.#lastSeen = new Date().toISOString();
    // the row is taken while the canvases are still here: it names the
    // sessions that were running and where, which is what a resume reads off
    // an inactive row. It is also the row the server's registry keeps for this
    // project from here on, so it is frozen rather than recomputed.
    this.#closed = this.row();
    await this.saveProject();
    await this.#closeStates();
    for (const id of [...this.#pending.keys()]) {
      this.#cancelRequest(id, new Error(line), true);
    }
    if (!this.#agentConnected) return;
    this.#agentConnected = false;
    this.#link.send({ type: "error", message: line });
    this.#link.close("project marked inactive");
  }

  // -------------------------------------------------------------------------
  // persistent branch states and physical routing
  // -------------------------------------------------------------------------

  #branchInfo(state: WorktreeState): CanvasBranchInfo {
    return {
      id: state.id,
      branch: state.branch,
      head: state.head,
      mappedCommit: state.mappedCommit,
      live: state.live || state.session !== null || [...this.#controlSessions.values()].some((s) => s.branch === state.id),
      path: state.path,
      isDefault: state.isDefault,
    };
  }

  async #loadPersistentBranches(): Promise<void> {
    const infos = await this.#storage.listBranches(this.#tenant, this.#project.key);
    for (const info of infos) {
      const stored = await this.#storage.readBranch(this.#tenant, this.#project.key, info.id);
      if (stored !== null) await this.#openState(stored);
    }
  }

  #openState(stored: StoredBranchState): Promise<WorktreeState> {
    const existing = this.#states.get(stored.info.id);
    if (existing !== undefined) {
      this.#applyStored(existing, stored);
      return Promise.resolve(existing);
    }
    const pending = this.#pendingStates.get(stored.info.id);
    if (pending !== undefined) return pending;
    const opening = this.#loadState(stored);
    this.#pendingStates.set(stored.info.id, opening);
    return opening;
  }

  async #loadState(stored: StoredBranchState): Promise<WorktreeState> {
    const { info } = stored;
    const store = new GraphStore(this.#storage, this.#tenant, this.#project.key, info.id);
    store.doc = stored.effective;
    const snapshots = new SnapshotStore(this.#storage, this.#tenant, this.#project.key, info.id);
    await snapshots.save(store.doc);
    const state: WorktreeState = {
      id: info.id,
      path: info.path,
      branch: info.branch,
      head: info.head,
      physicalAgent: "idle",
      mappedCommit: info.mappedCommit,
      live: info.live,
      isDefault: info.isDefault,
      store,
      snapshots,
      activity: new Set(),
      agent: "idle",
      session: null,
      backend: null,
      catchUp: { state: "idle", at: Date.now() },
      writing: Promise.resolve(),
      now: "",
      nowTimer: null,
      nowDirty: false,
      nowSent: null,
    };
    this.#pendingStates.delete(info.id);
    this.#states.set(info.id, state);
    return state;
  }

  #applyStored(state: WorktreeState, stored: StoredBranchState): void {
    state.path = stored.info.path;
    state.branch = stored.info.branch;
    state.head = stored.info.head;
    state.mappedCommit = stored.info.mappedCommit;
    state.live = stored.info.live;
    state.isDefault = stored.info.isDefault;
    state.store.doc = stored.effective;
  }

  /** Adopt both earlier project-key generations for this physical worktree. */
  async #adoptLegacy(worktree: string): Promise<void> {
    const candidates = new Set(
      [
        this.#legacyKeys[worktree],
        this.#legacyKeys[`repository:${worktree}`],
        this.#legacyKeys[`worktree:${worktree}`],
      ].filter((key): key is string => key !== undefined && key !== this.#project.key),
    );
    for (const legacy of candidates) {
      try {
        const adopted = await this.#storage.adoptLegacyKey(this.#tenant, legacy, this.#project.key, worktree);
        if (adopted) console.error(`[bridge] adopted the canvas of ${worktree} from its previous project key`);
      } catch (err) {
        console.error(`[bridge] failed to adopt the previous canvas of ${worktree}: ${errText(err)}`);
      }
    }
  }

  /** Flush and drop in-memory branch views before a retarget or close. */
  async #closeStates(): Promise<void> {
    await this.#worktreeSync;
    await Promise.all([...this.#pendingStates.values()]);
    await this.#controlWriting;
    const states = [...this.#states.values()];
    await Promise.all(states.map((state) => state.writing));
    this.#states.clear();
    this.#pendingStates.clear();
    for (const state of states) this.#clearNow(state);
    await Promise.all(states.map((state) => state.store.persist()));
  }

  /**
   * Refresh physical checkout metadata and routes. Detached worktrees remain in
   * `SessionInfo.worktrees`, but intentionally receive no durable branch route.
   */
  #scheduleWorktrees(worktrees: WorktreeInfo[]): Promise<void> {
    this.#worktreeSync = this.#worktreeSync
      .then(() => this.#syncWorktrees(worktrees))
      .catch((err: unknown) => this.#error(`worktree refresh failed: ${errText(err)}`));
    return this.#worktreeSync;
  }

  async #syncWorktrees(worktrees: WorktreeInfo[]): Promise<void> {
    const previous = new Map(this.#worktrees.map((info) => [info.id, info]));
    this.#worktrees = worktrees;
    this.#worktreeBranches.clear();
    for (const info of worktrees) {
      const branch = branchIdOf(info.branch);
      if (branch !== null) this.#worktreeBranches.set(info.id, branch);
    }
    const defaultBranch = worktrees.map((info) => branchIdOf(info.branch)).find((id) => id !== null) ?? null;

    for (const info of worktrees) {
      const branch = branchIdOf(info.branch);
      if (branch === null) continue;
      // Every route was published before this first await; state loading below
      // may be slow, and physical frames wait on #worktreeSync before retrying.
      const current = this.#states.get(branch);
      const branchInfo: CanvasBranchInfo = {
        id: branch,
        branch: info.branch ?? branch,
        head: info.head,
        mappedCommit: current?.mappedCommit ?? null,
        live: current?.live ?? false,
        path: info.path,
        isDefault: branch === defaultBranch,
      };
      await this.#storage.upsertBranch(this.#tenant, this.#project.key, branchInfo);
      const stored = await this.#storage.readBranch(this.#tenant, this.#project.key, branch);
      if (stored !== null) await this.#openState(stored);
    }

    const listed = new Set(worktrees.map((info) => info.id));
    for (const [worktree, old] of previous) {

      if (listed.has(worktree)) continue;
      const branch = branchIdOf(old.branch);
      if (branch === null) continue;
      const state = this.#states.get(branch);
      if (state === undefined || state.path === null) continue;
      const info = { ...this.#branchInfo(state), path: null, live: state.live };
      await this.#storage.upsertBranch(this.#tenant, this.#project.key, info);
      state.path = null;
    }
    if (defaultBranch !== null) {
      for (const state of this.#states.values()) {
        const isDefault = state.id === defaultBranch;
        if (state.isDefault === isDefault) continue;
        state.isDefault = isDefault;
        await this.#storage.upsertBranch(this.#tenant, this.#project.key, this.#branchInfo(state));
      }
    }
  }

  #stateForWorktree(worktree: string): WorktreeState | null {
    const branch = this.#sessionBranches.get(worktree) ?? this.#worktreeBranches.get(worktree);
    return branch === undefined ? null : this.#states.get(branch) ?? null;
  }

  #withState(worktree: string, run: (state: WorktreeState) => void, missing?: () => void): void {
    // Always cross the queued refresh boundary, even when the old route still
    // has a loaded state: checkout A→B must bind the following frame to B.
    const pending = this.#worktreeSync;
    void pending.then(() => {
      const loaded = this.#stateForWorktree(worktree);
      if (loaded === null) missing?.();
      else run(loaded);
    });
  }
  /** what the user is told a variation is called: its branch, never its path */
  #labelOf(state: WorktreeState): string {
    return state.branch.replace(/^refs\/heads\//, "");
  }

  #runningSessions(): WorktreeSession[] {
    const running: WorktreeSession[] = [];
    for (const state of this.#states.values()) {
      if (state.session === null || state.backend === null) continue;
      running.push({ worktree: state.id, session: state.session, backend: state.backend, state: state.agent });
    }
    for (const [sessionId, live] of this.#controlSessions) {
      running.push({
        worktree: live.branch,
        session: { sessionId, sessionName: "shape live", model: null },
        backend: LIVE_BACKEND,
        state: live.state,
      });
    }
    return running;
  }

  #sessionInfo(): SessionInfo {
    return {
      cwd: this.#project.cwd,
      targetHasCode: this.#project.targetHasCode,
      worktrees: this.#worktrees,
      branches: [...this.#states.values()].map((state) => this.#branchInfo(state)),
      sessions: this.#runningSessions(),
      agentConnected: this.#agentConnected,
      directivePath: this.#project.directivePath,
      manager: this.#project.manager,
    };
  }

  #broadcastSession(): void {
    this.#broadcast({ type: "session", session: this.#sessionInfo() });
  }

  // -------------------------------------------------------------------------
  // browser -> agent
  // -------------------------------------------------------------------------

  /**
   * A browser frame about this project's canvases. There are two: where a
   * session's terminal is, and a comparison of two revisions — the project's
   * status and which project a socket watches are the server's business, not a
   * room's. Nothing here is answered to one socket alone: a canvas is shared,
   * so every result and every refusal is broadcast and every client stays in
   * sync with the graph the sessions are writing.
   */
  handleClient(msg: RoomClientMsg): void {
    // nothing can be asked of a machine nothing is attached to, and the user is
    // owed a reason rather than silence. `diff` needs no agent at all: it is
    // answered from the snapshots this room holds.
    if (!this.#agentConnected && msg.type !== "diff") {
      this.#error(AGENT_GONE);
      return;
    }
    switch (msg.type) {
      case "focus_terminal": {
        const state = this.#states.get(msg.worktree);
        if (state === undefined) {
          this.#error(`${msg.worktree} is not a variation of this project`);
          return;
        }
        if (this.#project.observationOnly) {
          this.#error(`there is no terminal to go to on ${this.#labelOf(state)}`);
          return;
        }
        // taking the user to a session's own terminal is the one thing the
        // browser may still ask Shape to do, and only a session that is
        // actually reporting in has one
        const route = [...this.#sessionBranches].find(([, branch]) => branch === state.id);
        if (state.session === null || route === undefined) {
          this.#error(`nothing is reporting in from ${this.#labelOf(state)}`);
          return;
        }
        if (state.backend?.capabilities.terminal === "none") {
          this.#error(`there is no terminal to go to on ${this.#labelOf(state)}`);
          return;
        }
        this.#link.send({ type: "focus_terminal", worktree: route[0] });
        return;
      }
      case "diff": {
        // read-only: answered from that worktree's snapshots, no harness involved
        const state = this.#states.get(msg.worktree);
        if (state === undefined) {
          this.#error(`${msg.worktree} is not a variation of this project`);
          return;
        }
        void this.#diff(state, msg.revA, msg.revB);
        return;
      }
    }
  }


  // -------------------------------------------------------------------------
  // agent -> browsers
  // -------------------------------------------------------------------------

  handleAgent(msg: AgentFrame): void {
    switch (msg.type) {
      case "session_started":
        this.#withState(
          msg.worktree,
          (state) => {
            this.#sessionBranches.set(msg.worktree, state.id);
            state.session = msg.session;
            state.backend = msg.backend;
            state.physicalAgent = "idle";
            state.agent = "idle";
            this.#broadcast({
              type: "session_started",
              worktree: state.id,
              session: msg.session,
              backend: msg.backend,
            });
            this.#broadcastSession();
          },
          () => console.error(`[bridge] detached worktree session has no persistent branch: ${msg.worktree}`),
        );
        return;
      case "session_stopped":
        this.#withState(
          msg.worktree,
          (state) => {
            this.#sessionBranches.delete(msg.worktree);
            state.session = null;
            state.backend = null;
            const explicit = [...this.#controlSessions.values()].find((session) => session.branch === state.id);
            state.physicalAgent = "idle";
            this.#setAgent(state, explicit?.state ?? "idle");
            if (explicit === undefined) this.#setActivity(state, []);
            this.#clearNow(state);
            this.#broadcast({ type: "session_stopped", worktree: state.id, reason: msg.reason });
            this.#broadcastSession();
          },
          () => this.#sessionBranches.delete(msg.worktree),
        );
        return;
      case "agent_event":
        this.#withState(msg.worktree, (state) => this.#agentEvent(state, msg.event));
        return;
      case "catch_up_state":
        // Skill-driven map commits own durable mapping. Old agents may finish
        // a job started by an older server; it has no authority in this room.
        return;
      case "canvas_call":
        this.#withState(
          msg.worktree,
          (state) => {
            state.writing = this.#serializeControl(() => this.#canvasCall(state, msg.id, msg.args, msg.job));
          },
          () => this.#link.send({
            type: "canvas_result",
            id: msg.id,
            text: "detached worktree has no persistent branch; check out a branch before writing the canvas",
            isError: true,
          }),
        );
        return;
      case "reality":
        this.#withState(msg.worktree, (state) => {
          state.writing = this.#serializeControl(() => this.#reality(state, { ...msg.reality, head: msg.head }))
            .catch((err: unknown) => this.#error(`reality persistence failed: ${errText(err)}`));
        });
        return;
      case "worktrees":
        // solicited: the hello that asked syncs the states itself, right after
        // this answer settles its request
        if (msg.id !== null) {
          this.#settle(msg.id, msg.worktrees);
          return;
        }
        // unsolicited: the agent re-listed on its own
        void this.#scheduleWorktrees(msg.worktrees).then(() => this.#broadcastSession());
        return;
      case "picked_directory":
        this.#settle(msg.id, msg.project);
        return;
      case "watched_project_started":
        this.#settle(msg.id, msg.key);
        return;
      case "skeleton_result":
        this.#settle(msg.id, msg.ops);
        return;
      case "agent_error":
        if (msg.message.startsWith("pick_directory failed:") && this.#failRequest("pick_directory", msg.message)) return;
        if (msg.message.startsWith("watch_project failed:") && this.#failRequest("watch_project", msg.message)) return;
        this.#error(msg.message);
        return;
      case "injected":
        // the agent sends the whole list, so this is a replace: it is the same
        // list `attach` carries, and a room that added to it would count a
        // pane twice when the link came back
        this.#project = { ...this.#project, injected: msg.paneIds };
        // the switcher shows the count, and the row is what an inactive
        // project's summary is read from later
        this.#onProjectsChanged();
        void this.saveProject();
        return;
      case "agent_exit":
        // whether the process dies with the harness is the agent's call
        console.error(`[bridge] ${msg.reason}`);
        this.#broadcast({ type: "error", message: msg.reason });
        return;
      case "detached":
        this.agentGone(`agent detached: ${msg.reason}`);
        return;
    }
  }

  /** One worktree's harness event, projected: transcript, activity, state. */
  #agentEvent(state: WorktreeState, event: AgentEvent): void {
    switch (event.kind) {
      case "state":
        state.physicalAgent = event.state;
        this.#setAgent(
          state,
          [...this.#controlSessions.values()].find((session) => session.branch === state.id)?.state ?? event.state,
        );
        return;
      case "text":
        // the message of record has landed, so the deltas that built it are
        // spent; the line keeps showing its tail until the turn ends
        state.now = "";
        this.#broadcast({ type: "transcript", worktree: state.id, role: "assistant", text: event.text });
        return;
      case "text_delta":
        // never a transcript line and never stored: this is the sentence being
        // written, folded into one throttled line and thrown away at turn end
        state.now += event.delta;
        this.#pushNow(state);
        return;
      case "tool_start": {
        this.#broadcast({
          type: "transcript",
          worktree: state.id,
          role: "tool",
          text: event.summary === "" ? event.name : `${event.name} ${event.summary}`,
        });
        const hits = this.#nodesForPaths(state, event.paths);
        if (hits.length > 0) this.#setActivity(state, [...state.activity, ...hits]);
        return;
      }
      case "tool_end":
        if (event.isError) {
          this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: `${event.name} failed` });
        }
        return;
      case "turn_end":
        this.#setActivity(state, []);
        // nothing is being written any more: the live line goes out empty
        this.#clearNow(state);
        return;
      case "session": {
        // hook-driven adapters cannot answer this from a backend call: only the
        // harness knows which session it is on, and it tells the agent
        const current = state.session;
        const sessionId = event.sessionId ?? current?.sessionId ?? null;
        const model = event.model ?? current?.model ?? null;
        if (
          current !== null &&
          sessionId === current.sessionId &&
          model?.provider === current.model?.provider &&
          model?.id === current.model?.id
        ) {
          return;
        }
        state.session = { sessionId, sessionName: current?.sessionName ?? null, model };
        // a session id arriving late is not worth a hello: the client would
        // reset selection, focus and transcript over a field it never chose
        this.#broadcastSession();
        return;
      }
    }
  }

  /**
   * A delta landed: show the tail of what is being written, at most once every
   * NOW_THROTTLE_MS. The first delta of a quiet stretch goes out at once (the
   * reader sees the sentence start), the rest ride the timer, and the last one
   * is never dropped — the timer fires once more with nothing pending and stops.
   */
  #pushNow(state: WorktreeState): void {
    if (state.nowTimer !== null) {
      state.nowDirty = true;
      return;
    }
    this.#sendNow(state);
    state.nowTimer = setTimeout(() => {
      state.nowTimer = null;
      if (!state.nowDirty) return;
      state.nowDirty = false;
      this.#pushNow(state);
    }, NOW_THROTTLE_MS);
    state.nowTimer.unref?.();
  }

  /** the tail of the message being written, when it is not what went out last */
  #sendNow(state: WorktreeState): void {
    const text = state.now.slice(-NOW_TAIL);
    if (text === state.nowSent) return;
    state.nowSent = text;
    this.#broadcast({ type: "now", worktree: state.id, text });
  }

  /**
   * Nothing is being written on this worktree any more (the turn ended, or the
   * session went away): the line is cleared and the throttle forgotten.
   * Clearing an already-clear line says nothing and is dropped.
   */
  #clearNow(state: WorktreeState): void {
    if (state.nowTimer !== null) {
      clearTimeout(state.nowTimer);
      state.nowTimer = null;
    }
    state.nowDirty = false;
    state.now = "";
    if (state.nowSent === null) return;
    state.nowSent = null;
    this.#broadcast({ type: "now", worktree: state.id, text: null });
  }

  /** Apply a canvas call to one worktree's graph and answer the caller with what landed. */
  async #canvasCall(state: WorktreeState, id: string, args: unknown, jobId?: string): Promise<void> {
    if (jobId !== undefined) {
      this.#link.send({
        type: "canvas_result",
        id,
        text: "automatic synchronization is disabled; run `shape map` explicitly",
        isError: true,
      });
      return;
    }
    try {
      const outcome = state.store.applyCanvasCall(args);
      this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: outcome.transcript });
      if (outcome.changed) {
        state.store.doc.drift = computeDrift(state.store.doc, state.store.doc.reality);
        await this.#graphChanged(state);
        this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
        this.#setActivity(state, outcome.touched);
      }
      this.#link.send({ type: "canvas_result", id, text: outcome.text, isError: outcome.isError });
    } catch (err) {
      this.#link.send({ type: "canvas_result", id, text: `canvas persistence failed: ${errText(err)}`, isError: true });
    }
  }

  /** Re-derived reality for one checked-out branch. */
  async #reality(state: WorktreeState, reality: RealityLayer): Promise<void> {
    if (sameReality(state.store.doc.reality, reality)) return;
    state.store.setReality(reality, computeDrift(state.store.doc, reality));
    await this.#graphChanged(state);
    this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
  }

  /** Compare two stored revisions of one worktree; an unknown rev is the client's mistake. */
  async #diff(state: WorktreeState, revA: number, revB: number): Promise<void> {
    const snapshots = state.snapshots;
    const [a, b] = await Promise.all([snapshots.load(revA), snapshots.load(revB)]);
    if (a === null || b === null) {
      this.#error(`unknown revision ${a === null ? revA : revB}`);
      return;
    }
    this.#broadcast({ type: "delta", worktree: state.id, delta: diffSnapshots(a, b) });
  }

  /**
   * Intent nodes of this worktree's canvas whose codeRefs prefix any of these
   * paths. Paths are resolved against the WORKTREE's directory, not the
   * project's: a harness in a variation reports paths relative to the tree it
   * is checked out in. A ref that names one part inside a file
   * (`src/room.ts#Room`) is matched on its path half: the agent touching that
   * file is working on the bubble that claims a part of it.
   */
  #nodesForPaths(state: WorktreeState, tokens: string[]): string[] {
    const cwd = state.path;
    if (cwd === null || tokens.length === 0) return [];
    const rels: string[] = [];
    for (const token of tokens) {
      const abs = isAbsolute(token) ? token : resolve(cwd, token);
      const rel = relative(cwd, abs);
      if (rel.length > 0 && !rel.startsWith("..")) rels.push(rel);
    }
    return this.#nodesForRelativePaths(state, rels);
  }

  /** Match source-reported repository-relative files without treating repository.path as authority. */
  #nodesForFiles(state: WorktreeState, files: string[]): string[] {
    const relativeFiles = files
      .filter((file) => !isAbsolute(file))
      .map((file) => file.replace(/^\.\//, "").replace(/\/+$/, ""))
      .filter((file) => file.length > 0 && file !== ".." && !file.startsWith("../"));
    return this.#nodesForRelativePaths(state, relativeFiles);
  }

  #nodesForRelativePaths(state: WorktreeState, rels: string[]): string[] {
    if (rels.length === 0) return [];
    const hits: string[] = [];
    for (const node of state.store.doc.nodes) {
      const refs = node.codeRefs;
      if (refs === undefined || refs.length === 0) continue;
      const prefixes = refs.map((r) => (symbolRefOf(r)?.path ?? r).replace(/^\.\//, "").replace(/\/+$/, ""));
      if (rels.some((rel) => prefixes.some((p) => p.length > 0 && (rel === p || rel.startsWith(`${p}/`))))) {
        hits.push(node.id);
      }
    }
    return hits;
  }

  // -------------------------------------------------------------------------
  // agent requests
  // -------------------------------------------------------------------------

  /**
   * Ask the agent for something a browser is waiting on. The id correlates the
   * answer; an agent that goes quiet rejects the caller with a line it can show
   * instead of leaving the request pending forever. An agentless room fails at
   * once: a hello for a project whose agent is gone must not sit out the
   * timeout before falling back to what the last attach told us.
   */
  #request<T>(
    make: (id: string) => ServerToAgentMsg,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.#agentConnected) return Promise.reject(new Error(AGENT_GONE));
    if (signal?.aborted) return Promise.reject(new Error("the browser stopped waiting for the directory picker"));
    const id = `req-${++this.#requestSeq}`;
    const frame = make(id);
    const { promise, resolve: settle, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#cancelRequest(id, new Error(`the agent did not answer ${frame.type} within ${timeoutMs} ms`), true);
    }, timeoutMs);
    const abort = (): void => {
      this.#cancelRequest(id, new Error("the browser stopped waiting for the directory picker"), true);
    };
    if (signal !== undefined) signal.addEventListener("abort", abort, { once: true });
    this.#pending.set(id, {
      type: frame.type,
      settle,
      fail: reject,
      timer,
      stopListening: signal === undefined ? null : () => signal.removeEventListener("abort", abort),
    });
    this.#link.send(frame);
    return promise as Promise<T>;
  }

  #settle(id: string, value: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.stopListening?.();
    pending.settle(value);
  }

  /** Fail the one request of `type`; picker requests are single-flight. */
  #failRequest(type: ServerToAgentMsg["type"], message: string): boolean {
    for (const [id, pending] of this.#pending) {
      if (pending.type !== type) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.stopListening?.();
      pending.fail(new Error(message));
      return true;
    }
    return false;
  }

  /** Cancel one correlated request and, while its link exists, its agent-side work. */
  #cancelRequest(id: string, error: Error, notifyAgent: boolean): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.stopListening?.();
    if (notifyAgent && this.#agentConnected) this.#link.send({ type: "cancel_request", id });
    pending.fail(error);
  }

  // -------------------------------------------------------------------------

  #setAgent(state: WorktreeState, next: AgentState): void {
    if (state.agent === next) return;
    state.agent = next;
    this.#broadcast({ type: "agent", worktree: state.id, state: next });
  }

  #setActivity(state: WorktreeState, nodeIds: string[]): void {
    const next = new Set(nodeIds);
    if (next.size === state.activity.size && [...next].every((id) => state.activity.has(id))) return;
    state.activity = next;
    this.#broadcast({ type: "activity", worktree: state.id, nodeIds: [...next] });
  }

  /**
   * Persist a native branch mutation without swallowing storage failures, then
   * refresh durable live metadata before projecting it to browsers.
   */
  async #graphChanged(state: WorktreeState): Promise<void> {
    const wasLive = state.live;
    await this.#storage.saveGraph(this.#tenant, this.#project.key, state.id, state.store.doc);
    const stored = await this.#storage.readBranch(this.#tenant, this.#project.key, state.id);
    if (stored !== null) this.#applyStored(state, stored);

    const saved = await state.snapshots.save(state.store.doc);
    if (saved !== null) {
      this.#broadcast({ type: "revisions", worktree: state.id, revisions: await state.snapshots.list() });
    }
    if (state.live !== wasLive) this.#broadcastSession();
  }


  #error(message: string): void {
    console.error(`[bridge] ${message}`);
    this.#broadcast({ type: "error", message });
  }
}
