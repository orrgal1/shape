/**
 * The omp extension: Shape's harness layer, from inside the omp process.
 *
 * omp exposes no external IPC for a live *interactive* session — no socket, no
 * port, nothing to attach to (agent://OmpExtensionMap). The one sanctioned way
 * in is an extension loaded with `--extension`, which runs in-process and may
 * hold a socket for the session's life. So this file is the omp end of the
 * loopback link: it registers the `canvas` tool, forwards every event the
 * canvas cares about, and delivers what the user says back into the session.
 *
 * The backend launches it as
 *   SHAPE_LINK=ws://127.0.0.1:4400/link SHAPE_WORKTREE=<id> \
 *     omp --extension /abs/path/packages/link/src/omp-extension.ts
 * `SHAPE_LINK` is the only variable read here: every frame is keyed by `cwd`
 * (`ctx.cwd`), which is what the bridge resolves the worktree from, so
 * `SHAPE_WORKTREE` is the launcher's own bookkeeping and is not read.
 *
 * Runs under omp's Bun. Global `WebSocket` only — no node imports, no deps, so
 * the file is loadable straight from the checkout by a Bun `import()`. The
 * frames it builds and the pending-call correlator come from `./frames.ts`,
 * which holds to the same rules: `./cli.ts` speaks the identical wire from
 * Node, and a frame built twice is a frame that eventually differs.
 */

import { CANVAS_TOOL_DESCRIPTION, CANVAS_TOOL_SCHEMA } from "../../shared/src/index.ts";
import type { AgentEvent, LinkClientMsg, LinkServerMsg } from "../../shared/src/link.ts";
import {
  agentEventFrame,
  byeFrame,
  CALL_TIMEOUT_MS,
  CanvasCalls,
  canvasCallFrame,
  deliveredFrame,
  helloFrame,
  parseServerFrame,
  socketMessageText,
  UNREACHABLE,
  type CallResult,
  type LinkSocket,
} from "./frames.ts";

// ---------------------------------------------------------------------------
// The omp surface we use
// ---------------------------------------------------------------------------

/**
 * `@oh-my-pi/pi-coding-agent` is not a dependency of this workspace (omp is
 * the host, not a library we build against), so the slice of `ExtensionAPI` /
 * `ExtensionContext` this file touches is declared here. Names match the
 * documented API exactly (omp://extensions.md); everything optional is
 * feature-detected before use, because an older omp build may not have it.
 */
interface ExtensionCtx {
  readonly cwd: string;
  readonly sessionManager?: {
    getSessionId?: () => string | null | undefined;
    getSessionFile?: () => string | null | undefined;
  };
  readonly models?: { current?: () => unknown };
  readonly model?: unknown;
  /** documented on ExtensionContext: stop the run in flight */
  abort?: () => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
}

interface ToolTextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** the zod-compatible builder omp injects as `pi.zod` (backed by omptype) */
interface ZodType {
  optional: () => ZodType;
  nullable: () => ZodType;
  describe?: (text: string) => ZodType;
  min?: (n: number) => ZodType;
  max?: (n: number) => ZodType;
}

interface ZodBuilder {
  object: (shape: Record<string, ZodType>) => ZodType;
  array: (items: ZodType) => ZodType;
  string: () => ZodType;
  number: () => ZodType;
  boolean: () => ZodType;
  enum: (values: readonly string[]) => ZodType;
  unknown: () => ZodType;
}

interface ExtensionApi {
  on: (event: string, handler: (event: unknown, ctx: ExtensionCtx) => unknown) => void;
  registerTool: (definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    loadMode?: string;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionCtx,
    ) => Promise<ToolTextResult>;
  }) => void;
  /** the prompt path: idle starts a turn, mid-turn queues as a steer */
  sendUserMessage?: (content: string, options?: { deliverAs?: string }) => unknown;
  /** older builds only expose the generic delivery entry point */
  sendMessage?: (message: string, options?: { deliverAs?: string }) => unknown;
  logger?: { info?: (message: string) => void; error?: (message: string) => void };
  zod: ZodBuilder;
}

