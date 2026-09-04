/**
 * One project's canvases, server side: a graph per worktree with its own
 * revisions, the harnesses the agent runs in them, and the translation between
 * browser frames (`ClientMsg`) and agent link frames (`AgentToServerMsg` /
 * `ServerToAgentMsg`).
 *
 * A project is one repo, and every worktree of it is a variation with its own
 * canvas — the view merges them, the server keeps them apart. So the room is a
 * `Map<worktreeId, WorktreeState>`: graph, revisions, activity, harness state
 * and the validation modes are all per worktree, and every frame about one of
 * them names it. A worktree the agent listed but never opened a harness in
 * still has a state: its canvas is readable, only steering it is refused.
 *
 * The room never touches the target repo. Everything that needs a filesystem —
 * reality extraction, worktrees, session discovery, the project file index, the
 * mechanical skeleton — is asked of the agent and awaited as a link answer, so
 * a project on another machine is served exactly like a local one.
 */

import { basename, isAbsolute, relative, resolve } from "node:path";
import { diffSnapshots } from "../../../shared/src/delta.ts";
import { buildFileIndex, type FileIndex } from "../../../shared/src/fileindex.ts";
import { symbolRefOf } from "../../../shared/src/index.ts";
import type {
  AgentEvent,
  AgentProject,
  AgentSession,
  AgentState,
  AgentToServerMsg,
  BackendInfo,
  CanvasOp,
  ClientMsg,
  DiscoveredSession,
  GraphDoc,
  Next,
  ProjectSummary,
  ProjectTools,
  RealityLayer,
  RevisionInfo,
  ServerMsg,
  ServerToAgentMsg,
  SessionInfo,
  WorktreeInfo,
  WorktreeSession,
} from "../../../shared/src/index.ts";
import type { ServerEnd } from "../transport.ts";
import { computeDrift } from "./drift.ts";
import { importLegacyProject } from "./legacy.ts";
import { composeCatchUpPrompt, composeSurveyPrompt, onboardingOpGate } from "./onboarding.ts";
import { PREAMBLE } from "./preamble.ts";
import { draftRootCall, DRAFT_ROOT_ID, productTurnGate } from "./productturn.ts";
import { SnapshotStore } from "./snapshots.ts";
import { AUTO_CONTINUE_PROMPT, composeFirstUtterance, composeUtterance, synthesizeNext } from "./steering.ts";
import { mainWorktreeOf, type AuditBody, type Storage, type StoredProject } from "./storage.ts";
import { GraphStore, type OpGate } from "./store.ts";

/** the frame that opens (or retargets) a room */
export type AttachMsg = Extract<AgentToServerMsg, { type: "attach" }>;

/** everything else an agent sends; `attach` is the server's business, not a room's */
export type AgentFrame = Exclude<AgentToServerMsg, { type: "attach" }>;

/**
 * One variation of the project: its canvas and everything that is true of that
 * canvas alone. Two worktrees of one repo share nothing here — not the graph,
 * not what the harness is doing, not the validation mode a turn armed — which
 * is why every frame in and out of the room names the worktree it belongs to.
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
  /** the harness running here, or null when none is: steering is refused then */
  session: AgentSession | null;
  /** the harness's backend; null exactly when `session` is */
  backend: BackendInfo | null;
  /** onboarding validation mode: armed from an onboarding turn until this worktree's next idle */
  onboarding: boolean;
  /** what this worktree's survey or catch-up turn may point at; armed and disarmed with `onboarding` */
  fileIndex: FileIndex | null;
  /**
   * The session this room already mapped the project for, so a re-attach of a
   * live harness — or the `session_started` right behind the attach that
   * announced it — does not map it a second time. Null until one has been.
   */
  autoMappedSession: string | null;
  /**
   * The automatic map is owed to this worktree but its harness was mid-turn
   * when the room decided to run it: an adopted session, or one that started
   * with work already in flight. Consumed by the end of that turn.
   */
  autoMapPending: boolean;
  /**
   * Product-first validation mode: armed by the first utterance on this
   * worktree's empty canvas, disarmed by the end of that turn.
   */
  productTurn: boolean;
  /**
   * Where this worktree's last turn left things, as the browser shows it. Null
   * from the moment anything is said to it: a card offering choices about work
   * that has already moved on is worse than no card.
   */
  next: Next | null;
  /** an accepted canvas call carried a `next` during the turn running right now */
  nextThisTurn: boolean;
  /** the assistant text of the turn running right now, last message wins */
  lastText: string;
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
  /** this worktree decides for itself: the bridge answers its own turn ends */
  autonomous: boolean;
  /** auto-continues since the last human utterance, capped at AUTO_CAP */
  autoRuns: number;
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

/**
 * How long an `open_worktree` may be in flight before another is allowed. The
 * agent answers with `session_started` or an `open_worktree` error long before
 * this; the timer only makes sure a lost answer cannot wedge the menu forever.
 */
const OPEN_TIMEOUT_MS = 60_000;

/**
 * How long a folder chooser may stand open before the room stops waiting on
 * it. Generous on purpose: a person browsing for a project takes minutes, and
 * the dialog is modal on their machine. It only exists so an answer that never
 * comes — a tab closed mid-dialog, an agent that dropped — cannot leave the
 * menu refusing every later chooser.
 */
const PICK_TIMEOUT_MS = 600_000;

/**
 * An `agent_error` starting with one of these settles a switch attempt — the
 * agent refused or failed it, so the guard that serializes switches opens
 * again. Any other adapter error may well arrive mid-switch and says nothing
 * about it. A create that never reached its switch settles the same guard.
 * (`scripts/ctl.mjs` reads the same prefixes as "switch over".)
 */
const SWITCH_SETTLED_PREFIXES = [
  "switch_project",
  "create_project",
  "adopt rejected",
  "no Shape adapter",
  // a switch (or an adopt) that got as far as starting a harness and could not:
  // the attempt is over either way, and the guard must not stay closed on it
  "open_worktree failed",
];

