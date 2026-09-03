/**
 * The agent link's two ends, transport-agnostic. The server holds a
 * `ServerEnd` per attached agent; the agent holds one `AgentEnd`. Frames are
 * `AgentToServerMsg` / `ServerToAgentMsg` (shared/src/link.ts) in both
 * directions, delivered in order, one listener per end.
 *
 * `memoryLinkPair()` joins two ends inside one process (local mode). Delivery
 * is asynchronous even in memory — a microtask hop — so the two sides never
 * re-enter each other and behave exactly like the socket-backed pair will.
 */

import type { AgentToServerMsg, ServerToAgentMsg } from "../../shared/src/index.ts";

interface LinkEnd<Out, In> {
  send(msg: Out): void;
  /** replaces any previous listener */
  onMessage(cb: (msg: In) => void): void;
  /** fires once, when the other end closes or the transport drops */
  onClose(cb: (reason: string) => void): void;
  close(reason: string): void;
  readonly closed: boolean;
}

/** the server's end: sends `ServerToAgentMsg`, receives `AgentToServerMsg` */
export type ServerEnd = LinkEnd<ServerToAgentMsg, AgentToServerMsg>;
/** the agent's end: sends `AgentToServerMsg`, receives `ServerToAgentMsg` */
export type AgentEnd = LinkEnd<AgentToServerMsg, ServerToAgentMsg>;

class MemoryEnd<Out, In> implements LinkEnd<Out, In> {
  #peer: MemoryEnd<In, Out> | null = null;
  #onMessage: ((msg: In) => void) | null = null;
  #onClose: ((reason: string) => void) | null = null;
  /** frames that arrived before a listener was installed */
  #backlog: In[] = [];
  closed = false;

  link(peer: MemoryEnd<In, Out>): void {
    this.#peer = peer;
  }

  send(msg: Out): void {
    if (this.closed) return;
    const peer = this.#peer;
    if (peer === null || peer.closed) return;
    queueMicrotask(() => peer.deliver(msg));
  }

  deliver(msg: In): void {
    if (this.closed) return;
    const cb = this.#onMessage;
    if (cb === null) {
      this.#backlog.push(msg);
      return;
    }
    cb(msg);
  }

  onMessage(cb: (msg: In) => void): void {
    this.#onMessage = cb;
    const backlog = this.#backlog;
    this.#backlog = [];
    for (const msg of backlog) cb(msg);
  }

  onClose(cb: (reason: string) => void): void {
    this.#onClose = cb;
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const peer = this.#peer;
    this.#peer = null;
    queueMicrotask(() => {
      this.#onClose?.(reason);
      peer?.close(reason);
    });
  }
}

export function memoryLinkPair(): { server: ServerEnd; agent: AgentEnd } {
  const server = new MemoryEnd<ServerToAgentMsg, AgentToServerMsg>();
  const agent = new MemoryEnd<AgentToServerMsg, ServerToAgentMsg>();
  server.link(agent);
  agent.link(server);
  return { server, agent };
}
