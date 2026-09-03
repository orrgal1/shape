/**
 * One project's canvas, server side: the graph and its revisions, the session
 * the browsers see, and the translation between browser frames (`ClientMsg`)
 * and agent link frames (`AgentToServerMsg` / `ServerToAgentMsg`).
 *
 * The room never touches the target repo. Everything that needs a filesystem —
 * reality extraction, worktrees, session discovery, the project file index, the
 * mechanical skeleton — is asked of the agent and awaited as a link answer, so
 * a project on another machine is served exactly like a local one.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { diffSnapshots } from "../../../shared/src/delta.ts";
import { buildFileIndex, type FileIndex } from "../../../shared/src/fileindex.ts";
import type {
  AgentEvent,
  AgentProject,
  AgentState,
  AgentToServerMsg,
  CanvasOp,
  ClientMsg,
  DiscoveredSession,
  RealityLayer,
  ServerMsg,
  ServerToAgentMsg,
  SessionInfo,
  WorktreeInfo,
} from "../../../shared/src/index.ts";
import type { ServerEnd } from "../transport.ts";
import { computeDrift } from "./drift.ts";
import { composeSurveyPrompt, onboardingOpGate } from "./onboarding.ts";
import { PREAMBLE } from "./preamble.ts";
import { SnapshotStore } from "./snapshots.ts";
import { composeUtterance } from "./steering.ts";
import { GraphStore } from "./store.ts";

/** the frame that opens (or retargets) a room */
export type AttachMsg = Extract<AgentToServerMsg, { type: "attach" }>;

/** everything else an agent sends; `attach` is the server's business, not a room's */
export type AgentFrame = Exclude<AgentToServerMsg, { type: "attach" }>;

export interface ProjectRoomOptions {
  link: ServerEnd;
  /** reaches every browser watching this project */
  broadcast: (msg: ServerMsg) => void;
}

/**
 * How long a browser-facing answer waits on the agent. A hello must not hang on
 * a busy agent: it falls back to what the last attach told us.
 */
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * An `agent_error` starting with one of these settles a switch attempt — the
 * agent refused or failed it, so the guard that serializes switches opens
 * again. Any other adapter error may well arrive mid-switch and says nothing
 * about it. (`scripts/ctl.mjs` reads the same three prefixes as "switch over".)
 */
const SWITCH_SETTLED_PREFIXES = ["switch_project", "adopt rejected", "no Shape adapter"];

interface PendingRequest {
  settle: (value: unknown) => void;
  timer: NodeJS.Timeout;
}

