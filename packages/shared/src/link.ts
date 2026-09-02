/**
 * The link wire (external process ↔ bridge). Anything that is not a browser —
 * the MCP server Shape ships (`packages/link/src/mcp.ts`), a harness hook
 * (`packages/link/src/hook.ts`), or a future adapter sidecar — speaks these
 * frames over the same `ws://127.0.0.1:<port>/ws` endpoint the canvas uses.
 *
 * Two directions, both small:
 * - `canvas_call` is a host-tool round trip carried over the socket: the caller
 *   correlates by `id` and the answer (`canvas_result`) goes back to THAT socket
 *   only, never broadcast — a canvas result is nobody else's business.
 * - `agent_event` is one already-projected harness event. It feeds the very same
 *   `BackendEvents` the active backend uses, so an adapter with no native event
 *   stream (hooks, transcript tailing) still lights up activity, transcript and
 *   agent state.
 *
 * Types only — imported by both packages and by the link, so it must stay erasable.
 */

/** one harness event, already projected into the terms the bridge cares about */
export type AgentEvent =
  | { kind: "state"; state: "idle" | "streaming" | "compacting" }
  /** one whole assistant message (the sender coalesces deltas) */
  | { kind: "text"; text: string }
  /** `paths` are path-ish tokens for codeRefs matching; `summary` is human */
  | { kind: "tool_start"; name: string; paths: string[]; summary: string }
  | { kind: "tool_end"; name: string; isError: boolean }
  | { kind: "turn_end" }
  | { kind: "session"; sessionId: string | null; model: { provider: string; id: string } | null };

export type LinkClientMsg =
  /** answered to the SAME socket only, correlated by `id` */
  | { type: "canvas_call"; id: string; args: unknown }
  | { type: "agent_event"; event: AgentEvent };

export type LinkServerMsg = { type: "canvas_result"; id: string; text: string; isError: boolean };
