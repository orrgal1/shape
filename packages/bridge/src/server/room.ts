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

import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { diffSnapshots } from "../../../shared/src/delta.ts";
import { symbolRefOf } from "../../../shared/src/index.ts";
import type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentState,
  AgentToServerMsg,
  BackendInfo,
  CanvasOp,
  CatchUpState,
  ClientMsg,
  GraphDoc,
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
import { composeSyncPrompt } from "./onboarding.ts";
import { SnapshotStore } from "./snapshots.ts";
import { mainWorktreeOf, type AuditBody, type Storage, type StoredProject } from "./storage.ts";
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

/**
 * One variation of the project: its canvas and everything that is true of that
 * canvas alone. Two worktrees of one repo share nothing here — not the graph,
 * not what the session in it is doing — which is why every frame in and out of
 * the room names the worktree it belongs to.
 */
interface WorktreeState {
  /** worktree id: the realpath of its directory, as the agent resolved it */
  readonly id: string;
  /** the worktree's directory; the paths its harness reports are relative to it */
  path: string;
  /** the branch checked out there; what the user is shown, never the path */
  branch: string | null;
  store: GraphStore;
  snapshots: SnapshotStore;
  /** bubbles the harness is working in right now */
  activity: Set<string>;
  agent: AgentState;
  /** the harness reporting in from here, or null when none is */
  session: AgentSession | null;
  /** the harness's backend; null exactly when `session` is */
  backend: BackendInfo | null;
  catchUp: CatchUpState;
  inspecting: boolean;
  inspectionTimer: NodeJS.Timeout | null;
  /** A material attach-time update that the following inspection must account for. */
  realityChanged: boolean;
  sync: { id: string; head: string | null; persisted: boolean } | null;
  /** Serializes job writes and completion so persistence always precedes acknowledgement. */
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
  /**
   * Per worktree, the project key an older Shape would have stored its canvas
   * under. Only an `attach` fills this: the agent is the one that knows the
   * directories, and `restore()` reopens a room with no agent — a room nobody
   * is attached to must never go claiming graphs it cannot have named.
   */
  #legacyKeys: Record<string, string> = {};
  /** one canvas per worktree, in the order the agent listed them (main first) */
  readonly #states = new Map<string, WorktreeState>();
  /**
   * Worktrees whose state is being read out of storage right now. An agent
   * frame for a worktree nobody has heard of yet (a harness started in a
   * worktree made after the last listing) waits on this instead of racing a
   * second load of the same graph.
   */
  readonly #pendingStates = new Map<string, Promise<WorktreeState>>();
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

  /**
   * Worktrees with a live session right now: those reporting in on this room's
   * link, plus those the last discovery scan saw a session in. A union, not a
   * sum — one worktree with a herdr agent that also greeted on the link is one
   * live session.
   */
  #liveSessions(): number {
    const live = new Set(this.#seenLive);
    for (const state of this.#states.values()) {
      if (state.session !== null) live.add(state.id);
    }
    return live.size;
  }

