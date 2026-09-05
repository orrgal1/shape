/**
 * The agent half of Shape: everything that needs the target repo's
 * filesystem, git, `ps` or the user's terminal. It watches the sessions
 * running in the repo's worktrees, extracts the reality layer, lists
 * worktrees and discoverable sessions, and terminates the loopback link; it
 * owns no canvas state at all.
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
 * ONE AGENT, ONE REPO, N WORKTREES. All the worktrees of a repo are one
 * project (one key, one canvas), and each of them may have a session
 * reporting in — `#sessions`, keyed by worktree id (the realpath of its
 * directory). Everything that is about one variation is stamped with that id
 * on the way out and routed by it on the way in: events, canvas calls,
 * reality. `switch` only ever means "another repo"; a path inside this one is
 * already on the canvas, so it only refreshes the worktree list.
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

import { execFile, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { LINK_WS_PATH } from "../../../shared/src/index.ts";
import type {
  AgentState,
  BackendInfo,
  DiscoveredSession,
  ManagerHandle,
  RealityLayer,
  WorktreeInfo,
} from "../../../shared/src/index.ts";
import type {
  AgentSession,
  AgentToServerMsg,
  ServerToAgentMsg,
  WorktreeSession,
} from "../../../shared/src/link.ts";
import type { AgentEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import { detectTools, type DetectedTools } from "./detect.ts";
import { LINK_CLI, directivePath, renderDirective, writeDirective } from "./directive.ts";
import { discoverSessions } from "./discover.ts";
import type { AgentEvents, LinkHello, LinkTarget } from "./external.ts";
import type { HerdrLauncher } from "./launcher/herdr.ts";
import { chooseLauncher } from "./launcher/index.ts";
import { mountLoopbackLink, type LoopbackLink } from "./link.ts";
import { attachManager } from "./manager.ts";
import { hasSourceCode, synthesizeSkeleton } from "./onboarding-fs.ts";
import { extractReality } from "./reality.ts";
import { pushRecent } from "./recents.ts";
import { ensureGitExclude, legacyProjectKey, listWorktrees, projectKey, repoIdentity } from "./worktrees.ts";

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
 * The command that opens the folder chooser, when a smoke (or an operator on a
 * machine whose desktop Shape guesses wrong) names one: whitespace-split and
 * run without a shell, exactly like the platform commands below. Its stdout is
 * the chosen path and exit 1 is a cancel, so a smoke can stand in for a person.
 */
const PICK_FOLDER_OVERRIDE = pickFolderOverride();

function pickFolderOverride(): { command: string; args: string[] } | null {
  const [command, ...args] = (process.env.SHAPE_PICK_FOLDER ?? "").split(/\s+/).filter((part) => part.length > 0);
  return command === undefined ? null : { command, args };
}

/** the Windows chooser, as a one-liner PowerShell hands to a WinForms dialog */
const PICK_FOLDER_PS =
  "Add-Type -AssemblyName System.Windows.Forms; " +
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
  "$d.Description = 'Open a project in Shape'; " +
  "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath } else { exit 1 }";

/**
 * macOS: an `NSOpenPanel` driven from JXA. AppleScript's `choose folder` from a
 * background process opens its panel BEHIND every window — osascript is a
 * UIElement and `tell me to activate` cannot raise it (seen live: the panel sat
 * unseen for ten minutes). Going through Finder (`tell application "Finder"`)
 * would raise it, but needs an Automation permission grant, so the user meets
 * a system prompt before their chooser. Becoming a regular app for the
 * duration and `activateIgnoringOtherApps` needs nothing and comes to the
 * front. Cancel exits 1 and prints nothing; the path is the only output.
 */
const PICK_FOLDER_JXA = [
  'ObjC.import("Cocoa"); ObjC.import("stdlib");',
  "const app = $.NSApplication.sharedApplication;",
  "app.setActivationPolicy($.NSApplicationActivationPolicyRegular);",
  "app.activateIgnoringOtherApps(true);",
  "const panel = $.NSOpenPanel.openPanel;",
  "panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false;",
  'panel.message = "Open a project in Shape"; panel.prompt = "Open";',
  'panel.directoryURL = $.NSURL.fileURLWithPath($("~").stringByExpandingTildeInPath);',
  "if (panel.runModal() !== $.NSModalResponseOK) $.exit(1);",
  "ObjC.unwrap(panel.URLs.objectAtIndex(0).path);",
].join(" ");

