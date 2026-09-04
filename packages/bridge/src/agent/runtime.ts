/**
 * The agent half of Shape: everything that needs a harness, the target repo's
 * filesystem, git, `ps` or a tty. It owns the harness lifecycle, the reality
 * extraction, worktrees/session discovery, the terminal panes and the loopback
 * link; it owns no canvas state at all.
 *
 * It talks to a Shape server over one `AgentEnd` (`transport.ts`) in Link v2
 * frames: `attach` first, then events and answers to the server's requests.
 * In local mode the other end is a `ProjectRoom` in this same process, which
 * is why every stderr line here still says `[bridge]`.
 *
 * ONE AGENT, ONE REPO, N HARNESSES. All the worktrees of a repo are one
 * project (one key, one canvas), and Shape runs a harness in each worktree the
 * user opens — `#harnesses`, keyed by worktree id (the realpath of its
 * directory). Everything that is about one variation is stamped with that id
 * on the way out and routed by it on the way in: events, canvas calls,
 * deliveries, reality, the terminal pane. `switch` only ever means "another
 * repo"; a path inside this one opens a variation instead.
 *
 * Three rules shape the code:
 * - ONE `BackendEvents` sink per harness, for that harness's whole life. The
 *   native adapter and the loopback link (hooks, MCP, sidecars) must land in
 *   the same place, or a hook-driven harness would lose its transcript and
 *   activity — and they must land in the sink of the worktree they came from,
 *   which is why link callers report their cwd.
 * - Outbound frames queue until the server has answered `attached` for the
 *   current attach. Claude Code fires SessionStart within a second of coming
 *   up, well before the room exists; those frames are not allowed to vanish.
 * - Delivery, open/close and retarget are one serial chain: two prompts racing
 *   an idle session, or a retarget landing mid-delivery, are the bugs this
 *   prevents.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { LINK_WS_PATH } from "../../../shared/src/index.ts";
import type {
  AgentState,
  BackendInfo,
  DiscoveredSession,
  HarnessId,
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
import { createBackend, loadShapeConfig, rememberBackend, resolveBackend } from "./backend/index.ts";
import type { Backend, BackendEvents } from "./backend/types.ts";
import { harnessIdFor, launchableHarnesses, detectTools, type DetectedTools } from "./detect.ts";
import { discoverSessions } from "./discover.ts";
import type { LinkTarget } from "./external.ts";
import { chooseLauncher } from "./launcher/index.ts";
import type { Launched, Launcher } from "./launcher/types.ts";
import { mountLoopbackLink, type LoopbackLink } from "./link.ts";
import { createProject, probeGitHub, type GithubRequest } from "./newproject.ts";
import { SKIP_DIRS, hasSourceCode, synthesizeSkeleton } from "./onboarding-fs.ts";
import { PtyManager, isPtyMsg } from "./pty.ts";
import { extractReality, gitFileIndex } from "./reality.ts";
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

/** fs walk bounds for `file_index` on a non-git target: a big repo, not a whole disk */
const MAX_WALK_FILES = 20_000;
const MAX_WALK_DIRS = 5_000;

/** the GitHub CLI to shell out to; overridable so smokes never touch a real account */
const GH_BINARY = process.env.SHAPE_GH ?? "gh";

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

/** deliver receipts kept for dedupe: a reconnect only re-sends what is unacknowledged */
const MAX_RECEIPTS = 64;

/**
 * Distinct caller spellings the link router remembers before starting over.
 * Generous for honest callers (a handful of directories per project) and a
 * hard ceiling on a process that invents paths.
 */
const MAX_LINK_ROUTES = 256;

export interface AgentRuntimeOptions {
  /**
   * The directory to open. Any worktree of the repo will do: the project is
   * the repo, and this is the variation that gets the first harness.
   */
  cwd: string;
  /**
   * `--backend <id>`: the operator's default for this process. Beaten by a
   * project's own `.shape/config.json` — a project that wrote down its choice
   * keeps it — and by whatever an `open_worktree` asks for explicitly.
   */
  backend?: string;
  /** `--omp "<cmd ...>"`: replaces the omp adapter's command */
  ompCommand?: string[];
  /**
   * The terminal pane is a shell on the target machine, so a remote agent only
   * offers it when the operator asks. Off means no pty at all: the advertised
   * capability is `"none"` and every `pty_*` frame is ignored.
   */
  allowTerminal: boolean;
  /** the runtime mounts the loopback link (`/link`) here in start() */
  sockets: SocketServer;
  link: AgentEnd;
  /** a retarget failed and there is nowhere to stand; the caller decides what the process does */
  onExit: (reason: string) => void;
}

