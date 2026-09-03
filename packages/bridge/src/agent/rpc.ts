/**
 * Minimal JSONL RPC client for `omp --mode rpc` (protocol v1 only).
 *
 * Per CONTRACTS.md: we stay on v1 — no `negotiate_protocol`, and `rpc_chunk`
 * frames are ignored (our frames are small). Responses are correlated by id;
 * every other frame is handed to the event callback.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

/** Any non-response stdout frame (session events, host tool calls, ready, ...). */
export type RpcFrame = Record<string, unknown>;

export interface RpcClientOptions {
  /** argv of the child process; argv[0] is the executable */
  command: string[];
  cwd: string;
  onEvent: (frame: RpcFrame) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr?: (text: string) => void;
  /** ms to wait for a correlated response before rejecting */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (r: RpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

function isFrame(value: unknown): value is RpcFrame {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asResponse(frame: RpcFrame): RpcResponse | null {
  if (frame.type !== "response") return null;
  const command = typeof frame.command === "string" ? frame.command : "unknown";
  const response: RpcResponse = {
    type: "response",
    command,
    success: frame.success === true,
  };
  if (typeof frame.id === "string") response.id = frame.id;
  if ("data" in frame) response.data = frame.data;
  if (typeof frame.error === "string") response.error = frame.error;
  if (typeof frame.code === "string") response.code = frame.code;
  return response;
}

export class RpcClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, Pending>();
  readonly #timeoutMs: number;
  readonly #onEvent: (frame: RpcFrame) => void;
  readonly #readySettle: (frame: RpcFrame) => void;
  readonly #readyFail: (err: Error) => void;
  #seq = 0;
  #buf = "";
  #closed = false;
  /** set by dispose(): this exit was asked for, so it must not look like a crash */
  #disposing = false;
  /** resolves with the `ready` frame */
  readonly ready: Promise<RpcFrame>;

  constructor(opts: RpcClientOptions) {
    this.#timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.#onEvent = opts.onEvent;

    const [exe, ...args] = opts.command;
    if (exe === undefined) throw new Error("RpcClient: empty command");
    this.#child = spawn(exe, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const readyGate = Promise.withResolvers<RpcFrame>();
    this.ready = readyGate.promise;
    this.#readySettle = readyGate.resolve;
    this.#readyFail = readyGate.reject;

    const stdout = this.#child.stdout;
    if (stdout === null) throw new Error("RpcClient: child has no stdout");
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.#buf += chunk;
      let nl = this.#buf.indexOf("\n");
      while (nl !== -1) {
        const line = this.#buf.slice(0, nl).trim();
        this.#buf = this.#buf.slice(nl + 1);
        if (line.length > 0) this.#handleLine(line);
        nl = this.#buf.indexOf("\n");
      }
    });

    const stderr = this.#child.stderr;
    if (stderr !== null) {
      stderr.setEncoding("utf8");
      stderr.on("data", (chunk: string) => opts.onStderr?.(chunk));
    }

    this.#child.on("error", (err) => {
      this.#readyFail(err);
      this.#failAllPending(err);
    });

    this.#child.on("exit", (code, signal) => {
      this.#closed = true;
      this.#readyFail(new Error(`omp exited before ready (code=${code} signal=${signal})`));
      this.#failAllPending(new Error(`omp exited (code=${code} signal=${signal})`));
      // expected shutdown (project switch): the host asked for this exit
      if (!this.#disposing) opts.onExit(code, signal);
    });
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#onEvent({ type: "bridge_parse_error", line });
      return;
    }
    if (!isFrame(parsed)) return;
    // protocol v1: chunked frames are never emitted to us; ignore defensively.
    if (parsed.type === "rpc_chunk") return;

    const response = asResponse(parsed);
    if (response !== null) {
      const id = response.id;
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (pending !== undefined && id !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.resolve(response);
        return;
      }
      // uncorrelated response (unknown command, parse failure): surface as event
      this.#onEvent(parsed);
      return;
    }

    if (parsed.type === "ready") this.#readySettle(parsed);
    this.#onEvent(parsed);
  }

  #failAllPending(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  /** Fire-and-forget frame write (host_tool_result, host_uri_result, ...). */
  send(frame: Record<string, unknown>): void {
    if (this.#closed) return;
    const stdin = this.#child.stdin;
    if (stdin === null) return;
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /** Id-correlated command; resolves with the matching response frame. */
  request(command: Record<string, unknown>): Promise<RpcResponse> {
    if (this.#closed) return Promise.reject(new Error("omp is not running"));
    const id = `req_${++this.#seq}`;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`rpc timeout after ${this.#timeoutMs}ms for ${String(command.type)}`));
    }, this.#timeoutMs);
    timer.unref();
    this.#pending.set(id, { resolve, reject, timer });
    this.send({ ...command, id });
    return promise;
  }

  /**
   * Expected shutdown: closing stdin is omp's documented exit path (it drains
   * accepted commands, disposes the session and exits 0). Resolves once the
   * child is actually gone; SIGKILL is the backstop.
   */
  async dispose(): Promise<void> {
    this.#disposing = true;
    if (this.#closed) return;
    const gone = Promise.withResolvers<void>();
    this.#child.once("exit", () => gone.resolve());
    this.#child.stdin?.end();
    const backstop = setTimeout(() => this.#child.kill("SIGKILL"), 3000);
    await gone.promise;
    clearTimeout(backstop);
  }
}
