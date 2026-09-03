/**
 * The agent half of Shape: everything that needs the harness, the target
 * repo's filesystem, git, `ps` or a tty. It owns the backend lifecycle, the
 * reality extraction, worktrees/session discovery, the terminal pane's child
 * and the loopback link; it owns no canvas state at all.
 *
 * It talks to a Shape server over one `AgentEnd` (`transport.ts`) in Link v2
 * frames: `attach` first, then events and answers to the server's requests.
 * In local mode the other end is a `ProjectRoom` in this same process, which
 * is why every stderr line here still says `[bridge]`.
 *
 * Two rules shape the code:
 * - ONE `BackendEvents` sink for the runtime's whole life. The native adapter
 *   and the loopback link (hooks, MCP, sidecars) must land in the same place,
 *   or a hook-driven harness would lose its transcript and activity.
 * - Outbound frames queue until the server has answered `attached` for the
 *   current attach. Claude Code fires SessionStart within a second of coming
 *   up, well before the room exists; those frames are not allowed to vanish.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { CANVAS_TOOL_DESCRIPTION, CANVAS_TOOL_SCHEMA, LINK_WS_PATH } from "../../../shared/src/index.ts";
import type {
  BackendInfo,
  DiscoveredSession,
  RealityLayer,
  WorktreeInfo,
} from "../../../shared/src/index.ts";
import type { AgentSession, AgentToServerMsg, ServerToAgentMsg } from "../../../shared/src/link.ts";
import type { AgentEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import { KNOWN_BACKENDS, createBackend, loadShapeConfig } from "./backend/index.ts";
import type { Backend, BackendEvents } from "./backend/types.ts";
import { discoverSessions } from "./discover.ts";
import { mountLoopbackLink, type LoopbackLink } from "./link.ts";
import { SKIP_DIRS, hasSourceCode, synthesizeSkeleton } from "./onboarding-fs.ts";
import { PtyManager, isPtyMsg } from "./pty.ts";
import { extractReality, gitFileIndex } from "./reality.ts";
import { pushRecent } from "./recents.ts";
import { ensureGitExclude, listWorktrees } from "./worktrees.ts";

/** an empty layer keeps `synthesizeSkeleton` honest before the first extraction */
const NO_REALITY: RealityLayer = { nodes: [], edges: [], extractedAt: null, head: null };

/** fs walk bounds for `file_index` on a non-git target: a big repo, not a whole disk */
const MAX_WALK_FILES = 20_000;
const MAX_WALK_DIRS = 5_000;

export interface AgentRuntimeOptions {
  cwd: string;
  /** `--backend <id>`: beats both config files */
  backend?: string;
  /** `--omp "<cmd ...>"`: replaces the omp adapter's command */
  ompCommand?: string[];
  /** the runtime mounts the loopback link (`/link`) here in start() */
  sockets: SocketServer;
  link: AgentEnd;
  /** the harness died or a retarget failed; the caller decides what the process does */
  onExit: (reason: string) => void;
}

/** Backend failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The room key: stable across restarts, independent of how the path was typed.
 * Machine name is in it because two checkouts at the same path on two laptops
 * are two projects.
 */
async function projectKey(cwd: string): Promise<string> {
  const real = await realpath(cwd).catch(() => cwd);
  return createHash("sha256").update(`${hostname()}:${real}`).digest("hex");
}

/**
 * `file_index` for a target git cannot describe. Bounded because the answer
 * only has to be good enough to validate codeRefs against; symlinked
 * directories are left out rather than followed into a cycle.
 */
