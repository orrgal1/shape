/**
 * The terminal pane's other half: one pseudo-terminal per open worktree,
 * running the user's login shell in that worktree's directory.
 *
 * One shared terminal per worktree by design: output is broadcast to every
 * attached browser and any of them can type. The alternative — a pty per
 * socket — makes "what did I just run in Shape" depend on which tab you are
 * looking at. The worktree is the boundary because its harness is: a variation
 * is opened and closed with its shell.
 *
 * This module owns the child; it never touches the graph, the agent, or the
 * socket set. `broadcast` is the only way out, and every frame it sends names
 * the worktree it came from.
 */

import { spawn, type IPty } from "@lydell/node-pty";
import type { PtyClientMsg, PtyServerMsg } from "../../../shared/src/pty.ts";

/**
 * A live terminal the pane can show instead of a shell: the harness's own
 * session, owned by the launcher that started it. `onData`/`onExit` return
 * their unsubscribe so a closed variation leaves nothing attached.
 */
export interface TerminalSource {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
}

const FALLBACK_SHELL = "/bin/zsh";

/** `pty_state.shell` while the pane shows the harness the user can type into */
const AGENT_SHELL = "agent";

/** a terminal smaller than this is a resize race, not a window */
const MIN_DIM = 1;
/** guards against a bogus frame asking for a 2-billion-column pty */
const MAX_DIM = 1000;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const PTY_MSG_TYPES: Record<string, true> = { pty_open: true, pty_input: true, pty_resize: true, pty_close: true };

/**
 * Terminal frames are routed before the graph protocol looks at a message, so
 * this is a `type`-only check — the payload is validated by the handler.
 */
export function isPtyMsg(msg: { type: string }): msg is PtyClientMsg {
  return PTY_MSG_TYPES[msg.type] === true;
}

function clampDim(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DIM, Math.max(MIN_DIM, Math.trunc(value)));
}

export class PtyManager {
  readonly #broadcast: (msg: PtyServerMsg) => void;
  readonly #shell = process.env.SHELL !== undefined && process.env.SHELL.length > 0 ? process.env.SHELL : FALLBACK_SHELL;
  /** the worktree this pane belongs to; stamped on every frame that goes out */
  readonly #worktree: string;
  readonly #cwd: string;
  #pty: IPty | null = null;
  /** last size the browser asked for; a fresh pty is spawned at this size */
  #cols = DEFAULT_COLS;
  #rows = DEFAULT_ROWS;
  /**
   * A harness TUI shown instead of the shell. The adapter owns the child, so
   * this manager never spawns or kills it — it only wires the pane to it.
   */
  #source: TerminalSource | null = null;
  #sourceAlive = false;
  /** unsubscribes for `#source`; dropped on the next attach */
  #sourceOff: Array<() => void> = [];

  /**
   * Terminal output arrives in many small chunks (a shell prompt alone is
   * several). One socket frame per chunk is pure overhead, so a turn's worth of
   * output is joined and sent on the next macrotask.
   */
  #pending: string[] = [];
  #flushing = false;
  #disposed = false;

  constructor(opts: { worktree: string; cwd: string; broadcast: (msg: PtyServerMsg) => void }) {
    this.#worktree = opts.worktree;
    this.#cwd = opts.cwd;
    this.#broadcast = opts.broadcast;
  }

