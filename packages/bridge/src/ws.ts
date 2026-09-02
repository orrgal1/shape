/**
 * WebSocket server for browser clients (ws://127.0.0.1:<port>/ws).
 * Server frames are `ServerMsg`; inbound text is narrowed to `ClientMsg`.
 */

import { WebSocketServer, type WebSocket } from "ws";
import {
  BRIDGE_WS_PATH,
  type ClientMsg,
  type Referent,
  type ServerMsg,
} from "../../shared/src/index.ts";

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
  port: number;
  host?: string;
  /** frame sent to every newly connected client (worktrees are re-detected here) */
  hello: () => ServerMsg | Promise<ServerMsg>;
  onMessage: (msg: ClientMsg) => void;
}

export class WsHub {
  readonly #server: WebSocketServer;
  readonly #clients = new Set<WebSocket>();

  constructor(opts: WsHubOptions) {
    this.#server = new WebSocketServer({
      port: opts.port,
      host: opts.host ?? "127.0.0.1",
      path: BRIDGE_WS_PATH,
    });

    this.#server.on("connection", (socket) => {
      this.#clients.add(socket);
      // handlers first: hello is async, and a client may talk before it lands
      socket.on("message", (data) => {
        const msg = parseClientMsg(data.toString());
        if (msg === null) {
          socket.send(JSON.stringify({ type: "error", message: "unparseable client message" } satisfies ServerMsg));
          return;
        }
        opts.onMessage(msg);
      });
      socket.on("close", () => this.#clients.delete(socket));
      socket.on("error", () => this.#clients.delete(socket));
      void Promise.resolve(opts.hello()).then((msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      });
    });
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  listening(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#server.once("listening", () => resolve());
    this.#server.once("error", reject);
    return promise;
  }

  broadcast(msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const socket of this.#clients) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  close(): Promise<void> {
    for (const socket of this.#clients) socket.close();
    this.#clients.clear();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#server.close(() => resolve());
    return promise;
  }
}
