/**
 * The herdr launcher: a direct client of herdr's socket API, so a Shape
 * session is a real tab in the user's own terminal multiplexer.
 *
 * Wire (agent://HerdrMap, re-verified against the real herdr 0.8.0, protocol
 * 19): newline-delimited JSON over a unix socket, `{id, method, params}` ->
 * `{id, result}` | `{id, error:{code,message}}`. Two properties of that server
 * shape this whole client:
 *
 *   - A plain request is answered with ONE line and then the server HANGS UP.
 *     A call therefore IS a connection: open, write the frame, read the first
 *     response line, done. The close that follows the answer is the protocol,
 *     not a failure — a close BEFORE the answer is the failure. Matching by id
 *     is not available either: a request herdr refuses at validation time
 *     comes back with `id: ""`, so the first response line on a connection
 *     carrying one request is that request's answer.
 *   - An `events.subscribe` connection is the exception: it answers
 *     `{type:"subscription_started"}` and then STAYS OPEN, streaming
 *     `{event, data}` envelopes. `pane.exited` / `pane.closed` are global, but
 *     `pane.agent_status_changed` REQUIRES a `pane_id` (its subscription
 *     schema says so, and herdr answers `invalid_request` without it) — so
 *     status is one connection per launched pane, alongside one global
 *     lifecycle stream that reconnects itself.
 *
 * Launching is two steps because herdr's is: `tab.create` makes a tab whose
 * root pane sits at an idle shell, then `agent.start` runs the harness in that
 * pane and waits until herdr recognizes it. Pane ids are the durable handle
 * (agent names follow whoever occupies the pane), so everything after launch
 * is addressed by pane id.
 *
 * Placement is the other half of that: a project gets ONE workspace and each
 * of its variations ONE tab in it, so the user's tab strip reads the way the
 * canvas does. The workspace is found per launch (`workspace.list`, which is
 * cheap next to starting a harness) by the id Shape last used for the
 * project, then by a workspace herdr says is a checkout of it, then by its
 * name; nothing matching means `workspace.create`, whose answer already
 * carries the first tab and root pane — so a project's first session IS that
 * root tab and asks for no tab of its own.
 *
 * Focusing is two steps for the same reason: `agent.focus` switches the tab
 * INSIDE herdr, but the terminal application hosting it is still behind the
 * browser, so from the user's chair nothing happened. On macOS the app bundle
 * is found by walking the herdr client's parent chain out to a `.app`
 * (`SHAPE_TERMINAL_APP` names it outright, for an operator or a test) and
 * raised with `open` (`SHAPE_OPEN` replaces that binary in a test). Where
 * nothing can be raised — another platform, a client over ssh or in a
 * bare console — the launcher advertises `terminal: "none"` and the browser
 * offers no "Go to terminal" button at all.
 */

import { execFile } from "node:child_process";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentStatus, Launched, LaunchSpec, Launcher } from "./types.ts";

/** the protocol version this client was written against (herdr 0.8.x) */
const PROTOCOL = 19;

/** `herdr status` only has to prove the server is up, not be fast about it */
const STATUS_TIMEOUT_MS = 10_000;

/** a call herdr has not answered in this long is a call it will not answer */
const CALL_TIMEOUT_MS = 30_000;

/** `agent.start` waits for herdr to recognize the harness; its own ceiling */
const START_TIMEOUT_MS = 60_000;

/** names already taken on the server before a launch gives up (see `launch`) */
const MAX_NAME_ATTEMPTS = 20;

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

