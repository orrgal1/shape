/**
 * The agent link's two ends, transport-agnostic. The server holds a
 * `ServerEnd` per attached agent; the agent holds one `AgentEnd`. Frames are
 * `AgentToServerMsg` / `ServerToAgentMsg` (shared/src/link.ts) in both
 * directions, delivered in order, one listener per end.
 *
 * `memoryLinkPair()` joins two ends inside one process (local mode). Delivery
 * is asynchronous even in memory — a microtask hop — so the two sides never
 * re-enter each other and behave exactly like the socket-backed pair below.
 *
 * `socketServerEnd()` and `connectAgentEnd()` are that pair (remote mode): one
 * `ws` connection per attached agent on the server side, and a client end that
 * outlives connections — it retries with backoff and reports every gap so the
 * runtime can fail in-flight work and re-`attach`.
 */

import { WebSocket } from "ws";
import type { AgentToServerMsg, ServerToAgentMsg } from "../../shared/src/index.ts";
import { parseAgentToServerMsg, parseServerToAgentMsg } from "./linkframes.ts";

interface LinkEnd<Out, In> {
  send(msg: Out): void;
  /** replaces any previous listener */
  onMessage(cb: (msg: In) => void): void;
  /** fires once, when the other end closes or the transport drops */
  onClose(cb: (reason: string) => void): void;
  close(reason: string): void;
  readonly closed: boolean;
}

/** the server's end: sends `ServerToAgentMsg`, receives `AgentToServerMsg`; one per connection */
export type ServerEnd = LinkEnd<ServerToAgentMsg, AgentToServerMsg>;
/**
 * the agent's end: sends `AgentToServerMsg`, receives `ServerToAgentMsg`. Outlives
 * connections: a socket-backed end reconnects with backoff and reports the gap so
 * the runtime can fail in-flight calls (`onDisconnect`) and re-`attach`
 * (`onReconnect`). Frames sent while disconnected are dropped — `attach`
 * carries the whole state again. The in-memory end never fires either.
 */
export interface AgentEnd extends LinkEnd<AgentToServerMsg, ServerToAgentMsg> {
  onDisconnect(cb: (reason: string) => void): void;
  onReconnect(cb: () => void): void;
}

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

  onDisconnect(): void {}

  onReconnect(): void {}

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

// ---------------------------------------------------------------------------
// Socket-backed ends (remote mode)
// ---------------------------------------------------------------------------

/** one attached agent, as the server sees it: a single connection, no retries */
class SocketServerEnd implements ServerEnd {
  readonly #socket: WebSocket;
  #onMessage: ((msg: AgentToServerMsg) => void) | null = null;
  #onClose: ((reason: string) => void) | null = null;
  /** frames that arrived before the room installed its listener */
  #backlog: AgentToServerMsg[] = [];
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => {
      const msg = parseAgentToServerMsg(data.toString());
      if (msg === null) {
        // the peer is a program, not a user: name the bad frame, keep the link
        this.send({ type: "error", message: "unparseable agent frame" });
        return;
      }
      const cb = this.#onMessage;
      if (cb === null) {
        this.#backlog.push(msg);
        return;
      }
      cb(msg);
    });
    socket.on("close", (_code, reason) => {
      this.#drop(reason.length === 0 ? "socket closed" : reason.toString());
    });
    socket.on("error", (err) => this.#drop(err.message));
  }

  send(msg: ServerToAgentMsg): void {
    if (this.#closed || this.#socket.readyState !== this.#socket.OPEN) return;
    this.#socket.send(JSON.stringify(msg));
  }

  onMessage(cb: (msg: AgentToServerMsg) => void): void {
    this.#onMessage = cb;
    const backlog = this.#backlog;
    this.#backlog = [];
    for (const msg of backlog) cb(msg);
  }

  onClose(cb: (reason: string) => void): void {
    this.#onClose = cb;
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    // the protocol caps a close reason at 123 bytes, and it is only a label
    this.#socket.close(1000, reason.slice(0, 120));
  }

  get closed(): boolean {
    // CONNECTING(0) < OPEN(1) < CLOSING(2) < CLOSED(3)
    return this.#closed || this.#socket.readyState > this.#socket.OPEN;
  }

  /** the connection is gone: exactly one `onClose`, whichever event noticed */
  #drop(reason: string): void {
    this.#closed = true;
    const cb = this.#onClose;
    this.#onClose = null;
    cb?.(reason);
  }
}

export function socketServerEnd(socket: WebSocket): ServerEnd {
  return new SocketServerEnd(socket);
}

/**
 * The one refusal a retry cannot fix: a wrong token stays wrong, so the end
 * gives up instead of reconnecting forever against a server that keeps saying
 * no. The agent CLI prints this and exits.
 */
export const TOKEN_REFUSED = "Shape server refused the token (401)";

export interface ConnectAgentEndOptions {
  /** first retry delay; doubles per failed attempt (default 500 ms) */
  minBackoffMs?: number;
  /** ceiling for the doubling (default 8 s) */
  maxBackoffMs?: number;
  /**
   * Sent as `Authorization: Bearer <token>` on the upgrade. Omitted against an
   * unauthenticated server, which ignores it anyway.
   */
  token?: string;
  /**
   * The server refused the token; the end is closed for good. `onClose` fires
   * too — this exists because the runtime owns that listener, and the process
   * that built the link is the one that decides whether to exit.
   */
  onRefused?: (reason: string) => void;
}

/**
 * The agent's end in remote mode. It owns the reconnect loop: a dropped
 * connection is a gap, not the end of the link, so the runtime keeps running
 * and re-`attach`es when the server comes back.
 */
