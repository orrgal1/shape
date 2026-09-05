/**
 * The herdr client: a direct client of herdr's socket API, so Shape can see
 * the user's own terminal multiplexer and show them the tab a session runs in.
 *
 * Shape starts no sessions at all, the project's manager included. What it
 * uses herdr for is twofold: looking at what is live (`workspaceOf`, `tabs`,
 * `agents`) so the project's manager tab can be recognized (`../manager.ts`)
 * and so a repo somebody is working in is discovered at all; and bringing a
 * session's tab in front of the user (`focusCwd`).
 *
 * Wire (agent://HerdrMap, re-verified against the real herdr 0.8.0, protocol
 * 19): newline-delimited JSON over a unix socket, `{id, method, params}` ->
 * `{id, result}` | `{id, error:{code,message}}`. One property of that server
 * shapes this whole client: a request is answered with ONE line and then the
 * server HANGS UP. A call therefore IS a connection: open, write the frame,
 * read the first response line, done. The close that follows the answer is the
 * protocol, not a failure — a close BEFORE the answer is the failure. Matching
 * by id is not available either: a request herdr refuses at validation time
 * comes back with `id: ""`, so the first response line on a connection
 * carrying one request is that request's answer.
 *
 * A project gets ONE workspace and Shape never creates it: `workspace.list` is
 * searched for one herdr says is a checkout of the project, then for one
 * carrying its name. Nothing matching means the user has no workspace for that
 * project, which is a real answer.
 *
 * Focusing is two steps: `agent.focus` switches the tab INSIDE herdr, but the
 * terminal application hosting it is still behind the browser, so from the
 * user's chair nothing happened. On macOS the app bundle is found by walking
 * the herdr client's parent chain out to a `.app` (`SHAPE_TERMINAL_APP` names
 * it outright, for an operator or a test) and raised with `open` (`SHAPE_OPEN`
 * replaces that binary in a test). Where nothing can be raised — another
 * platform, a client over ssh or in a bare console — the tab is still
 * switched, and the failure to raise the window is what the user is told.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";

/** the protocol version this client was written against (herdr 0.8.x) */
const PROTOCOL = 19;

/** `herdr status` only has to prove the server is up, not be fast about it */
const STATUS_TIMEOUT_MS = 10_000;

/** a call herdr has not answered in this long is a call it will not answer */
const CALL_TIMEOUT_MS = 30_000;

/** connecting to a socket nobody is listening on must not hang the startup */
const CONNECT_TIMEOUT_MS = 3_000;

/** listing every process is a fact-finding call, not a wait: fail fast */
const PS_TIMEOUT_MS = 3_000;

/** raising a window either happens now or the user is already elsewhere */
const OPEN_TIMEOUT_MS = 5_000;

/** `ps -axo` on a busy machine runs well past node's 1 MB default */
const PS_MAX_BUFFER = 8 * 1024 * 1024;

/** how a window is brought forward; overridable so smokes raise nothing real */
const OPEN_BINARY = process.env.SHAPE_OPEN ?? "open";

/** the app bundle to raise, named by an operator (or a test) who knows better */
const TERMINAL_APP_ENV = "SHAPE_TERMINAL_APP";

/** ids herdr sees in its own log: one per request this process ever sends */
let requests = 0;

/**
 * A nested object off the socket, or an empty one. Herdr's results are deep
 * (`result.snapshot.protocol`, `result.root_pane.pane_id`) and every leaf is
 * read with `typeof` right after, so coercing the containers keeps one shape
 * check at the boundary instead of a guard at every step.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A refusal herdr named. The code travels in the message because nothing acts
 * on it: every call this client makes is one a project can simply do without.
 */
function refusal(code: string, message: string): Error {
  return new Error(`herdr refused: ${code} (${message})`);
}

/** an id herdr actually gave us, as opposed to a field of the wrong shape */
function asId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A directory as the filesystem sees it, for comparing what herdr reports a
 * session runs in with a worktree id (always a realpath). A path that cannot
 * be resolved is judged by its spelling — the session may be running in a
 * directory that has since been removed.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolvePath(path);
  }
}