/**
 * The WHATWG socket constructor Bun puts on the global. Declared locally
 * because this package's tsconfig has no DOM lib and the runtime one is what
 * we bind to; the socket's own shape is `LinkSocket` in `./frames.ts`, shared
 * with the CLI.
 */
declare const WebSocket: {
  new (url: string): LinkSocket;
  readonly OPEN: number;
};

// ---------------------------------------------------------------------------
// Small readers over outside data
// ---------------------------------------------------------------------------

/** event payloads and model objects arrive as `unknown`; this admits them */
function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Path-ish tokens out of a tool's argument projection, for codeRefs matching.
 * Same rule the bridge's own event sink applies to hook-reported calls, so a
 * bubble matches the same tool calls whichever channel reported them.
 */
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

/** the one argument worth showing a human, same key order as the rpc adapter */
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

/** the text blocks of a message snapshot, concatenated */
function messageText(message: unknown): string {
  const entry = record(message);
  if (entry === null) return "";
  const content = entry.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    const block = record(part);
    if (block === null || block.type !== "text") continue;
    if (typeof block.text === "string") text += block.text;
  }
  return text;
}

/** `{ provider, id }` out of whatever omp calls a model */
function modelOf(value: unknown): { provider: string; id: string } | null {
  const model = record(value);
  if (model === null) return null;
  const provider = str(model.provider);
  const id = str(model.id);
  if (provider === null || id === null) return null;
  return { provider, id };
}

// ---------------------------------------------------------------------------
// The canvas tool's parameters
// ---------------------------------------------------------------------------

/**
 * `CANVAS_TOOL_SCHEMA` is the one canvas contract (the MCP server and the
 * native host tool hand omp exactly that JSON Schema), but `registerTool`
 * wants a *callable* schema: omp's own detection contract calls a plain object
 * "JSON Schema" and only a callable with `.assert`/`.toJsonSchema` an omptype
 * schema (omp://omptype-guide.md), and only the latter is what an extension
 * tool is validated with. omptype's `fromJsonSchema` is not on the injected
 * `pi.zod` / `pi.arktype` surface, so the schema is translated here instead of
 * hand-mirrored: a mirror would silently drift from the shared enums the
 * canvas actually validates against.
 *
 * The translation covers the keywords the canvas schema uses and degrades
 * anything else to `unknown` rather than throwing — a schema is the model's
 * guide rail, while the authority on a malformed op is the bridge, which
 * answers with a repair receipt either way.
 */
