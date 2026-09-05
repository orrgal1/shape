/**
 * The agent half of Shape for ONE project: everything that needs the target
 * repo's filesystem, git, `ps` or the user's terminal. It watches the sessions
 * running in the repo's worktrees, extracts the reality layer and lists
 * worktrees; it owns no canvas state at all.
 *
 * It talks to a Shape server over one `AgentEnd` (`transport.ts`) in Link v2
 * frames: `attach` first, then events and answers to the server's requests.
 * In local mode the other end is a `ProjectRoom` in this same process, which
 * is why every stderr line here still says `[bridge]`.
 *
 * SHAPE STARTS NOTHING. A session appears because something inside a worktree
 * of this repo spoke on the loopback link — the omp extension greeting, a
 * Claude Code hook firing, an MCP sidecar calling the canvas — and it
 * disappears when that session says goodbye. There is no way in from the
 * browser: nothing here launches a harness, types at one, aborts one or
 * changes how it approves its own work.
 *
 * ONE RUNTIME, ONE REPO, N WORKTREES; the fleet owns the loopback link and
 * hosts one runtime per active project. All the worktrees of a repo are one
 * project (one key, one canvas), and each of them may have a session reporting
 * in — `#sessions`, keyed by worktree id (the realpath of its directory).
 * Everything that is about one variation is stamped with that id on the way
 * out and routed by it on the way in: events, canvas calls, reality. A repo
 * this runtime does not contain is another project with a runtime of its own,
 * which is why `routeLink` answers null rather than retargeting.
 *
 * Two rules shape the code:
 * - ONE `AgentEvents` sink per worktree, for as long as a session reports in
 *   from it. Hooks, the MCP sidecar and the harness's own extension must land
 *   in the same place, or a hook-driven session would lose its transcript and
 *   activity — and they must land in the sink of the worktree they came from,
 *   which is why link callers report their cwd.
 * - Outbound frames queue until the server has answered `attached` for the
 *   current attach. Claude Code fires SessionStart within a second of coming
 *   up, well before the room exists; those frames are not allowed to vanish.
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { LINK_WS_PATH } from "../../../shared/src/index.ts";
import type { AgentState, BackendInfo, ManagerHandle, RealityLayer, WorktreeInfo } from "../../../shared/src/index.ts";
import type {
  AgentSession,
  AgentToServerMsg,
  ServerToAgentMsg,
  WorktreeSession,
} from "../../../shared/src/link.ts";
import type { AgentEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import type { DetectedTools } from "./detect.ts";
import { LINK_CLI, directivePath, renderDirective, writeDirective } from "./directive.ts";
import type { AgentEvents, LinkHello, LinkTarget } from "./external.ts";
import type { HerdrLauncher } from "./launcher/herdr.ts";
import { attachManager } from "./manager.ts";
import { hasSourceCode, synthesizeSkeleton } from "./onboarding-fs.ts";
import { extractReality } from "./reality.ts";
import {
  canonicalDir,
  ensureGitExclude,
  legacyProjectKey,
  listWorktrees,
  projectKey,
  repoIdentity,
  worktreeContaining,
} from "./worktrees.ts";

/** an empty layer keeps `synthesizeSkeleton` honest before the first extraction */
const NO_REALITY: RealityLayer = {
  nodes: [],
  edges: [],
  symbols: [],
  infra: [],
  verification: [],
  extractedAt: null,
  head: null,
};

/**
 * What a canvas call in flight when the link drops resolves to. The harness
 * reads tool results out loud, so it says what happened and what did not.
 */
const SERVER_UNREACHABLE = "Shape server unreachable — the canvas was not updated";

/**
 * Distinct caller spellings the link router remembers before starting over.
 * Generous for honest callers (a handful of directories per project) and a
 * hard ceiling on a process that invents paths.
 */
const MAX_LINK_ROUTES = 256;

export interface AgentRuntimeOptions {
  /**
   * The directory this project was seen at. Any worktree of the repo will do:
   * the project is the repo, and this is the variation the fleet found first.
   */
  cwd: string;
  /** for the link URL alone (the directive and the manager's config carry it) */
  sockets: SocketServer;
  link: AgentEnd;
  /** what is installed on this machine; the fleet detects it once for every runtime */
  tools: DetectedTools;
  launcher: HerdrLauncher | null;
  /** whether a loopback caller from `cwd` is currently greeted (the fleet owns the link) */
  isLinked: (cwd: string) => boolean;
  /** the server closed this runtime's link (project marked inactive, attach refused): the fleet drops it */
  onExit: (reason: string) => void;
}