/** Refusal for everything that needs a harness while no agent is attached. */
const AGENT_GONE = "no agent is attached to this project — start `shape agent` in it";

/**
 * Whether a session starting in a project whose canvas is behind its code maps
 * it by itself: on unless a process says otherwise. The knob exists for the
 * smokes, which seed a workspace WITH code and then drive onboarding by hand —
 * an automatic survey landing in the middle of that would be answering their
 * own frames for them. It is read once, on the server process.
 */
const AUTO_MAP = process.env.SHAPE_AUTO_MAP !== "0";

/**
 * How many turns in a row autonomous mode may answer for the user before it
 * stops and asks for a human. A stretch that long is either finished work
 * nobody looked at or a loop, and both are better paused than left running.
 */
const AUTO_CAP = 25;

/** what the panel says when the cap stops a stretch; not an error, just the end of one */
const AUTO_PAUSED = "autonomous mode paused after 25 turns without you — say something to continue";

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
 * row written before Shape detected tools has none: `pty` and nothing detected
 * is exactly what such a machine could do, and the browser shows no card it
 * cannot honour.
 */
const NO_TOOLS: ProjectTools = { launcher: "pty", launchers: [], harnesses: [] };

interface PendingRequest {
  settle: (value: unknown) => void;
  fail: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** a delivery waiting for its receipt, and the harness it was composed for */
interface Undelivered {
  worktree: string;
  body: string;
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
  /**
   * `deliver` frames that never got a `delivered` receipt. An agent that
   * dropped mid-delivery hears them again when it re-attaches; its ids are
   * idempotent, so a delivery the harness did see is not repeated to it.
   */
  readonly #undelivered = new Map<string, Undelivered>();
  /** last values the agent reported; a hello the agent does not answer uses these */
  #worktrees: WorktreeInfo[] = [];
  #discovered: DiscoveredSession[] = [];
  #recents: string[] = [];
  #switching = false;
  /** the safety timer of the `open_worktree` in flight, or null when none is */
  #opening: NodeJS.Timeout | null = null;
  /**
   * The folder chooser standing open on the agent's machine: the socket that
   * asked for it, and the timer that gives up on it. One at a time, because
   * one machine can only have one modal dialog in front of the user — and the
   * answer is that socket's alone, so it is kept rather than broadcast.
   */
  #picking: { reply: (msg: ServerMsg) => void; timer: NodeJS.Timeout } | null = null;
  /**
   * A finished `create_project`, waiting for the hello that announces the
   * project it made. Browsers reset their transcript on a hello, so the line
   * has to arrive after one — see the flush at the end of hello().
   */
  #pendingCreated: { text: string; warnings: string[] } | null = null;
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

  /** the tenant whose project list, default room and storage tree this room is in */
  get tenant(): string {
    return this.#tenant;
  }

  /** the room's agent arrived on `end`; a link it has moved off has no say here */
  attachedTo(end: ServerEnd): boolean {
    return this.#agentConnected && this.#link === end;
  }

  /** what a picker shows for this project */
  summary(): ProjectSummary {
    return {
      projectId: this.#project.key,
      label: this.#project.label,
      cwd: this.#project.cwd,
      // a project whose harness was never resolved says so: the picker's row
      // is honest about a project nobody has started a session in yet
      harness: this.#project.backend?.id ?? "none",
      agentConnected: this.#agentConnected,
      lastSeen: this.#lastSeen,
    };
  }