/**
 * How each desktop asks a person for a folder. The dialog belongs on THIS side
 * of the wire: no browser API yields an absolute path, and a path chosen on any
 * other machine would name nothing here.
 */
function folderChooser(platform: string): { command: string; args: string[] } | null {
  if (platform === "darwin") return { command: "osascript", args: ["-l", "JavaScript", "-e", PICK_FOLDER_JXA] };
  if (platform === "linux") {
    return { command: "zenity", args: ["--file-selection", "--directory", "--title=Open a project in Shape"] };
  }
  if (platform === "win32") return { command: "powershell", args: ["-NoProfile", "-Command", PICK_FOLDER_PS] };
  return null;
}

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
   * The directory to open. Any worktree of the repo will do: the project is
   * the repo, and this is the variation the agent stands in.
   */
  cwd: string;
  /** the runtime mounts the loopback link (`/link`) here in start() */
  sockets: SocketServer;
  link: AgentEnd;
  /** a retarget failed and there is nowhere to stand; the caller decides what the process does */
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class AgentRuntime {
  readonly #sockets: SocketServer;
  readonly #link: AgentEnd;
  readonly #onExit: (reason: string) => void;

  /** the directory the agent was pointed at; changed by a retarget */
  #cwd: string;
  /** the MAIN worktree — the project's cwd, label and storage anchor */
  #projectCwd = "";
  /** sha256 of machine + the repo's common dir: every worktree shares it */
  #projectKey = "";
  /** the worktree `#cwd` sits in */
  #primary = "";
  /**
   * What is installed here, detected once at startup and again on `discover`.
   * Project-wide: one agent process sees one PATH.
   */
  #tools: DetectedTools = { launchers: [], harnesses: [] };
  /**
   * The user's terminal multiplexer, when there is one. It is how a session's
   * tab is brought forward and where the project's manager lives; null means
   * no session here has a terminal Shape can reach.
   */
  #launcher: HerdrLauncher | null = null;

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

  #loopback: LoopbackLink | null = null;
  #targetHasCode = false;
  #discovered: DiscoveredSession[] = [];
  #recents: string[] = [];
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

  /**
   * Retargeting is serialized: two switches racing would leave the agent
   * standing in one repo while everything it has told the room describes the
   * other.
   */
  #retargeting: Promise<void> = Promise.resolve();
  /**
   * The folder chooser standing in front of the user right now. Deliberately
   * NOT on `#retargeting`: a dialog is open for as long as a person browses,
   * and nothing else may queue behind that. One at a time — one machine has
   * one user in front of it.
   */
  #picking: ChildProcess | null = null;

  /** false while frames wait for `attached`; see the file header */
  #outboxOpen = false;
  #queue: AgentToServerMsg[] = [];
  /**
   * One-shot: resolved by the first `attached` (or by a stop, so a signal
   * handler firing while we still wait for a server that never comes is not a
   * hang). Re-attaches after a retarget or a reconnect do not reopen it —
   * nothing awaits it once start() has returned.
   */
  readonly #attachGate = Promise.withResolvers<void>();

  /** pending canvas calls, by frame id */
  readonly #calls = new Map<string, (result: { text: string; isError: boolean }) => void>();
  #callSeq = 0;
  #stopped = false;

  constructor(opts: AgentRuntimeOptions) {
    this.#sockets = opts.sockets;
    this.#link = opts.link;
    this.#onExit = opts.onExit;
    this.#cwd = opts.cwd;
  }

  /**
   * Bring the agent up: link endpoint, what is installed, the user's terminal
   * multiplexer, the project's facts, then `attach`.
   *
   * The order matters — the loopback link is mounted first so a session that
   * greets (or a hook that fires) during startup finds somebody listening, and
   * `attach` goes last so the hello it triggers already carries whatever has
   * reported in. A startup opens no session at all: the project is attached
   * with the sessions that happen to be there, which is usually none, and the
   * canvas shows the repo either way.
   */
  async start(): Promise<void> {
    this.#link.onMessage((msg) => this.#onServerMsg(msg));
    this.#link.onClose(() => void this.#teardown());
    this.#link.onDisconnect((reason) => this.#onLinkGap(reason));
    this.#link.onReconnect(() => this.#onLinkBack());
    this.#loopback = mountLoopbackLink(this.#sockets, { route: (cwd) => this.#routeLink(cwd) });
    this.#tools = await detectTools();
    this.#launcher = await chooseLauncher(this.#tools);
    console.error(
      `[bridge] terminal: ${this.#launcher === null ? "none" : "herdr"}; harnesses here: ${this.#tools.harnesses.map((tool) => tool.id).join(", ") || "none"}`,
    );
    await this.#openProject();
    // the config the manager pass writes is what every builder the manager
    // launches later comes up with, so it is written before anything reports in
    await this.#attachManager();
    this.#sendAttach();
    await this.#attachGate.promise;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    // the room goes agentless on this frame, so it leaves before the sockets do
    this.#link.send({ type: "detached", reason: "agent stopped" });
    await this.#teardown();
    // a socket-backed end would otherwise keep reconnecting to a server that
    // has nothing left to talk to
    this.#link.close("agent stopped");
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
   * worktree whichever variation the agent was pointed at.
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
    this.#primary = this.#worktreeFor(await this.#realpath(this.#cwd)) ?? identity.main;

    // both are answers about the OLD project
    this.#realities.clear();
    this.#linkRoutes.clear();
    const hasPackages = await this.#startupReality(this.#primary);
    this.#targetHasCode = hasPackages || (await hasSourceCode(this.#primary));
    await ensureGitExclude(this.#cwd);
    this.#recents = await pushRecent(this.#projectCwd);
    this.#discovered = await this.#discoverSessions();
    await this.#writeDirective();
  }

  /**
   * Drop this project's directive on disk, so a session Shape never registered
   * a tool in can still find the canvas. Called from every `#openProject` —
   * startup and every `switch` — which is also how it keeps up with the link
   * URL: the URL is fixed for this process (the socket server's port is set at
   * construction), so the only way it changes is a new agent, whose first
   * `#openProject` rewrites the file. `writeDirective` skips an identical
   * write, so re-opening the same project costs a read.
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
   * Find or open this project's manager (issue #3, `./manager.ts`). Runs after
   * `#openProject`, because the directive it points the manager's builders at
   * is written there.
   *
   * This is the ONE session Shape opens rather than observes, and it is a
   * manager, not a worker: it reads the manager skill and dispatches builders
   * into their own worktrees, each of which reports in on its own.
   *
   * `attachManager` reports every failure itself and answers null, so there is
   * nothing to catch: a project without a manager still has a canvas.
   */
  async #attachManager(): Promise<void> {
    this.#manager = await attachManager({ path: this.#projectCwd, label: basename(this.#projectCwd) }, this.#launcher, {
      linkUrl: this.#sockets.url(LINK_WS_PATH),
      directivePath: this.#directivePath,
      // the link's callers spell their cwd however they were started; only the
      // runtime knows how to compare a spelling with a directory
      isLinked: (cwd) => {
        const wanted = this.#canonicalDir(cwd);
        return (this.#loopback?.greeted() ?? []).some((entry) => this.#canonicalDir(entry) === wanted);
      },
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
   * Forget every session Shape was watching. A retarget tells the room about
   * each one — the browsers are still looking at the project being left, and a
   * session on it is no longer being watched — while a teardown says nothing,
   * because the room is going away with us.
   */
  #dropSessions(reason: string | null): void {
    const observed = [...this.#sessions.values()];
    this.#sessions.clear();
    if (reason === null) return;
    for (const entry of observed) this.#post({ type: "session_stopped", worktree: entry.worktree, reason });
  }

  /**
   * Announce the current project. A second `attach` on the same link is a
   * retarget: the server replaces the room's project and re-hellos its
   * browsers, which is how a switch reaches the canvas.
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
        // the project's harness as a picker names it: the first session that
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
      discovered: this.#discovered,
      recentProjects: this.#recents,
    });
  }

  async #teardown(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // start() may still be waiting for an `attached` that will never come now
    this.#attachGate.resolve();
    // a dialog must not outlive the agent that opened it: nothing is left to
    // answer, and the user would be staring at a chooser nobody reads
    this.#picking?.kill();
    this.#dropSessions(null);
    this.#loopback?.close();
  }

  // -------------------------------------------------------------------------
  // worktree identity
  // -------------------------------------------------------------------------

  async #realpath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return resolve(path);
    }
  }

  /**
   * Which worktree a path belongs to: the deepest known worktree that contains
   * it, or null for a path outside the repo. Compared as realpaths, which is
   * what a worktree id is — `resolve()` alone would make `/tmp` and
   * `/private/tmp` two different variations on macOS.
   */
  #worktreeFor(realpathOfDir: string): string | null {
    let best: string | null = null;
    for (const { id } of this.#worktrees) {
      if (realpathOfDir !== id && !realpathOfDir.startsWith(`${id}${sep}`)) continue;
      if (best === null || id.length > best.length) best = id;
    }
    return best;
  }

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
   * Canonical form of a directory a caller named, for prefix matching against
   * worktree ids (which are always realpaths).
   *
   * The deepest EXISTING ancestor is what gets resolved: a caller may name a
   * directory that no longer exists (a removed worktree, a path built by hand),
   * and its ancestors still say which repo it was in. Matching stops at a
   * worktree root anyway, so dropping the unresolvable tail cannot change the
   * answer.
   */
  #canonicalDir(cwd: string): string {
    const asked = resolve(cwd);
    let path = asked;
    for (;;) {
      try {
        return realpathSync(path);
      } catch {
        const parent = dirname(path);
        // nothing on the way to the root exists: judge it by its spelling
        if (parent === path) return asked;
        path = parent;
      }
    }
  }

  /**
   * Route a loopback caller (the harness's own extension, a hook, an MCP
   * sidecar) to the worktree it belongs to, by the directory it reports
   * running in: the deepest worktree containing it wins. A worktree of this
   * repo with nothing on record yet GAINS a session here — a caller speaking
   * from it is the only evidence Shape ever gets that one exists.
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
  #routeLink(cwd: string): LinkTarget | { error: string } {
    let resolved = this.#linkRoutes.get(cwd);
    if (resolved === undefined) {
      resolved = this.#worktreeFor(this.#canonicalDir(cwd));
      // a caller inventing paths must not grow this without bound
      if (this.#linkRoutes.size >= MAX_LINK_ROUTES) this.#linkRoutes.clear();
      this.#linkRoutes.set(cwd, resolved);
    }
    if (resolved === null) {
      return { error: `${cwd} is not part of ${basename(this.#projectCwd)} — this Shape agent is on ${this.#projectCwd}` };
    }
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

  /** Agent sessions running on this machine, for the adopt picker. */
  async #discoverSessions(): Promise<DiscoveredSession[]> {
    try {
      return await discoverSessions();
    } catch (err) {
      console.error(`[bridge] session discovery failed: ${errText(err)}`);
      return [];
    }
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
        // showing a terminal must not queue behind a retarget: the user is
        // asking to LOOK at something
        void this.#focusTerminal(msg.worktree);
        return;
      case "switch": {
        const { path } = msg;
        this.#retargeting = this.#retargeting.then(() => this.#switchProject(path));
        return;
      }
      case "adopt": {
        const { pid } = msg;
        this.#retargeting = this.#retargeting.then(() => this.#adopt(pid));
        return;
      }
      case "pick_folder":
        // a dialog waits on a person, so it is never put on the retarget
        // chain: nothing may queue behind somebody browsing folders
        this.#pickFolder();
        return;
      case "discover": {
        // read-only scan: must not queue behind a retarget. The tools are
        // re-detected with it — a harness installed since startup is exactly
        // what somebody hitting "look again" is hoping to find.
        const { id } = msg;
        void detectTools().then((tools) => {
          this.#tools = tools;
        });
        void this.#discoverSessions().then((sessions) => {
          this.#discovered = sessions;
          this.#post({ type: "sessions", id, sessions });
        });
        return;
      }
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
        if (this.#worktreeFor(worktree) === null) return;
        const reality = this.#realities.get(worktree)?.layer ?? NO_REALITY;
        void synthesizeSkeleton(worktree, reality).then((ops) =>
          this.#post({ type: "skeleton_result", worktree, id, ops }),
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // terminal and retargeting
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

  /**
   * A path the user pointed Shape at. Inside the current repo it is a
   * VARIATION, not another project: the canvas already holds it and its
   * session (if any) is already being watched, so the only thing that can be
   * out of date is the worktree list. Another repo is the real switch — every
   * observed session is forgotten, the new project is opened and re-`attach`ed.
   *
   * Nothing is started either way. A repo Shape retargets onto shows the
   * sessions that report in from it, which may be none until somebody starts
   * one themselves.
   */
  async #switchProject(rawPath: string): Promise<void> {
    const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
    const target = resolve(expanded);
    if (!(await isDirectory(target))) {
      this.#error(`switch_project rejected: "${rawPath}" is not an existing directory`);
      return;
    }
    const inRepo = this.#worktreeFor(await this.#realpath(target));
    if (inRepo !== null) {
      // a variation the user reaches for may be brand new (a worktree added
      // since the last scan), and the room's list has to catch up
      await this.#refreshWorktrees(null);
      return;
    }

    try {
      this.#dropSessions("agent retargeted");
      this.#cwd = target;
      // frames from the new project belong to a room the server has not opened
      // yet: they wait for the `attached` that answers the attach below
      this.#outboxOpen = false;

      await this.#openProject();
      await this.#attachManager();
      this.#sendAttach();
      console.error(`[bridge] switched target to ${target}`);
    } catch (err) {
      // no `attached` is coming for a switch that died: the queued frames
      // belong to a project that never attached, and the only thing worth
      // saying is why
      this.#queue = [];
      this.#outboxOpen = true;
      const reason = `switch_project failed: ${String(err)}`;
      this.#error(reason);
      this.#onExit(reason);
    }
  }

  /**
   * Adopt a session someone else started: point Shape at the repo it runs in.
   * The pid is resolved in a FRESH scan (the server's list is as old as its
   * last discover), and the switch is the whole of it — Shape does not touch
   * that session. If it is shape-aware it appears on the canvas by itself, the
   * moment it speaks on this agent's link; if it is not, the project is still
   * attached and the directive on disk says how to join.
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
    console.error(`[bridge] adopting the ${session.harness} session of pid ${pid}: switching to ${session.cwd}`);
    await this.#switchProject(session.cwd);
  }

  /**
   * Put the machine's own folder chooser in front of the user and post where
   * it landed. This is the agent's job and not the browser's because no web
   * API hands a page an absolute path — and in local mode this process is on
   * the user's machine, which is the one whose folders they mean.
   *
   * The chooser gets no timeout of its own: a person may browse for minutes,
   * and the room's own timer is the bound. What it does get is a teardown that
   * kills it, so a dialog cannot outlive the agent that opened it. Nothing is
   * retargeted here: the answer goes back and the BROWSER decides what to do
   * with it (it sends `switch_project`, exactly as if the path were typed).
   *
   * A second ask only reaches here once the room gave up on the first (it
   * refuses while its slot is held) — so the dialog still up is one nobody is
   * waiting for, and the newest click is what the user means: the old panel
   * is killed and answers nobody, a fresh one is put up.
   */
  #pickFolder(): void {
    this.#picking?.kill();
    const chooser = PICK_FOLDER_OVERRIDE ?? folderChooser(process.platform);
    if (chooser === null) {
      this.#picking = null;
      this.#error(`pick_folder failed: no folder chooser on ${process.platform} — type the path instead`);
      return;
    }
    const child = execFile(chooser.command, chooser.args, (err, stdout, stderr) => {
      // a chooser killed by the teardown, or replaced by a newer ask, answers
      // nobody
      if (this.#stopped || this.#picking !== child) return;
      this.#picking = null;
      if (err !== null) {
        // Exit 1 with nothing on stderr is how every chooser here says "closed
        // without choosing" — zenity, the PowerShell dialog, the JXA panel and
        // the command a smoke stands in with. osascript exits 1 for a broken
        // script too, but then it says so on stderr, and that is a failure.
        if (err.code === 1 && stderr.trim().length === 0) {
          this.#post({ type: "folder_picked", path: null });
          return;
        }
        if (err.code === "ENOENT") {
          // linux is the one platform whose chooser is not part of the desktop
          this.#error(
            process.platform === "linux" && PICK_FOLDER_OVERRIDE === null
              ? "pick_folder failed: no folder chooser found (install zenity)"
              : `pick_folder failed: ${chooser.command} could not be run`,
          );
          return;
        }
        // a panel somebody killed from outside was closed for the user, not by
        // them: nobody wants an answer, and the browser must not get one
        if (err.signal !== undefined && err.signal !== null) return;
        // node's own message is the whole command line; the user wants the
        // chooser's words, or failing those, how it left
        const said = stderr.trim().split("\n")[0]?.trim() ?? "";
        this.#error(`pick_folder failed: ${said.length > 0 ? said : `the chooser exited with code ${String(err.code)}`}`);
        return;
      }
      // a chooser may end a folder in a slash (AppleScript's `POSIX path of`
      // does); every path Shape carries is written without one. Root is the
      // one path that IS its slash.
      const chosen = stdout.trim();
      const path = chosen.length > 1 && chosen.endsWith("/") ? chosen.slice(0, -1) : chosen;
      if (path.length === 0) {
        this.#error("pick_folder failed: the chooser named no folder");
        return;
      }
      this.#post({ type: "folder_picked", path });
    });
    this.#picking = child;
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
    if (this.#worktreeFor(worktree) === null) {
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
