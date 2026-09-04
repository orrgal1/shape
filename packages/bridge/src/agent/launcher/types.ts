/**
 * Launcher seam: HOW a harness gets a real terminal session, separate from
 * WHICH harness it is (that is `backend/`).
 *
 * Shape does not presume to be the terminal. When herdr is installed the
 * session runs in the user's own multiplexer — a real tab they can walk over
 * to — and Shape only asks for it to be focused. Otherwise Shape owns a pty
 * and the browser can open a drawer over the canvas.
 *
 * An adapter therefore never spawns anything itself: it composes an argv and
 * hands it to the launcher the agent chose at startup.
 */

import type { HarnessId } from "../../../../shared/src/index.ts";

/** herdr's five agent states; the generic adapter's only source of truth */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface LaunchSpec {
  /** where the harness runs: the worktree's directory */
  cwd: string;
  /** the worktree id this session belongs to, for the frames Shape sends about it */
  worktree: string;
  /** which harness this is; herdr needs it to recognize the pane */
  kind: HarnessId;
  /** the whole command line, argv[0] included (the executable) */
  argv: string[];
  /** added to the session's environment, never replacing it */
  env: Record<string, string>;
  /**
   * The project this session is a variation OF: its main worktree's realpath
   * and the name a human calls it. Launchers that host sessions somewhere
   * shared need it — herdr keeps every session of one project in ONE
   * workspace, one tab per variation, so the workspace has to be findable
   * (and namable) from the project rather than from the worktree.
   */
  project: { path: string; label: string };
  /** what the tab is called where a human can see it */
  label: string;
}

/**
 * One launched session. The launcher owns the process; the adapter owns what
 * is said to it. `onExit`/`onStatus` return their unsubscribe so a closed
 * variation leaves nothing attached.
 */
export interface Launched {
  /** the launcher's durable handle: a herdr pane id, or the pty's worktree */
  readonly handle: string;
  /** bring the session in front of the user, however this launcher can */
  focus(): Promise<void>;
  kill(): Promise<void>;
  onExit(cb: (code: number | null) => void): () => void;
  /**
   * Lifecycle as the LAUNCHER sees it, for harnesses that tell Shape nothing
   * themselves. Absent when the launcher cannot see inside the session.
   */
  onStatus?(cb: (status: AgentStatus) => void): () => void;
  /**
   * Type an utterance into the session as if the user had. Absent when this
   * launcher has no way in (nothing today, but a launcher that only observes
   * is a real possibility).
   */
  type?(text: string): Promise<void>;
  /**
   * Press Escape in the session: every TUI harness Shape drives reads that as
   * "stop what you are doing". Absent when the launcher cannot send keys.
   */
  interrupt?(): Promise<void>;
}

export interface Launcher {
  readonly id: "herdr" | "pty";
  readonly label: string;
  /**
   * Where this launcher's terminal lives, which is what the browser renders
   * from: the user's own terminal, or a pane Shape owns. "none" is the third
   * case — the session runs somewhere Shape can neither embed nor raise, so no
   * terminal is offered at all rather than a button that does nothing visible.
   */
  readonly terminal: "external" | "pane" | "none";
  launch(spec: LaunchSpec): Promise<Launched>;
  /** drop whatever the launcher holds process-wide (sockets, subscriptions) */
  dispose(): void;
}