/** how long to wait before reopening a dropped event stream, and its ceiling */
const RECONNECT_MS = 500;
const RECONNECT_MAX_MS = 30_000;

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}`, unique among live agents */
const MAX_AGENT_NAME = 32;

const STATUSES: Record<string, AgentStatus> = {
  idle: "idle",
  working: "working",
  blocked: "blocked",
  done: "done",
  unknown: "unknown",
};

/**
 * The events that are global, and the only ones this launcher needs globally:
 * a pane going away ends a session. An agent APPEARING is not interesting —
 * `agent.start` already waited for that — and status is per-pane by protocol.
 */
const LIFECYCLE_SUBSCRIPTIONS: readonly Record<string, unknown>[] = [{ type: "pane.exited" }, { type: "pane.closed" }];

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
 * A herdr agent name out of a worktree directory: lowercase, `[a-z0-9_-]`,
 * suffixed with a counter so two sessions in the same directory (a restart
 * before herdr released the old name) cannot collide.
 */
function agentName(cwd: string, seq: number): string {
  const slug = (cwd.split("/").pop() ?? "shape").toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-");
  const suffix = `-${String(seq)}`;
  const room = MAX_AGENT_NAME - "shape-".length - suffix.length;
  const trimmed = slug.slice(0, Math.max(1, room)).replace(/-+$/, "");
  return `shape-${trimmed.length > 0 ? trimmed : "session"}${suffix}`;
}

/**
 * One framed connection to herdr: at most one request in flight on it, plus
 * the event stream a subscription turns it into.
 *
 * The lifetime is the protocol's: a request connection lives for exactly one
 * exchange (`HerdrConnection.call`), a subscription connection lives until
 * herdr or the launcher ends it.
 */
class HerdrConnection {
  readonly #socket: Socket;
  #buffer = "";
  #pending: { settle: (result: Record<string, unknown>) => void; fail: (err: Error) => void } | null = null;
  #onEvent: ((event: string, data: Record<string, unknown>) => void) | null = null;
  #onGone: ((reason: string) => void) | null = null;
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

  static open(path: string): Promise<HerdrConnection> {
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
    const connection = await HerdrConnection.open(path);
    try {
      return await connection.request(method, params, timeoutMs);
    } finally {
      connection.close();
    }
  }

  get closed(): boolean {
    return this.#reason !== null;
  }

  onEvent(cb: (event: string, data: Record<string, unknown>) => void): void {
    this.#onEvent = cb;
  }

  /** Told when this connection ends, at once if it already has. */
  onGone(cb: (reason: string) => void): void {
    if (this.#reason !== null) {
      cb(this.#reason);
      return;
    }
    this.#onGone = cb;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.#reason !== null) return Promise.reject(new Error(this.#reason));
    if (this.#pending !== null) return Promise.reject(new Error("a herdr connection carries one request at a time"));
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
  close(): void {
    this.#onGone = null;
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
    const onGone = this.#onGone;
    this.#onGone = null;
    onGone?.(reason);
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
      // a push envelope carries an event name; a response carries result/error
      if (typeof frame.event === "string") {
        this.#onEvent?.(frame.event, asRecord(frame.data));
        continue;
      }
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

/**
 * A subscription kept alive: `events.subscribe` on its own connection, the
 * stream that follows, and a reopen with growing backoff whenever herdr drops
 * it. The FIRST open is awaited — a subscription that cannot be established
 * at all is the caller's problem — and every reopen after that is this
 * object's business, announced once per outage so a restarting herdr does not
 * fill the log.
 */
class HerdrSubscription {
  readonly #path: string;
  readonly #label: string;
  readonly #subscriptions: readonly Record<string, unknown>[];
  readonly #onEvent: (event: string, data: Record<string, unknown>) => void;
  #connection: HerdrConnection | null = null;
  #timer: NodeJS.Timeout | null = null;
  #backoff = RECONNECT_MS;
  #warned = false;
  #stopped = false;

  private constructor(opts: {
    path: string;
    label: string;
    subscriptions: readonly Record<string, unknown>[];
    onEvent: (event: string, data: Record<string, unknown>) => void;
  }) {
    this.#path = opts.path;
    this.#label = opts.label;
    this.#subscriptions = opts.subscriptions;
    this.#onEvent = opts.onEvent;
  }

  static async open(opts: {
    path: string;
    label: string;
    subscriptions: readonly Record<string, unknown>[];
    onEvent: (event: string, data: Record<string, unknown>) => void;
  }): Promise<HerdrSubscription> {
    const subscription = new HerdrSubscription(opts);
    await subscription.#connect();
    return subscription;
  }

  /** The thing this watched is gone, or the launcher is: stop for good. */
  close(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#connection?.close();
    this.#connection = null;
  }

  async #connect(): Promise<void> {
    const connection = await HerdrConnection.open(this.#path);
    try {
      await connection.request("events.subscribe", { subscriptions: this.#subscriptions });
    } catch (err) {
      connection.close();
      throw err;
    }
    if (this.#stopped) {
      connection.close();
      return;
    }
    connection.onEvent(this.#onEvent);
    connection.onGone((reason) => {
      this.#dropped(reason);
    });
    this.#connection = connection;
    this.#backoff = RECONNECT_MS;
    if (this.#warned) {
      this.#warned = false;
      console.error(`[bridge] herdr's ${this.#label} events are back`);
    }
  }

  #dropped(reason: string): void {
    this.#connection = null;
    if (this.#stopped) return;
    if (!this.#warned) {
      this.#warned = true;
      console.error(`[bridge] herdr's ${this.#label} events stopped (${reason}) — reconnecting`);
    }
    this.#retry();
  }

  #retry(): void {
    if (this.#stopped || this.#timer !== null) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, RECONNECT_MAX_MS);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect().catch(() => {
        this.#retry();
      });
    }, delay);
    // a reconnect nobody is waiting for must not hold the process open
    this.#timer.unref();
  }
}