function schemaToZod(schema: unknown, z: ZodBuilder): ZodType {
  const node = record(schema);
  if (node === null) return z.unknown();

  const types = Array.isArray(node.type) ? node.type.filter((t) => typeof t === "string") : [node.type];
  const nullable = types.includes("null");
  const kind = types.find((t) => typeof t === "string" && t !== "null");

  let built: ZodType;
  switch (kind) {
    case "object": {
      const properties = record(node.properties) ?? {};
      const required = Array.isArray(node.required) ? node.required : [];
      const shape: Record<string, ZodType> = {};
      for (const [key, value] of Object.entries(properties)) {
        const field = schemaToZod(value, z);
        shape[key] = required.includes(key) ? field : field.optional();
      }
      built = z.object(shape);
      break;
    }
    case "array": {
      built = z.array(schemaToZod(node.items, z));
      if (typeof node.minItems === "number") built = built.min?.(node.minItems) ?? built;
      if (typeof node.maxItems === "number") built = built.max?.(node.maxItems) ?? built;
      break;
    }
    case "string": {
      const values = Array.isArray(node.enum) ? node.enum.filter((v) => typeof v === "string") : null;
      built = values !== null && values.length > 0 ? z.enum(values) : z.string();
      if (values === null && typeof node.maxLength === "number") {
        built = built.max?.(node.maxLength) ?? built;
      }
      break;
    }
    case "number":
    case "integer":
      built = z.number();
      break;
    case "boolean":
      built = z.boolean();
      break;
    default:
      built = z.unknown();
      break;
  }

  if (nullable) built = built.nullable();
  const description = str(node.description);
  if (description !== null) built = built.describe?.(description) ?? built;
  return built;
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

/** reconnect floor and ceiling: a restarted bridge is back within seconds */
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 8_000;

/**
 * One socket to the bridge, held for the session's life and re-dialled on a
 * backoff when the bridge restarts. Everything crossing the wire goes through
 * here so there is a single place that knows whether Shape is listening.
 */
class ShapeLink {
  readonly #url: string;
  readonly #calls = new CanvasCalls(CALL_TIMEOUT_MS);
  #socket: LinkSocket | null = null;
  #dialling = false;
  #backoffMs = BACKOFF_MIN_MS;
  #nextDialAt = 0;
  /** the frames to (re)send the moment a socket opens: hello, then session */
  #greeting: () => LinkClientMsg[] = () => [];
  #onServer: (frame: LinkServerMsg) => void = () => {};
  #log: (message: string) => void = () => {};

  constructor(url: string) {
    this.#url = url;
  }

  start(opts: {
    greeting: () => LinkClientMsg[];
    onServer: (frame: LinkServerMsg) => void;
    log: (message: string) => void;
  }): void {
    this.#greeting = opts.greeting;
    this.#onServer = opts.onServer;
    this.#log = opts.log;
    this.#dial();
  }

  get open(): boolean {
    return this.#socket !== null && this.#socket.readyState === WebSocket.OPEN;
  }

  /** an event is worth nothing once it is late: a closed link drops it */
  send(frame: LinkClientMsg): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // the close handler will re-dial; this frame is gone either way
    }
  }

  /** called on a managed 1 s tick: dials when the backoff has elapsed */
  tick(): void {
    if (this.#socket !== null || this.#dialling) return;
    if (Date.now() < this.#nextDialAt) return;
    this.#dial();
  }

  async call(cwd: string, id: string, args: unknown): Promise<CallResult> {
    if (!this.open) return { text: UNREACHABLE, isError: true };
    // registered before the frame goes out: a result on the same tick is still ours
    const answer = this.#calls.open(id);
    this.send(canvasCallFrame(cwd, id, args));
    return answer;
  }

  /** the tool call was cancelled: the answer, if it ever comes, is nobody's */
  cancel(id: string, text: string): void {
    this.#calls.cancel(id, text);
  }

  nextId(prefix: string): string {
    return this.#calls.nextId(prefix);
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#calls.settleAll(UNREACHABLE);
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      // already gone
    }
  }

  #dial(): void {
    this.#dialling = true;
    let socket: LinkSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch (err) {
      this.#dialling = false;
      this.#retry();
      this.#log(`link dial failed: ${String(err)}`);
      return;
    }

    socket.addEventListener("open", () => {
      this.#socket = socket;
      this.#dialling = false;
      this.#backoffMs = BACKOFF_MIN_MS;
      for (const frame of this.#greeting()) this.send(frame);
    });
    socket.addEventListener("close", () => {
      this.#dialling = false;
      const wasOpen = this.#socket === socket;
      this.#socket = null;
      this.#calls.settleAll(UNREACHABLE);
      this.#retry();
      if (wasOpen) this.#log("link closed; reconnecting");
    });
    socket.addEventListener("error", () => {
      // `close` always follows; the backoff is armed there
      this.#dialling = false;
    });
    socket.addEventListener("message", (event: unknown) => {
      const text = socketMessageText(event);
      if (text === null) return;
      const frame = parseServerFrame(text);
      if (frame === null) return;
      // a result belongs to the call that asked; everything else is an ask of
      // the session, which the extension answers
      if (frame.type === "canvas_result") {
        this.#calls.settle(frame);
        return;
      }
      this.#onServer(frame);
    });
  }

  #retry(): void {
    this.#nextDialAt = Date.now() + this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export default function shapeExtension(pi: ExtensionApi): void {
  const url = process.env.SHAPE_LINK ?? "";
  const log = (message: string): void => {
    if (pi.logger?.info !== undefined) pi.logger.info(`[shape] ${message}`);
    else console.error(`[shape] ${message}`);
  };

  let link: ShapeLink | null = null;
  let session: ExtensionCtx | null = null;
  let cwd = "";
  /** deltas of the message in flight, in case a snapshot arrives without text */
  let assistant = "";
  /** our own idea of the turn, so a compaction that ends mid-turn is not "idle" */
  let streaming = false;
  /**
   * Autonomous mode, flipped by the bridge. It makes `tool_call` allow every
   * call, which is NOT the same as approving one: per agent://OmpExtensionMap
   * the TUI's approval gate is a separate stage an extension cannot open, so a
   * session that must never prompt is launched with `--approval-mode yolo`.
   * This flag is the mid-session best effort on top of that.
   */
  let autonomous = false;

  const sessionEvent = (ctx: ExtensionCtx): AgentEvent => {
    const manager = ctx.sessionManager;
    const sessionId = str(manager?.getSessionId?.());
    const sessionFile = str(manager?.getSessionFile?.());
    const model = modelOf(ctx.models?.current?.()) ?? modelOf(ctx.model);
    return { kind: "session", sessionId, sessionFile, model };
  };

  const greeting = (): LinkClientMsg[] => {
    const ctx = session;
    if (ctx === null) return [];
    const event = sessionEvent(ctx);
    const identity = event.kind === "session" ? event : null;
    return [
      helloFrame({
        cwd,
        harness: "omp",
        sessionId: identity?.sessionId ?? null,
        sessionFile: identity?.sessionFile ?? null,
        model: identity?.model ?? null,
        // the extension owns both: `sendUserMessage` steers, `canvas` is ours
        capabilities: { steer: true, tool: true },
      }),
      agentEventFrame(cwd, event),
    ];
  };

  const emit = (event: AgentEvent): void => {
    link?.send(agentEventFrame(cwd, event));
  };

  const state = (value: "idle" | "streaming" | "compacting"): void => {
    emit({ kind: "state", state: value });
  };

  const deliver = (frame: { id: string; body: string; mode: "prompt" | "steer" }): void => {
    const options = frame.mode === "steer" ? { deliverAs: "steer" } : {};
    const send = pi.sendUserMessage ?? pi.sendMessage;
    if (send === undefined) {
      log("this omp build has neither sendUserMessage nor sendMessage; cannot deliver");
      return;
    }
    void Promise.resolve(send.call(pi, frame.body, options)).catch((err: unknown) => {
      log(`deliver failed: ${String(err)}`);
    });
    // `sendUserMessage` prompts when idle and steers mid-turn on its own, so
    // nothing is ever left waiting for a later turn: `queued` is always false
    link?.send(deliveredFrame(cwd, frame.id, frame.mode, false));
  };

  const onServer = (frame: LinkServerMsg): void => {
    switch (frame.type) {
      case "deliver":
        deliver(frame);
        return;
      case "abort":
        // ExtensionContext.abort() is the documented stop-the-run entry point
        if (session?.abort !== undefined) session.abort();
        else log("this omp build has no ctx.abort; abort ignored");
        return;
      case "autonomous":
        autonomous = frame.on;
        return;
      case "error":
        log(`bridge rejected a frame: ${frame.message}`);
        return;
      case "canvas_result":
        // answered inside the link, which correlates it with its caller
        return;
      default:
        return;
    }
  };

  pi.registerTool({
    name: "canvas",
    label: "Canvas",
    description: CANVAS_TOOL_DESCRIPTION,
    parameters: schemaToZod(CANVAS_TOOL_SCHEMA, pi.zod),
    // the canvas is the user's only view of the work: never unloaded
    loadMode: "essential",
    async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<ToolTextResult> {
      const live = link;
      if (live === null || !live.open) {
        return { content: [{ type: "text", text: UNREACHABLE }], isError: true };
      }
      const id = typeof toolCallId === "string" && toolCallId.length > 0
        ? `omp-${toolCallId}`
        : live.nextId("omp-call");
      const onAbort = (): void => live.cancel(id, "canvas call aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      const target = str(ctx.cwd) ?? cwd;
      try {
        const result = await live.call(target, id, params);
        return { content: [{ type: "text", text: result.text }], isError: result.isError };
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    session = ctx;
    cwd = ctx.cwd;
    if (url === "") {
      log("SHAPE_LINK is not set; the canvas link stays closed");
      return;
    }
    const live = new ShapeLink(url);
    link = live;
    live.start({ greeting, onServer, log });
    // one managed tick owns reconnection: a raw timer that throws would take
    // the whole session down (omp://extensions.md "Background work")
    const timer = ctx.setInterval(() => live.tick(), BACKOFF_MIN_MS);
    pi.on("session_shutdown", () => ctx.clearTimer(timer));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    link?.send(byeFrame(cwd || ctx.cwd, "session shutdown"));
    link?.close();
    link = null;
    session = null;
  });

  pi.on("agent_start", () => {
    streaming = true;
    state("streaming");
  });

  pi.on("agent_end", (event) => {
    // a non-terminal agent_end means async work will resume the session, so
    // the turn is not over (omp://sdk.md); an absent field is terminal
    if (record(event)?.isTerminal === false) return;
    streaming = false;
    emit({ kind: "turn_end" });
    state("idle");
  });

  pi.on("message_start", () => {
    assistant = "";
  });

  pi.on("message_update", (event) => {
    const delta = record(record(event)?.assistantMessageEvent);
    if (delta === null || delta.type !== "text_delta") return;
    if (typeof delta.delta !== "string" || delta.delta.length === 0) return;
    assistant += delta.delta;
    // never stored: the room folds deltas into the live "now" line
    emit({ kind: "text_delta", delta: delta.delta });
  });

  pi.on("message_end", (event) => {
    const message = record(record(event)?.message);
    // omp ends the user's messages and its own injected reminders through this
    // same event (verified against omp 18.1.2: a delivered prompt arrives as
    // `role: "user"`, a reminder as a custom message), and only the assistant
    // is the agent talking. A non-assistant end must also leave the deltas
    // alone: the turn they belong to has not finished.
    if (message === null || message.role !== "assistant") return;
    // the snapshot when it carries text, else the deltas we coalesced
    const text = (messageText(message) || assistant).trim();
    assistant = "";
    if (text.length > 0) emit({ kind: "text", text });
  });

  pi.on("tool_execution_start", (event) => {
    const frame = record(event);
    if (frame === null) return;
    const args = frame.args ?? frame.input;
    emit({
      kind: "tool_start",
      name: str(frame.toolName) ?? "tool",
      paths: argPaths(args),
      summary: primaryArg(args),
    });
  });

  pi.on("tool_execution_end", (event) => {
    const frame = record(event);
    if (frame === null) return;
    emit({ kind: "tool_end", name: str(frame.toolName) ?? "tool", isError: frame.isError === true });
  });

  // compaction: both the automatic pass and an explicit /compact
  const compactionStart = (): void => state("compacting");
  // a compaction inside a turn is followed by more streaming, not by idleness
  const compactionEnd = (): void => state(streaming ? "streaming" : "idle");
  pi.on("auto_compaction_start", compactionStart);
  pi.on("auto_compaction_end", compactionEnd);
  pi.on("session.compacting", compactionStart);
  pi.on("session_compact", compactionEnd);

  pi.on("tool_call", () => {
    // Allowing a call is not approving it: the TUI approval gate is a separate
    // stage (see `autonomous` above). `{}` is "no objection from us".
    if (autonomous) return {};
    return undefined;
  });
}
