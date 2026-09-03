/**
 * The canvas tool as an MCP server — the universal channel.
 *
 * A harness that cannot host a tool for Shape can almost always load an MCP
 * server, so this process exposes exactly one tool, `canvas`, with the bridge's
 * own description and JSON-Schema, and forwards every call over the bridge's
 * WebSocket (`canvas_call` → `canvas_result`). Nothing about the canvas lives
 * here: the bridge validates and applies the ops and hands back the text the
 * agent should read.
 *
 * Launch line (see ./paths.ts): `node packages/link/src/mcp.ts`, with
 * `SHAPE_BRIDGE_URL` when the bridge is not on the default port.
 *
 * A missing bridge is a normal condition, not a crash: the agent gets a tool
 * error saying so and can carry on working.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import {
  BRIDGE_PORT,
  LINK_WS_PATH,
  CANVAS_TOOL_DESCRIPTION,
  CANVAS_TOOL_SCHEMA,
} from "../../shared/src/index.ts";
import type { LinkServerMsg } from "../../shared/src/link.ts";

const BRIDGE_URL = process.env.SHAPE_BRIDGE_URL ?? `ws://127.0.0.1:${BRIDGE_PORT}${LINK_WS_PATH}`;

/** the bridge answers a canvas call in milliseconds; this is only a deadlock guard */
const CALL_TIMEOUT_MS = 20_000;

const BRIDGE_DOWN = "Shape bridge is not running";

interface CallResult {
  text: string;
  isError: boolean;
}

/**
 * One lazily-(re)connected socket to the bridge. Lazy because the harness may
 * load this server long before a canvas exists, and because a bridge restart
 * must not require restarting the harness: the next call just reconnects.
 */
class BridgeLink {
  #socket: WebSocket | null = null;
  #connecting: Promise<WebSocket> | null = null;
  readonly #pending = new Map<string, (result: CallResult) => void>();
  #seq = 0;

  #connect(): Promise<WebSocket> {
    const open = this.#socket;
    if (open !== null && open.readyState === WebSocket.OPEN) return Promise.resolve(open);
    const inFlight = this.#connecting;
    if (inFlight !== null) return inFlight;

    const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
    this.#connecting = promise;
    const socket = new WebSocket(BRIDGE_URL);
    socket.on("open", () => {
      this.#socket = socket;
      this.#connecting = null;
      resolve(socket);
    });
    socket.on("error", (err: Error) => {
      this.#connecting = null;
      this.#socket = null;
      reject(err);
    });
    socket.on("close", () => {
      this.#socket = null;
      this.#connecting = null;
      // an in-flight call cannot be answered by a socket that is gone
      for (const settle of this.#pending.values()) settle({ text: BRIDGE_DOWN, isError: true });
      this.#pending.clear();
    });
    socket.on("message", (data: WebSocket.RawData) => {
      let frame: LinkServerMsg;
      try {
        frame = JSON.parse(data.toString()) as LinkServerMsg;
      } catch {
        return;
      }
      // the bridge greets every socket and broadcasts graphs; only results are ours
      if (frame.type !== "canvas_result") return;
      const settle = this.#pending.get(frame.id);
      if (settle === undefined) return;
      this.#pending.delete(frame.id);
      settle({ text: frame.text, isError: frame.isError });
    });
    return promise;
  }

  async call(args: unknown): Promise<CallResult> {
    let socket: WebSocket;
    try {
      socket = await this.#connect();
    } catch {
      return { text: BRIDGE_DOWN, isError: true };
    }

    this.#seq += 1;
    const id = `mcp-${process.pid}-${this.#seq}`;
    const { promise, resolve } = Promise.withResolvers<CallResult>();
    this.#pending.set(id, resolve);
    const timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return;
      resolve({ text: "Shape bridge did not answer the canvas call", isError: true });
    }, CALL_TIMEOUT_MS);
    try {
      socket.send(JSON.stringify({ type: "canvas_call", id, args }));
    } catch {
      this.#pending.delete(id);
      clearTimeout(timer);
      return { text: BRIDGE_DOWN, isError: true };
    }
    const result = await promise;
    clearTimeout(timer);
    return result;
  }
}

const link = new BridgeLink();

const server = new Server(
  { name: "shape", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "canvas",
      description: CANVAS_TOOL_DESCRIPTION,
      inputSchema: CANVAS_TOOL_SCHEMA as unknown as { type: "object" },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "canvas") {
    return {
      content: [{ type: "text" as const, text: `unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }
  const result = await link.call(request.params.arguments ?? {});
  return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
});

await server.connect(new StdioServerTransport());