/**
 * One running harness and everything that belongs to its worktree alone. The
 * runtime holds one per opened variation; closing the variation disposes the
 * whole record.
 */
interface Harness {
  /** worktree id: the realpath of the directory the harness runs in */
  readonly worktree: string;
  readonly cwd: string;
  readonly backend: Backend;
  /**
   * The launcher's handle on this session — focus it, kill it, type at it.
   * Null only while the session is coming up: the record is registered before
   * `start` so a harness that greets during startup finds its sink.
   */
  launched: Launched | null;
  /** the one sink for this harness: native adapter events AND loopback frames */
  readonly events: BackendEvents;
  /** this worktree's terminal pane; null when the terminal is gated off */
  readonly pty: PtyManager | null;
  session: AgentSession;
  state: AgentState;
  /** started with its own approval prompts off */
  autonomous: boolean;
  /** the server's preamble has been spent on this harness's first prompt */
  promptSent: boolean;
}

/** Backend failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What an `open_worktree` (or an adopt, or a startup) asks for. */
interface OpenOptions {
  /** the harness the frame named; beats every config layer */
  backend?: string;
  /** continue this harness session instead of starting a fresh one */
  resumeSessionId?: string;
  /** start it with its own approval prompts off */
  autonomous?: boolean;
  /** write the harness choice to `<cwd>/.shape/config.json` */
  remember?: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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
  /** `--backend`, kept for every harness we open: an adopt overrides it once */
  readonly #cliBackend: string | undefined;
  readonly #cliOmpCommand: string[] | undefined;
  /** `--allow-terminal`: false gates every pane off for good */
  readonly #allowTerminal: boolean;

  /** the directory the agent was pointed at; changed by a retarget */
  #cwd: string;
  /** the MAIN worktree — the project's cwd, label and storage anchor */
  #projectCwd = "";
  /** sha256 of machine + the repo's common dir: every worktree shares it */
  #projectKey = "";
  /** the worktree `#cwd` sits in: the one that gets a harness at startup */
  #primary = "";
  /**
   * The project's harness as the picker names it: the backend of the first
   * worktree opened. Per-harness backends travel in `sessions`. Null when
   * nothing resolved — the project is attached, nothing is running, and the
   * browser asks what to start.
   */
  #projectBackend: BackendInfo | null = null;
  /**
   * What is installed here, detected once at startup and again on `discover`.
   * Project-wide: one agent process sees one PATH.
   */
  #tools: DetectedTools = { launchers: [], harnesses: [] };
  /**
   * How sessions get a terminal, chosen once for this process: the user's own
   * multiplexer when there is one, else a pty Shape owns.
   */
  #launcher!: Launcher;

  /** one harness per opened worktree, keyed by worktree id */
  readonly #harnesses = new Map<string, Harness>();
  /** every worktree of the repo (a non-git target gets exactly one) */
  #worktrees: WorktreeInfo[] = [];
  /** last extraction per worktree; a variation nobody opened can still have one */
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
  /**
   * `gh` is installed and signed in here. Probed once per process in start():
   * an auth check per attach would cost a subprocess on every retarget, and a
   * login that changes mid-session is not worth the round trip.
   */
  #canPublish = false;
  #discovered: DiscoveredSession[] = [];
  #recents: string[] = [];

  /** the server's preamble, from `attached`; prepended to each harness's first prompt */
  #preamble = "";
  /**
   * Delivery, opening/closing a variation and retargeting are serialized: two
   * prompts racing an idle session would have the second one judged against a
   * state that no longer holds, and a retarget must never land mid-delivery.
   */
  #delivering: Promise<void> = Promise.resolve();
  /**
   * The folder chooser standing in front of the user right now. Deliberately
   * NOT on `#delivering`: a dialog is open for as long as a person browses, and
   * nothing typed at the canvas may queue behind that. One at a time — one
   * machine has one user in front of it.
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

  /** pending canvas calls (native host tool and loopback), by frame id */
  readonly #calls = new Map<string, (result: { text: string; isError: boolean }) => void>();
  #callSeq = 0;
  /**
   * The last MAX_RECEIPTS `delivered` answers, by deliver id. Kept per room,
   * not per harness: deliver ids are the room's and unique across its
   * worktrees, and a variation that is closed and reopened must not make a
   * replayed id look fresh.
   */
  readonly #receipts = new Map<string, { worktree: string; mode: "prompt" | "steer"; queued: boolean }>();
  #stopped = false;

