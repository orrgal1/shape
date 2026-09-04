/**
 * Shape's own launcher: the harness runs in a pseudo-terminal this process
 * owns, one per worktree, and the browser can open a drawer over the canvas to
 * watch and type into it.
 *
 * Used when herdr is absent — and in every smoke, because a fake harness in a
 * pty is a real session as far as everything above the launcher is concerned.
 * "Focus" is the one thing a pty cannot do for itself: there is no window to
 * raise, so it asks the browser to show the drawer instead.
 */

import { spawn, type IPty } from "@lydell/node-pty";
import type { PtyManager, TerminalSource } from "../pty.ts";
import type { Launched, LaunchSpec, Launcher } from "./types.ts";

/** the harness's own idea of a terminal, until the browser says otherwise */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/** A pty this launcher owns, projected onto the terminal pane's contract. */
class PtySession implements TerminalSource {
  readonly #pty: IPty;
  readonly #onData = new Set<(data: string) => void>();
  readonly #onExit = new Set<(code: number | null) => void>();

  constructor(pty: IPty) {
    this.#pty = pty;
    pty.onData((data) => {
      for (const cb of this.#onData) cb(data);
    });
    pty.onExit(({ exitCode, signal }) => {
      const code = signal !== undefined && signal !== 0 ? null : exitCode;
      for (const cb of this.#onExit) cb(code);
    });
  }

  write(data: string): void {
    this.#pty.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.#pty.resize(cols, rows);
    } catch {
      // the child is gone; its exit is already on its way to the pane
    }
  }

  onData(cb: (data: string) => void): () => void {
    this.#onData.add(cb);
    return () => {
      this.#onData.delete(cb);
    };
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.#onExit.add(cb);
    return () => {
      this.#onExit.delete(cb);
    };
  }

  /**
   * Type an utterance as the user would: bracketed paste keeps a multi-line
   * message one prompt instead of submitting each line, then Return sends it.
   * Every TUI harness Shape drives reads its prompt this way.
   */
  paste(text: string): void {
    this.#pty.write(`\x1b[200~${text.replaceAll("\r\n", "\n")}\x1b[201~`);
    this.#pty.write("\r");
  }

  kill(): void {
    try {
      this.#pty.kill();
    } catch {
      // already gone
    }
  }
}

export interface PtyLauncherOptions {
  /**
   * That worktree's terminal pane, or null when this agent runs without one
   * (`--allow-terminal` off). The session still runs; nobody can see it.
   */
  pane: (worktree: string) => PtyManager | null;
  /** ask the browser to bring the drawer up: the only "focus" a pty has */
  requestTerminal: (worktree: string) => void;
}

export class PtyLauncher implements Launcher {
  readonly id = "pty" as const;
  readonly label = "Shape's own terminal";
  /** Shape owns this pty, so the browser can render and drive it */
  readonly terminal = "pane" as const;

  readonly #pane: PtyLauncherOptions["pane"];
  readonly #requestTerminal: PtyLauncherOptions["requestTerminal"];

  constructor(opts: PtyLauncherOptions) {
    this.#pane = opts.pane;
    this.#requestTerminal = opts.requestTerminal;
  }

  async launch(spec: LaunchSpec): Promise<Launched> {
    const [command, ...args] = spec.argv;
    if (command === undefined) throw new Error(`nothing to run for ${spec.kind}`);
    const pane = this.#pane(spec.worktree);
    let pty: IPty;
    try {
      pty = spawn(command, args, {
        cwd: spec.cwd,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        name: "xterm-256color",
        encoding: "utf8",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          // lets the harness (and anything it starts) know where it is running
          SHAPE: "1",
          ...spec.env,
        },
      });
    } catch (err) {
      throw new Error(`could not start ${command} in ${spec.cwd}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const session = new PtySession(pty);
    // the pane shows the harness from the moment it exists, so a browser that
    // opens the drawer during startup joins the real thing
    pane?.attach(session);

    return {
      handle: spec.worktree,
      focus: async () => {
        this.#requestTerminal(spec.worktree);
      },
      kill: async () => {
        this.#pane(spec.worktree)?.attach(null);
        session.kill();
      },
      onExit: (cb) => session.onExit(cb),
      type: async (text) => {
        session.paste(text);
      },
      interrupt: async () => {
        session.write("\x1b");
      },
    };
  }

  dispose(): void {
    // every pty belongs to a launched session; closing those is the harness's
    // own teardown, not the launcher's
  }
}