/** Agent failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ProjectRoom {
  readonly #link: ServerEnd;
  readonly #broadcast: (msg: ServerMsg) => void;
  /** assigned by retarget(), which always runs before anything else reaches the room */
  #project!: AgentProject;
  #store!: GraphStore;
  #snapshots!: SnapshotStore;
  #session!: SessionInfo;
  #loaded = false;
  #agent: AgentState = "idle";
  #activity = new Set<string>();
  /** last values the agent reported; a hello the agent does not answer uses these */
  #worktrees: WorktreeInfo[] = [];
  #sessions: DiscoveredSession[] = [];
  #recents: string[] = [];
  /** onboarding validation mode: armed from `onboard` until the next idle */
  #onboarding = false;
  /** what the survey turn may point at; armed and disarmed with #onboarding */
  #fileIndex: FileIndex | null = null;
  #switching = false;
  readonly #pending = new Map<string, PendingRequest>();
  #requestSeq = 0;

  constructor(opts: ProjectRoomOptions) {
    this.#link = opts.link;
    this.#broadcast = opts.broadcast;
  }

  /**
   * Open the project the agent attached to — and, on a second `attach`, move
   * the room onto the new one: the old graph is flushed first, then session,
   * agent state and onboarding mode start over. The `attached` answer (whose
   * preamble the agent prepends to a session's first prompt) goes out last, so
   * nothing the agent sends next finds a half-loaded room.
   */
  async retarget(attach: AttachMsg): Promise<void> {
    if (this.#loaded) {
      await this.#store.persist();
      this.#agent = "idle";
      this.#activity = new Set();
      this.#onboarding = false;
      this.#fileIndex = null;
    }
    // the attach IS the answer to whichever switch was in flight
    this.#switching = false;

    const project = attach.project;
    this.#project = project;
    this.#store = new GraphStore(project.cwd);
    this.#snapshots = new SnapshotStore(project.cwd);
    await this.#store.load();
    // the rev we opened at must be diffable, not just the ones we go on to make
    await this.#snapshots.save(this.#store.doc);

    const reality = attach.reality;
    if (reality !== null && JSON.stringify(this.#store.doc.reality) !== JSON.stringify(reality)) {
      this.#store.setReality(reality, computeDrift(this.#store.doc, reality));
      await this.#graphChanged();
    }

    this.#worktrees = attach.worktrees;
    this.#sessions = attach.sessions;
    this.#recents = attach.recentProjects;
    this.#session = {
      ...attach.session,
      cwd: project.cwd,
      targetHasCode: project.targetHasCode,
      worktrees: attach.worktrees,
      backend: project.backend,
    };
    this.#loaded = true;
    this.#link.send({ type: "attached", projectId: project.key, preamble: PREAMBLE });
  }

  /**
   * Worktrees and running sessions are re-detected on every hello (connect and
   * post-switch): discovery is a ~150 ms `ps` + session-store walk on the agent
   * side, worth it to have the adopt list correct the instant the pop-up opens.
   * An agent too busy to answer in time does not hold the browser up — the
   * hello goes out with the values from the last attach.
   */
  async hello(): Promise<ServerMsg> {
    const [worktrees, sessions] = await Promise.all([
      this.#request<WorktreeInfo[]>((id) => ({ type: "list_worktrees", id })).catch(() => this.#worktrees),
      this.#request<DiscoveredSession[]>((id) => ({ type: "discover", id })).catch(() => this.#sessions),
    ]);
    this.#worktrees = worktrees;
    this.#sessions = sessions;
    this.#session = { ...this.#session, worktrees };
    return {
      type: "hello",
      graph: this.#store.doc,
      session: this.#session,
      agent: this.#agent,
      recentProjects: this.#recents,
      revisions: await this.#snapshots.list(),
      sessions,
    };
  }

  /** The link dropped, or the agent detached: nothing is running any more. */
  agentGone(line: string): void {
    console.error(`[bridge] ${line}`);
    this.#setAgent("idle");
    this.#setActivity([]);
  }

  // -------------------------------------------------------------------------
  // browser -> agent
  // -------------------------------------------------------------------------

  /**
   * `reply` reaches only the socket the frame came from. Nothing answers a
   * single browser today: a canvas is shared, so every result is broadcast and
   * every client stays in sync with the graph the agent is writing.
   */
  handleClient(msg: ClientMsg, reply: (msg: ServerMsg) => void): void {
    switch (msg.type) {
      case "pty_open":
      case "pty_input":
      case "pty_resize":
      case "pty_close":
        // the terminal is its own channel: never queued behind agent delivery
        this.#link.send(msg);
        return;
      case "abort":
        this.#link.send({ type: "abort" });
        return;
      case "switch_project":
        if (this.#switching) {
          this.#error("switch_project rejected: a project switch is already in progress");
          return;
        }
        this.#switching = true;
        this.#link.send({ type: "switch", path: msg.path });
        return;
      case "adopt":
        if (this.#switching) {
          this.#error("adopt rejected: a project switch is already in progress");
          return;
        }
        this.#switching = true;
        this.#link.send({ type: "adopt", pid: msg.pid });
        return;
      case "diff":
        // read-only: answered from the snapshots, the agent is not involved
        void this.#diff(msg.revA, msg.revB);
        return;
      case "discover":
        this.#request<DiscoveredSession[]>((id) => ({ type: "discover", id }))
          .then((sessions) => this.#broadcast({ type: "sessions", sessions }))
          .catch((err: unknown) => this.#error(errText(err)));
        return;
      case "onboard":
        void this.#onboard(msg.focus);
        return;
      case "utterance":
        this.#broadcast({ type: "transcript", role: "user", text: msg.text });
        this.#link.send({
          type: "deliver",
          id: `req-${++this.#requestSeq}`,
          body: composeUtterance(this.#store, msg.text, msg.referent),
        });
        return;
    }
  }

  /**
   * Onboarding (onboarding.md): the mechanical skeleton first, then the survey
   * turn with codeRefs validation armed against the project's file index. Both
   * come from the agent — a room knows the project only through its graph.
   */
  async #onboard(focus: string | undefined): Promise<void> {
    if (this.#store.doc.nodes.length > 0) {
      this.#error("onboard rejected: the canvas already has bubbles — steer them instead of remapping");
      return;
    }

    const scoped = focus === undefined || focus.trim().length === 0 ? "" : ` — focus: ${focus.trim()}`;
    this.#broadcast({ type: "transcript", role: "user", text: `Map this project${scoped}` });

    let ops: CanvasOp[];
    try {
      ops = await this.#request<CanvasOp[]>((id) => ({ type: "synthesize_skeleton", id }));
    } catch (err) {
      this.#error(errText(err));
      return;
    }

    if (ops.length > 0) {
      const outcome = this.#store.applyCanvasCall({
        ops,
        note: `mechanical skeleton: ${this.#store.doc.reality.nodes.length} workspace package(s)`,
      });
      this.#broadcast({ type: "transcript", role: "tool", text: outcome.transcript });
      if (outcome.changed) {
        void this.#graphChanged();
        this.#broadcast({ type: "graph", graph: this.#store.doc });
      }
      if (outcome.isError) this.#error(`skeleton synthesis rejected: ${outcome.text}`);
    } else {
      this.#broadcast({
        type: "transcript",
        role: "tool",
        text: "canvas: no workspace packages detected — survey starts from an empty canvas",
      });
    }

    let files: string[];
    try {
      files = await this.#request<string[]>((id) => ({ type: "file_index", id }));
    } catch (err) {
      this.#error(errText(err));
      return;
    }

    this.#fileIndex = buildFileIndex(files);
    this.#onboarding = true;
    this.#link.send({
      type: "deliver",
      id: `req-${++this.#requestSeq}`,
      body: composeSurveyPrompt(this.#store.doc, focus),
    });
  }

  // -------------------------------------------------------------------------
  // agent -> browsers
  // -------------------------------------------------------------------------

  handleAgent(msg: AgentFrame): void {
    switch (msg.type) {
      case "agent_event":
        this.#agentEvent(msg.event);
        return;
      case "canvas_call":
        this.#canvasCall(msg.id, msg.args);
        return;
      case "reality":
        void this.#reality(msg.reality);
        return;
      case "worktrees":
        this.#worktrees = msg.worktrees;
        this.#session = { ...this.#session, worktrees: msg.worktrees };
        if (msg.id !== null) this.#settle(msg.id, msg.worktrees);
        return;
      case "sessions":
        this.#sessions = msg.sessions;
        // unsolicited: the agent re-scanned on its own, so everyone hears it
        if (msg.id === null) this.#broadcast({ type: "sessions", sessions: msg.sessions });
        else this.#settle(msg.id, msg.sessions);
        return;
      case "recents":
        this.#recents = msg.paths;
        return;
      case "delivered":
        // only the agent knows whether the harness was mid-turn when it landed
        if (msg.queued) {
          this.#broadcast({
            type: "transcript",
            role: "tool",
            text: `${this.#session.backend.label} cannot be interrupted mid-turn — queued for the next turn`,
          });
        }
        return;
      case "file_index":
        this.#settle(msg.id, msg.files);
        return;
      case "skeleton_result":
        this.#settle(msg.id, msg.ops);
        return;
      case "agent_error":
        if (SWITCH_SETTLED_PREFIXES.some((prefix) => msg.message.startsWith(prefix))) this.#switching = false;
        this.#error(msg.message);
        return;
      case "agent_exit":
        // whether the process dies with the harness is the agent's call
        console.error(`[bridge] ${msg.reason}`);
        this.#broadcast({ type: "error", message: msg.reason });
        return;
      case "detached":
        this.agentGone(`agent detached: ${msg.reason}`);
        return;
      case "pty_data":
      case "pty_exit":
      case "pty_state":
        this.#broadcast(msg);
        return;
    }
  }

  /** The agent's projection of one harness event: transcript, activity, state. */
  #agentEvent(event: AgentEvent): void {
    switch (event.kind) {
      case "state":
        // idle IS the end of a turn: onboarding validation disarms
        if (event.state === "idle") {
          this.#onboarding = false;
          this.#fileIndex = null;
        }
        this.#setAgent(event.state);
        return;
      case "text":
        this.#broadcast({ type: "transcript", role: "assistant", text: event.text });
        return;
      case "tool_start": {
        this.#broadcast({
          type: "transcript",
          role: "tool",
          text: event.summary === "" ? event.name : `${event.name} ${event.summary}`,
        });
        const hits = this.#nodesForPaths(event.paths);
        if (hits.length > 0) this.#setActivity([...this.#activity, ...hits]);
        return;
      }
      case "tool_end":
        if (event.isError) this.#broadcast({ type: "transcript", role: "tool", text: `${event.name} failed` });
        return;
      case "turn_end":
        this.#setActivity([]);
        return;
      case "session": {
        // hook-driven adapters cannot answer this from a backend call: only the
        // harness knows which session it is on, and it tells the agent
        const sessionId = event.sessionId ?? this.#session.sessionId;
        const model = event.model ?? this.#session.model;
        if (
          sessionId === this.#session.sessionId &&
          model?.provider === this.#session.model?.provider &&
          model?.id === this.#session.model?.id
        ) {
          return;
        }
        this.#session = { ...this.#session, sessionId, model };
        void this.hello().then((hello) => this.#broadcast(hello));
        return;
      }
    }
  }

  /** Apply a canvas call and answer the caller with what landed. */
  #canvasCall(id: string, args: unknown): void {
    const index = this.#fileIndex;
    const outcome = this.#store.applyCanvasCall(
      args,
      // the survey turn is validated against what the project index admits
      this.#onboarding && index !== null ? onboardingOpGate(index, this.#store.doc) : null,
    );
    this.#broadcast({ type: "transcript", role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      void this.#graphChanged();
      this.#broadcast({ type: "graph", graph: this.#store.doc });
    }
    this.#link.send({ type: "canvas_result", id, text: outcome.text, isError: outcome.isError });
  }

  /** Re-derived reality: the agent decides when, and logs where it came from. */
  async #reality(reality: RealityLayer): Promise<void> {
    this.#store.setReality(reality, computeDrift(this.#store.doc, reality));
    await this.#graphChanged();
    this.#broadcast({ type: "graph", graph: this.#store.doc });
  }

  /** Compare two stored revisions; an unknown rev is the client's mistake. */
  async #diff(revA: number, revB: number): Promise<void> {
    const snapshots = this.#snapshots;
    const [a, b] = await Promise.all([snapshots.load(revA), snapshots.load(revB)]);
    if (a === null || b === null) {
      this.#error(`unknown revision ${a === null ? revA : revB}`);
      return;
    }
    this.#broadcast({ type: "delta", delta: diffSnapshots(a, b) });
  }

  /** intent nodes whose codeRefs prefix any of these paths */
  #nodesForPaths(tokens: string[]): string[] {
    if (tokens.length === 0) return [];
    const cwd = this.#project.cwd;
    const rels: string[] = [];
    for (const token of tokens) {
      const abs = isAbsolute(token) ? token : resolve(cwd, token);
      const rel = relative(cwd, abs);
      if (rel.length > 0 && !rel.startsWith("..")) rels.push(rel);
    }
    if (rels.length === 0) return [];
    const hits: string[] = [];
    for (const node of this.#store.doc.nodes) {
      const refs = node.codeRefs;
      if (refs === undefined || refs.length === 0) continue;
      const prefixes = refs.map((r) => r.replace(/^\.\//, "").replace(/\/+$/, ""));
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
   * instead of leaving the request pending forever.
   */
  #request<T>(make: (id: string) => ServerToAgentMsg): Promise<T> {
    const id = `req-${++this.#requestSeq}`;
    const frame = make(id);
    const { promise, resolve: settle, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`the agent did not answer ${frame.type} within ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    this.#pending.set(id, { settle, timer });
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

  // -------------------------------------------------------------------------

  #setAgent(state: AgentState): void {
    if (this.#agent === state) return;
    this.#agent = state;
    this.#broadcast({ type: "agent", state });
  }

  #setActivity(nodeIds: string[]): void {
    const next = new Set(nodeIds);
    if (next.size === this.#activity.size && [...next].every((id) => this.#activity.has(id))) return;
    this.#activity = next;
    this.#broadcast({ type: "activity", nodeIds: [...next] });
  }

  /**
   * The graph's rev advanced: flush it and file a revision snapshot. A snapshot
   * that actually landed grows the set of revisions clients can diff over, so
   * they get the fresh list. The store is captured because a retarget may
   * replace `#snapshots` before the write settles.
   */
  #graphChanged(): Promise<void> {
    const persisted = this.#store.persist();
    const snapshots = this.#snapshots;
    void snapshots.save(this.#store.doc).then(async (info) => {
      if (info === null) return;
      this.#broadcast({ type: "revisions", revisions: await snapshots.list() });
    });
    return persisted;
  }

  #error(message: string): void {
    console.error(`[bridge] ${message}`);
    this.#broadcast({ type: "error", message });
  }
}
