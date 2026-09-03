/**
 * The loopback link endpoint (`ws://127.0.0.1:<port>/link`): harness-side
 * processes — the MCP server (`packages/link/src/mcp.ts`), a Claude Code hook
 * (`packages/link/src/hook.ts`), any adapter sidecar — talking to the agent
 * runtime that owns their harness.
 *
 * It terminates on the AGENT half by design: those callers are children of the
 * harness, they hold no server credentials, and everything they say has to be
 * indistinguishable from what the native adapter reports (`ExternalIo` feeds
 * the runtime's own `BackendEvents`). A `canvas_call` is answered on the socket
 * that asked and nowhere else; the graph broadcast is the part everyone sees.
 *
 * Trusted exactly as much as the browser hub is: loopback bind plus per-frame
 * validation in `linkparse.ts`.
 */

import type { WebSocket } from "ws";
import { LINK_WS_PATH } from "../../../shared/src/index.ts";
import type { LinkServerMsg } from "../../../shared/src/link.ts";
import type { SocketServer } from "../wsserver.ts";
import type { BackendEvents } from "./backend/types.ts";
import { ExternalIo } from "./external.ts";
import { parseLinkMsg } from "./linkparse.ts";

/**
 * Boundary refusal, same wording as the browser hub's: a frame the agent cannot
 * make sense of is rejected whole, never half-applied. Pre-serialized because
 * it is a constant.
 */
const REFUSAL = JSON.stringify({ type: "error", message: "unparseable client message" } satisfies LinkServerMsg);

export interface LoopbackLinkOptions {
  /** forward to the server and resolve with the `canvas_result` it sends back */
  onCanvasCall: (args: unknown) => Promise<{ text: string; isError: boolean }>;
  /** the runtime's event sink — the same one the live backend writes to */
  events: BackendEvents;
}

export interface LoopbackLink {
  /** drop every connected caller (runtime stop, link teardown) */
  close(): void;
}

export function mountLoopbackLink(sockets: SocketServer, opts: LoopbackLinkOptions): LoopbackLink {
  const io = new ExternalIo({ applyCanvas: opts.onCanvasCall, events: opts.events });
  const clients = new Set<WebSocket>();

  sockets.mount(LINK_WS_PATH, (socket) => {
    clients.add(socket);
    // no hello here: a link client is not a browser, it only ever gets answers
    // to what it asked
    socket.on("message", (data) => {
      const msg = parseLinkMsg(data.toString());
      if (msg === null) {
        socket.send(REFUSAL);
        return;
      }
      io.handle(msg, (out) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
      });
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  return {
    close(): void {
      for (const socket of clients) socket.close();
      clients.clear();
    },
  };
}
