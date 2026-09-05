/**
 * The browser hub: one mount on the shared listener (`/ws`), every connected
 * canvas client, and the boundary validator for what they send. Server frames
 * are `ServerMsg`; inbound text is narrowed to `ClientMsg`.
 *
 * A hub is also the room registry for browsers: each socket watches exactly
 * one project, so a frame a room broadcasts reaches its watchers and nobody
 * else. The widest thing it sends — a tenant's project list — still stops at
 * that tenant: a socket is admitted as one at the upgrade and never learns
 * that another exists.
 *
 * A socket is joined to a room, moved to another one (`join`), or left with
 * none at all: a browser whose project was marked inactive, and one that
 * connected before its tenant had a project, wait the same way and are
 * greeted by the next room that opens (`leave`, `greetPending`).
 *
 * A handler gets a `reply` alongside the message: frames a caller asked for by
 * id go back to the socket that asked, never to everyone. Link frames are not
 * this socket's business — they arrive on the link and are validated in
 * `linkframes.ts`.
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { BRIDGE_WS_PATH, type ClientMsg, type ServerMsg } from "../../../shared/src/index.ts";
import type { ConnectionHandler, SocketServer } from "../wsserver.ts";
import { LOCAL_TENANT } from "./auth.ts";

/**
 * Boundary validator for browser input. A frame that is about one canvas names
 * its `worktree`: the view merges a repo's worktrees, so which one a click is
 * about is in the frame, never in the connection. An empty worktree id is a
 * malformed frame — the room would have to guess which canvas it meant.
 */
export function parseClientMsg(raw: string): ClientMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) return null;
  // the worktree every worktree-scoped frame below is checked against; read
  // once, because a frame that has none is rejected by each of them
  const worktree = "worktree" in parsed && typeof parsed.worktree === "string" && parsed.worktree.length > 0 ? parsed.worktree : null;
  // the project a project-scoped frame names; the same reasoning as `worktree`
  const projectId = "projectId" in parsed && typeof parsed.projectId === "string" && parsed.projectId.length > 0 ? parsed.projectId : null;
  if (parsed.type === "select_project") {
    if (projectId === null) return null;
    return { type: "select_project", projectId };
  }
  if (parsed.type === "set_project_status") {
    if (projectId === null) return null;
    // the only two statuses there are: anything else is a client that thinks
    // Shape has more states than "we hold a room for it" and "we do not"
    if (!("status" in parsed) || (parsed.status !== "active" && parsed.status !== "inactive")) return null;
    return { type: "set_project_status", projectId, status: parsed.status };
  }
  if (parsed.type === "focus_terminal") {
    if (worktree === null) return null;
    return { type: "focus_terminal", worktree };
  }
  if (parsed.type !== "diff") return null;
  if (worktree === null) return null;
  if (!("revA" in parsed) || typeof parsed.revA !== "number" || !Number.isInteger(parsed.revA)) return null;
  if (!("revB" in parsed) || typeof parsed.revB !== "number" || !Number.isInteger(parsed.revB)) return null;
  return { type: "diff", worktree, revA: parsed.revA, revB: parsed.revB };
}

export interface WsHubOptions {
  /** the shared listener; the hub takes BRIDGE_WS_PATH on it */
  sockets: SocketServer;
  /**
   * The tenant a browser's upgrade speaks for, or null to refuse it (401). An
   * unauthenticated server answers `LOCAL_TENANT` here, so the hub itself has
   * no notion of "no auth" to get wrong.
   */
  authorize: (request: IncomingMessage) => string | null;
  /**
   * The project a fresh browser joins: the most recently attached one of ITS
   * tenant, or null while that tenant hosts none — such a socket has nothing to
   * be told yet and is greeted the moment the first room of its tenant opens.
   */
  defaultRoom: (tenant: string) => string | null;
  /**
   * Frame sent to a socket that just joined `key` (worktrees are re-detected
   * here). `null` = that room is gone, so the socket waits like an early one.
   */
  hello: (key: string) => Promise<ServerMsg | null>;
  /** `reply` reaches only the socket the message came from */
  onMessage: (msg: ClientMsg, socket: WebSocket, reply: (msg: ServerMsg) => void) => void;
  /**
   * The number of connected browsers, after every arrival and every drop. Zero
   * means nobody is watching: local mode stops scanning the machine until
   * somebody opens the canvas again.
   */
  onClients?: (count: number) => void;
}

