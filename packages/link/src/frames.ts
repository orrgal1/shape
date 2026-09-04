/**
 * The frames every link client builds, and the correlator every one of them
 * needs — in one place.
 *
 * Two processes in this package speak `LinkClientMsg` to the agent, and they
 * must not drift apart: the omp extension (`./omp-extension.ts`), which holds
 * one socket for a whole session, and the CLI (`./cli.ts`), which opens one for
 * a single canvas call. The bridge routes on the fields of those frames, so a
 * frame shape written twice is a routing bug waiting to happen; the same goes
 * for the request/response correlation, which is the only stateful part of
 * talking to the link and was worth writing exactly once.
 *
 * The extension is loaded by omp's own Bun straight from the checkout, so this
 * file inherits its constraints: pure functions and types, the global
 * `WebSocket` as the only runtime surface, NO node imports and no
 * dependencies.
 */

import type { AgentEvent, LinkClientMsg, LinkServerMsg } from "../../shared/src/link.ts";

// ---------------------------------------------------------------------------
// The socket, as both clients see it
// ---------------------------------------------------------------------------

/**
 * The WHATWG socket both runtimes put on the global — Bun's inside omp, Node's
 * in the CLI. Declared structurally because this package's tsconfig has no DOM
 * lib and the shape below is all either client uses.
 */
export interface LinkSocket {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
}

/**
 * The text of a `message` event, or null when the frame was binary. The event
 * arrives as `unknown` because neither runtime's `MessageEvent` type is in
 * scope here.
 */
export function socketMessageText(event: unknown): string | null {
  if (event === null || typeof event !== "object" || !("data" in event)) return null;
  const data: unknown = event.data;
  return typeof data === "string" ? data : null;
}

// ---------------------------------------------------------------------------
// Client frames
// ---------------------------------------------------------------------------

type Hello = Extract<LinkClientMsg, { type: "hello" }>;
type CanvasCall = Extract<LinkClientMsg, { type: "canvas_call" }>;
type AgentEventMsg = Extract<LinkClientMsg, { type: "agent_event" }>;
type Delivered = Extract<LinkClientMsg, { type: "delivered" }>;
type Bye = Extract<LinkClientMsg, { type: "bye" }>;

/**
 * The opening frame of a client that IS the harness. Sending it is a claim
 * with consequences: the bridge remembers the cwd it greeted for and replays a
 * dropped socket as the `bye` the harness never sent, which ends that
 * worktree's session. Only the extension may build one — a forwarder (the CLI,
 * the MCP sidecar, a hook) has no session to announce.
 */
export function helloFrame(fields: Omit<Hello, "type">): Hello {
  return { type: "hello", ...fields };
}

/** one canvas tool call, answered on this socket alone and correlated by `id` */
export function canvasCallFrame(cwd: string, id: string, args: unknown): CanvasCall {
  return { type: "canvas_call", cwd, id, args };
}

/** one already-projected harness event, fed into the bridge's own event sink */
export function agentEventFrame(cwd: string, event: AgentEvent): AgentEventMsg {
  return { type: "agent_event", cwd, event };
}

/** receipt for a `deliver`: `queued` when it landed mid-turn and waits its turn */
export function deliveredFrame(
  cwd: string,
  id: string,
  mode: Delivered["mode"],
  queued: boolean,
): Delivered {
  return { type: "delivered", cwd, id, mode, queued };
}

/** the harness session is going away, said out loud rather than left to a close */
export function byeFrame(cwd: string, reason: string): Bye {
  return { type: "bye", cwd, reason };
}

// ---------------------------------------------------------------------------
// Server frames
// ---------------------------------------------------------------------------

/**
 * One server frame out of the wire text, or null for anything that is not a
 * frame. A client reads the union off `type` and ignores what it does not know,
 * so the check here is only that there is a `type` to read.
 */
export function parseServerFrame(text: string): LinkServerMsg | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || !("type" in value)) return null;
  if (typeof value.type !== "string") return null;
  // the union is discriminated on `type` and every client switches on it: the
  // frame is trusted exactly as far as that, and an unknown `type` falls
  // through every switch to the caller's default
  const frame = value as LinkServerMsg;
  return frame;
}

// ---------------------------------------------------------------------------
// Canvas calls in flight
// ---------------------------------------------------------------------------

/** the bridge answers a canvas call in milliseconds; this is a deadlock guard */
export const CALL_TIMEOUT_MS = 20_000;

/** what a caller is told when there is no socket to ask on */
export const UNREACHABLE = "Shape server unreachable";

/** what a caller is told when the socket was open and the answer never came */
export const NO_ANSWER = "Shape did not answer the canvas call";

export interface CallResult {
  text: string;
  isError: boolean;
}

/**
 * The canvas calls this client is waiting on.
 *
 * A `canvas_call` is a tool the agent is BLOCKED on, so every way the answer
 * can fail to arrive has to end in a result rather than a hang: the bridge
 * answers (`settle`), the caller gives up (`cancel`), the socket dies
 * (`settleAll`), or nothing at all happens and the timer fires. Both clients
 * need all four, which is why the pending map lives here and not in either of
 * them.
 */
export class CanvasCalls {
  readonly #pending = new Map<string, (result: CallResult) => void>();
  readonly #timeoutMs: number;
  #seq = 0;

  constructor(timeoutMs: number = CALL_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  /** `<prefix>-<n>`: a correlation id nothing else on this socket holds */
  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq}`;
  }

  /** whether anything is still waiting for an answer */
  get idle(): boolean {
    return this.#pending.size === 0;
  }

  /**
   * Register `id` and hand back the answer it will settle to. The caller sends
   * the frame itself: registering first is what makes a result that arrives on
   * the same tick impossible to lose.
   */
  open(id: string): Promise<CallResult> {
    const { promise, resolve } = Promise.withResolvers<CallResult>();
    this.#pending.set(id, resolve);
    const timer = setTimeout(() => {
      if (!this.#pending.delete(id)) return;
      resolve({ text: NO_ANSWER, isError: true });
    }, this.#timeoutMs);
    return promise.then((result) => {
      clearTimeout(timer);
      return result;
    });
  }

  /** A server frame that answers a pending call; true when it was one of ours. */
  settle(frame: LinkServerMsg): boolean {
    if (frame.type !== "canvas_result") return false;
    const resolve = this.#pending.get(frame.id);
    if (resolve === undefined) return false;
    this.#pending.delete(frame.id);
    resolve({ text: frame.text, isError: frame.isError });
    return true;
  }

  /** the caller gave up (an aborted tool call): the answer is nobody's now */
  cancel(id: string, text: string): void {
    const resolve = this.#pending.get(id);
    if (resolve === undefined) return;
    this.#pending.delete(id);
    resolve({ text, isError: true });
  }

  /** the socket is gone: nothing in flight can be answered on it any more */
  settleAll(text: string): void {
    for (const resolve of this.#pending.values()) resolve({ text, isError: true });
    this.#pending.clear();
  }
}
