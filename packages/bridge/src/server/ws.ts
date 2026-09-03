/**
 * The browser hub: one mount on the shared listener (`/ws`), every connected
 * canvas client, and the boundary validator for what they send. Server frames
 * are `ServerMsg`; inbound text is narrowed to `ClientMsg`.
 *
 * A handler gets a `reply` alongside the message: frames a caller asked for by
 * id go back to the socket that asked, never to everyone. Link frames are not
 * this socket's business — they arrive on the link and are validated in
 * `agent/linkparse.ts`.
 */

import type { WebSocket } from "ws";
import {
  BRIDGE_WS_PATH,
  type ClientMsg,
  type Referent,
  type ServerMsg,
} from "../../../shared/src/index.ts";
import type { SocketServer } from "../wsserver.ts";

/** Boundary validator for browser input. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null;
  if (parsed.type === "abort") return { type: "abort" };
  if (parsed.type === "onboard") {
    if ("focus" in parsed && typeof parsed.focus === "string") return { type: "onboard", focus: parsed.focus };
    return { type: "onboard" };
  }
  if (parsed.type === "switch_project") {
    if (!("path" in parsed) || typeof parsed.path !== "string" || parsed.path.trim().length === 0) return null;
    return { type: "switch_project", path: parsed.path.trim() };
  }
  if (parsed.type === "diff") {
    if (!("revA" in parsed) || typeof parsed.revA !== "number" || !Number.isInteger(parsed.revA)) return null;
    if (!("revB" in parsed) || typeof parsed.revB !== "number" || !Number.isInteger(parsed.revB)) return null;
    return { type: "diff", revA: parsed.revA, revB: parsed.revB };
  }
  if (parsed.type === "pty_open" || parsed.type === "pty_resize") {
    // a terminal size must be a real geometry: the pty is resized with it
    if (!("cols" in parsed) || typeof parsed.cols !== "number" || !Number.isInteger(parsed.cols) || parsed.cols <= 0) {
      return null;
    }
    if (!("rows" in parsed) || typeof parsed.rows !== "number" || !Number.isInteger(parsed.rows) || parsed.rows <= 0) {
      return null;
    }
    return { type: parsed.type, cols: parsed.cols, rows: parsed.rows };
  }
  if (parsed.type === "pty_input") {
    if (!("data" in parsed) || typeof parsed.data !== "string") return null;
    return { type: "pty_input", data: parsed.data };
  }
  if (parsed.type === "pty_close") return { type: "pty_close" };
  if (parsed.type === "discover") return { type: "discover" };
  if (parsed.type === "adopt") {
    if (!("pid" in parsed) || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return { type: "adopt", pid: parsed.pid };
  }
  if (parsed.type !== "utterance") return null;
  if (!("text" in parsed) || typeof parsed.text !== "string") return null;

  let referent: Referent | null = null;
  if ("referent" in parsed && parsed.referent !== null && typeof parsed.referent === "object") {
    const r = parsed.referent;
    if (
      "kind" in r &&
      "id" in r &&
      (r.kind === "node" || r.kind === "edge") &&
      typeof r.id === "string"
    ) {
      referent = { kind: r.kind, id: r.id };
    }
  }
  return { type: "utterance", referent, text: parsed.text };
}

export interface WsHubOptions {
  /** the shared listener; the hub takes BRIDGE_WS_PATH on it */
  sockets: SocketServer;
  /**
   * Frame sent to every newly connected client (worktrees are re-detected
   * here). `null` = there is nothing to say yet — no agent has attached, so the
   * client is greeted by a broadcast when the project opens.
   */
  hello: () => ServerMsg | null | Promise<ServerMsg | null>;
  /** `reply` reaches only the socket the message came from */
  onMessage: (msg: ClientMsg, reply: (msg: ServerMsg) => void) => void;
}

export class WsHub {
  readonly #clients = new Set<WebSocket>();
  /** connected while there was no room: owed a hello when one opens */
  readonly #ungreeted = new Set<WebSocket>();

  constructor(opts: WsHubOptions) {
    opts.sockets.mount(BRIDGE_WS_PATH, (socket) => {
      this.#clients.add(socket);
      // handlers first: hello is async, and a client may talk before it lands
      socket.on("message", (data) => {
        const msg = parseClientMsg(data.toString());
        if (msg === null) {
          socket.send(JSON.stringify({ type: "error", message: "unparseable client message" } satisfies ServerMsg));
          return;
        }
        opts.onMessage(msg, (out) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
        });
      });
      socket.on("close", () => {
        this.#clients.delete(socket);
        this.#ungreeted.delete(socket);
      });
      socket.on("error", () => {
        this.#clients.delete(socket);
        this.#ungreeted.delete(socket);
      });
      void Promise.resolve(opts.hello()).then((msg) => {
        if (socket.readyState !== socket.OPEN) return;
        if (msg === null) {
          this.#ungreeted.add(socket);
          return;
        }
        socket.send(JSON.stringify(msg));
      });
    });
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** the hello owed to sockets that connected before any room existed */
  greetPending(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const socket of this.#ungreeted) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
    this.#ungreeted.clear();
  }

  broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const socket of this.#clients) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }
}