export class WsHub {
  readonly #clients = new Set<WebSocket>();
  /** the browsers watching each project, by room key (`<tenant>/<projectKey>`) */
  readonly #rooms = new Map<string, Set<WebSocket>>();
  /** which project each browser is watching */
  readonly #joined = new Map<WebSocket, string>();
  /** connected while there was no room: owed a hello when one of its tenant opens */
  readonly #ungreeted = new Set<WebSocket>();
  /** the tenant each browser was admitted as, decided at the upgrade */
  readonly #tenants = new Map<WebSocket, string>();
  readonly #onClients: ((count: number) => void) | null;

  constructor(opts: WsHubOptions) {
    this.#onClients = opts.onClients ?? null;
    const mount: ConnectionHandler = (socket, _request, tenant) => {
      this.#clients.add(socket);
      this.#tenants.set(socket, tenant);
      this.#onClients?.(this.#clients.size);
      // handlers first: hello is async, and a client may talk before it lands
      socket.on("message", (data) => {
        const msg = parseClientMsg(data.toString());
        if (msg === null) {
          socket.send(JSON.stringify({ type: "error", message: "unparseable client message" } satisfies ServerMsg));
          return;
        }
        opts.onMessage(msg, socket, (out) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
        });
      });
      socket.on("close", () => this.#drop(socket));
      socket.on("error", () => this.#drop(socket));

      const key = opts.defaultRoom(tenant);
      if (key === null) {
        this.#ungreeted.add(socket);
        return;
      }
      this.join(socket, key);
      void opts.hello(key).then((msg) => {
        if (socket.readyState !== socket.OPEN) return;
        if (msg === null) {
          this.#ungreeted.add(socket);
          return;
        }
        socket.send(JSON.stringify(msg));
      });
    };
    opts.sockets.mount(BRIDGE_WS_PATH, mount, { authorize: opts.authorize });
  }

  /** Move a browser onto a project; it hears only that room's frames from now on. */
  join(socket: WebSocket, key: string): void {
    const previous = this.#joined.get(socket);
    if (previous === key) return;
    if (previous !== undefined) this.#rooms.get(previous)?.delete(socket);
    this.#joined.set(socket, key);
    const members = this.#rooms.get(key);
    if (members === undefined) this.#rooms.set(key, new Set([socket]));
    else members.add(socket);
    this.#ungreeted.delete(socket);
  }

  /** null while the socket waits for the first room to open */
  roomOf(socket: WebSocket): string | null {
    return this.#joined.get(socket) ?? null;
  }

  /** the tenant a socket was admitted as; everything it may see is scoped to this */
  tenantOf(socket: WebSocket): string {
    // a socket the hub never saw cannot reach this: mounts hand it in
    return this.#tenants.get(socket) ?? LOCAL_TENANT;
  }

  /**
   * That project has no room any more (it was marked inactive): its browsers
   * are unjoined and owed a hello somewhere else, so they are handed back to
   * the caller — and marked ungreeted, so one left with nowhere to go is
   * greeted by the next room of its tenant like a socket that arrived early.
   */
  leave(key: string): WebSocket[] {
    const members = this.#rooms.get(key);
    if (members === undefined) return [];
    const sockets = [...members];
    this.#rooms.delete(key);
    for (const socket of sockets) {
      this.#joined.delete(socket);
      this.#ungreeted.add(socket);
    }
    return sockets;
  }

  /**
   * The hello owed to sockets that connected before their tenant had a room.
   * Another tenant's first room is no news to them: they keep waiting.
   */
  greetPending(tenant: string, key: string, msg: ServerMsg): void {
    if (this.#ungreeted.size === 0) return;
    const text = JSON.stringify(msg);
    for (const socket of [...this.#ungreeted]) {
      if (this.tenantOf(socket) !== tenant) continue;
      this.join(socket, key);
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  broadcastTo(key: string, msg: ServerMsg): void {
    const members = this.#rooms.get(key);
    if (members === undefined) return;
    const text = JSON.stringify(msg);
    for (const socket of members) {
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  /** a tenant's own news (its project list): every socket of that tenant, no room needed */
  broadcastToTenant(tenant: string, msg: ServerMsg): void {
    const text = JSON.stringify(msg);
    for (const socket of this.#clients) {
      if (this.tenantOf(socket) !== tenant) continue;
      if (socket.readyState === socket.OPEN) socket.send(text);
    }
  }

  #drop(socket: WebSocket): void {
    // both `close` and `error` land here for the same socket; the count goes
    // out for the first of them only
    if (!this.#clients.delete(socket)) return;
    this.#ungreeted.delete(socket);
    this.#tenants.delete(socket);
    const key = this.#joined.get(socket);
    if (key !== undefined) {
      this.#joined.delete(socket);
      this.#rooms.get(key)?.delete(socket);
    }
    this.#onClients?.(this.#clients.size);
  }
}
