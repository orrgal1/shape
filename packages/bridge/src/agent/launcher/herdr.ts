/**
 * The herdr client: a direct client of herdr's socket API, so Shape can see
 * the user's own terminal multiplexer and show them the tab a session runs in.
 *
 * Shape starts no coding sessions. What it uses herdr for is threefold: the
 * project's MANAGER tab (`../manager.ts`), which Shape does open and prompt
 * once; looking at what is live (`tabs`, `agents`) so the manager can be found
 * again; and bringing a session's tab in front of the user (`focusCwd`).
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
 * Opening the manager is two steps because herdr's is: `tab.create` makes a
 * tab whose root pane sits at an idle shell, then `agent.start` runs omp in
 * that pane and waits until herdr recognizes it. Placement is the other half:
 * a project gets ONE workspace, found (`workspace.list`) by the id Shape last
 * used for it, then by a workspace herdr says is a checkout of it, then by its
 * name; nothing matching means `workspace.create`, whose answer already
 * carries the first tab and root pane — so the manager can take that root tab
 * and asks for no tab of its own. The names `agent.start` is asked for are the
 * caller's in order (`manager` first), because a session Shape has to
 * recognize again after a restart is recognized by its name.
 *
 * Focusing is two steps for the same reason: `agent.focus` switches the tab
 * INSIDE herdr, but the terminal application hosting it is still behind the
 * browser, so from the user's chair nothing happened. On macOS the app bundle
 * is found by walking the herdr client's parent chain out to a `.app`
 * (`SHAPE_TERMINAL_APP` names it outright, for an operator or a test) and
 * raised with `open` (`SHAPE_OPEN` replaces that binary in a test). Where
 * nothing can be raised — another platform, a client over ssh or in a bare
 * console — the tab is still switched, and the failure to raise the window is
 * what the user is told.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import type { HarnessId } from "../../../../shared/src/index.ts";

/** the protocol version this client was written against (herdr 0.8.x) */
const PROTOCOL = 19;

/** `herdr status` only has to prove the server is up, not be fast about it */
const STATUS_TIMEOUT_MS = 10_000;

/** a call herdr has not answered in this long is a call it will not answer */
const CALL_TIMEOUT_MS = 30_000;

/** `agent.start` waits for herdr to recognize the harness; its own ceiling */
const START_TIMEOUT_MS = 60_000;

/** names already taken on the server before an open gives up (see `#start`) */
const MAX_NAME_ATTEMPTS = 20;

/**
 * How long a prompt waits for a just-started agent to become addressable.
 * `agent.start` answering means herdr recognized the harness, not that it will
 * take a prompt yet, so the pane is polled until it stops saying it is still
 * launching.
 */
