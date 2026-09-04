/**
 * The bridge end of the link: external processes talking the same WebSocket.
 *
 * Two frames, both from `packages/shared/src/link.ts`:
 * - `canvas_call` — the universal canvas channel for harnesses that cannot host
 *   a tool for us. The MCP server Shape ships (`packages/link/src/mcp.ts`) is
 *   just a caller: it forwards the tool arguments, we apply them to the graph,
 *   and the result goes back to the socket that asked, correlated by `id`.
 * - `agent_event` — one already-projected harness event, fed into the SAME
 *   `BackendEvents` the active backend uses. An adapter with no native event
 *   stream (Claude Code's hooks, a transcript tail) therefore gets activity,
 *   transcript lines and agent state for free, through the bridge's normal path.
 *
 * Both name the working directory the caller runs in, and that is how they are
 * routed: Shape runs one harness per worktree, each with its own event sink and
 * its own canvas, so a frame is only meaningful once the cwd it came from has
 * been resolved to one of them.
 *
 * The link is trusted exactly as much as the browser is: the socket is bound to
 * 127.0.0.1 and every frame was already validated in `agent/linkparse.ts`.
 */

import type { LinkClientMsg, LinkServerMsg } from "../../../shared/src/link.ts";
import type { BackendEvents } from "./backend/types.ts";

/** the session-bearing client's opening frame, as the validator hands it over */
export type LinkHello = Extract<LinkClientMsg, { type: "hello" }>;

/** The harness a link caller's cwd belongs to, as the runtime resolves it. */
export interface LinkTarget {
  /** apply canvas ops in that worktree and answer with what the agent should see */
  applyCanvas: (args: unknown) => Promise<{ text: string; isError: boolean }>;
  /** that harness's event sink — external events are indistinguishable from native ones */
  events: BackendEvents;
  /**
   * The three frames only a harness ON the link can send: it announced itself,
   * it acknowledged a `deliver`, its session ended. A target whose harness does
   * not speak the link (a hook, the MCP sidecar) never hears them, so an
   * adapter that has no session on the link leaves them out.
   *
   * `onHello` is handed the greeter's own channel, and that is the whole
   * point: a `deliver`, an `abort` or an `autonomous` is an ask of ONE session,
   * so it goes back down the socket that greeted and nowhere else.
   */
  onHello?: (hello: LinkHello, send: (msg: LinkServerMsg) => void) => void;
  onDelivered?: (receipt: { id: string; mode: "prompt" | "steer"; queued: boolean }) => void;
  onBye?: (reason: string) => void;
}

export interface ExternalIoOptions {
  /**
   * Map a caller's working directory to the harness that owns it, or refuse it
   * with a sentence the agent can read: a cwd outside the project, or a
   * variation nobody opened, has no sink to write to.
   */
  route: (cwd: string) => LinkTarget | { error: string };
}

export class ExternalIo {
  readonly #route: ExternalIoOptions["route"];

  constructor(opts: ExternalIoOptions) {
    this.#route = opts.route;
  }

  handle(msg: LinkClientMsg, reply: (msg: LinkServerMsg) => void): void {
    const target = this.#route(msg.cwd);
    if ("error" in target) {
      // a canvas call is a tool the harness is BLOCKED on: it hears the refusal
      // as a failed tool result, not as an `error` frame it does not read
      if (msg.type === "canvas_call") reply({ type: "canvas_result", id: msg.id, text: target.error, isError: true });
      else reply({ type: "error", message: target.error });
      return;
    }
    if (msg.type === "canvas_call") {
      const { id } = msg;
      // a canvas result belongs to the caller alone; the graph broadcast is the
      // part everyone else sees
      target.applyCanvas(msg.args).then(
        (result) => reply({ type: "canvas_result", id, text: result.text, isError: result.isError }),
        (err: unknown) =>
          reply({
            type: "canvas_result",
            id,
            text: `canvas call failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }),
      );
      return;
    }
    if (msg.type === "hello") {
      target.onHello?.(msg, reply);
      return;
    }
    if (msg.type === "delivered") {
      target.onDelivered?.({ id: msg.id, mode: msg.mode, queued: msg.queued });
      return;
    }
    if (msg.type === "bye") {
      target.onBye?.(msg.reason);
      return;
    }
    const events = target.events;
    const event = msg.event;
    switch (event.kind) {
      case "state":
        events.onAgentState(event.state);
        return;
      case "text":
        events.onAssistantText(event.text);
        return;
      case "text_delta":
        // the live "now" line only: a delta is never stored, and an adapter
        // that has nothing to show it in simply does not take them
        events.onTextDelta?.(event.delta);
        return;
      case "tool_start":
        events.onToolStart({ name: event.name, paths: event.paths, summary: event.summary });
        return;
      case "tool_end":
        events.onToolEnd({ name: event.name, isError: event.isError });
        return;
      case "turn_end":
        events.onTurnEnd();
        return;
      case "session":
        // hook-driven adapters cannot know their own session id: the harness
        // tells the bridge, not the adapter
        events.onSession?.({ sessionId: event.sessionId, model: event.model });
        return;
    }
  }
}