async function walkFileIndex(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const queue: string[] = [""];
  let dirs = 0;
  while (queue.length > 0 && files.length < MAX_WALK_FILES && dirs < MAX_WALK_DIRS) {
    const rel = queue.shift();
    if (rel === undefined) break;
    dirs++;
    let entries;
    try {
      entries = await readdir(rel === "" ? cwd : join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // posix separators throughout: these paths are matched against codeRefs,
      // which are written by hand and always posix
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        // dot directories other than these are kept: git tracks .github and
        // friends, and the index has to agree with what an agent can reference
        if (SKIP_DIRS[entry.name] !== true) queue.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(child);
      if (files.length >= MAX_WALK_FILES) break;
    }
  }
  return files;
}

export class AgentRuntime {
  readonly #sockets: SocketServer;
  readonly #link: AgentEnd;
  readonly #onExit: (reason: string) => void;
  /** `--backend`, kept for every re-create: an adopt overrides it per switch */
  readonly #cliBackend: string | undefined;
  readonly #cliOmpCommand: string[] | undefined;

  /** current target project; changed by `switch`/`adopt` */
  #cwd: string;
  /** sha256 of machine + realpath(cwd); re-derived per target in #openProject */
  #projectKey = "";
  /** the harness we drive; re-created per target project */
  #backend: Backend | null = null;
  /** wire projection of `#backend`; assigned with it in #createBackend */
  #backendInfo!: BackendInfo;
  /** see the file header: one sink for the runtime's whole life */
  readonly #events: BackendEvents = this.#backendEvents();
  /** shared project shell; retargeted, never re-created, across switches */
  readonly #pty: PtyManager;
  #loopback: LoopbackLink | null = null;

  #session: AgentSession = { sessionId: null, sessionName: null, model: null };
  #targetHasCode = false;
  #worktrees: WorktreeInfo[] = [];
  #sessions: DiscoveredSession[] = [];
  #recents: string[] = [];
  #reality: RealityLayer | null = null;
  #realityHead: string | null = null;
  #realityBusy = false;

  /** the server's preamble, from `attached`; prepended to the first fresh prompt */
  #preamble = "";
  #promptSent = false;
  /**
   * Delivery, retarget and adopt are serialized: two prompts racing an idle
   * session would have the second one judged against a state that no longer
   * holds, and a retarget must never land mid-delivery.
   */
  #delivering: Promise<void> = Promise.resolve();

  /** false while frames wait for `attached`; see the file header */
  #outboxOpen = false;
  #queue: AgentToServerMsg[] = [];
  #attachGate = Promise.withResolvers<void>();

  /** pending canvas calls (native host tool and loopback), by frame id */
  readonly #calls = new Map<string, (result: { text: string; isError: boolean }) => void>();
  #callSeq = 0;
  #stopped = false;

  constructor(opts: AgentRuntimeOptions) {
    this.#sockets = opts.sockets;
    this.#link = opts.link;
    this.#onExit = opts.onExit;
    this.#cliBackend = opts.backend;
    this.#cliOmpCommand = opts.ompCommand;
    this.#cwd = opts.cwd;
    // the pane exists before the harness starts: a backend with its own TUI is
    // attached to it the moment it comes up
    this.#pty = new PtyManager({ cwd: opts.cwd, broadcast: (msg) => this.#post(msg) });
  }

  /**
   * Bring the agent up: link endpoint, config, harness, project facts, then
   * `attach`. The order matters — the link is mounted first so a hook that
   * fires during backend startup finds somebody listening, and `attach` goes
   * last so the hello it triggers already carries the harness session.
   */
  async start(): Promise<void> {
    this.#link.onMessage((msg) => this.#onServerMsg(msg));
    this.#link.onClose(() => void this.#teardown());
    this.#loopback = mountLoopbackLink(this.#sockets, {
      onCanvasCall: (args) => this.#canvasCall(args),
      events: this.#events,
    });
    await this.#createBackend();
    await this.#openProject();
    await this.#startBackend();
    this.#sendAttach();
    await this.#attachGate.promise;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    // the room goes agentless on this frame, so it leaves before the sockets do
    this.#link.send({ type: "detached", reason: "agent stopped" });
    await this.#teardown();
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective config for `#cwd` (user config, then the project's,
   * then CLI flags) and instantiate its backend. An unknown id is a startup
   * error naming the ones we know.
   */
  async #createBackend(backendOverride?: string): Promise<void> {
    const config = await loadShapeConfig({
      cwd: this.#cwd,
      // an adopt names the harness it found; otherwise the CLI flag decides
      backend: backendOverride ?? this.#cliBackend,
      ompCommand: this.#cliOmpCommand,
    });
    const backend = createBackend(config.backend, config);
    this.#backend = backend;
    this.#backendInfo = { id: backend.id, label: backend.label, capabilities: backend.capabilities };
  }

  /** Everything about `#cwd` the server cannot see for itself. */
  async #openProject(): Promise<void> {
    this.#projectKey = await projectKey(this.#cwd);
    const hasPackages = await this.#startupReality();
    this.#targetHasCode = hasPackages || (await hasSourceCode(this.#cwd));
    this.#session = { sessionId: null, sessionName: null, model: null };
    this.#worktrees = await listWorktrees(this.#cwd);
    await ensureGitExclude(this.#cwd);
    this.#recents = await pushRecent(this.#cwd);
    this.#sessions = await this.#discoverSessions();
  }

  /** Start the harness in `#cwd`, register the canvas tool, prime session state. */
  async #startBackend(resumeSessionId?: string): Promise<void> {
    const backend = this.#backend;
    if (backend === null) throw new Error("bridge: no backend to start");
    await backend.start({
      cwd: this.#cwd,
      events: this.#events,
      canvasTool: { description: CANVAS_TOOL_DESCRIPTION, schema: CANVAS_TOOL_SCHEMA },
      // harness-side processes reach US, never the server
      bridgeUrl: this.#sockets.url(LINK_WS_PATH),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    });
    // a harness with its own TUI owns the terminal pane; everything else gets a shell
    this.#pty.attach(backend.terminal?.() ?? null);
    try {
      const state = await backend.state();
      this.#session = { sessionId: state.sessionId, sessionName: state.sessionName, model: state.model };
    } catch (err) {
      console.error(`[bridge] ${errText(err)}`);
    }
  }

  /**
   * Announce the current project. A second `attach` on the same link is a
   * retarget: the server replaces the room's project and re-hellos its
   * browsers, which is how a switch reaches the canvas.
   */
  #sendAttach(): void {
    this.#outboxOpen = false;
    this.#attachGate = Promise.withResolvers<void>();
    // never queued: this frame is what opens the queue
    this.#link.send({
      type: "attach",
      project: {
        key: this.#projectKey,
        label: basename(this.#cwd),
        cwd: this.#cwd,
        backend: this.#backendInfo,
        targetHasCode: this.#targetHasCode,
      },
      session: this.#session,
      reality: this.#reality,
      worktrees: this.#worktrees,
      sessions: this.#sessions,
      recentProjects: this.#recents,
    });
  }

  async #teardown(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const backend = this.#backend;
    this.#backend = null;
    // the harness's TUI dies with it; the pane must not be left pointing at it
    this.#pty.attach(null);
    if (backend !== null) await backend.dispose();
    this.#pty.dispose();
    this.#loopback?.close();
  }

  // -------------------------------------------------------------------------
  // harness -> server
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

  /** An adapter failure worth showing the user; the server logs and broadcasts it. */
  #error(message: string): void {
    this.#post({ type: "agent_error", message });
  }

  #backendEvents(): BackendEvents {
    return {
      onAgentState: (state) => {
        // idle IS the end of a turn: the reality layer is worth re-deriving
        if (state === "idle") void this.#refreshReality();
        this.#post({ type: "agent_event", event: { kind: "state", state } });
      },
      onAssistantText: (text) => this.#post({ type: "agent_event", event: { kind: "text", text } }),
      onToolStart: (call) =>
        this.#post({
          type: "agent_event",
          event: { kind: "tool_start", name: call.name, paths: call.paths, summary: call.summary },
        }),
      onToolEnd: (info) =>
        this.#post({ type: "agent_event", event: { kind: "tool_end", name: info.name, isError: info.isError } }),
      onTurnEnd: () => this.#post({ type: "agent_event", event: { kind: "turn_end" } }),
      onCanvasCall: (args) => this.#canvasCall(args),
      // hook-driven adapters cannot answer this from `state()`: only the harness
      // knows which session it is on, and it tells us, not the adapter
      onSession: (info) => {
        this.#session = {
          ...this.#session,
          sessionId: info.sessionId ?? this.#session.sessionId,
          model: info.model ?? this.#session.model,
        };
        this.#post({
          type: "agent_event",
          event: { kind: "session", sessionId: info.sessionId, model: info.model },
        });
      },
      onExit: (reason) => {
        this.#post({ type: "agent_exit", reason });
        this.#onExit(reason);
      },
      onError: (message) => this.#error(message),
    };
  }

  /**
   * Hand a canvas call to the server and wait for its result. Both callers —
   * the harness's native host tool and the loopback link — go through here, so
   * one counter is enough to correlate every answer.
   */
  #canvasCall(args: unknown): Promise<{ text: string; isError: boolean }> {
    const id = `call-${++this.#callSeq}`;
    const { promise, resolve: settle } = Promise.withResolvers<{ text: string; isError: boolean }>();
    this.#calls.set(id, settle);
    this.#post({ type: "canvas_call", id, args });
    return promise;
  }

  /**
   * Agent sessions worth adopting: everything running on this machine except
   * the harness children Shape itself spawned (adopting our own child would be
   * a loop).
   */
  async #discoverSessions(): Promise<DiscoveredSession[]> {
    try {
      return (await discoverSessions()).filter((session) => !session.spawnedByShape);
    } catch (err) {
      console.error(`[bridge] session discovery failed: ${errText(err)}`);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // server -> harness
  // -------------------------------------------------------------------------

  #onServerMsg(msg: ServerToAgentMsg): void {
    if (isPtyMsg(msg)) {
      // the terminal is its own channel: never queued behind agent delivery
      this.#pty.handle(msg);
      return;
    }
    switch (msg.type) {
      case "attached":
        this.#preamble = msg.preamble;
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
      case "deliver": {
        const { id, body } = msg;
        this.#delivering = this.#delivering.then(() => this.#deliver(id, body));
        return;
      }
      case "abort": {
        // aborts must not queue behind an in-flight delivery
        const backend = this.#backend;
        if (backend === null) return;
        backend.abort().catch((err: unknown) => this.#error(errText(err)));
        return;
      }
      case "switch": {
        const { path, backend, resumeSessionId } = msg;
        this.#delivering = this.#delivering.then(() =>
          this.#switchProject(path, {
            ...(backend === undefined ? {} : { backend }),
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
          }),
        );
        return;
      }
      case "adopt": {
        const { pid } = msg;
        this.#delivering = this.#delivering.then(() => this.#adopt(pid));
        return;
      }
      case "discover": {
        // read-only scan: must not queue behind an in-flight delivery
        const { id } = msg;
        void this.#discoverSessions().then((sessions) => {
          this.#sessions = sessions;
          this.#post({ type: "sessions", id, sessions });
        });
        return;
      }
      case "list_worktrees": {
        const { id } = msg;
        void listWorktrees(this.#cwd).then((worktrees) => {
          this.#worktrees = worktrees;
          this.#post({ type: "worktrees", id, worktrees });
        });
        return;
      }
      case "extract_reality":
        void this.#extractRealityNow();
        return;
      case "file_index": {
        const { id } = msg;
        void this.#fileIndex(id);
        return;
      }
      case "synthesize_skeleton": {
        const { id } = msg;
        void synthesizeSkeleton(this.#cwd, this.#reality ?? NO_REALITY).then((ops) =>
          this.#post({ type: "skeleton_result", id, ops }),
        );
        return;
      }
    }
  }

  /**
   * Steer into a running turn when the backend can; otherwise the message goes
   * as a prompt and the harness picks it up when the turn ends. The first
   * prompt of a harness session carries the server's preamble. The receipt goes
   * out before the send: it is what the server writes the "queued" line from.
   */
  async #deliver(id: string, body: string): Promise<void> {
    const backend = this.#backend;
    if (backend === null) return;

    let streaming = false;
    try {
      streaming = (await backend.state()).streaming;
    } catch (err) {
      this.#error(errText(err));
    }

    const mode: "prompt" | "steer" = backend.capabilities.steerMidTurn && streaming ? "steer" : "prompt";
    const message = streaming || this.#promptSent ? body : `${this.#preamble}${body}`;
    if (!streaming) this.#promptSent = true;
    this.#post({ type: "delivered", id, mode, queued: mode === "prompt" && streaming });

    try {
      await backend.send(message, mode);
    } catch (err) {
      this.#error(errText(err));
    }
  }

  /**
   * Retarget at another project: stop the current harness, re-read config,
   * re-open the new project, start a fresh backend, re-`attach`. The terminal
   * follows the new target.
   *
   * `opts.backend` is an adopt naming the harness it found (it beats config for
   * this target); `opts.resumeSessionId` continues that harness's session
   * instead of opening a fresh one.
   */
  async #switchProject(rawPath: string, opts?: { backend?: string; resumeSessionId?: string }): Promise<void> {
    const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
    const target = resolve(expanded);
    if (!(await isDirectory(target))) {
      this.#error(`switch_project rejected: "${rawPath}" is not an existing directory`);
      return;
    }
    // an adopt of a session in the current target still has work to do: the
    // backend itself changes, so only a plain switch can short-circuit
    if (target === this.#cwd && opts?.backend === undefined) {
      this.#sendAttach();
      return;
    }

    try {
      const old = this.#backend;
      this.#backend = null;
      // the old harness's TUI dies with it; the pane goes back to a shell
      this.#pty.attach(null);
      if (old !== null) await old.dispose();

      this.#cwd = target;
      this.#pty.retarget(target);
      this.#promptSent = false; // a new session earns the preamble again
      this.#reality = null;
      this.#realityHead = null;
      // frames from the new harness belong to a room the server has not opened
      // yet: they wait for the `attached` that answers the attach below
      this.#outboxOpen = false;

      // config is per-project: the new target may name a different backend
      await this.#createBackend(opts?.backend);
      await this.#openProject();
      await this.#startBackend(opts?.resumeSessionId);
      this.#sendAttach();
      console.error(`[bridge] switched target to ${target}`);
    } catch (err) {
      // no `attached` is coming for a switch that died: the queued frames
      // belong to a harness that never attached, and the only thing worth
      // delivering is why
      this.#queue = [];
      this.#outboxOpen = true;
      const reason = `switch_project failed: ${String(err)}`;
      this.#error(reason);
      this.#onExit(reason);
    }
  }

  /**
   * Adopt a session someone else started. The pid is resolved in a FRESH scan
   * (the server's list is as old as its last discover), the harness id IS the
   * backend id, and a session with an id is resumed rather than restarted.
   */
  async #adopt(pid: number): Promise<void> {
    const session = (await this.#discoverSessions()).find((candidate) => candidate.pid === pid);
    if (session === undefined) {
      this.#error(`adopt rejected: no running agent session with pid ${pid}`);
      return;
    }
    if (session.cwd === null) {
      this.#error(`adopt rejected: the working directory of pid ${pid} could not be read`);
      return;
    }
    if (!KNOWN_BACKENDS.includes(session.harness)) {
      this.#error(`no Shape adapter for ${session.harness} yet`);
      return;
    }
    console.error(
      `[bridge] adopting ${session.harness} pid ${pid} in ${session.cwd}` +
        (session.sessionId === null ? " (no session id: fresh start)" : ` (resume ${session.sessionId})`),
    );
    await this.#switchProject(session.cwd, {
      backend: session.harness,
      ...(session.sessionId === null ? {} : { resumeSessionId: session.sessionId }),
    });
  }

  /**
   * Every file an agent may point a codeRef at. Git is the truth where there is
   * one; otherwise the fs walk stands in for it.
   */
  async #fileIndex(id: string): Promise<void> {
    const index = await gitFileIndex(this.#cwd);
    const files = index === null ? await walkFileIndex(this.#cwd) : [...index.files];
    this.#post({ type: "file_index", id, files });
  }

  // -------------------------------------------------------------------------
  // reality layer
  // -------------------------------------------------------------------------

  #gitHead(): Promise<string | null> {
    const { promise, resolve: settle } = Promise.withResolvers<string | null>();
    execFile("git", ["rev-parse", "HEAD"], { cwd: this.#cwd }, (err, stdout) => {
      settle(err !== null ? null : stdout.trim() || null);
    });
    return promise;
  }

  /**
   * One extraction per project open, so the reality layer is present from
   * minute zero (it also answers `targetHasCode` for TS workspaces). The layer
   * itself travels in `attach`, not in a frame of its own. Returns whether any
   * package was found.
   */
  async #startupReality(): Promise<boolean> {
    try {
      const reality = await extractReality(this.#cwd);
      this.#reality = reality;
      this.#realityHead = reality.head ?? (await this.#gitHead());
      console.error(`[bridge] reality at startup: ${reality.nodes.length} package(s)`);
      return reality.nodes.length > 0;
    } catch (err) {
      console.error(`[bridge] startup reality extraction failed: ${String(err)}`);
      this.#reality = null;
      return false;
    }
  }

  /** HEAD moved while the agent was idle: re-derive and ship the layer. */
  async #refreshReality(): Promise<void> {
    if (this.#realityBusy) return;
    this.#realityBusy = true;
    try {
      const head = await this.#gitHead();
      if (head === null || head === this.#realityHead) return;
      const reality = await extractReality(this.#cwd);
      this.#reality = reality;
      this.#realityHead = head;
      this.#post({ type: "reality", reality, head });
      console.error(`[bridge] reality refreshed at ${head.slice(0, 8)} (${reality.nodes.length} packages)`);
    } catch (err) {
      console.error(`[bridge] reality refresh failed: ${String(err)}`);
    } finally {
      this.#realityBusy = false;
    }
  }

  /** `extract_reality`: the server asked, so the layer goes out unconditionally. */
  async #extractRealityNow(): Promise<void> {
    try {
      const reality = await extractReality(this.#cwd);
      this.#reality = reality;
      this.#realityHead = reality.head ?? (await this.#gitHead());
      this.#post({ type: "reality", reality, head: this.#realityHead });
    } catch (err) {
      this.#error(`reality extraction failed: ${String(err)}`);
    }
  }
}