/** Where herdr listens: the operator's own path, or herdr's default. */
export function herdrSocketPath(): string {
  const fromEnv = process.env.HERDR_SOCKET_PATH?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".config", "herdr", "herdr.sock");
}

/** one row of `ps -axo pid,ppid,command`, which is the whole process table */
export interface PsRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * `ps -axo pid,ppid,command` output as rows. The two numbers are fixed-width
 * padded and the command is the rest of the line, spaces and all — so the
 * split is "two tokens, then everything" rather than a column parse. The
 * header line and anything that is not two numbers is skipped.
 */
export function parsePsRows(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    // the three groups exist whenever the line matched at all; the defaults
    // are for the type checker, and an empty command is not a process
    const [, pid = "", ppid = "", command = ""] = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line) ?? [];
    if (command === "") continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), command });
  }
  return rows;
}

/**
 * Is this process the INTERACTIVE herdr client — the one sitting in a terminal
 * the user can be shown — as opposed to the server that hosts the sessions or
 * a one-shot query? argv[0] may be a path (`~/.local/bin/herdr`), so the
 * basename decides the program and the first argument decides the mode:
 * `herdr`, `herdr --session x`, `herdr session attach main` are clients;
 * `herdr server`, `herdr api …`, `herdr status` are not.
 */
export function isHerdrClient(command: string): boolean {
  const [argv0, verb] = command.trim().split(/\s+/);
  if (argv0 === undefined || basename(argv0) !== "herdr") return false;
  return verb === undefined || (verb !== "server" && verb !== "api" && verb !== "status");
}

/** a process whose executable IS a macOS application bundle, and that bundle */
const APP_BUNDLE = /^(\/.+\.app)\/Contents\/MacOS\//;

/**
 * The application bundle whose window has to come forward for "go to
 * terminal" to mean anything: the herdr client runs as a child of a shell,
 * which runs as a child of the terminal app (herdr <- zsh <- login <-
 * Ghostty.app), so the app is the first ancestor that is a `.app` executable.
 *
 * Pure on purpose — the process table is somebody else's problem — and
 * cycle-safe, because a table read while processes come and go can name a
 * parent that has already been reused. `null` means there is no such app:
 * a client over ssh, in a bare console, or no client at all.
 */
export function terminalAppOf(rows: readonly PsRow[], isClient: (command: string) => boolean = isHerdrClient): string | null {
  const byPid = new Map<number, PsRow>();
  for (const row of rows) byPid.set(row.pid, row);
  for (const row of rows) {
    if (!isClient(row.command)) continue;
    const seen = new Set<number>([row.pid]);
    let current: PsRow | undefined = byPid.get(row.ppid);
    while (current !== undefined && !seen.has(current.pid)) {
      seen.add(current.pid);
      const bundle = APP_BUNDLE.exec(current.command)?.[1];
      if (bundle !== undefined) return bundle;
      current = byPid.get(current.ppid);
    }
  }
  return null;
}