  /**
   * Open the project the agent attached to. A runtime observes one project for
   * its whole life, so a second `attach` on a room is the same project coming
   * back: the canvases are flushed and re-read, and every worktree is opened
   * again, with a session in it or not. `link` is the connection the attach
   * arrived on — a reconnecting agent brings a fresh one to a room that kept
   * its graphs while it was away. The `attached` answer goes out last, so
   * nothing the agent sends next finds a half-loaded room.
   */
  async retarget(attach: AttachMsg, link: ServerEnd): Promise<void> {
    if (this.#loaded) await this.#closeStates();

    const project = attach.project;
    this.#project = project;
    this.#legacyKeys = project.legacyKeys;
    // Before anything reads a graph: a canvas stored under the key this
    // machine used to derive is this project's canvas, and it moves onto the
    // current key first — ahead of the pre-database import below, which would
    // otherwise fill the new key with an older `.shape/graph.json` and make the
    // adoption look like an overwrite of a canvas someone had drawn.
    for (const id of Object.keys(this.#legacyKeys)) await this.#adoptLegacy(id);
    // a canvas drawn before Shape kept state in a database is this project's
    // too: taken over once, on the first attach that finds it
    if (this.#importLegacy) await importLegacyProject(this.#storage, this.#tenant, project);

    this.#worktrees = attach.worktrees;
    for (const info of attach.worktrees) {
      const state = await this.#openState(info.id, info);
      // reality is per worktree: two variations sit on two HEADs
      const reality = attach.realities[info.id];
      if (reality !== undefined && !sameReality(state.store.doc.reality, reality)) {
        state.store.setReality(reality, computeDrift(state.store.doc, reality));
        state.realityChanged = true;
        await this.#graphChanged(state);
      }
    }
    // a session in a worktree the listing missed still gets its canvas
    for (const running of attach.sessions) {
      const state = await this.#openState(running.worktree, null);
      state.session = running.session;
      state.backend = running.backend;
      state.agent = running.state;
    }
    // a target with no worktrees at all (a listing that failed) is still one
    // canvas: the project's own directory, which is what its records are keyed by
    if (this.#states.size === 0) await this.#openState(mainWorktreeOf(project.cwd), null);

    this.#loaded = true;
    this.#agentConnected = true;
    this.#lastSeen = new Date().toISOString();
    this.#link = link;
    this.#link.send({ type: "attached", projectId: project.key });
    for (const state of this.#states.values()) this.#inspect(state);
  }

  /**
   * Reopen a project from the registry with no agent behind it: every worktree
   * the row remembers gets its canvas and its opening snapshot exactly as an
   * attach loads them, and `agentConnected` starts false — the very state a
   * room lands in when its agent leaves, so the agent coming back later is the
   * ordinary re-bind and not a second path. No session is restored: the
   * harnesses the row names died with the server that wrote it.
   */
  async restore(row: StoredProject): Promise<void> {
    this.#project = row.project;
    this.#worktrees = row.worktrees;
    for (const info of row.worktrees) await this.#openState(info.id, info);
    if (this.#states.size === 0) await this.#openState(mainWorktreeOf(row.project.cwd), null);
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
    void this.#syncWorktrees(worktrees).then(() => this.#broadcastSession());
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
    await this.#syncWorktrees(worktrees);

    const states = [...this.#states.values()];
    const lists = await Promise.all(states.map((state) => state.snapshots.list()));
    const graphs: Record<string, GraphDoc> = {};
    const agents: Record<string, AgentState> = {};
    const revisions: Record<string, RevisionInfo[]> = {};
    const catchUps: Record<string, CatchUpState> = {};
    states.forEach((state, index) => {
      graphs[state.id] = state.store.doc;
      catchUps[state.id] = state.catchUp;
      // a worktree with no session has no state to report: the client shows its
      // canvas rather than drawing it as idle
      if (state.session !== null) agents[state.id] = state.agent;
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
      if (state.session !== null) {
        state.session = null;
        state.backend = null;
        this.#broadcast({ type: "session_stopped", worktree: state.id, reason: line });
      }
      this.#setAgent(state, "idle");
      this.#setActivity(state, []);
      // whatever was being written stopped mid-sentence with the link
      this.#clearNow(state);
      this.#cancelSync(state, line);
    }
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
    for (const state of this.#states.values()) this.#cancelSync(state, "project is inactive");
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
  // worktree states
  // -------------------------------------------------------------------------

  /**
   * This worktree's canvas, reading it out of storage the first time it is
   * asked for. Two callers racing the same new worktree share one load, so a
   * `session_started` and the `canvas_call` right behind it cannot open two
   * stores over one graph.
   */
  #openState(id: string, info: WorktreeInfo | null): Promise<WorktreeState> {
    const existing = this.#states.get(id);
    if (existing !== undefined) {
      if (info !== null) {
        existing.path = info.path;
        existing.branch = info.branch;
      }
      return Promise.resolve(existing);
    }
    const pending = this.#pendingStates.get(id);
    if (pending !== undefined) return pending;
    const opening = this.#loadState(id, info);
    this.#pendingStates.set(id, opening);
    return opening;
  }

  /**
   * Read one worktree's graph and file its opening snapshot, so the rev the
   * room opened at is diffable and not just the ones it goes on to make. A
   * storage that cannot be read costs this variation its history, never the
   * project its room: the state opens on an empty canvas.
   */
  async #loadState(id: string, info: WorktreeInfo | null): Promise<WorktreeState> {
    const key = this.#project.key;
    // a worktree the attach did not list (a session that started in one made
    // since) reaches its canvas through here, so the adoption is checked here too
    await this.#adoptLegacy(id);
    const store = new GraphStore(this.#storage, this.#tenant, key, id);
    const snapshots = new SnapshotStore(this.#storage, this.#tenant, key, id);
    try {
      await store.load();
    } catch (err) {
      console.error(`[bridge] failed to load the canvas of ${id}: ${errText(err)}`);
    }
    await snapshots.save(store.doc);
    const state: WorktreeState = {
      id,
      path: info?.path ?? id,
      branch: info?.branch ?? null,
      store,
      snapshots,
      activity: new Set(),
      agent: "idle",
      session: null,
      backend: null,
      catchUp: { state: "idle", at: Date.now() },
      inspecting: false,
      inspectionTimer: null,
      realityChanged: false,
      sync: null,
      writing: Promise.resolve(),
      now: "",
      nowTimer: null,
      nowDirty: false,
      nowSent: null,
    };
    this.#pendingStates.delete(id);
    this.#states.set(id, state);
    return state;
  }

  /**
   * Move this worktree's canvas onto the current project key when the agent
   * named an older key for it. Silent unless something moved: nearly every
   * worktree on nearly every attach has nothing stored under its legacy key,
   * and adoption is idempotent — the second call finds the old key empty. A
   * storage that refuses costs this variation its old canvas, never the room:
   * the state opens on whatever the current key holds.
   */
  async #adoptLegacy(id: string): Promise<void> {
    const legacy = this.#legacyKeys[id];
    if (legacy === undefined || legacy === this.#project.key) return;
    try {
      const adopted = await this.#storage.adoptLegacyKey(this.#tenant, legacy, this.#project.key, id);
      if (adopted) console.error(`[bridge] adopted the canvas of ${id} from its previous project key`);
    } catch (err) {
      console.error(`[bridge] failed to adopt the previous canvas of ${id}: ${errText(err)}`);
    }
  }

  /** Flush and drop every canvas: the room is being re-read, or it is closing. */
  async #closeStates(): Promise<void> {
    // a load still in flight would otherwise re-add its state after the clear
    await Promise.all([...this.#pendingStates.values()]);
    const states = [...this.#states.values()];
    for (const state of states) this.#cancelSync(state, "project canvas is closing");
    await Promise.all(states.map((state) => state.writing));
    this.#states.clear();
    this.#pendingStates.clear();
    // a throttle timer left behind would fire on a canvas this room no longer has
    for (const state of states) this.#clearNow(state);
    await Promise.all(states.map((state) => state.store.persist()));
  }

  /**
   * Take the agent's worktree listing as the truth: a variation that appeared
   * gets its canvas, one that was removed leaves the view. A removed worktree
   * with a session still reporting in from it stays — the agent is the
   * authority on what is running, and its graph is still being written.
   */
  async #syncWorktrees(worktrees: WorktreeInfo[]): Promise<void> {
    const previous = new Map(this.#worktrees.map((info) => [info.id, info.head]));
    this.#worktrees = worktrees;
    for (const info of worktrees) {
      const state = await this.#openState(info.id, info);
      if (!previous.has(info.id) || previous.get(info.id) !== info.head) {
        if (state.sync !== null && state.sync.head !== info.head) this.#cancelSync(state, "worktree HEAD changed");
        this.#inspect(state);
      }
    }
    const listed = new Set(worktrees.map((info) => info.id));
    for (const [id, state] of [...this.#states]) {
      if (listed.has(id) || state.session !== null) continue;
      this.#cancelSync(state, "worktree was removed");
      this.#states.delete(id);
      this.#clearNow(state);
      await state.store.persist();
    }
  }

  /**
   * Run something on a worktree's canvas, opening it first when the agent is
   * talking about one the room has not heard of yet. Frames for the same new
   * worktree run in arrival order: they all wait on the one load.
   */
  #withState(worktree: string, run: (state: WorktreeState) => void): void {
    const state = this.#states.get(worktree);
    if (state !== undefined) {
      run(state);
      return;
    }
    void this.#openState(worktree, null).then(run);
  }

  /** what the user is told a variation is called: its branch, never its path */
  #labelOf(state: WorktreeState): string {
    return state.branch ?? basename(state.path);
  }

  /** the harnesses reporting in right now, one per worktree that has one */
  #runningSessions(): WorktreeSession[] {
    const running: WorktreeSession[] = [];
    for (const state of this.#states.values()) {
      if (state.session === null || state.backend === null) continue;
      running.push({ worktree: state.id, session: state.session, backend: state.backend, state: state.agent });
    }
    return running;
  }

  #sessionInfo(): SessionInfo {
    return {
      cwd: this.#project.cwd,
      targetHasCode: this.#project.targetHasCode,
      worktrees: this.#worktrees,
      sessions: this.#runningSessions(),
      agentConnected: this.#agentConnected,
      directivePath: this.#project.directivePath,
      manager: this.#project.manager,
    };
  }

  /**
   * Session facts changed without any canvas changing (a harness came or went,
   * the agent left, worktrees appeared). Clients take this without resetting
   * selection, focus or transcript.
   */
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
        if (state.session === null) {
          this.#error(`nothing is reporting in from ${this.#labelOf(state)}`);
          return;
        }
        // a harness whose terminal Shape cannot reach is not asked for one: the
        // browser hides the button on the same capability, and a client that
        // ignores that is owed the reason rather than silence
        if (state.backend?.capabilities.terminal === "none") {
          this.#error(`there is no terminal to go to on ${this.#labelOf(state)}`);
          return;
        }
        this.#link.send({ type: "focus_terminal", worktree: state.id });
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

  /** Mechanical seed only: it never proves that a model has surveyed the project. */
  async #seedSkeleton(state: WorktreeState): Promise<void> {
    let ops: CanvasOp[];
    try {
      ops = await this.#request<CanvasOp[]>((id) => ({ type: "synthesize_skeleton", worktree: state.id, id }));
    } catch (err) {
      throw new Error(`skeleton synthesis failed: ${errText(err)}`);
    }
    if (!this.#agentConnected || this.#states.get(state.id) !== state || state.store.doc.nodes.length > 0) return;

    // a repo with no workspace packages in it has no skeleton to draw, and the
    // reader is told that rather than left wondering what the empty stage means
    if (ops.length === 0) {
      this.#broadcast({
        type: "transcript",
        worktree: state.id,
        role: "tool",
        text: "canvas: no workspace packages detected — nothing to draw yet",
      });
      return;
    }

    const outcome = state.store.applyCanvasCall(
      {
        ops,
        note: `mechanical skeleton: ${state.store.doc.reality.nodes.length} workspace package(s)`,
      },
      // the skeleton is one flat pile of parts and nothing else yet: there is
      // no product side for it to be connected to, and this receipt is the
      // server's own, never read by anyone
      { linkWarnings: false },
    );
    this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      await this.#graphChanged(state);
      this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
    }
    if (outcome.isError) throw new Error(`skeleton synthesis rejected: ${outcome.text}`);
    // the room's own record of the one write it makes without being asked
    this.#audit(state, { kind: "onboard", ops: ops.length });
  }

  #setCatchUp(state: WorktreeState, catchUp: CatchUpState): void {
    state.catchUp = catchUp;
    this.#broadcast({ type: "catch_up", worktree: state.id, catchUp });
    this.#onProjectsChanged();
  }

  #cancelSync(state: WorktreeState, reason: string): void {
    clearTimeout(state.inspectionTimer ?? undefined);
    state.inspectionTimer = null;
    state.inspecting = false;
    const job = state.sync;
    state.sync = null;
    if (job !== null && this.#agentConnected) this.#link.send({ type: "cancel_request", id: job.id });
    if (state.catchUp.state === "queued" || state.catchUp.state === "running") {
      this.#setCatchUp(state, { state: "failed", reason, at: Date.now() });
    }
  }

  /** Attach/reactivation inspects every registered variation, with or without a live session. */
  #inspect(state: WorktreeState): void {
    if (!this.#agentConnected || state.inspecting || state.sync !== null || this.#closed !== null) return;
    state.inspecting = true;
    this.#setCatchUp(state, { state: "queued", at: Date.now() });
    state.inspectionTimer = setTimeout(() => {
      if (!state.inspecting) return;
      state.inspecting = false;
      state.inspectionTimer = null;
      this.#setCatchUp(state, { state: "failed", reason: "reality extraction did not finish", at: Date.now() });
    }, 60_000);
    state.inspectionTimer.unref();
    this.#link.send({ type: "extract_reality", worktree: state.id });
  }

  async #planSync(state: WorktreeState, realityChanged: boolean): Promise<void> {
    const head = state.store.doc.reality.head;
    if (!realityChanged && Object.keys(state.store.doc.drift).length === 0 &&
        state.store.doc.nodes.length > 0 && state.store.doc.surveyed !== undefined &&
        state.store.doc.surveyed !== null && state.store.doc.surveyed.head === head) {
      this.#setCatchUp(state, { state: "idle", at: Date.now() });
      return;
    }
    const job = { id: randomUUID(), head, persisted: false };
    state.sync = job;
    this.#setCatchUp(state, { state: "queued", at: Date.now() });
    const survey = state.store.doc.nodes.length === 0;
    try {
      if (survey) await this.#seedSkeleton(state);
      if (!this.#agentConnected || this.#closed !== null || state.sync !== job || this.#states.get(state.id) !== state) return;
      if (state.store.doc.reality.head !== head) throw new Error("worktree HEAD changed while preparing synchronization");
      const at = Date.parse(state.store.doc.surveyed?.at ?? "");
      this.#link.send({
        type: "catch_up", worktree: state.id, id: job.id,
        prompt: composeSyncPrompt(state.store.doc, survey),
        since: Number.isFinite(at) ? at : 0,
      });
    } catch (err) {
      if (state.sync !== job) return;
      state.sync = null;
      this.#setCatchUp(state, { state: "failed", reason: errText(err), at: Date.now() });
    }
  }

  async #syncState(state: WorktreeState, id: string, catchUp: CatchUpState): Promise<void> {
    const job = state.sync;
    if (job === null || job.id !== id || !this.#agentConnected || this.#closed !== null) return;
    if (catchUp.state !== "idle") {
      if (catchUp.state === "failed") state.sync = null;
      this.#setCatchUp(state, catchUp);
      return;
    }
    try {
      if (!job.persisted) throw new Error("synchronization finished without persisting a canvas mutation");
      if (state.store.doc.reality.head !== job.head) throw new Error("synchronization completed against a stale HEAD");
      if (Object.keys(state.store.doc.drift).length > 0) throw new Error("synchronization completed with remaining drift");
      // GraphStore.persist intentionally swallows errors. A completion receipt must not.
      const doc = { ...state.store.doc, rev: state.store.doc.rev + 1, surveyed: { head: job.head, at: new Date().toISOString() } };
      await this.#storage.saveGraph(this.#tenant, this.#project.key, state.id, doc);
      if (state.sync !== job || !this.#agentConnected || this.#closed !== null) {
        await this.#storage.saveGraph(this.#tenant, this.#project.key, state.id, state.store.doc);
        return;
      }
      state.store.doc = doc;
      void state.snapshots.save(doc).catch((err: unknown) => this.#error(`snapshot failed: ${errText(err)}`));
      state.sync = null;
      this.#broadcast({ type: "graph", worktree: state.id, graph: doc });
      this.#setCatchUp(state, catchUp);
    } catch (err) {
      if (state.sync !== job) return;
      state.sync = null;
      this.#setCatchUp(state, { state: "failed", reason: errText(err), at: Date.now() });
    }
  }

  // -------------------------------------------------------------------------
  // agent -> browsers
  // -------------------------------------------------------------------------

  handleAgent(msg: AgentFrame): void {
    switch (msg.type) {
      case "session_started":
        this.#withState(msg.worktree, (state) => {
          state.session = msg.session;
          state.backend = msg.backend;
          state.agent = "idle";
          this.#broadcast({
            type: "session_started",
            worktree: state.id,
            session: msg.session,
            backend: msg.backend,
          });
          this.#broadcastSession();
          if (state.catchUp.state === "idle" && state.store.doc.reality.extractedAt === null) this.#inspect(state);
        });
        return;
      case "session_stopped": {
        const state = this.#states.get(msg.worktree);
        // a session of a project this room has moved off is not its business
        if (state === undefined) return;
        state.session = null;
        state.backend = null;
        this.#setAgent(state, "idle");
        this.#setActivity(state, []);
        // nothing is being written any more: the live line goes out empty
        this.#clearNow(state);
        this.#broadcast({ type: "session_stopped", worktree: state.id, reason: msg.reason });
        this.#broadcastSession();
        return;
      }
      case "agent_event":
        this.#withState(msg.worktree, (state) => this.#agentEvent(state, msg.event));
        return;
      case "catch_up_state": {
        const state = this.#states.get(msg.worktree);
        if (state === undefined) return;
        state.writing = state.writing.then(() => this.#syncState(state, msg.id, msg.catchUp));
        return;
      }
      case "canvas_call":
        this.#withState(msg.worktree, (state) => {
          state.writing = state.writing.then(() => this.#canvasCall(state, msg.id, msg.args, msg.job));
        });
        return;
      case "reality":
        this.#withState(msg.worktree, (state) => {
          state.writing = state.writing.then(() => this.#reality(state, { ...msg.reality, head: msg.head })).catch((err: unknown) => {
            this.#cancelSync(state, errText(err));
            this.#setCatchUp(state, { state: "failed", reason: errText(err), at: Date.now() });
          });
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
        void this.#syncWorktrees(msg.worktrees).then(() => this.#broadcastSession());
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
        this.#setAgent(state, event.state);
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
    const job = state.sync;
    if (jobId !== undefined && (!this.#agentConnected || this.#closed !== null || job === null || job.id !== jobId || state.catchUp.state !== "running" || state.store.doc.reality.head !== job.head)) {
      this.#link.send({ type: "canvas_result", id, text: "inactive, foreign or stale synchronization job", isError: true });
      return;
    }
    try {
    const outcome = state.store.applyCanvasCall(args);
    this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      state.store.doc.drift = computeDrift(state.store.doc, state.store.doc.reality);
      if (jobId === undefined) await this.#graphChanged(state);
      else {
        await this.#storage.saveGraph(this.#tenant, this.#project.key, state.id, state.store.doc);
        await state.snapshots.save(state.store.doc);
        if (job !== null && state.sync === job && !outcome.isError) job.persisted = true;
      }
      this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
      if (jobId === undefined) {
        // The canvas is the interface, so the bubbles an ordinary call just
        // wrote are where the user session is. Synchronization is machine work
        // and must never appear as ordinary session activity.
        this.#setActivity(state, outcome.touched);
      }
    }
    this.#link.send({ type: "canvas_result", id, text: outcome.text, isError: outcome.isError });
    } catch (err) {
      if (jobId !== undefined && state.sync?.id === jobId) {
        this.#cancelSync(state, errText(err));
        this.#setCatchUp(state, { state: "failed", reason: errText(err), at: Date.now() });
      }
      this.#link.send({ type: "canvas_result", id, text: `canvas persistence failed: ${errText(err)}`, isError: true });
    }
  }

  /** Re-derived reality for one worktree: the agent decides when, on its own HEAD. */
  async #reality(state: WorktreeState, reality: RealityLayer): Promise<void> {
    const changed = !sameReality(state.store.doc.reality, reality);
    if (changed) {
      state.store.setReality(reality, computeDrift(state.store.doc, reality));
      await this.#graphChanged(state);
      this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
    }
    if (state.sync !== null && state.sync.head !== reality.head) this.#cancelSync(state, "worktree HEAD changed during synchronization");
    if (state.inspecting) {
      state.inspecting = false;
      clearTimeout(state.inspectionTimer ?? undefined);
      state.inspectionTimer = null;
      const realityChanged = state.realityChanged || changed;
      state.realityChanged = false;
      await this.#planSync(state, realityChanged);
    }
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
    if (tokens.length === 0) return [];
    const cwd = state.path;
    const rels: string[] = [];
    for (const token of tokens) {
      const abs = isAbsolute(token) ? token : resolve(cwd, token);
      const rel = relative(cwd, abs);
      if (rel.length > 0 && !rel.startsWith("..")) rels.push(rel);
    }
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
   * One worktree's graph advanced: flush it and file a revision snapshot. A
   * snapshot that actually landed grows the set of revisions clients can diff
   * over, so they get that variation's fresh list. The stores are captured
   * because a retarget may drop the state before the write settles.
   */
  #graphChanged(state: WorktreeState): Promise<void> {
    const persisted = state.store.persist();
    const snapshots = state.snapshots;
    void snapshots.save(state.store.doc).then(async (info) => {
      if (info === null) return;
      this.#broadcast({ type: "revisions", worktree: state.id, revisions: await snapshots.list() });
    });
    return persisted;
  }

  /**
   * One line per canvas the room seeded by itself, stamped with where and which
   * variation. An on-prem operator answers "why does this project have bubbles
   * nobody drew" from the room's own storage; the write never blocks the
   * seeding and never fails it (see `Storage.appendAudit`).
   */
  #audit(state: WorktreeState, body: AuditBody): void {
    void this.#storage.appendAudit(this.#tenant, this.#project.key, state.id, {
      at: new Date().toISOString(),
      tenant: this.#tenant,
      projectId: this.#project.key,
      worktree: state.id,
      ...body,
    });
  }

  #error(message: string): void {
    console.error(`[bridge] ${message}`);
    this.#broadcast({ type: "error", message });
  }
}
