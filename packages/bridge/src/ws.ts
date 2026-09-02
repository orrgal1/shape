/**
 * WebSocket server for browser clients and for the link (ws://127.0.0.1:<port>/ws).
 * Server frames are `ServerMsg`; inbound text is narrowed to `ClientMsg`.
 *
 * A handler gets a `reply` alongside the message: frames a caller asked for by
 * id (canvas results) go back to the socket that asked, never to everyone.
 */

import { WebSocketServer, type WebSocket } from "ws";
import {
  BRIDGE_WS_PATH,
  type ClientMsg,
  type Referent,
  type ServerMsg,
} from "../../shared/src/index.ts";
import type { AgentEvent } from "../../shared/src/link.ts";

/** the six event kinds the link may report, validated field by field */
function parseAgentEvent(value: unknown): AgentEvent | null {
  if (value === null || typeof value !== "object" || !("kind" in value)) return null;
  // an object from JSON.parse, checked immediately above; every field below is
  // read as `unknown` and validated before it reaches the union
  const ev = value as Record<string, unknown>;
  switch (ev.kind) {
    case "state":
      if (ev.state !== "idle" && ev.state !== "streaming" && ev.state !== "compacting") return null;
      return { kind: "state", state: ev.state };
    case "text":
      if (typeof ev.text !== "string") return null;
      return { kind: "text", text: ev.text };
    case "tool_start": {
      if (typeof ev.name !== "string" || typeof ev.summary !== "string") return null;
      if (!Array.isArray(ev.paths) || ev.paths.some((p) => typeof p !== "string")) return null;
      // every element was just checked to be a string
      const paths = ev.paths as string[];
      return { kind: "tool_start", name: ev.name, paths, summary: ev.summary };
    }
    case "tool_end":
      if (typeof ev.name !== "string" || typeof ev.isError !== "boolean") return null;
      return { kind: "tool_end", name: ev.name, isError: ev.isError };
    case "turn_end":
      return { kind: "turn_end" };
    case "session": {
      if (ev.sessionId !== null && typeof ev.sessionId !== "string") return null;
      const raw = ev.model;
      let model: { provider: string; id: string } | null = null;
      if (raw !== null && raw !== undefined) {
        if (typeof raw !== "object") return null;
        // non-null object, checked immediately above
        const m = raw as Record<string, unknown>;
        if (typeof m.provider !== "string" || typeof m.id !== "string") return null;
        model = { provider: m.provider, id: m.id };
      }
      return { kind: "session", sessionId: ev.sessionId ?? null, model };
    }
    default:
      return null;
  }
}

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
  if (parsed.type === "canvas_call") {
    if (!("id" in parsed) || typeof parsed.id !== "string" || parsed.id.length === 0) return null;
    return { type: "canvas_call", id: parsed.id, args: "args" in parsed ? parsed.args : undefined };
  }
  if (parsed.type === "agent_event") {
    if (!("event" in parsed)) return null;
    const event = parseAgentEvent(parsed.event);
    if (event === null) return null;
    return { type: "agent_event", event };
  }
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
  port: number;
  host?: string;
  /** frame sent to every newly connected client (worktrees are re-detected here) */
  hello: () => ServerMsg | Promise<ServerMsg>;
  /** `reply` reaches only the socket the message came from */
  onMessage: (msg: ClientMsg, reply: (msg: ServerMsg) => void) => void;
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
        opts.onMessage(msg, (out) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
        });
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