/** what one launched pane's subscribers are waiting to hear */
interface PaneSinks {
  status: Set<(status: AgentStatus) => void>;
  exit: Set<(code: number | null) => void>;
  /** this pane's own `pane.agent_status_changed` stream, released with it */
  statuses: HerdrSubscription | null;
  /** an exit is reported once; herdr may say `pane.exited` and `pane.closed` */
  gone: boolean;
}

/** the tab a session was given, and the project workspace holding it */
interface Placed {
  tabId: string;
  paneId: string;
  /** the workspace's name, for the log line a human reads */
  workspace: string;
}

export class HerdrLauncher implements Launcher {
  readonly id = "herdr" as const;
  readonly label = "herdr";
  /**
   * A herdr tab is the USER's terminal: Shape can focus it and raise the
   * application hosting it, never embed it. When there is no such application
   * to raise (`#terminalApp` is null) the button would be a lie, so the
   * launcher offers no terminal at all — decided once, at probe time, because
   * capabilities are sent to the browser before any session exists.
   */
  readonly terminal: "external" | "none";

  readonly #path: string;
  readonly #version: string;
  /** the app bundle to raise; a hint, re-probed when raising it fails */
  #terminalApp: string | null;
  readonly #panes = new Map<string, PaneSinks>();
  /** project main worktree -> the workspace hosting that project's tabs */
  readonly #workspaces = new Map<string, string>();
  /** the one stream that outlives every session: panes going away */
  #lifecycle: HerdrSubscription | null = null;
  #seq = 0;

  private constructor(opts: { path: string; version: string; terminalApp: string | null }) {
    this.#path = opts.path;
    this.#version = opts.version;
    this.#terminalApp = opts.terminalApp;
    this.terminal = opts.terminalApp === null ? "none" : "external";
  }

