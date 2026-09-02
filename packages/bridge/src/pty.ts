/**
 * The terminal pane's other half: one pseudo-terminal per bridge, running the
 * user's login shell in whatever project the bridge currently targets.
 *
 * Single shared terminal by design (v1): output is broadcast to every attached
 * browser and any of them can type. The alternative — a pty per socket — makes
 * "what did I just run in Shape" depend on which tab you are looking at.
 *
 * This module owns the child; it never touches the graph, the agent, or the
 * socket set. `broadcast` is the only way out.
 */

import { spawn, type IPty } from "@lydell/node-pty";
import type { PtyClientMsg, PtyServerMsg } from "../../shared/src/pty.ts";

const FALLBACK_SHELL = "/bin/zsh";

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

  #cwd: string;
  #pty: IPty | null = null;
  /** last size the browser asked for; a fresh pty is spawned at this size */
  #cols = DEFAULT_COLS;
  #rows = DEFAULT_ROWS;

  /**
   * Terminal output arrives in many small chunks (a shell prompt alone is
   * several). One socket frame per chunk is pure overhead, so a turn's worth of
   * output is joined and sent on the next macrotask.
   */
  #pending: string[] = [];
  #flushing = false;
  #disposed = false;

  constructor(opts: { cwd: string; broadcast: (msg: PtyServerMsg) => void }) {
    this.#cwd = opts.cwd;
    this.#broadcast = opts.broadcast;
  }

  handle(msg: PtyClientMsg): void {
    if (this.#disposed) return;
    switch (msg.type) {
      case "pty_open":
        this.#cols = clampDim(msg.cols, this.#cols);
        this.#rows = clampDim(msg.rows, this.#rows);
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
        if (typeof msg.data !== "string" || this.#pty === null) return;
        this.#pty.write(msg.data);
        return;
      case "pty_resize": {
        const cols = clampDim(msg.cols, this.#cols);
        const rows = clampDim(msg.rows, this.#rows);
        if (cols === this.#cols && rows === this.#rows) return;
        this.#cols = cols;
        this.#rows = rows;
        this.#pty?.resize(cols, rows);
        return;
      }
      case "pty_close":
        // deliberately keeps `#pty` set: the child's own exit is what reports
        // the close, so the browser learns about it the same way either way
        this.#pty?.kill();
        return;
    }
  }

  /**
   * Follow a `switch_project`. The shell's cwd is a fact about the old project,
   * so the child goes; a terminal that was on screen comes back in the new
   * project rather than leaving an empty pane behind.
   */
  retarget(cwd: string): void {
    if (this.#disposed) return;
    this.#cwd = cwd;
    const wasOpen = this.#pty !== null;
    this.#detach();
    if (wasOpen) this.#spawn();
    else this.#emitState();
  }

  dispose(): void {
    this.#disposed = true;
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
      this.#broadcast({ type: "pty_data", data: `shape: could not start ${this.#shell} in ${this.#cwd}: ${reason}\r\n` });
      this.#broadcast({ type: "pty_exit", code: null });
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
      // a pty replaced by `retarget`/`dispose` is not news
      if (this.#pty !== term) return;
      this.#pty = null;
      this.#flush();
      this.#broadcast({ type: "pty_exit", code: signal !== undefined && signal !== 0 ? null : exitCode });
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
    this.#broadcast({ type: "pty_data", data });
  }

  #emitState(): void {
    this.#broadcast({ type: "pty_state", open: this.#pty !== null, shell: this.#shell, cwd: this.#cwd });
  }
}
