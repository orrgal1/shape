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
 * The link is trusted exactly as much as the browser is: the socket is bound to
 * 127.0.0.1 and every frame was already validated in `ws.ts`.
 */

import type { LinkClientMsg, LinkServerMsg } from "../../shared/src/link.ts";
import type { BackendEvents } from "./backend/types.ts";

const LINK_MSG_TYPES: Record<string, true> = { canvas_call: true, agent_event: true };

/**
 * Link frames are routed before the graph protocol looks at a message, so this
 * is a `type`-only check — the payload was validated in `parseClientMsg`.
 */
export function isLinkMsg(msg: { type: string }): msg is LinkClientMsg {
  return LINK_MSG_TYPES[msg.type] === true;
}

export interface ExternalIoOptions {
  /** apply canvas ops and answer with what the agent should see */
  applyCanvas: (args: unknown) => Promise<{ text: string; isError: boolean }>;
  /** the live backend's event sink — external events are indistinguishable from native ones */
  events: BackendEvents;
}

export class ExternalIo {
  readonly #applyCanvas: ExternalIoOptions["applyCanvas"];
  readonly #events: BackendEvents;

  constructor(opts: ExternalIoOptions) {
    this.#applyCanvas = opts.applyCanvas;
    this.#events = opts.events;
  }

  handle(msg: LinkClientMsg, reply: (msg: LinkServerMsg) => void): void {
    if (msg.type === "canvas_call") {
      const { id } = msg;
      // a canvas result belongs to the caller alone; the graph broadcast is the
      // part everyone else sees
      this.#applyCanvas(msg.args).then(
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
    const events = this.#events;
    const event = msg.event;
    switch (event.kind) {
      case "state":
        events.onAgentState(event.state);
        return;
      case "text":
        events.onAssistantText(event.text);
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