/** the process table, or null when `ps` will not say (with its reason) */
function readPs(): Promise<{ text: string } | { why: string }> {
  const { promise, resolve } = Promise.withResolvers<{ text: string } | { why: string }>();
  execFile(
    "ps",
    ["-axo", "pid,ppid,command"],
    { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
    (err, stdout) => {
      resolve(err === null ? { text: stdout } : { why: `ps failed: ${err.message}` });
    },
  );
  return promise;
}

/**
 * Which application Shape would raise to show the user their session, and why
 * there is none when there is none (that reason is what gets printed). The
 * env knob wins outright: someone naming the app owns it, and probing the
 * process table of a machine that already told you the answer is rude.
 */
async function findTerminalApp(): Promise<{ app: string; why: null } | { app: null; why: string }> {
  const named = process.env[TERMINAL_APP_ENV]?.trim();
  if (named !== undefined && named.length > 0) return { app: named, why: null };
  if (process.platform !== "darwin") {
    return { app: null, why: `${process.platform} has no window Shape knows how to raise` };
  }
  const table = await readPs();
  if ("why" in table) return { app: null, why: table.why };
  const app = terminalAppOf(parsePsRows(table.text));
  if (app !== null) return { app, why: null };
  return { app: null, why: "no herdr client of this machine runs inside a terminal application" };
}

/**
 * Bring an application's windows in front of whatever is covering them.
 * `open` on an already-running bundle is exactly an activate — it starts no
 * second copy — and its failure is a string rather than a throw because the
 * caller retries before it gives up.
 */
function raiseApp(app: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(OPEN_BINARY, [app], { timeout: OPEN_TIMEOUT_MS }, (err) => {
    resolve(err === null ? null : `${OPEN_BINARY} ${app}: ${err.message}`);
  });
  return promise;
}

/**
 * One framed connection to herdr, carrying exactly one request: that is the
 * whole lifetime the protocol offers for a plain method (see the header).
 */
class HerdrConnection {
  readonly #socket: Socket;
  #buffer = "";
  #pending: { settle: (result: Record<string, unknown>) => void; fail: (err: Error) => void } | null = null;
  /** why this connection ended, and the fact that it did */
  #reason: string | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#onData(chunk);
    });
    socket.on("close", () => {
      this.#gone("the herdr socket closed");
    });
    socket.on("error", (err: Error) => {
      this.#gone(`the herdr socket failed: ${err.message}`);
    });
  }

  static #open(path: string): Promise<HerdrConnection> {
    const { promise, resolve, reject } = Promise.withResolvers<HerdrConnection>();
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`herdr did not accept a connection on ${path} within ${String(CONNECT_TIMEOUT_MS)}ms`));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(new HerdrConnection(socket));
    });
    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`could not reach herdr on ${path}: ${err.message}`));
    });
    return promise;
  }

  /**
   * One request on its own connection — the only shape herdr supports for a
   * plain method. The connection is released either way: on success herdr has
   * usually hung up already, and on failure there is nothing to keep.
   */
  static async call(
    path: string,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const connection = await HerdrConnection.#open(path);
    try {
      return await connection.#request(method, params, timeoutMs);
    } finally {
      connection.#close();
    }
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#reason !== null) return Promise.reject(new Error(this.#reason));
    const id = `shape-${String(++requests)}`;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => {
      this.#pending = null;
      reject(new Error(`herdr did not answer ${method} within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    this.#pending = {
      settle: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      fail: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    };
    this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  /** Ends this connection on Shape's initiative: nobody is told it dropped. */
  #close(): void {
    this.#gone("the launcher closed this connection");
    this.#socket.destroy();
  }

  #gone(reason: string): void {
    if (this.#reason !== null) return;
    this.#reason = reason;
    const pending = this.#pending;
    this.#pending = null;
    // an answered request has no pending entry left: the close after the
    // answer is how herdr ends a plain exchange, and it fails nothing
    pending?.fail(new Error(reason));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const nl = this.#buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        console.error(`[bridge] unparseable herdr frame: ${line.slice(0, 200)}`);
        continue;
      }
      const frame = asRecord(raw);
      // this client subscribes to nothing, so a push envelope on a request
      // connection answers nobody: it must not be mistaken for the answer
      if (typeof frame.event === "string") continue;
      const entry = this.#pending;
      if (entry === null) continue;
      this.#pending = null;
      if (frame.error !== undefined && frame.error !== null) {
        const error = asRecord(frame.error);
        const code = typeof error.code === "string" ? error.code : "error";
        const message = typeof error.message === "string" ? error.message : code;
        entry.fail(refusal(code, message));
        continue;
      }
      entry.settle(asRecord(frame.result));
    }
  }
}

/** one tab of a project's workspace, as much of it as a caller needs to look */
export interface HerdrTab {
  tabId: string;
  label: string;
}

/** one agent herdr says is live, wherever on the server it is */
export interface HerdrAgent {
  paneId: string;
  tabId: string;
  workspaceId: string;
  name: string | null;
  cwd: string | null;
}

export class HerdrLauncher {
  readonly id = "herdr" as const;
  readonly label = "herdr";

  readonly #path: string;
  readonly #version: string;
  /** the app bundle to raise; a hint, re-probed when raising it fails */
  #terminalApp: string | null;

  private constructor(opts: { path: string; version: string; terminalApp: string | null }) {
    this.#path = opts.path;
    this.#version = opts.version;
    this.#terminalApp = opts.terminalApp;
  }

  /**
   * Is herdr here and talking? `session.snapshot` is the handshake: it proves
   * the socket belongs to a herdr server AND carries the protocol version to
   * assert against. A refusal is not an error — a project without herdr simply
   * has no terminal to show and no manager tab — so everything here answers
   * `null` and says why on stderr.
   *
   * `herdr status` is shelled out first ONLY when the socket path is herdr's
   * own default: that call exists to autospawn the server, and an operator (or
   * a test) who named a socket explicitly owns whatever is listening on it.
   *
   * The terminal app is settled here too, after the handshake: it costs a
   * process listing, and there is no point paying it for a herdr that is not
   * there.
   */
  static async probe(): Promise<HerdrLauncher | null> {
    const path = herdrSocketPath();
    const explicit = (process.env.HERDR_SOCKET_PATH?.trim() ?? "").length > 0;
    if (!explicit) await HerdrLauncher.#autospawn();
    try {
      const result = await HerdrConnection.call(path, "session.snapshot", {});
      // `herdr api snapshot` nests it; the socket method has been seen both
      // ways, and the fields we assert are the same either way
      const snapshot = result.snapshot === undefined ? result : asRecord(result.snapshot);
      const protocol = snapshot.protocol;
      if (protocol !== PROTOCOL) {
        console.error(
          `[bridge] herdr speaks protocol ${String(protocol)}, this Shape speaks ${String(PROTOCOL)} — Shape will not talk to it`,
        );
        return null;
      }
      const version = typeof snapshot.version === "string" ? snapshot.version : "unknown";
      const found = await findTerminalApp();
      if (found.app === null) {
        console.error(
          `[bridge] herdr's terminal window cannot be raised from here (${found.why}) — focusing a session switches its tab and nothing more`,
        );
      }
      console.error(`[bridge] herdr ${version} (protocol ${String(PROTOCOL)}) hosts this machine's sessions`);
      return new HerdrLauncher({ path, version, terminalApp: found.app });
    } catch (err) {
      console.error(`[bridge] herdr did not answer: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * herdr's server autospawns from its CLI, not from the socket accept loop
   * (agent://HerdrMap §1), so one benign subcommand is what guarantees there
   * is something to connect to. A missing binary answers nothing: the connect
   * below fails and the project runs without herdr.
   */
  static #autospawn(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    execFile("herdr", ["status"], { timeout: STATUS_TIMEOUT_MS }, () => resolve());
    return promise;
  }

  get version(): string {
    return this.#version;
  }

  /**
   * Bring the session running in `cwd` in front of the user: switch herdr to
   * its tab, then raise the terminal application hosting it.
   *
   * The session is found by the DIRECTORY it runs in, because Shape did not
   * start it and holds no pane id for it — the same match the manager pass
   * makes, and for the same reason. Directories are compared as realpaths:
   * herdr reports whatever spelling the session was started with. Nothing
   * running there, and nothing that can be shown, both throw with the sentence
   * the user reads.
   */
  async focusCwd(cwd: string): Promise<void> {
    const wanted = await canonical(cwd);
    let match: HerdrAgent | null = null;
    for (const agent of await this.agents()) {
      if (agent.cwd === null) continue;
      if ((await canonical(agent.cwd)) !== wanted) continue;
      match = agent;
      break;
    }
    if (match === null) throw new Error(`no session in the user's herdr is running in ${cwd}`);
    try {
      await this.#call("agent.focus", { target: match.paneId });
    } catch {
      // the pane may have lost its agent (the harness exited) while the tab
      // is still there to look at, and that is still the right answer to
      // "show me the terminal"
      await this.#call("tab.focus", { tab_id: match.tabId });
    }
    // herdr switched its own tab; the terminal is still behind the browser
    await this.#raise();
  }

  /**
   * The workspace hosting this project, if the user has one — find only. A
   * caller that is looking for something already in the user's terminal must
   * not bring a workspace into existence by asking.
   *
   * Matched by descending confidence: one herdr says is a checkout of the
   * project, then one simply carrying the project's name — a workspace the
   * user opened for this repo by hand is the right home too.
   */
  async workspaceOf(project: { path: string; label: string }): Promise<string | null> {
    const listed = await this.#call("workspace.list", {});
    const workspaces = (Array.isArray(listed.workspaces) ? listed.workspaces : []).map(asRecord);
    const match =
      workspaces.find((workspace) => {
        // plain workspaces carry no worktree at all; asRecord makes that a miss
        const worktree = asRecord(workspace.worktree);
        return worktree.repo_root === project.path || worktree.checkout_path === project.path;
      }) ?? workspaces.find((workspace) => workspace.label === project.label);
    return match === undefined ? null : asId(match.workspace_id);
  }

  /** Every tab of one workspace, by the label a human reads in the tab strip. */
  async tabs(workspaceId: string): Promise<HerdrTab[]> {
    const listed = await this.#call("tab.list", { workspace_id: workspaceId });
    const tabs: HerdrTab[] = [];
    for (const raw of Array.isArray(listed.tabs) ? listed.tabs : []) {
      const tab = asRecord(raw);
      const tabId = asId(tab.tab_id);
      if (tabId === null) continue;
      tabs.push({ tabId, label: typeof tab.label === "string" ? tab.label : "" });
    }
    return tabs;
  }

  /**
   * Every live agent on the server. `agent.list` is global by protocol — there
   * is no per-workspace form — so the caller filters; the workspace id and the
   * cwd are on every row, which is what makes that cheap.
   */
  async agents(): Promise<HerdrAgent[]> {
    const listed = await this.#call("agent.list", {});
    const agents: HerdrAgent[] = [];
    for (const raw of Array.isArray(listed.agents) ? listed.agents : []) {
      const agent = asRecord(raw);
      const paneId = asId(agent.pane_id);
      const tabId = asId(agent.tab_id);
      const workspaceId = asId(agent.workspace_id);
      if (paneId === null || tabId === null || workspaceId === null) continue;
      agents.push({ paneId, tabId, workspaceId, name: asId(agent.name), cwd: asId(agent.cwd) });
    }
    return agents;
  }

  /** Close one tab, whoever created it. */
  async closeTab(tabId: string): Promise<void> {
    await this.#call("tab.close", { tab_id: tabId });
  }

  /**
   * Type a prompt into a LIVE pane: the harness running there reads it as if
   * the user had typed it, so this is how Shape reaches a session that started
   * before Shape did and therefore never loaded the omp extension.
   *
   * The pane must be one `mgr board` just named — no waiting, no polling for a
   * harness to come up, because Shape starts no sessions of its own and every
   * pane it prompts is one the manager already has an agent in. A refusal
   * (`pane_not_found` after the session ended, an agent that is not accepting
   * input) throws with herdr's own code in the message, and the CALLER logs
   * it: one pane that would not take the directive is not a reason to stop
   * briefing the rest.
   */
  async prompt(paneId: string, text: string): Promise<void> {
    await this.#call("agent.prompt", { target: paneId, text });
  }

  /** Close a whole workspace, tabs and all. */
  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.#call("workspace.close", { workspace_id: workspaceId });
  }

  /** every plain method: one connection, one answer, gone (see the header) */
  #call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    return HerdrConnection.call(this.#path, method, params, timeoutMs);
  }

  /**
   * Bring the terminal application forward, so focusing a tab is something the
   * user can SEE. The remembered app is a hint: they may have quit that
   * terminal and reopened their herdr client in another one since the probe,
   * so a failure re-probes once and tries what it finds now. Still failing is
   * the caller's to hear — the tab IS focused, and only the window is not.
   */
  async #raise(): Promise<void> {
    const app = this.#terminalApp;
    if (app === null) return;
    const failure = await raiseApp(app);
    if (failure === null) return;
    const found = await findTerminalApp();
    const retry = found.app === null ? found.why : await raiseApp(found.app);
    if (retry === null) {
      this.#terminalApp = found.app;
      return;
    }
    throw new Error(`herdr's tab is focused, but its terminal window could not be brought forward: ${retry}`);
  }
}