const PROMPT_READY_MS = 15_000;
const PROMPT_POLL_MS = 250;

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

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}`, unique among live agents */
const MAX_AGENT_NAME = 32;

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
 * A refusal herdr named. The code is kept because a couple of them are not
 * failures but facts about the user's terminal — `workspace_not_found` means
 * they closed the project's workspace while Shape was not looking.
 */
class HerdrRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`herdr refused: ${code} (${message})`);
    this.code = code;
  }
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

/**
 * The tab and root pane out of a `tab.create` or `workspace.create` answer:
 * both carry the same pair, which is the whole reason a fresh workspace needs
 * no second call to be usable.
 */
function tabAndPane(answer: Record<string, unknown>): { tabId: string; paneId: string } {
  const tabId = asId(asRecord(answer.tab).tab_id);
  const paneId = asId(asRecord(answer.root_pane).pane_id);
  if (tabId === null || paneId === null) {
    throw new Error("herdr created a tab without a pane id — cannot start a harness in it");
  }
  return { tabId, paneId };
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
        entry.fail(new HerdrRefusal(code, message));
        continue;
      }
      entry.settle(asRecord(frame.result));
    }
  }
}

/** the tab a session was given, and the project workspace holding it */
interface Placed {
  tabId: string;
  paneId: string;
  /** the workspace's name, for the log line a human reads */
  workspace: string;
  /** the workspace's id, for callers that go on talking to herdr about it */
  workspaceId: string;
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

/** what `open` needs to place a tab and start a harness in it */
export interface HerdrOpenSpec {
  /** where the harness runs */
  cwd: string;
  /** which harness this is; herdr needs it to recognize the pane */
  kind: HarnessId;
  /** the whole command line, argv[0] included (the executable) */
  argv: string[];
  /** added to the session's environment, never replacing it */
  env: Record<string, string>;
  /**
   * The project this tab belongs to: its main worktree's realpath and the name
   * a human calls it. herdr keeps every tab of one project in ONE workspace,
   * so the workspace has to be findable (and namable) from the project.
   */
  project: { path: string; label: string };
  /** what the tab is called where a human can see it */
  label: string;
}

/** a harness started by `open`: a tab and a name, and nothing watching it */
export interface HerdrOpened {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agentName: string;
}

export class HerdrLauncher {
  readonly id = "herdr" as const;
  readonly label = "herdr";

  readonly #path: string;
  readonly #version: string;
  /** the app bundle to raise; a hint, re-probed when raising it fails */
  #terminalApp: string | null;
  /** project main worktree -> the workspace hosting that project's tabs */
  readonly #workspaces = new Map<string, string>();
  #seq = 0;

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
   * Start a harness in a tab of this project's workspace and hand back where
   * it landed — Shape does not watch it afterwards.
   *
   * This is for the one session Shape opens rather than observes: the
   * project's manager (`../manager.ts`). A project with no workspace yet gets
   * one whose root tab becomes this tab, renamed to `spec.label`.
   *
   * The names are the caller's, in order, because a manager is known by name
   * to whoever reads the tab strip (`manager` first); only once every one of
   * them is taken does this fall back to numbering the last (`-2`, `-3`, …).
   */
  async open(spec: HerdrOpenSpec, names: readonly string[]): Promise<HerdrOpened> {
    const candidates = names.filter((name) => name.length > 0);
    if (candidates.length === 0) throw new Error("herdr cannot start an agent without a name to try");
    const last = candidates[candidates.length - 1] as string;
    const placed = await this.#place(spec);
    const name = await this.#start(placed, spec, (attempt) => {
      const candidate = candidates[attempt];
      if (candidate !== undefined) return candidate;
      const suffix = `-${String(attempt - candidates.length + 2)}`;
      return `${last.slice(0, MAX_AGENT_NAME - suffix.length)}${suffix}`;
    });
    console.error(
      `[bridge] herdr started ${spec.kind} as ${name} in pane ${placed.paneId} of workspace ${placed.workspace} (${spec.cwd})`,
    );
    return { paneId: placed.paneId, tabId: placed.tabId, workspaceId: placed.workspaceId, agentName: name };
  }

  /**
   * Type a prompt into a pane, after the gap between `agent.start` answering
   * and herdr treating that agent as addressable (see PROMPT_READY_MS). A pane
   * with no agent left in it is not going to become ready: `agent.get`
   * refusing, or the wait running out, is the caller's.
   */
  async prompt(paneId: string, text: string): Promise<void> {
    const deadline = Date.now() + PROMPT_READY_MS;
    for (;;) {
      const got = await this.#call("agent.get", { target: paneId });
      if (asRecord(got.agent).launch_pending !== true) break;
      if (Date.now() >= deadline) {
        throw new Error(`agent in pane ${paneId} was still starting after ${String(PROMPT_READY_MS)}ms`);
      }
      const { promise, resolve: settle } = Promise.withResolvers<void>();
      // a wait for a session nobody is watching must not hold the process open
      setTimeout(settle, PROMPT_POLL_MS).unref();
      await promise;
    }
    await this.#call("agent.prompt", { target: paneId, text });
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
   */
  async workspaceOf(project: { path: string; label: string }): Promise<string | null> {
    return (await this.#findWorkspace(project))?.id ?? null;
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

  /** Close a whole workspace, tabs and all. */
  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.#call("workspace.close", { workspace_id: workspaceId });
  }

  /**
   * Run the harness in a placed tab, under the first name herdr accepts.
   *
   * Agent names are unique per herdr SERVER, and Shape's own numbering is per
   * process: a bridge restarted under a tab its predecessor left running (the
   * user's terminal outlives us) collides on the name it would pick first.
   * herdr says so with `agent_name_taken`, so the next candidate is tried —
   * the tab that was already created is the one the harness must start in.
   * Every other refusal takes the tab down with it: a tab with a dead shell in
   * it is litter in the user's terminal.
   */
  async #start(placed: Placed, spec: HerdrOpenSpec, nextName: (attempt: number) => string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const name = nextName(attempt);
      try {
        await this.#call(
          "agent.start",
          // `AgentStartParams` in herdr's schema: `pane_id`, `timeout_ms` (3 000 < t ≤ 300 000)
          { name, kind: spec.kind, pane_id: placed.paneId, args: spec.argv.slice(1), timeout_ms: START_TIMEOUT_MS },
          START_TIMEOUT_MS + CALL_TIMEOUT_MS,
        );
        return name;
      } catch (err) {
        if (err instanceof HerdrRefusal && err.code === "agent_name_taken" && attempt < MAX_NAME_ATTEMPTS) continue;
        await this.#call("tab.close", { tab_id: placed.tabId }).catch(() => undefined);
        throw err;
      }
    }
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

  /**
   * Where this tab goes: the workspace that already hosts this project, or a
   * new one named after it. The cache is only ever a hint — the user owns
   * these workspaces and can close one between two opens — so every open
   * re-lists and a stale entry is dropped rather than trusted.
   */
  async #place(spec: HerdrOpenSpec): Promise<Placed> {
    const found = await this.#findWorkspace(spec.project);
    if (found !== null) {
      try {
        const created = await this.#call("tab.create", {
          workspace_id: found.id,
          cwd: spec.cwd,
          label: spec.label,
          env: spec.env,
          // a session Shape started must not steal the terminal the user is in
          focus: false,
        });
        this.#workspaces.set(spec.project.path, found.id);
        return { ...tabAndPane(created), workspace: found.label, workspaceId: found.id };
      } catch (err) {
        // the workspace went away between the list and the create: the user
        // closed it, and this project needs a new one. Every other refusal is
        // the caller's to hear about
        if (!(err instanceof HerdrRefusal) || err.code !== "workspace_not_found") throw err;
        this.#workspaces.delete(spec.project.path);
      }
    }
    return await this.#createWorkspace(spec);
  }

  /**
   * The workspace already hosting this project, by descending confidence: the
   * one Shape opened for it (when the user still has it), one herdr says is a
   * checkout of the project, then one simply carrying the project's name — a
   * workspace the user opened for this repo by hand is the right home too.
   */
  async #findWorkspace(project: { path: string; label: string }): Promise<{ id: string; label: string } | null> {
    const listed = await this.#call("workspace.list", {});
    const workspaces = (Array.isArray(listed.workspaces) ? listed.workspaces : []).map(asRecord);
    const cached = this.#workspaces.get(project.path);
    const match =
      (cached === undefined ? undefined : workspaces.find((workspace) => workspace.workspace_id === cached)) ??
      workspaces.find((workspace) => {
        // plain workspaces carry no worktree at all; asRecord makes that a miss
        const worktree = asRecord(workspace.worktree);
        return worktree.repo_root === project.path || worktree.checkout_path === project.path;
      }) ??
      workspaces.find((workspace) => workspace.label === project.label);
    if (match === undefined) {
      this.#workspaces.delete(project.path);
      return null;
    }
    const id = asId(match.workspace_id);
    if (id === null) return null;
    return { id, label: typeof match.label === "string" ? match.label : project.label };
  }

  /**
   * A workspace of this project's own, because nothing hosts it yet. herdr
   * answers with the workspace AND its first tab and root pane, so this tab
   * takes that root tab — renamed to say what it is — and the project's first
   * tab costs one call instead of two. The workspace opens in the tab's own
   * directory, which for the manager is the main worktree.
   */
  async #createWorkspace(spec: HerdrOpenSpec): Promise<Placed> {
    const created = await this.#call("workspace.create", {
      cwd: spec.cwd,
      label: spec.project.label,
      env: spec.env,
      focus: false,
    });
    const workspaceId = asId(asRecord(created.workspace).workspace_id);
    // the id is how everything after this addresses the workspace (which tabs
    // are in it, which agent is the manager): an answer without one is not a
    // workspace Shape can go on to use
    if (workspaceId === null) throw new Error("herdr created a workspace without an id");
    this.#workspaces.set(spec.project.path, workspaceId);
    const placed = { ...tabAndPane(created), workspace: spec.project.label, workspaceId };
    try {
      await this.#call("tab.rename", { tab_id: placed.tabId, label: spec.label });
    } catch (err) {
      // the label is only what a human reads in their own tab strip: worth a
      // line on stderr, never worth losing the session over
      console.error(
        `[bridge] herdr would not rename tab ${placed.tabId} to ${spec.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return placed;
  }
}