  /**
   * Open the project the agent attached to — and, on a second `attach`, move
   * the room onto the new one: the old canvases are flushed and dropped first,
   * then every worktree of the new project is opened, running or not. `link` is
   * the connection the attach arrived on: a reconnecting agent brings a fresh
   * one to a room that kept its graphs while it was away. The `attached` answer
   * (whose preamble the agent prepends to a session's first prompt) goes out
   * last, so nothing the agent sends next finds a half-loaded room — followed
   * only by the deliveries that never got a receipt.
   */
  async retarget(attach: AttachMsg, link: ServerEnd): Promise<void> {
    if (this.#loaded) await this.#closeStates();
    // the attach IS the answer to whichever switch was in flight
    this.#switching = false;
    this.#settleOpen();

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
      if (reality !== undefined && JSON.stringify(state.store.doc.reality) !== JSON.stringify(reality)) {
        state.store.setReality(reality, computeDrift(state.store.doc, reality));
        await this.#graphChanged(state);
      }
    }
    // a harness in a worktree the listing missed still gets its canvas
    for (const running of attach.sessions) {
      const state = await this.#openState(running.worktree, null);
      state.session = running.session;
      state.backend = running.backend;
      state.agent = running.state;
    }
    // a target with no worktrees at all (a listing that failed) is still one
    // canvas: the project's own directory, which is what its records are keyed by
    if (this.#states.size === 0) await this.#openState(mainWorktreeOf(project.cwd), null);

    this.#discovered = attach.discovered;
    this.#recents = attach.recentProjects;
    this.#loaded = true;
    this.#agentConnected = true;
    this.#lastSeen = new Date().toISOString();
    this.#link = link;
    this.#link.send({ type: "attached", projectId: project.key, preamble: PREAMBLE });
    // the agent dedupes by id, so a delivery the harness already saw is not
    // repeated; one for a worktree this project does not have (the agent
    // retargeted elsewhere) can never be delivered and is dropped
    for (const [id, pending] of this.#undelivered) {
      if (!this.#states.has(pending.worktree)) {
        this.#undelivered.delete(id);
        continue;
      }
      this.#link.send({ type: "deliver", worktree: pending.worktree, id, body: pending.body });
    }
    // and last of all, the sessions this attach announced: as far as this room
    // is concerned they have just started, so each gets the same automatic map
    // a `session_started` gets. After the link is bound above, because mapping
    // delivers a prompt down it.
    for (const running of attach.sessions) {
      const state = this.#states.get(running.worktree);
      if (state !== undefined) void this.#autoMap(state);
    }
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
  }

  /**
   * File this project in the registry: what a restarted server needs to reopen
   * the rooms without their agent. Called after every attach, and again when
   * the agent leaves so `lastSeen` is the departure. A registry that cannot be
   * written costs the next restart a project, never this session a turn.
   */
  saveProject(): Promise<void> {
    return this.#storage
      .saveProject({
        project: this.#project,
        tenant: this.#tenant,
        worktrees: this.#worktrees,
        sessions: this.#runningSessions(),
        lastSeen: this.#lastSeen,
      })
      .catch((err: unknown) => {
        console.error(`[bridge] failed to save project registry: ${errText(err)}`);
      });
  }

  /**
   * Worktrees and running sessions are re-detected on every hello (connect and
   * post-switch): discovery is a ~150 ms `ps` + session-store walk on the agent
   * side, worth it to have the adopt list correct the instant the pop-up opens.
   * An agent too busy to answer in time does not hold the browser up — the
   * hello goes out with the values from the last attach.
   */
  async hello(): Promise<ServerMsg> {
    const [worktrees, discovered] = await Promise.all([
      this.#request<WorktreeInfo[]>((id) => ({ type: "list_worktrees", id })).catch(() => this.#worktrees),
      this.#request<DiscoveredSession[]>((id) => ({ type: "discover", id })).catch(() => this.#discovered),
    ]);
    await this.#syncWorktrees(worktrees);
    this.#discovered = discovered;

    const states = [...this.#states.values()];
    const lists = await Promise.all(states.map((state) => state.snapshots.list()));
    const graphs: Record<string, GraphDoc> = {};
    const agents: Record<string, AgentState> = {};
    const revisions: Record<string, RevisionInfo[]> = {};
    const nexts: Record<string, Next | null> = {};
    const autonomous: Record<string, boolean> = {};
    states.forEach((state, index) => {
      graphs[state.id] = state.store.doc;
      // a worktree with no harness has no state to report: the client shows its
      // canvas and offers to open it, rather than drawing it as idle
      if (state.session !== null) agents[state.id] = state.agent;
      revisions[state.id] = lists[index] ?? [];
      // a tab that opens mid-stretch owes the reader the same card and the same
      // toggle as the tab that was there when they landed
      nexts[state.id] = state.next;
      autonomous[state.id] = state.autonomous;
    });

    // The line belongs to the project this hello announces, and a browser
    // clears its transcript on a hello — so it goes out on the next turn of
    // the loop, by which time the caller has broadcast what it awaited here.
    if (this.#pendingCreated !== null) setTimeout(() => this.#flushCreated(), 0);
    return {
      type: "hello",
      graphs,
      session: this.#sessionInfo(),
      agents,
      recentProjects: this.#recents,
      projects: this.#projects(),
      projectId: this.#project.key,
      revisions,
      sessions: discovered,
      nexts,
      autonomous,
      // project-wide: one agent process, one PATH, one chosen launcher
      tools: toolsOf(this.#project),
    };
  }

  /**
   * The link dropped, or the agent detached: no harness of this project is
   * running any more, every canvas goes read-only, and everything a browser was
   * waiting on fails with a line it can show instead of hanging until the
   * request timeout.
   */
  agentGone(line: string): void {
    console.error(`[bridge] ${line}`);
    // a `detached` frame already told us; the close that follows is not news
    if (!this.#agentConnected) return;
    this.#agentConnected = false;
    this.#lastSeen = new Date().toISOString();
    this.#switching = false;
    this.#settleOpen();
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
      state.onboarding = false;
      state.fileIndex = null;
      // the turn end that would have run the owed map is never coming
      state.autoMapPending = false;
      state.productTurn = false;
      // nothing left to steer: the card's choices could not be sent, and there
      // is no turn end left for autonomous mode to answer
      this.#setNext(state, null);
      this.#setAutonomous(state, false);
    }
    this.#broadcastSession();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.fail(new Error(AGENT_GONE));
    }
    this.#pending.clear();
    this.#onProjectsChanged();
    void this.saveProject();
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
    // a worktree the attach did not list (a harness started in one made since)
    // reaches its canvas through here, so the adoption is checked here too
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
      onboarding: false,
      fileIndex: null,
      autoMappedSession: null,
      autoMapPending: false,
      productTurn: false,
      next: null,
      nextThisTurn: false,
      lastText: "",
      now: "",
      nowTimer: null,
      nowDirty: false,
      nowSent: null,
      autonomous: false,
      autoRuns: 0,
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

  /** Flush and drop every canvas: the room is moving to another project. */
  async #closeStates(): Promise<void> {
    // a load still in flight would otherwise re-add its state after the clear
    await Promise.all([...this.#pendingStates.values()]);
    const states = [...this.#states.values()];
    this.#states.clear();
    this.#pendingStates.clear();
    // a throttle timer left behind would fire on a canvas this room no longer has
    for (const state of states) this.#clearNow(state);
    await Promise.all(states.map((state) => state.store.persist()));
  }

  /**
   * Take the agent's worktree listing as the truth: a variation that appeared
   * gets its canvas, one that was removed leaves the view. A removed worktree
   * with a harness still in it stays — the agent is the authority on what is
   * running, and its graph is still being written.
   */
  async #syncWorktrees(worktrees: WorktreeInfo[]): Promise<void> {
    this.#worktrees = worktrees;
    for (const info of worktrees) await this.#openState(info.id, info);
    const listed = new Set(worktrees.map((info) => info.id));
    for (const [id, state] of [...this.#states]) {
      if (listed.has(id) || state.session !== null) continue;
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

  /** the main worktree: the one the project's path names, else the first listed */
  #mainId(): string {
    const cwd = this.#project.cwd;
    const named = this.#worktrees.find((info) => info.path === cwd);
    if (named !== undefined) return named.id;
    const first = this.#worktrees[0];
    return first?.id ?? mainWorktreeOf(cwd);
  }

  /** what the user is told a variation is called: its branch, never its path */
  #labelOf(state: WorktreeState): string {
    return state.branch ?? basename(state.path);
  }

  /** the harnesses running right now, one per worktree that has one */
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
      canPublish: this.#project.canPublish,
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
   * `reply` reaches only the socket the frame came from. Almost nothing is
   * answered that way: a canvas is shared, so every result is broadcast and
   * every client stays in sync with the graph the agent is writing. The folder
   * chooser is the exception — one person opened a dialog, and where it lands
   * is nobody else's business.
   */
  handleClient(msg: ClientMsg, reply: (msg: ServerMsg) => void): void {
    if (!this.#agentConnected && msg.type !== "diff") {
      // the terminal pane already shows the shell is gone; everything else owes
      // the user a reason nothing happened. `diff` needs no harness at all.
      // The chooser is refused under its own prefix instead: the menu that
      // asked is waiting for an answer that names the request it made.
      if (msg.type === "pick_folder") {
        reply({ type: "error", message: "pick_folder rejected: no agent is attached to this project" });
        return;
      }
      if (!msg.type.startsWith("pty_")) this.#error(AGENT_GONE);
      return;
    }
    switch (msg.type) {
      case "pty_open":
      case "pty_input":
      case "pty_resize":
      case "pty_close": {
        // A pty over the network is a remote shell, so an agent that did not
        // allow one is not asked for it: the browser hides the pane on the same
        // capability, and a client that ignores that gets silence, not a shell.
        // A variation with no harness has no shell to attach to either.
        const state = this.#states.get(msg.worktree);
        if (state?.backend === undefined || state.backend === null) return;
        if (state.backend.capabilities.terminal === "none") return;
        // the terminal is its own channel: never queued behind agent delivery
        this.#link.send(msg);
        return;
      }
      case "abort": {
        const state = this.#steerable(msg.worktree);
        if (state === null) return;
        this.#link.send({ type: "abort", worktree: state.id });
        return;
      }
      case "switch_project":
        if (this.#switching) {
          this.#error("switch_project rejected: a project switch is already in progress");
          return;
        }
        this.#switching = true;
        this.#link.send({ type: "switch", path: msg.path });
        return;
      case "pick_folder": {
        // The dialog is modal on the user's machine, so a second one is refused
        // rather than queued: there is nothing to see behind the first.
        if (this.#picking !== null) {
          reply({ type: "error", message: "pick_folder rejected: a folder chooser is already open" });
          return;
        }
        const timer = setTimeout(() => {
          this.#picking = null;
          reply({ type: "error", message: "pick_folder failed: the chooser did not answer" });
        }, PICK_TIMEOUT_MS);
        timer.unref?.();
        this.#picking = { reply, timer };
        this.#link.send({ type: "pick_folder" });
        return;
      }
      case "create_project":
        // a create ends in a retarget, so it shares the switch guard: two of
        // them in flight would leave the room pointing at whichever finished last
        if (this.#switching) {
          this.#error("create_project rejected: a project switch is already in progress");
          return;
        }
        this.#switching = true;
        this.#link.send({ type: "create", path: msg.path, github: msg.github });
        return;
      case "adopt":
        if (this.#switching) {
          this.#error("adopt rejected: a project switch is already in progress");
          return;
        }
        this.#switching = true;
        this.#link.send({ type: "adopt", pid: msg.pid });
        return;
      case "open_worktree": {
        // opening a variation is the agent starting a harness: serialized like
        // a switch, because both end in the agent telling us what it now runs
        if (this.#switching) {
          this.#error("open_worktree rejected: a project switch is already in progress");
          return;
        }
        if (this.#opening !== null) {
          this.#error("open_worktree rejected: another variation is already being opened");
          return;
        }
        this.#opening = setTimeout(() => {
          this.#opening = null;
        }, OPEN_TIMEOUT_MS);
        this.#opening.unref?.();
        // The choices of the start card ride along untouched: which harness,
        // whether it decides for itself, whether the project remembers. Only
        // the agent can act on any of them — it is the one with the config
        // files and the launcher — so the room forwards and does not resolve.
        const open: Extract<ServerToAgentMsg, { type: "open_worktree" }> = { type: "open_worktree", path: msg.path };
        if (msg.backend !== undefined) open.backend = msg.backend;
        if (msg.autonomous !== undefined) open.autonomous = msg.autonomous;
        if (msg.remember !== undefined) open.remember = msg.remember;
        this.#link.send(open);
        return;
      }
      case "focus_terminal": {
        const state = this.#steerable(msg.worktree);
        if (state === null) return;
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
      case "close_worktree": {
        const state = this.#states.get(msg.worktree);
        if (state === undefined) {
          this.#error(`close_worktree rejected: ${msg.worktree} is not a variation of this project`);
          return;
        }
        if (state.session === null) {
          this.#error(`close_worktree rejected: nothing is running on ${this.#labelOf(state)}`);
          return;
        }
        this.#link.send({ type: "close_worktree", worktree: state.id });
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
      case "discover":
        this.#request<DiscoveredSession[]>((id) => ({ type: "discover", id }))
          .then((sessions) => this.#broadcast({ type: "sessions", sessions }))
          .catch((err: unknown) => this.#error(errText(err)));
        return;
      case "onboard": {
        const state = this.#variationOf(msg.worktree);
        if (state === null) return;
        void this.#onboard(state, msg.focus);
        return;
      }
      case "set_autonomous": {
        const state = this.#steerable(msg.worktree);
        if (state === null) return;
        // handing it the wheel takes the product-first turn off this worktree:
        // that gate exists to stop and let the user look, which is the one
        // thing autonomous mode is being asked not to do
        if (msg.on) state.productTurn = false;
        this.#setAutonomous(state, msg.on);
        this.#broadcast({
          type: "transcript",
          worktree: state.id,
          role: "tool",
          text: msg.on
            ? "autonomous mode on — it decides and keeps going until the work is finished"
            : "autonomous mode off — it stops at the end of each turn again",
        });
        return;
      }
      case "utterance": {
        const state = this.#variationOf(msg.worktree);
        if (state === null) return;
        this.#broadcast({ type: "transcript", worktree: state.id, role: "user", text: msg.text });
        // A human said something, so the card the last turn ended on is spent
        // and the autonomous stretch starts counting again from here.
        this.#setNext(state, null);
        state.autoRuns = 0;
        // The first words about an empty canvas earn a bubble immediately, and
        // — unless the user turned it off, or handed the wheel over — a turn
        // spent on the product picture before anything is built. Anything said
        // later disarms it: the picture is only ever bought once, at the start.
        const greenfield = state.store.doc.nodes.length === 0;
        state.productTurn = greenfield && msg.productFirst !== false && !state.autonomous;
        if (greenfield) this.#draftRoot(state, msg.text);
        const body = greenfield
          ? composeFirstUtterance(state.store, msg.text, { productTurn: state.productTurn })
          : composeUtterance(state.store, msg.text, msg.referent);
        const id = this.#deliver(state, body);
        this.#audit(state, { kind: "deliver", id, referent: msg.referent, text: msg.text });
        return;
      }
    }
  }

  /**
   * The canvas a browser frame names. A path that is not one of this project's
   * variations is a client bug and is refused; whether a session runs there is
   * a separate question, asked by `#steerable` only where it matters.
   */
  #variationOf(worktree: string): WorktreeState | null {
    const state = this.#states.get(worktree);
    if (state === undefined) {
      this.#error(`${worktree} is not a variation of this project`);
      return null;
    }
    return state;
  }

  /**
   * The canvas a browser frame acts on THROUGH a running session: aborting a
   * turn, bringing its terminal forward, changing how it approves itself all
   * need a harness that is already there. Saying something does not — that
   * opens the session — so those frames take `#variationOf` instead.
   */
  #steerable(worktree: string): WorktreeState | null {
    const state = this.#variationOf(worktree);
    if (state === null) return null;
    if (state.session === null) {
      this.#error(`no session is running on ${this.#labelOf(state)} — open it from the variations menu`);
      return null;
    }
    return state;
  }

  /**
   * Onboarding (onboarding.md), both directions of it. An empty canvas gets the
   * survey: the mechanical skeleton first, then the survey turn with codeRefs
   * validation armed against that worktree's file index. A canvas that already
   * has bubbles gets the catch-up turn instead — the same validation, no
   * skeleton, and a prompt made of what the code did since the map was drawn.
   * Everything mechanical comes from the agent: a room knows the project only
   * through its graph.
   *
   * `auto` marks the room's own decision to map rather than a person asking for
   * it (`#autoMap`): the transcript line says so, and a map that already
   * matches the code is refused out loud only to whoever asked.
   */
  async #onboard(
    state: WorktreeState,
    focus: string | undefined,
    opts: { auto?: boolean } = {},
  ): Promise<void> {
    if (state.store.doc.nodes.length > 0) {
      await this.#catchUp(state, opts.auto === true);
      return;
    }

    const scoped = focus === undefined || focus.trim().length === 0 ? "" : ` — focus: ${focus.trim()}`;
    // the room's own decision says why it made it: a harness that starts
    // mapping a repo nobody asked it to map is otherwise unexplained
    const because = opts.auto === true ? " — this project has code and no map yet" : "";
    this.#broadcast({
      type: "transcript",
      worktree: state.id,
      role: "user",
      text: `Map this project${scoped}${because}`,
    });

    let ops: CanvasOp[];
    try {
      ops = await this.#request<CanvasOp[]>((id) => ({ type: "synthesize_skeleton", worktree: state.id, id }));
    } catch (err) {
      this.#error(errText(err));
      return;
    }

    if (ops.length > 0) {
      const outcome = state.store.applyCanvasCall(
        {
          ops,
          note: `mechanical skeleton: ${state.store.doc.reality.nodes.length} workspace package(s)`,
        },
        null,
        // the skeleton is one flat pile of parts and nothing else yet: the
        // survey turn is where its links get written, and this receipt is the
        // server's own, never read by the agent
        { linkWarnings: false },
      );
      this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: outcome.transcript });
      if (outcome.changed) {
        void this.#graphChanged(state);
        this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
      }
      if (outcome.isError) this.#error(`skeleton synthesis rejected: ${outcome.text}`);
    } else {
      this.#broadcast({
        type: "transcript",
        worktree: state.id,
        role: "tool",
        text: "canvas: no workspace packages detected — survey starts from an empty canvas",
      });
    }

    let files: string[];
    try {
      files = await this.#request<string[]>((id) => ({ type: "file_index", worktree: state.id, id }));
    } catch (err) {
      this.#error(errText(err));
      return;
    }

    state.fileIndex = buildFileIndex(files);
    state.onboarding = true;
    const id = this.#deliver(state, composeSurveyPrompt(state.store.doc, focus));
    // the survey text is the server's, not the user's: the focus is all the
    // audit needs to explain why a harness suddenly mapped a repo
    this.#audit(state, { kind: "onboard", id, focus: focus ?? null });
    this.#markSurveyed(state);
  }

  /**
   * The other onboarding turn: the map is there and the code moved under it.
   * No skeleton — the bubbles exist, and re-seeding packages onto a canvas
   * somebody has grouped would undo the grouping — but the same file index and
   * the same validation as a survey, because a bubble added today has to clear
   * the bar the ones around it cleared. The prompt is what the code did since
   * (`composeCatchUpPrompt`): the drift notes, and the parts no bubble covers.
   *
   * A user focus is not carried here: the gap decides what this turn is about,
   * not a sentence about where to look.
   */
  async #catchUp(state: WorktreeState, auto: boolean): Promise<void> {
    const body = composeCatchUpPrompt(state.store.doc);
    if (body === null) {
      // nothing is behind. Whoever asked hears why; a room that decided by
      // itself simply does not spend a turn on it
      if (!auto) this.#error("onboard: the map already matches the code");
      return;
    }

    let files: string[];
    try {
      files = await this.#request<string[]>((id) => ({ type: "file_index", worktree: state.id, id }));
    } catch (err) {
      this.#error(errText(err));
      return;
    }

    state.fileIndex = buildFileIndex(files);
    state.onboarding = true;
    this.#broadcast({
      type: "transcript",
      worktree: state.id,
      role: "user",
      text: "Catch the map up with the code",
    });
    const id = this.#deliver(state, body);
    this.#audit(state, { kind: "onboard", id, focus: null, catchUp: true });
    this.#markSurveyed(state);
  }

  /**
   * The prompt is out, so this canvas has been mapped against the code at this
   * HEAD. Delivery is the mark and not the turn's end: a survey the harness
   * never finished must not leave the automatic trigger free to deliver the
   * same prompt again on every reconnect. It rides out as an ordinary revision,
   * so the browsers hold the same mark the room decides from.
   */
  #markSurveyed(state: WorktreeState): void {
    state.store.setSurveyed({ head: state.store.doc.reality.head, at: new Date().toISOString() });
    void this.#graphChanged(state);
    this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
  }

  /**
   * A session started in this worktree: if its canvas is behind the code, the
   * room maps it without being asked. This is the whole answer to the two
   * states a project lands in by itself — never mapped (code, no bubbles: the
   * survey) and fallen behind (bubbles, and the code moved: the catch-up) —
   * because a canvas nobody mapped shows an empty stage under a strip of
   * reality nobody asked for, and a stale one shows a picture that quietly
   * stopped being true.
   *
   * Once per session start, and never twice for the same session: an attach
   * that announces a live harness and the `session_started` behind it are one
   * start, and a reconnect of that same harness is not another one. The
   * catch-up half is additionally held to the HEAD it was last caught up at, so
   * a project that was just caught up is left alone until the code moves again.
   * A harness that is mid-turn (an adopted session) is not interrupted: the map
   * is owed until that turn ends (`#endTurn`). A worktree whose code the room
   * has never had read to it is asked for it, and the map is owed until that
   * extraction lands (`#reality`).
   */
  async #autoMap(state: WorktreeState, opts: { atTurnEnd?: boolean } = {}): Promise<void> {
    if (!AUTO_MAP || !this.#agentConnected || !this.#project.targetHasCode) return;
    if (state.session === null || state.onboarding) return;
    const doc = state.store.doc;
    // The room does not know this worktree's code yet — a variation opened just
    // now has no extraction behind it — and a map drawn blind is worse than one
    // drawn a moment later: the skeleton would be empty and the inventory with
    // it. So the room asks for the reading and owes the map until it arrives
    // (`#reality`). The ask goes out once: a second caller finds it owed.
    if (doc.reality.extractedAt === null) {
      if (!state.autoMapPending) this.#link.send({ type: "extract_reality", worktree: state.id });
      state.autoMapPending = true;
      return;
    }
    if (doc.nodes.length > 0) {
      // caught up at this HEAD already, or nothing to catch up: either way the
      // map is as true as the room can make it without a person saying more
      if (doc.surveyed?.head === doc.reality.head) return;
      if (composeCatchUpPrompt(doc) === null) return;
    }
    // a turn end IS the moment the deferred map runs: the harness is between
    // turns there, whatever its last state event said
    if (opts.atTurnEnd !== true && state.agent === "streaming") {
      state.autoMapPending = true;
      return;
    }
    // the session, as the room can name it: a harness that never says which
    // session it is on is mapped once per open of this worktree, which is what
    // the reset in `session_stopped` makes true
    const session = state.session.sessionId ?? state.id;
    if (state.autoMappedSession === session) return;
    state.autoMappedSession = session;
    await this.#onboard(state, undefined, { auto: true });
  }

  /**
   * Send a composed prompt to one worktree's harness and remember it until the
   * receipt arrives: an agent that dropped in between hears it again on
   * re-attach. Returns the delivery's id, which is what a receipt and an audit
   * line are correlated by. Ids are the room's, not the worktree's: one
   * sequence keeps them unique across every variation.
   */
  #deliver(state: WorktreeState, body: string): string {
    const id = `req-${++this.#requestSeq}`;
    this.#undelivered.set(id, { worktree: state.id, body });
    this.#link.send({ type: "deliver", worktree: state.id, id, body });
    return id;
  }

  // -------------------------------------------------------------------------
  // agent -> browsers
  // -------------------------------------------------------------------------

  handleAgent(msg: AgentFrame): void {
    switch (msg.type) {
      case "session_started":
        // whatever asked for it is answered: an `open_worktree`, or a switch
        // the agent resolved to a worktree of this same project
        this.#settleOpen();
        this.#switching = false;
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
          // a session in a project whose canvas is behind its code maps it
          // before anything is said to it
          void this.#autoMap(state);
        });
        return;
      case "session_stopped": {
        const state = this.#states.get(msg.worktree);
        // a harness of a project this room has moved off is not its business
        if (state === undefined) return;
        state.session = null;
        state.backend = null;
        state.onboarding = false;
        state.fileIndex = null;
        // the next session in this worktree is a new start: it is owed the
        // automatic map even if the harness never named itself
        state.autoMappedSession = null;
        state.autoMapPending = false;
        state.productTurn = false;
        // the harness that would have answered the card is gone
        this.#setNext(state, null);
        this.#setAutonomous(state, false);
        this.#setAgent(state, "idle");
        this.#setActivity(state, []);
        // nothing is being said any more: the live line goes out empty
        this.#clearNow(state);
        this.#broadcast({ type: "session_stopped", worktree: state.id, reason: msg.reason });
        this.#broadcastSession();
        return;
      }
      case "agent_event":
        this.#withState(msg.worktree, (state) => this.#agentEvent(state, msg.event));
        return;
      case "canvas_call":
        this.#withState(msg.worktree, (state) => this.#canvasCall(state, msg.id, msg.args));
        return;
      case "reality":
        this.#withState(msg.worktree, (state) => {
          void this.#reality(state, msg.reality);
        });
        return;
      case "worktrees":
        // solicited: the hello that asked syncs the states itself, right after
        // this answer settles its request
        if (msg.id !== null) {
          this.#settle(msg.id, msg.worktrees);
          return;
        }
        void this.#syncWorktrees(msg.worktrees).then(() => this.#broadcastSession());
        return;
      case "sessions":
        this.#discovered = msg.sessions;
        // unsolicited: the agent re-scanned on its own, so everyone hears it
        if (msg.id === null) this.#broadcast({ type: "sessions", sessions: msg.sessions });
        else this.#settle(msg.id, msg.sessions);
        return;
      case "recents":
        this.#recents = msg.paths;
        return;
      case "folder_picked": {
        // an answer nobody is waiting for — the timer gave up, or the browser
        // that asked went away — has no socket to go to and is dropped
        const picker = this.#settlePick();
        picker?.({ type: "folder_picked", path: msg.path });
        return;
      }
      case "delivered":
        this.#undelivered.delete(msg.id);
        this.#withState(msg.worktree, (state) => {
          this.#audit(state, { kind: "delivered", id: msg.id, mode: msg.mode, queued: msg.queued });
          // only the agent knows whether the harness was mid-turn when it landed
          if (!msg.queued) return;
          const harness = state.backend?.label ?? "the harness";
          this.#broadcast({
            type: "transcript",
            worktree: state.id,
            role: "tool",
            text: `${harness} cannot be interrupted mid-turn — queued for the next turn`,
          });
        });
        return;
      case "file_index":
        this.#settle(msg.id, msg.files);
        return;
      case "skeleton_result":
        this.#settle(msg.id, msg.ops);
        return;
      case "created": {
        // the agent already switched, so this room IS the new project. The line
        // explains in plain words what landed, publishing included; a warning
        // is something the user has to know but nothing that stopped the
        // create. Both wait for the hello this attach is about to produce.
        const repo = msg.repo === "initialized" ? "new repository" : "existing repository";
        const published = msg.github === null ? "" : `, published to ${msg.github.url}`;
        this.#pendingCreated = {
          text: `Started ${basename(msg.path)} at ${msg.path} — ${repo}${published}`,
          warnings: msg.warnings,
        };
        // a hello that would clear it has REQUEST_TIMEOUT_MS to appear: that is
        // the longest one can take, and a line nobody ever hears is worse than
        // one that lands a moment early
        setTimeout(() => this.#flushCreated(), REQUEST_TIMEOUT_MS);
        return;
      }
      case "agent_error": {
        if (SWITCH_SETTLED_PREFIXES.some((prefix) => msg.message.startsWith(prefix))) this.#switching = false;
        // the agent refused to open a variation: the menu may try another
        if (msg.message.startsWith("open_worktree")) this.#settleOpen();
        // The chooser could not be shown, or it failed: for the browser that
        // asked, THIS is the answer — so it lands on that socket and the slot
        // opens again, the way an `open_worktree failed` settles an open.
        if (msg.message.startsWith("pick_folder")) {
          const picker = this.#settlePick();
          if (picker !== null) {
            console.error(`[bridge] ${msg.message}`);
            picker({ type: "error", message: msg.message });
            return;
          }
        }
        this.#error(msg.message);
        return;
      }
      case "agent_exit":
        // whether the process dies with the harness is the agent's call
        console.error(`[bridge] ${msg.reason}`);
        this.#broadcast({ type: "error", message: msg.reason });
        return;
      case "detached":
        this.agentGone(`agent detached: ${msg.reason}`);
        return;
      case "terminal":
        // the pty launcher asking the browser for its drawer: the frame the
        // `focus_terminal` that caused it is answered by
        this.#broadcast(msg);
        return;
      case "pty_data":
      case "pty_exit":
      case "pty_state":
        // already named their worktree on the way in
        this.#broadcast(msg);
        return;
    }
  }

  /** Say what a `create_project` produced; a second call has nothing left to say. */
  #flushCreated(): void {
    const created = this.#pendingCreated;
    if (created === null) return;
    this.#pendingCreated = null;
    this.#broadcast({ type: "transcript", worktree: this.#mainId(), role: "tool", text: created.text });
    for (const warning of created.warnings) this.#error(warning);
  }

  /** One worktree's harness event, projected: transcript, activity, state. */
  #agentEvent(state: WorktreeState, event: AgentEvent): void {
    switch (event.kind) {
      case "state":
        // idle IS the end of a turn: onboarding validation disarms
        if (event.state === "idle") {
          state.onboarding = false;
          state.fileIndex = null;
        }
        this.#setAgent(state, event.state);
        return;
      case "text":
        // the turn's last sentence: what a synthesized card says at turn end
        state.lastText = event.text;
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
        // the turn the product picture was bought with is over: the next one
        // may build, whatever the user says next
        state.productTurn = false;
        this.#setActivity(state, []);
        this.#endTurn(state);
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
   * The turn is over, so the user is owed a way on. The agent's own card wins;
   * a turn that ended without one gets the generic one, because a canvas with
   * nothing under it and no sentence to say next is where a reader stalls. Then
   * autonomous mode, if it is on, answers that card itself.
   *
   * A map the room owes this worktree comes first and takes the whole turn end:
   * the session was mid-turn when the room decided to map it, and the card that
   * turn was going to leave behind is a way on into work nobody asked about —
   * the map is the way on.
   */
  #endTurn(state: WorktreeState): void {
    // nothing is being written any more, and that goes out before the card: a
    // stale sentence under a fresh offer reads as a turn still running
    this.#clearNow(state);
    if (state.autoMapPending) {
      state.autoMapPending = false;
      state.nextThisTurn = false;
      state.lastText = "";
      void this.#autoMap(state, { atTurnEnd: true });
      return;
    }
    if (!state.nextThisTurn) this.#setNext(state, synthesizeNext(state.lastText));
    state.nextThisTurn = false;
    state.lastText = "";
    if (state.autonomous) this.#autoContinue(state);
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
   * Nothing is being said on this worktree any more (the turn ended, or the
   * harness went away): the line is cleared and the throttle forgotten.
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

  /**
   * Autonomous mode's answer to the end of a turn: take the card's own offer.
   * A card with no choices and no question is the agent saying the work is
   * finished, and that is the one thing this does not argue with. The cap is
   * what keeps a loop from running all night unattended.
   */
  #autoContinue(state: WorktreeState): void {
    const next = state.next;
    if (next === null || state.session === null || !this.#agentConnected) return;
    if (next.choices.length === 0 && next.question === null) return;
    if (state.autoRuns >= AUTO_CAP) {
      this.#setAutonomous(state, false);
      this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: AUTO_PAUSED });
      return;
    }
    state.autoRuns += 1;
    // the card has been answered, so it stops being an offer to the user: what
    // they see next is the card the turn this prompt starts ends on
    this.#setNext(state, null);
    this.#broadcast({
      type: "transcript",
      worktree: state.id,
      role: "user",
      text: `autonomous: ${AUTO_CONTINUE_PROMPT}`,
    });
    const id = this.#deliver(state, AUTO_CONTINUE_PROMPT);
    this.#audit(state, { kind: "auto", id, run: state.autoRuns });
  }

  /** Apply a canvas call to one worktree's graph and answer the caller with what landed. */
  #canvasCall(state: WorktreeState, id: string, args: unknown): void {
    // Link warnings are the canvas asking for the connection a bubble owes;
    // during the product-first turn the layers they point at are exactly what
    // the agent may not draw yet, so it is not asked (productturn.ts).
    const outcome = state.store.applyCanvasCall(args, this.#opGate(state), {
      linkWarnings: !state.productTurn,
    });
    this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      void this.#graphChanged(state);
      this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
      // The canvas is the interface, so the bubbles a call just wrote are where
      // the agent is — a truer answer than the file paths a tool happened to
      // open, and the only one there is before any file is touched. It replaces
      // the file-derived set rather than joining it: the last thing written is
      // the thing to look at.
      this.#setActivity(state, outcome.touched);
    }
    // The card rides on the call rather than on the graph: a call may be all
    // card and no change, and it still says where the turn is leaving things.
    if (outcome.next !== null) {
      state.nextThisTurn = true;
      this.#setNext(state, outcome.next);
    }
    this.#link.send({ type: "canvas_result", id, text: outcome.text, isError: outcome.isError });
  }

  /**
   * The extra validation armed on this worktree right now, if any. Onboarding
   * wins: a survey turn is already a product-and-parts pass held to what the
   * code says, so the product-first gate has nothing to add to it.
   */
  #opGate(state: WorktreeState): OpGate | null {
    const index = state.fileIndex;
    // the survey turn is validated against what the project index admits
    if (state.onboarding && index !== null) return onboardingOpGate(index, state.store.doc);
    // the first turn on an empty canvas is the product picture, nothing below it
    if (state.productTurn) return productTurnGate(state.store.doc);
    return null;
  }

  /**
   * Sketch the user's own words onto the empty canvas before the agent has
   * done anything: a blank screen with a streaming agent behind it reads as a
   * frozen one. It goes through the store like any other call, so it is a
   * revision the user can compare against, and the bubble lights up as the
   * place the work is happening.
   */
  #draftRoot(state: WorktreeState, text: string): void {
    const outcome = state.store.applyCanvasCall(draftRootCall(text));
    this.#broadcast({ type: "transcript", worktree: state.id, role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      void this.#graphChanged(state);
      this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
    }
    if (outcome.isError) this.#error(`first sketch rejected: ${outcome.text}`);
    this.#setActivity(state, [DRAFT_ROOT_ID]);
  }

  /** Re-derived reality for one worktree: the agent decides when, on its own HEAD. */
  async #reality(state: WorktreeState, reality: RealityLayer): Promise<void> {
    state.store.setReality(reality, computeDrift(state.store.doc, reality));
    await this.#graphChanged(state);
    this.#broadcast({ type: "graph", worktree: state.id, graph: state.store.doc });
    // a map this worktree is owed was waiting on exactly this: the room now
    // knows what the code is, so it can say what the map is missing. Only an
    // owed one runs here — an extraction arriving on its own is the code
    // moving, and the room does not answer that with a turn nobody asked for
    // until a session starts again.
    if (state.autoMapPending) {
      state.autoMapPending = false;
      void this.#autoMap(state);
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
  #request<T>(make: (id: string) => ServerToAgentMsg): Promise<T> {
    if (!this.#agentConnected) return Promise.reject(new Error(AGENT_GONE));
    const id = `req-${++this.#requestSeq}`;
    const frame = make(id);
    const { promise, resolve: settle, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`the agent did not answer ${frame.type} within ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    this.#pending.set(id, { settle, fail: reject, timer });
    this.#link.send(frame);
    return promise as Promise<T>;
  }

  #settle(id: string, value: unknown): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.settle(value);
  }

  /** the `open_worktree` in flight is answered (or given up on) */
  #settleOpen(): void {
    if (this.#opening === null) return;
    clearTimeout(this.#opening);
    this.#opening = null;
  }

  /**
   * The folder chooser is answered: the slot opens for the next one, and the
   * socket that asked is handed back so the answer can go to it alone. Null
   * when nothing was open — the timer had already given up on it.
   */
  #settlePick(): ((msg: ServerMsg) => void) | null {
    const picking = this.#picking;
    if (picking === null) return null;
    clearTimeout(picking.timer);
    this.#picking = null;
    return picking.reply;
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
   * The card this worktree is offering, broadcast on every change. Clearing an
   * already-clear card says nothing, so it is dropped — every other transition
   * is news, including one card replacing another.
   */
  #setNext(state: WorktreeState, next: Next | null): void {
    if (state.next === null && next === null) return;
    state.next = next;
    this.#broadcast({ type: "next", worktree: state.id, next });
  }

  /** whether this worktree is deciding for itself; the counter belongs to the stretch */
  #setAutonomous(state: WorktreeState, on: boolean): void {
    state.autoRuns = 0;
    if (state.autonomous === on) return;
    state.autonomous = on;
    this.#broadcast({ type: "autonomous", worktree: state.id, on });
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
   * One line per steering delivery and receipt, stamped with who, where, and
   * which variation. An on-prem operator answers "what was said to this
   * harness, and did it land" from the room's own storage; the write never
   * blocks the delivery and never fails it (see `Storage.appendAudit`).
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