  constructor(opts: AgentRuntimeOptions) {
    this.#sockets = opts.sockets;
    this.#link = opts.link;
    this.#onExit = opts.onExit;
    this.#cliBackend = opts.backend;
    this.#cliOmpCommand = opts.ompCommand;
    this.#cwd = opts.cwd;
    this.#allowTerminal = opts.allowTerminal;
  }

  /**
   * Bring the agent up: link endpoint, what is installed, the launcher, the
   * project's facts, the first session, then `attach`.
   *
   * The order matters — the loopback link is mounted first so a harness that
   * greets (or a hook that fires) during startup finds somebody listening, and
   * `attach` goes last so the hello it triggers already carries the running
   * session. A startup always ends with a session on the primary variation:
   * the resolution cannot come up empty, so the only way past this is a
   * harness that failed to start, which throws.
   */
  async start(): Promise<void> {
    this.#link.onMessage((msg) => this.#onServerMsg(msg));
    this.#link.onClose(() => void this.#teardown());
    this.#link.onDisconnect((reason) => this.#onLinkGap(reason));
    this.#link.onReconnect(() => this.#onLinkBack());
    this.#loopback = mountLoopbackLink(this.#sockets, { route: (cwd) => this.#routeLink(cwd) });
    this.#tools = await detectTools();
    this.#launcher = await chooseLauncher({
      tools: this.#tools,
      pty: {
        pane: (worktree) => this.#harnesses.get(worktree)?.pty ?? null,
        requestTerminal: (worktree) => this.#post({ type: "terminal", worktree, open: true }),
      },
    });
    console.error(
      `[bridge] launcher: ${this.#launcher.id}; harnesses here: ${this.#tools.harnesses.map((tool) => tool.id).join(", ") || "none"}`,
    );
    this.#canPublish = await probeGitHub(GH_BINARY);
    await this.#openProject();
    // announced by `attach`, not by a frame of its own: the room does not exist
    // yet
    const primary = await this.#openHarness(this.#primary);
    this.#projectBackend = this.#backendInfo(primary);
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
  // project and harness lifecycle
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
  }

  /**
   * Start a harness in one worktree: its own resolution (a variation may name
   * a different harness), its own event sink, its own terminal pane. The
   * resolution always names a harness — with nothing chosen it is omp — so a
   * worktree that is opened either gets a session or throws saying why.
   * Throws when the chosen harness could not start; the caller decides whether
   * that is a startup error or an `open_worktree` refusal.
   */
  async #openHarness(worktree: string, opts?: OpenOptions): Promise<Harness> {
    const cwd = worktree;
    const config = await loadShapeConfig({ cwd, ompCommand: this.#cliOmpCommand });
    const id = resolveBackend({
      explicit: opts?.backend,
      config,
      cli: this.#cliBackend,
      detected: launchableHarnesses(this.#tools),
    });
    // the choice is recorded BEFORE the session starts: the user asked to
    // remember it, not to remember it if it worked
    if (opts?.remember === true) await rememberBackend(cwd, id);

    const backend = createBackend(id, config);
    const autonomous = opts?.autonomous === true;
    const harness: Harness = {
      worktree,
      cwd,
      backend,
      launched: null,
      events: this.#backendEvents(worktree),
      // The pane exists before the session starts: the pty launcher attaches
      // the harness to it the moment it comes up. Under a launcher whose
      // terminal is the user's own there is no pane at all — Shape must not
      // offer a second, different terminal for the same variation — so every
      // `pty_*` frame for it is dropped.
      pty:
        this.#allowTerminal && this.#launcher.id === "pty"
          ? new PtyManager({ worktree, cwd, broadcast: (msg) => this.#post(msg) })
          : null,
      session: { sessionId: null, sessionName: null, model: null },
      state: "idle",
      autonomous,
      promptSent: false,
    };
    // registered before start() so a harness that greets — or a hook that
    // fires — during startup finds its sink
    this.#harnesses.set(worktree, harness);

    let launched: Launched;
    try {
      launched = await backend.start({
        launcher: this.#launcher,
        worktree,
        cwd,
        // the project, not this variation: one herdr workspace per project,
        // named after the repo, and one tab in it per variation
        project: { path: this.#projectCwd, label: basename(this.#projectCwd) },
        // harness-side processes reach US, never the server
        linkUrl: this.#sockets.url(LINK_WS_PATH),
        autonomous,
        events: harness.events,
        ...(opts?.resumeSessionId === undefined ? {} : { resumeSessionId: opts.resumeSessionId }),
      });
    } catch (err) {
      this.#harnesses.delete(worktree);
      harness.pty?.dispose();
      throw err;
    }
    harness.launched = launched;
    const session = backend.session();
    harness.session = { sessionId: session.sessionId, sessionName: null, model: session.model };
    return harness;
  }

  /**
   * How one harness is described on the wire, derived fresh each time: an
   * adapter on the loopback link only learns what the harness really supports
   * when it greets, and an agent started without `--allow-terminal` answers
   * "no terminal" whatever its launcher could do.
   */
  #backendInfo(harness: Harness): BackendInfo {
    const capabilities = harness.backend.capabilities;
    return {
      id: harness.backend.id,
      label: harness.backend.label,
      capabilities: this.#allowTerminal ? capabilities : { ...capabilities, terminal: "none" },
    };
  }

  /**
   * Dispose one harness. `reason` is null for a teardown/retarget, where the
   * room is about to be replaced anyway and a `session_stopped` per variation
   * would be noise.
   */
  async #closeHarness(harness: Harness, reason: string | null): Promise<void> {
    // deleted first: the adapter's own `onExit` during dispose must not be
    // reported as a harness that died on its own
    this.#harnesses.delete(harness.worktree);
    // the session dies with it; the pane must not be left pointing at it
    harness.pty?.attach(null);
    try {
      await harness.backend.dispose();
    } catch (err) {
      console.error(`[bridge] ${errText(err)}`);
    }
    harness.pty?.dispose();
    if (reason !== null) this.#post({ type: "session_stopped", worktree: harness.worktree, reason });
  }

  /**
   * A session ended on its own (crash, `/exit`, the user quit the TUI, the
   * terminal tab was closed). The variation loses its session and the canvas
   * says so — and that is all: the project stays attached with its canvas, the
   * other variations keep running, and the browser can start another session
   * whenever the user wants one. The agent has no reason to leave.
   */
  #onHarnessExit(worktree: string, reason: string): void {
    const harness = this.#harnesses.get(worktree);
    if (harness === undefined) return;
    this.#harnesses.delete(worktree);
    harness.pty?.attach(null);
    // the session is already gone; this only releases what the adapter holds
    harness.backend.dispose().catch((err: unknown) => console.error(`[bridge] ${errText(err)}`));
    harness.pty?.dispose();
    this.#post({ type: "session_stopped", worktree, reason });
    // the project's harness was this one and it is gone: the browser's picker
    // must not keep naming it
    if (this.#harnesses.size === 0) this.#projectBackend = null;
    console.error(`[bridge] session in ${this.#label(worktree)} ended: ${reason}`);
  }

  /**
   * Announce the current project. A second `attach` on the same link is a
   * retarget: the server replaces the room's project and re-hellos its
   * browsers, which is how a switch reaches the canvas.
   */
  #sendAttach(): void {
    this.#outboxOpen = false;
    const sessions: WorktreeSession[] = [...this.#harnesses.values()].map((harness) => ({
      worktree: harness.worktree,
      session: harness.session,
      backend: this.#backendInfo(harness),
      state: harness.state,
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
        backend: this.#projectBackend,
        tools: { launcher: this.#launcher.id, launchers: this.#tools.launchers, harnesses: this.#tools.harnesses },
        targetHasCode: this.#targetHasCode,
        canPublish: this.#canPublish,
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
    const harnesses = [...this.#harnesses.values()];
    for (const harness of harnesses) await this.#closeHarness(harness, null);
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

  /**
   * One harness's event sink, bound to its worktree for the harness's whole
   * life. Every frame it produces names that worktree, so the room can file it
   * against the right canvas without guessing.
   */
  #backendEvents(worktree: string): BackendEvents {
    return {
      onAgentState: (state) => {
        const harness = this.#harnesses.get(worktree);
        if (harness !== undefined) harness.state = state;
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
      onCanvasCall: (args) => this.#canvasCall(worktree, args),
      // adapters driven by hooks or by the link cannot answer this themselves:
      // only the harness knows which session it is on, and it tells us
      onSession: (info) => {
        const harness = this.#harnesses.get(worktree);
        if (harness !== undefined) {
          harness.session = {
            ...harness.session,
            sessionId: info.sessionId ?? harness.session.sessionId,
            model: info.model ?? harness.session.model,
          };
        }
        this.#post({
          type: "agent_event",
          worktree,
          event: { kind: "session", sessionId: info.sessionId, model: info.model },
        });
      },
      onExit: (reason) => this.#onHarnessExit(worktree, reason),
      onError: (message) => this.#error(message),
    };
  }

  /**
   * Hand a canvas call to the server and wait for its result. Every caller —
   * a harness's native host tool and the loopback link — goes through here, so
   * one counter is enough to correlate every answer, and the worktree it was
   * made in travels with it.
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
   * Route a loopback caller (MCP sidecar, hook, adapter sidecar) to the
   * harness that owns it, by the directory it reports running in: the deepest
   * worktree containing it wins.
   *
   * The cwd is canonicalized first and that is not optional. A worktree id is
   * a realpath, but a caller's spelling need not be one: `process.cwd()` is
   * canonical, while a hook reporting `$PWD` or a payload's `cwd` carries
   * whatever the user typed — and on macOS every `/tmp` path is a symlink to
   * `/private/tmp`. Matching the raw string would refuse a harness that is
   * plainly inside the repo. Resolutions are memoized because the same handful
   * of directories repeat for a whole session; the cache is dropped whenever
   * the worktree list changes, since a path that resolved to nothing may now
   * be a variation.
   */
  #routeLink(cwd: string): LinkTarget | { error: string } {
    let worktree = this.#linkRoutes.get(cwd);
    if (worktree === undefined) {
      worktree = this.#worktreeFor(this.#canonicalDir(cwd));
      // a caller inventing paths must not grow this without bound
      if (this.#linkRoutes.size >= MAX_LINK_ROUTES) this.#linkRoutes.clear();
      this.#linkRoutes.set(cwd, worktree);
    }
    if (worktree === null) {
      return { error: `${cwd} is not part of ${basename(this.#projectCwd)} — this Shape agent is on ${this.#projectCwd}` };
    }
    const harness = this.#harnesses.get(worktree);
    if (harness === undefined) {
      return { error: `no Shape session is running on ${this.#label(worktree)} — open it from the variations menu` };
    }
    const backend = harness.backend;
    return {
      applyCanvas: (args) => this.#canvasCall(worktree, args),
      events: harness.events,
      // the frames only a harness ON the link sends go to its own adapter: it
      // is the one that knows what a greeting or a receipt means for it, and
      // the session id and capabilities it announces belong to this worktree
      onHello: (hello, send) => {
        backend.onHello?.(hello, send);
        const session = backend.session();
        harness.session = { sessionId: session.sessionId, sessionName: null, model: session.model };
      },
      onDelivered: (receipt) => backend.onDelivered?.(receipt),
      onBye: (reason) => backend.onBye?.(reason),
    };
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
      // the terminal is its own channel: never queued behind agent delivery.
      // With the terminal gated off there is no pty and the frame is dropped
      // without an answer — a stale tab must not be able to open a shell — and
      // the same goes for a variation with no harness to own a pane.
      this.#harnesses.get(msg.worktree)?.pty?.handle(msg);
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
        const { worktree, id, body } = msg;
        this.#delivering = this.#delivering.then(() => this.#deliver(worktree, id, body));
        return;
      }
      case "abort": {
        // aborts must not queue behind an in-flight delivery
        const harness = this.#harnesses.get(msg.worktree);
        if (harness === undefined) return;
        harness.backend.abort().catch((err: unknown) => this.#error(errText(err)));
        return;
      }
      case "open_worktree": {
        const { path, backend, resumeSessionId, autonomous, remember } = msg;
        this.#delivering = this.#delivering.then(() =>
          this.#openWorktreeByPath(path, {
            ...(backend === undefined ? {} : { backend }),
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
            ...(autonomous === undefined ? {} : { autonomous }),
            ...(remember === undefined ? {} : { remember }),
          }),
        );
        return;
      }
      case "focus_terminal":
        // showing a terminal must not queue behind a delivery: the user is
        // asking to LOOK at something
        void this.#focusTerminal(msg.worktree);
        return;
      case "close_worktree": {
        const { worktree } = msg;
        this.#delivering = this.#delivering.then(() => this.#closeWorktree(worktree));
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
      case "create": {
        const { path, github } = msg;
        // a create ends in a retarget, so it belongs on the same chain as one:
        // making a folder must never land in the middle of a delivery
        this.#delivering = this.#delivering.then(() => this.#createProject(path, github));
        return;
      }
      case "adopt": {
        const { pid } = msg;
        this.#delivering = this.#delivering.then(() => this.#adopt(pid));
        return;
      }
      case "pick_folder":
        // a dialog waits on a person, so it is never put on the delivery
        // chain: prompts must not queue behind somebody browsing folders
        this.#pickFolder();
        return;
      case "discover": {
        // read-only scan: must not queue behind an in-flight delivery. The
        // tools are re-detected with it — a harness installed since startup is
        // exactly what somebody hitting "look again" is hoping to find.
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
      case "file_index": {
        const { worktree, id } = msg;
        void this.#fileIndex(worktree, id);
        return;
      }
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

  /**
   * Steer into a running turn when the backend can; otherwise the message goes
   * as a prompt and the harness picks it up when the turn ends. The first
   * prompt of a harness session carries the server's preamble — once per
   * harness, because each variation's session starts knowing nothing. The
   * receipt goes out before the send: it is what the server writes the "queued"
   * line from.
   *
   * Something typed for a variation with no session STARTS one — a tab in the
   * user's terminal — and the sentence is the first thing that session hears.
   * Typing is the ask; there is nothing to refuse. Delivers are serialized
   * under `#delivering`, so the open needs no lock of its own, and it posts
   * the `session_started` the canvas draws the session from before the
   * `delivered` receipt goes out. An open that fails has already said why:
   * nothing is delivered, and no receipt is minted for an id the server may
   * still retry.
   *
   * Deliver ids are idempotent. After a reconnect the server re-sends every
   * deliver it holds no receipt for, and some of those did reach the harness
   * before the gap: a known id is answered with the receipt it already earned
   * and never handed to the backend twice.
   */
  async #deliver(worktree: string, id: string, body: string): Promise<void> {
    const known = this.#receipts.get(id);
    if (known !== undefined) {
      this.#post({ type: "delivered", worktree: known.worktree, id, mode: known.mode, queued: known.queued });
      return;
    }

    let harness = this.#harnesses.get(worktree);
    if (harness === undefined) {
      await this.#openVariation(worktree);
      harness = this.#harnesses.get(worktree);
      // the open reported its own `open_worktree failed …`; a receipt here
      // would tell the user the sentence landed somewhere
      if (harness === undefined) return;
    }
    const backend = harness.backend;

    // the harness's own events are the truth about what it is doing: they are
    // what the canvas is drawn from, and asking the adapter instead would let
    // the two disagree
    const streaming = harness.state === "streaming" || harness.state === "compacting";

    const mode: "prompt" | "steer" = backend.capabilities.steerMidTurn && streaming ? "steer" : "prompt";
    const message = streaming || harness.promptSent ? body : `${this.#preamble}${body}`;
    if (!streaming) harness.promptSent = true;
    const receipt = { worktree, mode, queued: mode === "prompt" && streaming };
    this.#receipts.set(id, receipt);
    // only the ids a reconnect could still re-send are worth remembering
    if (this.#receipts.size > MAX_RECEIPTS) {
      const oldest = this.#receipts.keys().next();
      if (oldest.done !== true) this.#receipts.delete(oldest.value);
    }
    this.#post({ type: "delivered", worktree, id, mode: receipt.mode, queued: receipt.queued });

    try {
      await backend.send(message, mode);
    } catch (err) {
      this.#error(errText(err));
    }
  }

  // -------------------------------------------------------------------------
  // variations and retargeting
  // -------------------------------------------------------------------------

  /**
   * `open_worktree`: run a harness in one of THIS repo's worktrees. The path
   * is the room's (a browser picked it from the worktree list), so it is
   * resolved and checked against the repo before anything is spawned. Every
   * refusal starts with `open_worktree` — the room reads that prefix.
   */
  async #openWorktreeByPath(rawPath: string, opts?: OpenOptions): Promise<void> {
    const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
    const target = await this.#realpath(resolve(expanded));
    const worktree = this.#worktreeFor(target);
    if (worktree === null) {
      this.#error(`open_worktree rejected: "${rawPath}" is not a variation of ${basename(this.#projectCwd)}`);
      return;
    }
    await this.#openVariation(worktree, opts);
  }

  /**
   * Open (or re-open) one variation and tell the room. A variation that is
   * already running is answered with the `session_started` it already earned —
   * the room's open is finished either way, and the frame is the truth about
   * that variation — except when the open asks for something DIFFERENT: an
   * adopt, another harness, or approvals the running session does not have.
   *
   * An open either ends with a session in that variation or reports why it
   * could not start one: the resolution itself never comes up empty.
   */
  async #openVariation(worktree: string, opts?: OpenOptions): Promise<void> {
    const running = this.#harnesses.get(worktree);
    if (running !== undefined) {
      const replacing = opts?.backend !== undefined || opts?.resumeSessionId !== undefined;
      if (!replacing) {
        // "autonomous" is the one thing about a running session an open can
        // still change: whether it approves its own tool calls
        const autonomous = opts?.autonomous;
        if (autonomous !== undefined && autonomous !== running.autonomous) {
          try {
            await running.backend.setAutonomous(autonomous);
            running.autonomous = autonomous;
          } catch (err) {
            this.#error(errText(err));
          }
        }
        this.#post({
          type: "session_started",
          worktree,
          session: running.session,
          backend: this.#backendInfo(running),
        });
        return;
      }
      // an adopt (or a different harness) REPLACES the session in that
      // variation: the one the user picked is the one they want driving it
      await this.#closeHarness(running, "replaced by the session you picked");
    }

    let harness: Harness;
    try {
      harness = await this.#openHarness(worktree, opts);
    } catch (err) {
      this.#error(`open_worktree failed for ${this.#label(worktree)}: ${errText(err)}`);
      return;
    }
    // the first session of a project names its harness for the picker
    this.#projectBackend ??= this.#backendInfo(harness);
    this.#post({
      type: "session_started",
      worktree,
      session: harness.session,
      backend: this.#backendInfo(harness),
    });
    console.error(`[bridge] session started on ${this.#label(worktree)} (${harness.cwd})`);
    // a variation the user reaches for may be brand new (a worktree added
    // since the last scan), and the room's list has to catch up
    await this.#refreshWorktrees(null);
  }

  /**
   * `focus_terminal`: bring that variation's session in front of the user.
   * What that means is the launcher's business — a herdr tab is focused for
   * real, a pty answers with a `terminal` frame the browser opens its drawer
   * on — so the only thing decided here is whether there is anything to show.
   */
  async #focusTerminal(worktree: string): Promise<void> {
    const harness = this.#harnesses.get(worktree);
    if (harness === undefined || harness.launched === null) {
      this.#error(`could not bring the terminal forward: no session is running on ${this.#label(worktree)}`);
      return;
    }
    if (!this.#allowTerminal) {
      this.#error(
        "could not bring the terminal forward: this Shape agent was started without --allow-terminal, so its terminal is not offered",
      );
      return;
    }
    try {
      await harness.launched.focus();
    } catch (err) {
      this.#error(`could not bring the terminal forward: ${errText(err)}`);
    }
  }

  /** `close_worktree`: dispose one variation's harness, keep the rest running. */
  async #closeWorktree(worktree: string): Promise<void> {
    const harness = this.#harnesses.get(worktree);
    if (harness === undefined) {
      this.#error(`close_worktree rejected: no session is running on ${this.#label(worktree)}`);
      return;
    }
    await this.#closeHarness(harness, "closed");
    console.error(`[bridge] session on ${this.#label(worktree)} closed`);
    await this.#refreshWorktrees(null);
  }

  /**
   * A path the user pointed Shape at. Inside the current repo it is a
   * VARIATION, not another project: the canvas already holds it, so it opens a
   * harness there and nothing is retargeted. Another repo is the real switch —
   * every harness is disposed, the new project is opened and re-`attach`ed.
   *
   * `opts.backend` is an adopt naming the harness it found; `opts.resumeSessionId`
   * continues that harness's session instead of opening a fresh one.
   */
  async #switchProject(rawPath: string, opts?: OpenOptions): Promise<void> {
    const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
    const target = resolve(expanded);
    if (!(await isDirectory(target))) {
      this.#error(`switch_project rejected: "${rawPath}" is not an existing directory`);
      return;
    }
    const inRepo = this.#worktreeFor(await this.#realpath(target));
    if (inRepo !== null) {
      await this.#openVariation(inRepo, opts);
      return;
    }

    try {
      const harnesses = [...this.#harnesses.values()];
      for (const harness of harnesses) await this.#closeHarness(harness, null);

      this.#cwd = target;
      // a switch is a new room, and deliver ids restart with it: keeping the
      // old room's receipts would let a fresh `req-1` look like a repeat
      this.#receipts.clear();
      // frames from the new harness belong to a room the server has not opened
      // yet: they wait for the `attached` that answers the attach below
      this.#outboxOpen = false;

      await this.#openProject();
      const primary = await this.#openHarness(this.#primary, opts);
      this.#projectBackend = this.#backendInfo(primary);
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
   * Start a new project and move onto it. The `created` frame goes out AFTER
   * the switch, through the ordinary outbox, so it reaches the room the new
   * project just opened instead of the one we are leaving — the user reads it
   * where they end up. A switch that fails reports itself; nothing extra is
   * said here.
   */
  async #createProject(rawPath: string, github: GithubRequest): Promise<void> {
    let created;
    try {
      created = await createProject(rawPath, github, { gh: GH_BINARY });
    } catch (err) {
      // nowhere to stand. The room's switch guard opens on a `create_project`
      // prefix, so an unexpected failure (a folder that cannot be made) has to
      // wear one too, or the canvas would refuse every later switch.
      const reason = errText(err);
      this.#error(reason.startsWith("create_project") ? reason : `create_project failed: ${reason}`);
      return;
    }

    this.#recents = await pushRecent(created.target);
    await this.#switchProject(created.target);
    this.#post({
      type: "created",
      path: created.target,
      repo: created.repo,
      github: created.github,
      warnings: created.warnings,
    });
  }

  /**
   * Adopt a session someone else started. The pid is resolved in a FRESH scan
   * (the server's list is as old as its last discover), and a session with an
   * id is resumed rather than restarted. A session running in one of this
   * repo's worktrees becomes THAT variation's session; anywhere else it is a
   * switch.
   *
   * Adopting means STARTING a session Shape can drive on the same transcript,
   * because a process someone else launched has no Shape extension, no hooks
   * and no link — there is nothing to attach to. Which is why it needs a
   * harness Shape can resume, and a `--resume` to hand it.
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
    // discovery classifies processes with its own spelling; the launcher and
    // the adapters use the launchable ids
    const backend: HarnessId = harnessIdFor(session.harness);
    console.error(
      `[bridge] adopting ${backend} pid ${pid} in ${session.cwd}` +
        (session.sessionId === null ? " (no session id: fresh start)" : ` (resume ${session.sessionId})`),
    );
    await this.#switchProject(session.cwd, {
      backend,
      ...(session.sessionId === null ? {} : { resumeSessionId: session.sessionId }),
    });
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

  /**
   * Every file an agent may point a codeRef at, in one variation. Git is the
   * truth where there is one; otherwise the fs walk stands in for it.
   */
  async #fileIndex(worktree: string, id: string): Promise<void> {
    if (this.#worktreeFor(worktree) === null) {
      this.#error(`file_index rejected: ${worktree} is not a variation of ${basename(this.#projectCwd)}`);
      return;
    }
    const index = await gitFileIndex(worktree);
    const files = index === null ? await walkFileIndex(worktree) : [...index.files];
    this.#post({ type: "file_index", worktree, id, files });
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

  /** One worktree's HEAD moved while its harness was idle: re-derive and ship it. */
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
   * A variation with no harness is still a real directory — the room may want
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
