/**
 * Backend seam: the only surface the bridge knows about a coding harness.
 *
 * Everything harness-specific (how it is started, how a turn ends, how an
 * utterance gets in) lives behind this interface in `backend/<id>.ts`; the
 * bridge keeps the parts that need the canvas — the graph store, the preamble,
 * activity mapping and the steer-vs-prompt decision.
 *
 * An adapter never spawns anything: it composes an argv and hands it to the
 * `Launcher` the agent chose, so the session is always a real terminal
 * session someone could have started by hand.
 */

import type { AgentState, BackendCapabilities } from "../../../../shared/src/index.ts";
import type { LinkServerMsg } from "../../../../shared/src/link.ts";
import type { LinkHello } from "../external.ts";
import type { Launched, Launcher } from "../launcher/types.ts";

/** one tool invocation, already projected into canvas terms */
export interface BackendToolCall {
  name: string;
  /** path-ish tokens from the call's arguments, for codeRefs matching */
  paths: string[];
  /** short human summary of the call's primary argument ("" when there is none) */
  summary: string;
}

export interface BackendEvents {
  onAgentState(state: AgentState): void;
  /** one whole assistant message, coalesced by the adapter */
  onAssistantText(text: string): void;
  /**
   * A fragment of the message being written right now, for the live "now"
   * line. Optional: an adapter with no streaming surface never reports one,
   * and nothing downstream stores them.
   */
  onTextDelta?(delta: string): void;
  onToolStart(call: BackendToolCall): void;
  onToolEnd(info: { name: string; isError: boolean }): void;
  /** the turn is over as far as tool activity goes */
  onTurnEnd(): void;
  /** bridge applies the ops and returns the result the agent should see */
  onCanvasCall(args: unknown): Promise<{ text: string; isError: boolean }>;
  /**
   * The harness told us which session/model it is on. Adapters that learn it
   * out of band (a hook process, the loopback link) report it whenever it
   * arrives, which may be long after the session started.
   */
  onSession?(info: { sessionId: string | null; model: { provider: string; id: string } | null }): void;
  /** this harness's session is gone; the worktree keeps its canvas */
  onExit(reason: string): void;
  onError(message: string): void;
}

/** everything an adapter needs to put a session on screen */
export interface BackendStart {
  /** how the session gets a terminal: the user's own, or one Shape owns */
  launcher: Launcher;
  /** the worktree id this session belongs to */
  worktree: string;
  /** where the harness runs (the worktree's directory) */
  cwd: string;
  /**
   * The project this variation belongs to: its main worktree's realpath and
   * its display name. Passed straight to the launcher, which may need to
   * group a project's sessions (herdr: one workspace per project).
   */
  project: { path: string; label: string };
  /** `ws://127.0.0.1:<port>/link` of THIS agent, for harnesses on the link */
  linkUrl: string;
  /** start it with its own approval prompts off */
  autonomous: boolean;
  events: BackendEvents;
  /** resume this harness session instead of starting a fresh one */
  resumeSessionId?: string;
}

export interface Backend {
  readonly id: string;
  readonly label: string;
  /**
   * What this harness can do, as launched. Only meaningful once `start` has
   * resolved: a harness on the loopback link tells Shape what it supports in
   * its `hello`, and the launcher decides where its terminal lives.
   */
  readonly capabilities: BackendCapabilities;
  /**
   * Put a session on screen and return the launcher's handle for it. Resolves
   * when the session is USABLE — for a harness on the link, when it has
   * greeted; for one driven by typing, when the launcher says it is up.
   */
  start(opts: BackendStart): Promise<Launched>;
  /** the harness's own session id and model, as far as the adapter knows */
  session(): { sessionId: string | null; model: { provider: string; id: string } | null };
  send(message: string, mode: "prompt" | "steer"): Promise<void>;
  abort(): Promise<void>;
  /** approvals on or off for a session that is already running */
  setAutonomous(on: boolean): Promise<void>;
  dispose(): Promise<void>;

  /**
   * The loopback frames only a harness that speaks the link ever sends. An
   * adapter driven by hooks or by typing leaves them out, and the runtime
   * simply has nothing to hand over.
   */
  onHello?(hello: LinkHello, send: (msg: LinkServerMsg) => void): void;
  onDelivered?(receipt: { id: string; mode: "prompt" | "steer"; queued: boolean }): void;
  onBye?(reason: string): void;
}
