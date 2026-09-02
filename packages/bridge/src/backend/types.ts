/**
 * Backend seam: the only surface the bridge knows about a coding-agent CLI.
 *
 * Everything harness-specific (frame shapes, command names, how a turn ends)
 * lives behind this interface in `backend/<id>.ts`; the bridge keeps the parts
 * that need the canvas — the graph store, the preamble, activity mapping and
 * the steer-vs-prompt decision.
 */

import type { AgentState, BackendCapabilities } from "../../../shared/src/index.ts";

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
  onToolStart(call: BackendToolCall): void;
  onToolEnd(info: { name: string; isError: boolean }): void;
  /** the turn is over as far as tool activity goes */
  onTurnEnd(): void;
  /** bridge applies the ops and returns the result the agent should see */
  onCanvasCall(args: unknown): Promise<{ text: string; isError: boolean }>;
  /** the backend process is gone; the bridge cannot serve this project anymore */
  onExit(reason: string): void;
  onError(message: string): void;
}

export interface BackendState {
  streaming: boolean;
  sessionId: string | null;
  sessionName: string | null;
  model: { provider: string; id: string } | null;
}

export interface Backend {
  readonly id: string;
  readonly label: string;
  readonly capabilities: BackendCapabilities;
  /** spawn the CLI in `cwd` and register the canvas tool; resolves when usable */
  start(opts: {
    cwd: string;
    events: BackendEvents;
    canvasTool: { description: string; schema: object };
  }): Promise<void>;
  state(): Promise<BackendState>;
  send(message: string, mode: "prompt" | "steer"): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