  handle(msg: PtyClientMsg): void {
    if (this.#disposed) return;
    switch (msg.type) {
      case "pty_open":
        this.#cols = clampDim(msg.cols, this.#cols);
        this.#rows = clampDim(msg.rows, this.#rows);
        // an attached harness is already running: the pane joins it mid-flight
        // (its scrollback belongs to the program), nothing starts
        if (this.#source !== null) {
          this.#source.resize(this.#cols, this.#rows);
          this.#emitState();
          return;
        }
        // a second tab attaching must not restart the shell out from under the
        // first: answer with the state it can already see
        if (this.#pty !== null) {
          this.#pty.resize(this.#cols, this.#rows);
          this.#emitState();
          return;
        }
        this.#spawn();
        return;
      case "pty_input":
        if (typeof msg.data !== "string") return;
        if (this.#source !== null) {
          if (this.#sourceAlive) this.#source.write(msg.data);
          return;
        }
        if (this.#pty === null) return;
        this.#pty.write(msg.data);
        return;
      case "pty_resize": {
        const cols = clampDim(msg.cols, this.#cols);
        const rows = clampDim(msg.rows, this.#rows);
        if (cols === this.#cols && rows === this.#rows) return;
        this.#cols = cols;
        this.#rows = rows;
        if (this.#source !== null) this.#source.resize(cols, rows);
        else this.#pty?.resize(cols, rows);
        return;
      }
      case "pty_close":
        // the agent's own terminal is not closable from the pane — killing it
        // would take the session Shape is driving with it
        if (this.#source !== null) return;
        // deliberately keeps `#pty` set: the child's own exit is what reports
        // the close, so the browser learns about it the same way either way
        this.#pty?.kill();
        return;
    }
  }

  /**
   * Point the pane at a harness's own terminal instead of a project shell, or
   * back again with `null`. The launcher owns the source's child: attaching
   * only subscribes, detaching only unsubscribes. The session is joined
   * mid-flight — its scrollback belongs to the program that drew it.
   */
  attach(source: TerminalSource | null): void {
    if (this.#disposed || source === this.#source) return;
    for (const off of this.#sourceOff) off();
    this.#sourceOff = [];
    // a shell and a harness TUI must never share the pane
    if (source !== null) this.#detach();
    this.#source = source;
    this.#sourceAlive = source !== null;
    if (source !== null) {
      this.#sourceOff.push(
        source.onData((data) => {
          if (this.#source !== source) return;
          this.#pending.push(data);
          if (this.#flushing) return;
          this.#flushing = true;
          setImmediate(() => this.#flush());
        }),
        source.onExit((code) => {
          if (this.#source !== source) return;
          this.#sourceAlive = false;
          this.#flush();
          this.#broadcast({ type: "pty_exit", worktree: this.#worktree, code });
          this.#emitState();
        }),
      );
    }
    this.#emitState();
  }

  dispose(): void {
    this.#disposed = true;
    for (const off of this.#sourceOff) off();
    this.#sourceOff = [];
    this.#source = null;
    this.#detach();
    this.#pending = [];
  }

  /** kill the child without reporting it as a shell that exited on its own */
  #detach(): void {
    const term = this.#pty;
    if (term === null) return;
    this.#pty = null;
    this.#flush();
    try {
      term.kill();
    } catch {
      // already gone; nothing to report either way
    }
  }

  #spawn(): void {
    let term: IPty;
    try {
      term = spawn(this.#shell, ["-l"], {
        cwd: this.#cwd,
        cols: this.#cols,
        rows: this.#rows,
        name: "xterm-256color",
        encoding: "utf8",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          // lets a shell profile (or a nested agent) know where it is running
          SHAPE: "1",
        },
      });
    } catch (err) {
      // no error frame exists on this wire, and the pane is the right place to
      // read why it is empty
      const reason = err instanceof Error ? err.message : String(err);
      this.#broadcast({
        type: "pty_data",
        worktree: this.#worktree,
        data: `shape: could not start ${this.#shell} in ${this.#cwd}: ${reason}\r\n`,
      });
      this.#broadcast({ type: "pty_exit", worktree: this.#worktree, code: null });
      this.#emitState();
      return;
    }

    this.#pty = term;
    term.onData((data) => {
      if (this.#pty !== term) return;
      this.#pending.push(data);
      if (this.#flushing) return;
      this.#flushing = true;
      setImmediate(() => this.#flush());
    });
    term.onExit(({ exitCode, signal }) => {
      // a pty replaced by `dispose` is not news
      if (this.#pty !== term) return;
      this.#pty = null;
      this.#flush();
      this.#broadcast({
        type: "pty_exit",
        worktree: this.#worktree,
        code: signal !== undefined && signal !== 0 ? null : exitCode,
      });
      this.#emitState();
    });
    this.#emitState();
  }

  #flush(): void {
    this.#flushing = false;
    if (this.#pending.length === 0) return;
    const data = this.#pending.length === 1 ? this.#pending[0] : this.#pending.join("");
    this.#pending.length = 0;
    if (data === undefined || data.length === 0) return;
    this.#broadcast({ type: "pty_data", worktree: this.#worktree, data });
  }

  #emitState(): void {
    const source = this.#source;
    // an attached harness is "open" for as long as its own child lives
    const open = source !== null ? this.#sourceAlive : this.#pty !== null;
    // the pane says whose program it is showing: the project shell by name, or
    // the harness the launcher started in this worktree
    const shell = source === null ? this.#shell : AGENT_SHELL;
    this.#broadcast({ type: "pty_state", worktree: this.#worktree, open, shell, cwd: this.#cwd });
  }
}