/**
 * One session Shape is watching, and everything that belongs to its worktree
 * alone. Shape starts nothing: the record appears when a caller from that
 * worktree first speaks on the link, and is dropped when the session says
 * goodbye.
 */
interface Observed {
  /** worktree id: the realpath of the directory the session runs in */
  readonly worktree: string;
  /** the one sink for this worktree: every link event that comes out of it */
  readonly events: AgentEvents;
  /**
   * What the session called itself in its `hello`. Null while nothing has
   * greeted — a hook or an MCP sidecar proves a session is there without
   * saying which harness it is.
   */
  harness: string | null;
  /** a canvas call has come from here, so the tool really is reaching Shape */
  hostTool: boolean;
  session: AgentSession;
  state: AgentState;
}

/** Failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentRuntime {
  readonly #sockets: SocketServer;
  readonly #link: AgentEnd;
  readonly #isLinked: (cwd: string) => boolean;
  readonly #onExit: (reason: string) => void;

  /** the directory this project was seen at; any worktree of the repo */
  readonly #cwd: string;
  /** the MAIN worktree — the project's cwd, label and storage anchor */
  #projectCwd = "";
  /** sha256 of machine + the repo's common dir: every worktree shares it */
  #projectKey = "";
  /** the worktree `#cwd` sits in */
  #primary = "";
  /**
   * What is installed here, as the fleet detected it. Machine-wide: one agent
   * process sees one PATH, so every runtime is handed the same answer.
   */
  readonly #tools: DetectedTools;
  /**
   * The user's terminal multiplexer, when there is one. It is how a session's
   * tab is brought forward and where the project's manager lives; null means
   * no session here has a terminal Shape can reach.
   */
  readonly #launcher: HerdrLauncher | null;

  /** one record per worktree with a session reporting in, keyed by worktree id */
  readonly #sessions = new Map<string, Observed>();
  /** every worktree of the repo (a non-git target gets exactly one) */
  #worktrees: WorktreeInfo[] = [];
  /** last extraction per worktree; a variation with no session can still have one */
  readonly #realities = new Map<string, { layer: RealityLayer; head: string | null }>();
  /** worktrees with an extraction in flight, so an idle storm cannot pile up */
  readonly #realityBusy = new Set<string>();
  /**
   * Loopback caller cwd → the worktree it belongs to (null = not ours), so a
   * canonicalization costs one syscall per spelling instead of one per frame.
   */
  readonly #linkRoutes = new Map<string, string | null>();

  #targetHasCode = false;
  /**
   * Where this project's directive was written, so a session Shape has no
   * integration with can still find the canvas. Null when the write failed.
   */
  #directivePath: string | null = null;
  /**
   * This project's manager session in the user's herdr, as Shape last saw it.
   * Null whenever there is none to see — no herdr, no `mgr`, or a herdr that
   * would not cooperate — which the canvas shows as plainly as it shows one.
   */
  #manager: ManagerHandle | null = null;

  /** false while frames wait for `attached`; see the file header */
  #outboxOpen = false;
  #queue: AgentToServerMsg[] = [];
  /**
   * One-shot: resolved by the first `attached` (or by a stop, so a signal
   * handler firing while we still wait for a server that never comes is not a
   * hang). A re-attach after a reconnect does not reopen it — nothing awaits
   * it once start() has returned.
   */
  readonly #attachGate = Promise.withResolvers<void>();

  /** pending canvas calls, by frame id */
  readonly #calls = new Map<string, (result: { text: string; isError: boolean }) => void>();
  #callSeq = 0;
  #stopped = false;

  constructor(opts: AgentRuntimeOptions) {
    this.#sockets = opts.sockets;
    this.#link = opts.link;
    this.#tools = opts.tools;
    this.#launcher = opts.launcher;
    this.#isLinked = opts.isLinked;
    this.#onExit = opts.onExit;
    this.#cwd = opts.cwd;
  }

  /** The project's main worktree: its cwd on the wire and the fleet's key path. */
  get cwd(): string {
    return this.#projectCwd;
  }

  /**
   * Bring this project up: link listeners, the project's facts, then `attach`.
   *
   * `attach` goes last so the hello it triggers already carries whatever has
   * reported in. A startup opens no session at all: the project is attached
   * with the sessions that happen to be there, which is usually none, and the
   * canvas shows the repo either way.
   */
  async start(): Promise<void> {
    this.#link.onMessage((msg) => this.#onServerMsg(msg));
    // the only way a runtime ends other than a stop: the server closed this
    // link, which is how being marked inactive reaches this side
    this.#link.onClose((reason) => this.#teardown(reason));
    this.#link.onDisconnect((reason) => this.#onLinkGap(reason));
    this.#link.onReconnect(() => this.#onLinkBack());
    await this.#openProject();
    // the config the manager pass writes is what every builder the manager
    // launches later comes up with, so it is written before anything reports in
    await this.#attachManager();
    this.#sendAttach();
    await this.#attachGate.promise;
  }

  stop(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    // the room goes agentless on this frame, so it leaves before the sockets do
    this.#link.send({ type: "detached", reason: "agent stopped" });
    // a stop is the fleet's own doing: it already knows this runtime is gone,
    // so the teardown reports no exit
    this.#teardown(null);
    // a socket-backed end would otherwise keep reconnecting to a server that
    // has nothing left to talk to
    this.#link.close("agent stopped");
    return Promise.resolve();
  }

  /**
   * The socket-backed link dropped and is retrying. In-flight canvas calls
   * cannot survive the gap — the room that would answer them is gone, and the
   * harness is blocked on the tool result — so they fail with something worth
   * reading out loud. The outbox closes behind them: the next thing on this
   * link is a fresh `attach`, and whatever queues up meanwhile goes out when
   * the server answers it.
   */
  #onLinkGap(reason: string): void {
    console.error(`[bridge] link to the Shape server dropped: ${reason}`);
    this.#outboxOpen = false;
    const pending = [...this.#calls.values()];
    this.#calls.clear();
    for (const settle of pending) settle({ text: SERVER_UNREACHABLE, isError: true });
  }

  /** Reconnected: the room may be new or may have outlived us, so re-announce. */
  #onLinkBack(): void {
    console.error("[bridge] link to the Shape server re-established");
    this.#sendAttach();
  }

  // -------------------------------------------------------------------------
  // project lifecycle
  // -------------------------------------------------------------------------

  /**
   * Everything about the repo `#cwd` sits in that the server cannot see for
   * itself. The project is the REPO: the key comes from the common dir, so
   * every worktree lands on one canvas, and the project's cwd is the main
   * worktree whichever variation the fleet found this project through.
   */
  async #openProject(): Promise<void> {
    const identity = await repoIdentity(this.#cwd);
    this.#projectCwd = identity.main;
    this.#projectKey = projectKey(identity);

    const worktrees = await listWorktrees(this.#cwd);
    // a non-git target is still one variation, or the canvas would have a
    // session running in a worktree the browser has never heard of
    this.#worktrees =
      worktrees.length > 0 ? worktrees : [{ id: identity.main, path: identity.main, branch: null, head: null }];
    this.#primary = worktreeContaining(this.#worktrees, canonicalDir(this.#cwd)) ?? identity.main;
    // the fleet registers a runtime before it starts, so a caller may already
    // have been told this repo does not contain it — that answer was about a
    // runtime with no worktree list yet, and it must not outlive one
    this.#linkRoutes.clear();

    const hasPackages = await this.#startupReality(this.#primary);
    this.#targetHasCode = hasPackages || (await hasSourceCode(this.#primary));
    await ensureGitExclude(this.#cwd);
    await this.#writeDirective();
  }

  /**
   * Drop this project's directive on disk, so a session Shape never registered
   * a tool in can still find the canvas. The link URL in it is fixed for this
   * process (the socket server's port is set at construction), so one write per
   * project open is all it ever needs; `writeDirective` skips an identical
   * write, so a project that comes back costs a read.
   * Never fatal: without the file the tool-bearing sessions are unaffected.
   */
  async #writeDirective(): Promise<void> {
    const path = directivePath(this.#projectKey);
    try {
      await writeDirective(
        path,
        renderDirective({
          linkUrl: this.#sockets.url(LINK_WS_PATH),
          cliPath: LINK_CLI,
          projectCwd: this.#projectCwd,
        }),
      );
      this.#directivePath = path;
    } catch (err) {
      this.#directivePath = null;
      console.error(`[bridge] could not write shape-directive.md: ${errText(err)}`);
    }
  }

  /**
   * Find this project's manager (issue #3, `./manager.ts`). Runs after
   * `#openProject`, because the directive it points the manager's builders at
   * is written there.
   *
   * Shape opens no session: the manager is one the user (or a previous Shape)
   * already has in their herdr, and all this pass does is recognize it and
   * hand Shape's integration down to the builders it launches.
   *
   * `attachManager` reports every failure itself and answers null, so there is
   * nothing to catch: a project without a manager still has a canvas.
   */
  async #attachManager(): Promise<void> {
    this.#manager = await attachManager({ path: this.#projectCwd, label: basename(this.#projectCwd) }, this.#launcher, {
      linkUrl: this.#sockets.url(LINK_WS_PATH),
      directivePath: this.#directivePath,
      isLinked: this.#isLinked,
    });
  }

  /**
   * How one observed session is described on the wire, derived fresh each
   * time. Everything in it is either what the session itself said or a plain
   * fact about this machine: Shape cannot steer a session it does not drive,
   * cannot resume one it never started, and can only reach a terminal when
   * herdr is hosting it.
   */
  #backendInfo(observed: Observed): BackendInfo {
    const harness = observed.harness;
    return {
      id: harness ?? "unknown",
      label: harness ?? "agent",
      capabilities: {
        steerMidTurn: false,
        hostTool: observed.hostTool,
        // a session that greeted reports its own events; one that never did is
        // known only through the hooks and tool calls that reach the link
        events: harness === null ? "hooks" : "native",
        resume: false,
        terminal: this.#launcher === null ? "none" : "external",
      },
    };
  }

  /**
   * A session Shape had not seen before just spoke from `worktree`. Nothing
   * was started: a caller reporting in IS the session appearing, so the record
   * is created here and the room hears about it at once. What that session is
   * gets refined the moment it greets — until then all Shape knows is the
   * directory the work is happening in.
   */
  #observe(worktree: string): Observed {
    const observed: Observed = {
      worktree,
      events: this.#agentEvents(worktree),
      harness: null,
      hostTool: false,
      session: { sessionId: null, sessionName: null, model: null },
      state: "idle",
    };
    this.#sessions.set(worktree, observed);
    this.#postSessionStarted(observed);
    console.error(`[bridge] a session is reporting in from ${this.#label(worktree)} (${worktree})`);
    return observed;
  }

  /** The session in `worktree` as the room draws it, with whatever is known now. */
  #postSessionStarted(observed: Observed): void {
    this.#post({
      type: "session_started",
      worktree: observed.worktree,
      session: observed.session,
      backend: this.#backendInfo(observed),
    });
  }

  /**
   * The harness itself greeted. This is where an observed session stops being
   * a directory somebody is working in and becomes a named session: the
   * harness, its session id and model, and whether the canvas tool is really
   * registered in it. The room is told again, because everything it heard the
   * first time was what Shape had to assume.
   */
  #onHello(worktree: string, hello: LinkHello): void {
    const observed = this.#sessions.get(worktree);
    if (observed === undefined) return;
    observed.harness = hello.harness;
    observed.hostTool = observed.hostTool || hello.capabilities.tool;
    observed.session = { sessionId: hello.sessionId, sessionName: null, model: hello.model };
    this.#postSessionStarted(observed);
    console.error(
      `[bridge] ${hello.harness} in ${this.#label(worktree)} greeted (session ${hello.sessionId ?? "unnamed"})`,
    );
  }

  /**
   * A session ended (`bye`, or the link socket dropped, which the endpoint
   * replays as one). The variation loses its session and the canvas says so —
   * and that is all: the project stays attached with its canvas, the other
   * variations keep reporting, and the next session to speak from that
   * directory appears the same way this one did.
   */
  #onBye(worktree: string, reason: string): void {
    if (!this.#sessions.delete(worktree)) return;
    this.#post({ type: "session_stopped", worktree, reason });
    console.error(`[bridge] the session in ${this.#label(worktree)} ended: ${reason}`);
  }

  /**
   * Announce this project. Sent again only when the link came back after a
   * gap: the room's project never changes under a runtime.
   */
  #sendAttach(): void {
    this.#outboxOpen = false;
    const sessions: WorktreeSession[] = [...this.#sessions.values()].map((observed) => ({
      worktree: observed.worktree,
      session: observed.session,
      backend: this.#backendInfo(observed),
      state: observed.state,
    }));
    const realities: Record<string, RealityLayer> = {};
    for (const [worktree, entry] of this.#realities) realities[worktree] = entry.layer;
    // the key each worktree WOULD have had before the project key came off the
    // repo's common dir: the server needs them to find a canvas drawn under the
    // old scheme and move it onto this project (CONTRACTS.md § Worktrees on one
    // canvas). Derived here because only the agent knows the directories.
    const legacyKeys: Record<string, string> = {};
    for (const info of this.#worktrees) legacyKeys[info.id] = legacyProjectKey(info.id);
    // never queued: this frame is what opens the queue
    this.#link.send({
      type: "attach",
      project: {
        key: this.#projectKey,
        label: basename(this.#projectCwd),
        cwd: this.#projectCwd,
        // the project's harness as the canvas names it: the first session that
        // reported in. Null while none has — which is the ordinary state of a
        // project nobody is working in right now
        backend: sessions[0]?.backend ?? null,
        tools: { launcher: this.#launcher?.id ?? null, launchers: this.#tools.launchers, harnesses: this.#tools.harnesses },
        targetHasCode: this.#targetHasCode,
        directivePath: this.#directivePath,
        manager: this.#manager,
        legacyKeys,
      },
      worktrees: this.#worktrees,
      sessions,
      realities,
    });
  }

  /**
   * The runtime is over: either the fleet stopped it, or the server closed the
   * link (`reason`), which is how a project marked inactive reaches this side.
   * The sessions are simply forgotten — the room going away takes their
   * drawings with it, and there is nobody left to tell.
   */
  #teardown(reason: string | null): void {
    if (this.#stopped) return;
    this.#stopped = true;
    // start() may still be waiting for an `attached` that will never come now
    this.#attachGate.resolve();
    this.#sessions.clear();
    if (reason !== null) this.#onExit(reason);
  }

  // -------------------------------------------------------------------------
  // worktree identity
  // -------------------------------------------------------------------------

  /** How a variation is named to a human: its branch, or its directory. */
  #label(worktree: string): string {
    const info = this.#worktrees.find((entry) => entry.id === worktree);
    return info?.branch ?? basename(worktree);
  }

  /** Re-scan the repo's worktrees and tell the room; `id` answers a request. */
  async #refreshWorktrees(id: string | null): Promise<void> {
    const worktrees = await listWorktrees(this.#projectCwd);
    if (worktrees.length > 0) this.#worktrees = worktrees;
    // a spelling that resolved to nothing may be a variation now
    this.#linkRoutes.clear();
    this.#post({ type: "worktrees", id, worktrees: this.#worktrees });
  }

  // -------------------------------------------------------------------------
  // sessions -> server
  // -------------------------------------------------------------------------

  /** The runtime's only way out: frames wait here until the room exists. */
  #post(msg: AgentToServerMsg): void {
    if (this.#outboxOpen) {
      this.#link.send(msg);
      return;
    }
    this.#queue.push(msg);
  }

  #openOutbox(): void {
    this.#outboxOpen = true;
    const queued = this.#queue;
    this.#queue = [];
    for (const msg of queued) this.#link.send(msg);
  }

  /** A failure worth showing the user; the server logs and broadcasts it. */
  #error(message: string): void {
    this.#post({ type: "agent_error", message });
  }

  /**
   * One worktree's event sink, bound to that worktree for as long as a session
   * reports in from it. Every frame it produces names the worktree, so the
   * room can file it against the right canvas without guessing.
   */
  #agentEvents(worktree: string): AgentEvents {
    return {
      onAgentState: (state) => {
        const observed = this.#sessions.get(worktree);
        if (observed !== undefined) observed.state = state;
        // idle IS the end of a turn: this worktree's reality is worth re-deriving
        if (state === "idle") void this.#refreshReality(worktree);
        this.#post({ type: "agent_event", worktree, event: { kind: "state", state } });
      },
      onAssistantText: (text) => this.#post({ type: "agent_event", worktree, event: { kind: "text", text } }),
      // the live "now" line: passed straight through, never stored here. The
      // room is what folds a burst of these into one line and forgets them.
      onTextDelta: (delta) => this.#post({ type: "agent_event", worktree, event: { kind: "text_delta", delta } }),
      onToolStart: (call) =>
        this.#post({
          type: "agent_event",
          worktree,
          event: { kind: "tool_start", name: call.name, paths: call.paths, summary: call.summary },
        }),
      onToolEnd: (info) =>
        this.#post({
          type: "agent_event",
          worktree,
          event: { kind: "tool_end", name: info.name, isError: info.isError },
        }),
      onTurnEnd: () => this.#post({ type: "agent_event", worktree, event: { kind: "turn_end" } }),
      // only the harness knows which session it is on, and a hook-driven one
      // learns it long after the work started
      onSession: (info) => {
        const observed = this.#sessions.get(worktree);
        if (observed !== undefined) {
          observed.session = {
            ...observed.session,
            sessionId: info.sessionId ?? observed.session.sessionId,
            model: info.model ?? observed.session.model,
          };
        }
        this.#post({
          type: "agent_event",
          worktree,
          event: { kind: "session", sessionId: info.sessionId, model: info.model },
        });
      },
    };
  }

  /**
   * Hand a canvas call to the server and wait for its result. Every caller on
   * the link goes through here, so one counter is enough to correlate every
   * answer, and the worktree it was made in travels with it.
   */
  #canvasCall(worktree: string, args: unknown): Promise<{ text: string; isError: boolean }> {
    const id = `call-${++this.#callSeq}`;
    const { promise, resolve: settle } = Promise.withResolvers<{ text: string; isError: boolean }>();
    this.#calls.set(id, settle);
    this.#post({ type: "canvas_call", worktree, id, args });
    return promise;
  }

  /**
   * Route a loopback caller (the harness's own extension, a hook, an MCP
   * sidecar) to the worktree it belongs to, by the directory it reports
   * running in: the deepest worktree containing it wins. A worktree of this
   * repo with nothing on record yet GAINS a session here — a caller speaking
   * from it is the only evidence Shape ever gets that one exists. A cwd
   * outside this repo is null, not a refusal: the fleet asks every runtime in
   * turn, and only it knows whether some other project claims that directory.
   *
   * The cwd is canonicalized first and that is not optional. A worktree id is
   * a realpath, but a caller's spelling need not be one: `process.cwd()` is
   * canonical, while a hook reporting `$PWD` or a payload's `cwd` carries
   * whatever the user typed — and on macOS every `/tmp` path is a symlink to
   * `/private/tmp`. Matching the raw string would refuse a session that is
   * plainly inside the repo. Resolutions are memoized because the same handful
   * of directories repeat for a whole session; the cache is dropped whenever
   * the worktree list changes, since a path that resolved to nothing may now
   * be a variation.
   */
  routeLink(cwd: string): LinkTarget | null {
    let resolved = this.#linkRoutes.get(cwd);
    if (resolved === undefined) {
      resolved = worktreeContaining(this.#worktrees, canonicalDir(cwd));
      // a caller inventing paths must not grow this without bound
      if (this.#linkRoutes.size >= MAX_LINK_ROUTES) this.#linkRoutes.clear();
      this.#linkRoutes.set(cwd, resolved);
    }
    if (resolved === null) return null;
    const worktree = resolved;
    const observed = this.#sessions.get(worktree) ?? this.#observe(worktree);
    return {
      applyCanvas: (args) => {
        // a tool call is proof the canvas tool is registered in that session,
        // which the room draws differently from a session Shape only overhears
        if (!observed.hostTool) {
          observed.hostTool = true;
          this.#postSessionStarted(observed);
        }
        return this.#canvasCall(worktree, args);
      },
      events: observed.events,
      onHello: (hello) => this.#onHello(worktree, hello),
      onBye: (reason) => this.#onBye(worktree, reason),
    };
  }

  // -------------------------------------------------------------------------
  // server -> agent
  // -------------------------------------------------------------------------

  #onServerMsg(msg: ServerToAgentMsg): void {
    switch (msg.type) {
      case "attached":
        this.#openOutbox();
        this.#attachGate.resolve();
        return;
      case "error":
        console.error(`[bridge] ${msg.message}`);
        return;
      case "canvas_result": {
        const settle = this.#calls.get(msg.id);
        if (settle === undefined) return;
        this.#calls.delete(msg.id);
        settle({ text: msg.text, isError: msg.isError });
        return;
      }
      case "focus_terminal":
        void this.#focusTerminal(msg.worktree);
        return;
      case "list_worktrees": {
        const { id } = msg;
        void this.#refreshWorktrees(id);
        return;
      }
      case "extract_reality":
        void this.#extractRealityNow(msg.worktree);
        return;
      case "synthesize_skeleton": {
        const { worktree, id } = msg;
        if (worktreeContaining(this.#worktrees, worktree) === null) return;
        const reality = this.#realities.get(worktree)?.layer ?? NO_REALITY;
        void synthesizeSkeleton(worktree, reality).then((ops) =>
          this.#post({ type: "skeleton_result", worktree, id, ops }),
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // terminal
  // -------------------------------------------------------------------------

  /**
   * `focus_terminal`: bring that variation's session in front of the user.
   * Shape does not own the terminal, so this only asks herdr to switch to the
   * tab whose agent runs in that directory and raises the application hosting
   * it. Without herdr there is nothing to switch to — the session's
   * capabilities say `terminal: "none"`, so the browser offers no button, and
   * a frame that arrives anyway is answered with the reason.
   */
  async #focusTerminal(worktree: string): Promise<void> {
    if (!this.#sessions.has(worktree)) {
      this.#error(`could not bring the terminal forward: no session is reporting in from ${this.#label(worktree)}`);
      return;
    }
    const launcher = this.#launcher;
    if (launcher === null) {
      this.#error(
        "could not bring the terminal forward: herdr is not running here, so Shape cannot reach a session's terminal",
      );
      return;
    }
    try {
      await launcher.focusCwd(worktree);
    } catch (err) {
      this.#error(`could not bring the terminal forward: ${errText(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // reality layer (per worktree: HEADs differ)
  // -------------------------------------------------------------------------

  #gitHead(cwd: string): Promise<string | null> {
    const { promise, resolve: settle } = Promise.withResolvers<string | null>();
    execFile("git", ["rev-parse", "HEAD"], { cwd }, (err, stdout) => {
      settle(err !== null ? null : stdout.trim() || null);
    });
    return promise;
  }

  /**
   * One extraction for the variation the agent opens on, so the reality layer
   * is present from minute zero (it also answers `targetHasCode`). The layers
   * themselves travel in `attach`, not in a frame of their own. Returns whether
   * any package was found.
   */
  async #startupReality(worktree: string): Promise<boolean> {
    try {
      const layer = await extractReality(worktree);
      this.#realities.set(worktree, { layer, head: layer.head ?? (await this.#gitHead(worktree)) });
      console.error(`[bridge] reality at startup: ${layer.nodes.length} package(s)`);
      return layer.nodes.length > 0;
    } catch (err) {
      console.error(`[bridge] startup reality extraction failed: ${String(err)}`);
      return false;
    }
  }

  /** One worktree's HEAD moved while its session was idle: re-derive and ship it. */
  async #refreshReality(worktree: string): Promise<void> {
    if (this.#realityBusy.has(worktree)) return;
    this.#realityBusy.add(worktree);
    try {
      const head = await this.#gitHead(worktree);
      if (head === null || head === this.#realities.get(worktree)?.head) return;
      const layer = await extractReality(worktree);
      this.#realities.set(worktree, { layer, head });
      this.#post({ type: "reality", worktree, reality: layer, head });
      console.error(
        `[bridge] reality on ${this.#label(worktree)} refreshed at ${head.slice(0, 8)} (${layer.nodes.length} packages)`,
      );
    } catch (err) {
      console.error(`[bridge] reality refresh failed: ${String(err)}`);
    } finally {
      this.#realityBusy.delete(worktree);
    }
  }

  /**
   * `extract_reality`: the server asked, so the layer goes out unconditionally.
   * A variation with no session is still a real directory — the room may want
   * its reality to draw drift on a canvas nobody is working in.
   */
  async #extractRealityNow(worktree: string): Promise<void> {
    if (worktreeContaining(this.#worktrees, worktree) === null) {
      this.#error(`extract_reality rejected: ${worktree} is not a variation of ${basename(this.#projectCwd)}`);
      return;
    }
    try {
      const layer = await extractReality(worktree);
      const head = layer.head ?? (await this.#gitHead(worktree));
      this.#realities.set(worktree, { layer, head });
      this.#post({ type: "reality", worktree, reality: layer, head });
    } catch (err) {
      this.#error(`reality extraction failed: ${String(err)}`);
    }
  }
}