class SocketAgentEnd implements AgentEnd {
  readonly #url: string;
  readonly #minBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #token: string | undefined;
  readonly #onRefused: ((reason: string) => void) | undefined;
  #socket: WebSocket | null = null;
  #onMessage: ((msg: ServerToAgentMsg) => void) | null = null;
  #onClose: ((reason: string) => void) | null = null;
  #onDisconnect: ((reason: string) => void) | null = null;
  #onReconnect: (() => void) | null = null;
  /** frames that arrived before the runtime installed its listener */
  #backlog: ServerToAgentMsg[] = [];
  #retry: NodeJS.Timeout | null = null;
  #backoffMs: number;
  /** a socket reached OPEN once: from here a drop is a gap and an open is a reconnect */
  #everOpen = false;
  /** inside a gap: `onDisconnect` reports the gap, not every failed retry */
  #inGap = false;
  /**
   * a frame was dropped since the last open. The runtime sends `attach` as soon
   * as its backend is up, which is BEFORE the first open when the server was
   * down at startup; without re-announcing, that attach is lost and the agent
   * waits for an `attached` that nobody will send.
   */
  #droppedSinceOpen = false;
  /** the waiting hint is a startup line, printed once however long we wait */
  #warned = false;
  #closed = false;

  constructor(url: string, opts?: ConnectAgentEndOptions) {
    this.#url = url;
    this.#minBackoffMs = opts?.minBackoffMs ?? 500;
    this.#maxBackoffMs = opts?.maxBackoffMs ?? 8000;
    this.#token = opts?.token;
    this.#onRefused = opts?.onRefused;
    this.#backoffMs = this.#minBackoffMs;
    this.#connect();
  }

  send(msg: AgentToServerMsg): void {
    const socket = this.#socket;
    // a frame that lands in a gap is dropped: `attach` carries the state again
    if (this.#closed || socket === null || socket.readyState !== socket.OPEN) {
      if (!this.#closed) this.#droppedSinceOpen = true;
      return;
    }
    socket.send(JSON.stringify(msg));
  }

  onMessage(cb: (msg: ServerToAgentMsg) => void): void {
    this.#onMessage = cb;
    const backlog = this.#backlog;
    this.#backlog = [];
    for (const msg of backlog) cb(msg);
  }

  onClose(cb: (reason: string) => void): void {
    this.#onClose = cb;
  }

  onDisconnect(cb: (reason: string) => void): void {
    this.#onDisconnect = cb;
  }

  onReconnect(cb: () => void): void {
    this.#onReconnect = cb;
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retry !== null) {
      clearTimeout(this.#retry);
      this.#retry = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(1000, reason.slice(0, 120));
    const cb = this.#onClose;
    this.#onClose = null;
    cb?.(reason);
  }

  get closed(): boolean {
    return this.#closed;
  }

  #connect(): void {
    if (this.#closed) return;
    // an agent can set headers where a browser cannot, so the token travels in
    // `Authorization` and never in the URL (logs, `ps`, referrers)
    const socket = new WebSocket(
      this.#url,
      this.#token === undefined ? {} : { headers: { Authorization: `Bearer ${this.#token}` } },
    );
    this.#socket = socket;
    // a failed connect arrives as `error` THEN `close`: one gap per socket
    let dropped = false;
    const drop = (reason: string): void => {
      if (dropped) return;
      dropped = true;
      if (this.#socket === socket) this.#socket = null;
      if (this.#closed) return;
      if (this.#everOpen) {
        if (!this.#inGap) {
          this.#inGap = true;
          this.#onDisconnect?.(reason);
        }
      } else if (!this.#warned) {
        // the agent CLI has nothing else to say while the server is missing
        this.#warned = true;
        console.error(`[bridge] waiting for Shape server at ${this.#url}`);
      }
      this.#schedule();
    };
    socket.on("open", () => {
      this.#backoffMs = this.#minBackoffMs;
      this.#inGap = false;
      // a real reconnect says so; a first open that swallowed frames only needs
      // the runtime to say everything again
      if (this.#everOpen) console.error("[bridge] reconnected to Shape server");
      const reannounce = this.#everOpen || this.#droppedSinceOpen;
      this.#everOpen = true;
      this.#droppedSinceOpen = false;
      if (reannounce) this.#onReconnect?.();
    });
    socket.on("message", (data) => {
      const msg = parseServerToAgentMsg(data.toString());
      if (msg === null) {
        console.error("[bridge] dropped unparseable server frame");
        return;
      }
      const cb = this.#onMessage;
      if (cb === null) {
        this.#backlog.push(msg);
        return;
      }
      cb(msg);
    });
    socket.on("close", (_code, reason) => {
      drop(reason.length === 0 ? "server closed the link" : reason.toString());
    });
    socket.on("error", (err) => drop(err.message));
    // the upgrade was answered with HTTP instead of a socket. 401 is the one
    // answer a retry cannot improve on: give up so the operator sees why.
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      if (status !== 401) {
        drop(`server answered HTTP ${status} to the upgrade`);
        return;
      }
      dropped = true; // the abort below arrives as `error`; it is not a gap
      this.close(TOKEN_REFUSED);
      this.#onRefused?.(TOKEN_REFUSED);
    });
  }

  #schedule(): void {
    if (this.#closed || this.#retry !== null) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, this.#maxBackoffMs);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, delay);
    // waiting for a server must not be the reason the process stays alive
    this.#retry.unref();
  }
}

export function connectAgentEnd(url: string, opts?: ConnectAgentEndOptions): AgentEnd {
  return new SocketAgentEnd(url, opts);
}
