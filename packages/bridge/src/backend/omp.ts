/**
 * omp adapter: `omp --mode rpc` over JSONL (rpc.md protocol v1) behind the
 * Backend seam. Everything omp-frame-shaped lives here — lifecycle frames,
 * text-delta coalescing, the host tool round-trip, argument projection.
 */

import { RpcClient } from "../rpc.ts";
import type { RpcFrame } from "../rpc.ts";
import type { BackendCapabilities } from "../../../shared/src/index.ts";
import type { Backend, BackendEvents, BackendState } from "./types.ts";

const CAPABILITIES: BackendCapabilities = {
  steerMidTurn: true,
  hostTool: true,
  events: "native",
  resume: true,
  terminal: "shell",
};

/** Path-ish tokens out of a tool's (truncated) argument projection. */
function argPaths(args: unknown): string[] {
  if (args === null || typeof args !== "object") return [];
  const tokens: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    for (const token of value.split(/[\s'"`,;:()]+/)) {
      if (token.length > 0) tokens.push(token);
    }
  }
  return tokens;
}

function primaryArg(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  for (const key of ["path", "file", "command", "pattern", "query", "url"]) {
    if (key in args) {
      const value: unknown = Reflect.get(args, key);
      if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return "";
}

export class OmpBackend implements Backend {
  readonly id = "omp";
  readonly label = "omp";
  readonly capabilities = CAPABILITIES;
  readonly #command: string[];
  #rpc: RpcClient | null = null;
  #events: BackendEvents | null = null;
  /** text deltas of the message in flight; flushed on message_end/turn_end */
  #assistant = "";

  constructor(opts: { command: string[] }) {
    const command = [...opts.command];
    if (!command.includes("--mode")) command.push("--mode", "rpc");
    this.#command = command;
  }

  async start(opts: {
    cwd: string;
    events: BackendEvents;
    canvasTool: { description: string; schema: object };
  }): Promise<void> {
    const events = opts.events;
    this.#events = events;
    const rpc = new RpcClient({
      command: this.#command,
      cwd: opts.cwd,
      onEvent: (frame) => this.#onFrame(frame),
      onStderr: (text) => process.stderr.write(text),
      onExit: (code, signal) => events.onExit(`omp exited (code=${code} signal=${signal})`),
    });
    this.#rpc = rpc;

    const ready = await rpc.ready;
    console.error(`[bridge] omp ready (protocol ${String(ready.protocolVersion ?? "?")})`);

    const tools = await rpc.request({
      type: "set_host_tools",
      tools: [
        {
          name: "canvas",
          label: "Canvas",
          description: opts.canvasTool.description,
          parameters: opts.canvasTool.schema,
          loadMode: "essential",
        },
      ],
    });
    if (!tools.success) throw new Error(`set_host_tools failed: ${tools.error ?? "unknown"}`);
    console.error("[bridge] registered host tool: canvas");

    // A session that is already mid-turn when we attach must not look idle.
    const data = await this.#getState();
    if (data !== null && typeof data === "object") {
      if ("isCompacting" in data && data.isCompacting === true) events.onAgentState("compacting");
      else if ("isStreaming" in data && data.isStreaming === true) events.onAgentState("streaming");
    }
  }

  async state(): Promise<BackendState> {
    const data = await this.#getState();
    const state: BackendState = { streaming: false, sessionId: null, sessionName: null, model: null };
    if (data === null || typeof data !== "object") return state;
    if ("isStreaming" in data && data.isStreaming === true) state.streaming = true;
    if ("sessionId" in data && typeof data.sessionId === "string") state.sessionId = data.sessionId;
    if ("sessionName" in data && typeof data.sessionName === "string") state.sessionName = data.sessionName;
    if ("model" in data && data.model !== null && typeof data.model === "object") {
      const model = data.model;
      if ("provider" in model && typeof model.provider === "string" && "id" in model && typeof model.id === "string") {
        state.model = { provider: model.provider, id: model.id };
      }
    }
    return state;
  }

  async send(message: string, mode: "prompt" | "steer"): Promise<void> {
    const res = await this.#live().request({ type: mode, message });
    if (!res.success) throw new Error(`${mode} failed: ${res.error ?? "unknown"}`);
  }

  async abort(): Promise<void> {
    const res = await this.#live().request({ type: "abort" });
    if (!res.success) throw new Error(`abort failed: ${res.error ?? "unknown"}`);
  }

  /** Expected shutdown: stop whatever turn is running, then close stdin. */
  async dispose(): Promise<void> {
    const rpc = this.#rpc;
    this.#rpc = null;
    this.#events = null;
    if (rpc === null) return;
    rpc.send({ type: "abort" });
    await rpc.dispose();
  }

  #live(): RpcClient {
    const rpc = this.#rpc;
    if (rpc === null) throw new Error("omp is not running");
    return rpc;
  }

  async #getState(): Promise<unknown> {
    const res = await this.#live().request({ type: "get_state" });
    if (!res.success) throw new Error(`get_state failed: ${res.error ?? "unknown"}`);
    return res.data;
  }

  // -------------------------------------------------------------------------
  // omp frames -> BackendEvents
  // -------------------------------------------------------------------------

  #onFrame(frame: RpcFrame): void {
    const events = this.#events;
    if (events === null) return;
    switch (frame.type) {
      case "agent_start":
        events.onAgentState("streaming");
        return;
      case "agent_end":
        // a non-terminal agent_end is a sub-agent finishing, not the turn
        if (frame.isTerminal !== false) events.onAgentState("idle");
        return;
      case "auto_compaction_start":
        events.onAgentState("compacting");
        return;
      case "auto_compaction_end":
        events.onAgentState("streaming");
        return;
      case "message_update":
        this.#onDelta(frame.assistantMessageEvent);
        return;
      case "message_end":
        this.#flushAssistant(events);
        return;
      case "turn_end":
        this.#flushAssistant(events);
        events.onTurnEnd();
        return;
      case "tool_execution_start": {
        const args = "args" in frame ? frame.args : frame.input;
        events.onToolStart({
          name: typeof frame.toolName === "string" ? frame.toolName : "tool",
          paths: argPaths(args),
          summary: primaryArg(args),
        });
        return;
      }
      case "tool_execution_end":
        events.onToolEnd({
          name: typeof frame.toolName === "string" ? frame.toolName : "tool",
          isError: frame.isError === true,
        });
        return;
      case "host_tool_call":
        void this.#onHostToolCall(frame, events);
        return;
      case "extension_error":
        events.onError(`extension error: ${String(frame.error ?? "unknown")}`);
        return;
      case "bridge_parse_error":
        console.error(`[bridge] unparseable omp frame: ${String(frame.line)}`);
        return;
      default:
        return;
    }
  }

  #onDelta(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    if (!("type" in event) || event.type !== "text_delta") return;
    if (!("delta" in event) || typeof event.delta !== "string") return;
    this.#assistant += event.delta;
  }

  #flushAssistant(events: BackendEvents): void {
    const text = this.#assistant.trim();
    this.#assistant = "";
    if (text.length > 0) events.onAssistantText(text);
  }

  async #onHostToolCall(frame: RpcFrame, events: BackendEvents): Promise<void> {
    const id = frame.id;
    if (typeof id !== "string") return;

    if (frame.toolName !== "canvas") {
      this.#rpc?.send({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: `unknown host tool "${String(frame.toolName)}"` }] },
      });
      return;
    }

    let outcome: { text: string; isError: boolean };
    try {
      outcome = await events.onCanvasCall(frame.arguments);
    } catch (err) {
      outcome = { text: `canvas call failed: ${String(err)}`, isError: true };
    }
    this.#rpc?.send({
      type: "host_tool_result",
      id,
      ...(outcome.isError ? { isError: true } : {}),
      result: { content: [{ type: "text", text: outcome.text }] },
    });
  }
}