  /**
   * Is herdr here and talking? `session.snapshot` is the handshake: it proves
   * the socket belongs to a herdr server AND carries the protocol version to
   * assert against. A refusal is not an error — Shape falls back to its own
   * pty — so everything here answers `null` and says why on stderr.
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
          `[bridge] herdr speaks protocol ${String(protocol)}, this Shape speaks ${String(PROTOCOL)} — using Shape's own terminal instead`,
        );
        return null;
      }
      const version = typeof snapshot.version === "string" ? snapshot.version : "unknown";
      const found = await findTerminalApp();
      if (found.app === null) {
        console.error(
          `[bridge] herdr's terminal window cannot be raised from here (${found.why}) — "Go to terminal" is not offered`,
        );
      }
      const launcher = new HerdrLauncher({ path, version, terminalApp: found.app });
      // the one stream that must be up before Shape commits to herdr: without
      // it a session that ends in the user's terminal would never be noticed
      launcher.#lifecycle = await HerdrSubscription.open({
        path,
        label: "lifecycle",
        subscriptions: LIFECYCLE_SUBSCRIPTIONS,
        onEvent: (event, data) => {
          launcher.#onEvent(event, data);
        },
      });
      console.error(`[bridge] herdr ${version} (protocol ${String(PROTOCOL)}) will host the sessions`);
      return launcher;
    } catch (err) {
      console.error(`[bridge] herdr did not answer: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * herdr's server autospawns from its CLI, not from the socket accept loop
   * (agent://HerdrMap §1), so one benign subcommand is what guarantees there
   * is something to connect to. A missing binary answers nothing: the connect
   * below fails and the pty launcher takes over.
   */
  static #autospawn(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    execFile("herdr", ["status"], { timeout: STATUS_TIMEOUT_MS }, () => resolve());
    return promise;
  }

  get version(): string {
    return this.#version;
  }

  async launch(spec: LaunchSpec): Promise<Launched> {
    const placed = await this.#place(spec);
    const { tabId, paneId } = placed;

    const sinks: PaneSinks = { status: new Set(), exit: new Set(), statuses: null, gone: false };
    this.#panes.set(paneId, sinks);
    // status is subscribed per pane (the protocol has no global form of it),
    // and herdr already reports it DURING `agent.start` — so the stream goes
    // up while the pane is still an idle shell. A status change nobody heard
    // is a session the canvas believes is idle while it works.
    try {
      sinks.statuses = await HerdrSubscription.open({
        path: this.#path,
        label: `pane ${paneId}`,
        subscriptions: [{ type: "pane.agent_status_changed", pane_id: paneId }],
        onEvent: (event, data) => {
          this.#onEvent(event, data);
        },
      });
    } catch (err) {
      // a session in the user's own terminal with no status is worth more than
      // no session: a harness on the loopback link still says what it is doing
      console.error(
        `[bridge] herdr will not report status for pane ${paneId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Agent names are unique per herdr SERVER, and the sequence is per Shape
    // process: a bridge restarted under a tab its predecessor left running
    // (the user's terminal outlives us) collides on `shape-<slug>-1`. herdr
    // says so with `agent_name_taken`, so the next number is tried — the tab
    // that was already created is the one the harness must start in.
    let name = agentName(spec.cwd, ++this.#seq);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#call(
          "agent.start",
          // `AgentStartParams` in herdr's schema: `pane_id`, `timeout_ms` (3 000 < t ≤ 300 000)
          { name, kind: spec.kind, pane_id: paneId, args: spec.argv.slice(1), timeout_ms: START_TIMEOUT_MS },
          START_TIMEOUT_MS + CALL_TIMEOUT_MS,
        );
        break;
      } catch (err) {
        if (err instanceof HerdrRefusal && err.code === "agent_name_taken" && attempt < MAX_NAME_ATTEMPTS) {
          name = agentName(spec.cwd, ++this.#seq);
          continue;
        }
        // a tab with a dead shell in it is litter in the user's terminal
        this.#forget(paneId);
        await this.#call("tab.close", { tab_id: tabId }).catch(() => undefined);
        throw err;
      }
    }

    console.error(
      `[bridge] herdr started ${spec.kind} as ${name} in pane ${paneId} of workspace ${placed.workspace} (${spec.cwd})`,
    );

    return {
      handle: paneId,
      focus: async () => {
        try {
          await this.#call("agent.focus", { target: paneId });
        } catch {
          // the pane may have lost its agent (the harness exited) while the tab
          // is still there to look at, and that is still the right answer to
          // "show me the terminal"
          await this.#call("tab.focus", { tab_id: tabId });
        }
        // herdr switched its own tab; the terminal is still behind the browser
        await this.#raise();
      },
      kill: async () => {
        this.#forget(paneId);
        await this.#call("tab.close", { tab_id: tabId });
      },
      onExit: (cb) => {
        sinks.exit.add(cb);
        return () => {
          sinks.exit.delete(cb);
        };
      },
      onStatus: (cb) => {
        sinks.status.add(cb);
        return () => {
          sinks.status.delete(cb);
        };
      },
      type: async (text) => {
        await this.#call("agent.prompt", { target: paneId, text });
      },
      interrupt: async () => {
        await this.#call("agent.send_keys", { target: paneId, keys: ["esc"] });
      },
    };
  }

  dispose(): void {
    for (const paneId of [...this.#panes.keys()]) this.#forget(paneId);
    this.#lifecycle?.close();
    this.#lifecycle = null;
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
   * Where this session's tab goes: the workspace that already hosts this
   * project, or a new one named after it. The cache is only ever a hint — the
   * user owns these workspaces and can close one between two launches — so
   * every launch re-lists and a stale entry is dropped rather than trusted.
   */
  async #place(spec: LaunchSpec): Promise<Placed> {
    const found = await this.#findWorkspace(spec);
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
        return { ...tabAndPane(created), workspace: found.label };
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
  async #findWorkspace(spec: LaunchSpec): Promise<{ id: string; label: string } | null> {
    const listed = await this.#call("workspace.list", {});
    const workspaces = (Array.isArray(listed.workspaces) ? listed.workspaces : []).map(asRecord);
    const cached = this.#workspaces.get(spec.project.path);
    const match =
      (cached === undefined ? undefined : workspaces.find((workspace) => workspace.workspace_id === cached)) ??
      workspaces.find((workspace) => {
        // plain workspaces carry no worktree at all; asRecord makes that a miss
        const worktree = asRecord(workspace.worktree);
        return worktree.repo_root === spec.project.path || worktree.checkout_path === spec.project.path;
      }) ??
      workspaces.find((workspace) => workspace.label === spec.project.label);
    if (match === undefined) {
      this.#workspaces.delete(spec.project.path);
      return null;
    }
    const id = asId(match.workspace_id);
    if (id === null) return null;
    return { id, label: typeof match.label === "string" ? match.label : spec.project.label };
  }

  /**
   * A workspace of this project's own, because nothing hosts it yet. herdr
   * answers with the workspace AND its first tab and root pane, so this
   * session takes that root tab — renamed to say which variation it is — and
   * the project's first session costs one call instead of two. The workspace
   * opens in the SESSION's directory: that is the tree this harness must
   * edit, and for a project's first session it is the main worktree anyway.
   */
  async #createWorkspace(spec: LaunchSpec): Promise<Placed> {
    const created = await this.#call("workspace.create", {
      cwd: spec.cwd,
      label: spec.project.label,
      env: spec.env,
      focus: false,
    });
    const workspaceId = asId(asRecord(created.workspace).workspace_id);
    if (workspaceId !== null) this.#workspaces.set(spec.project.path, workspaceId);
    const placed = { ...tabAndPane(created), workspace: spec.project.label };
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

  /** Stop watching a pane, releasing the connection its status came on. */
  #forget(paneId: string): PaneSinks | null {
    const sinks = this.#panes.get(paneId);
    if (sinks === undefined) return null;
    this.#panes.delete(paneId);
    sinks.statuses?.close();
    sinks.statuses = null;
    return sinks;
  }

  #onEvent(event: string, data: Record<string, unknown>): void {
    const paneId = typeof data.pane_id === "string" ? data.pane_id : null;
    if (paneId === null) return;
    const sinks = this.#panes.get(paneId);
    if (sinks === undefined) return;
    switch (event) {
      case "pane.agent_status_changed": {
        const status = typeof data.agent_status === "string" ? STATUSES[data.agent_status] : undefined;
        if (status === undefined) return;
        for (const cb of sinks.status) cb(status);
        return;
      }
      case "pane.exited":
      case "pane.closed": {
        if (sinks.gone) return;
        sinks.gone = true;
        this.#forget(paneId);
        const raw = data.exit_code;
        const code = typeof raw === "number" && Number.isInteger(raw) ? raw : null;
        for (const cb of sinks.exit) cb(code);
        return;
      }
      default:
        return;
    }
  }
}
