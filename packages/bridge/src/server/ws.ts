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
 * A handler gets a `reply` alongside the message: frames a caller asked for by
 * id go back to the socket that asked, never to everyone. Link frames are not
 * this socket's business — they arrive on the link and are validated in
 * `linkframes.ts`.
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import {
  BRIDGE_WS_PATH,
  type ClientMsg,
  type Referent,
  type ServerMsg,
} from "../../../shared/src/index.ts";
import type { ConnectionHandler, SocketServer } from "../wsserver.ts";
import { LOCAL_TENANT } from "./auth.ts";

/**
 * Boundary validator for browser input. A frame that acts on one canvas names
 * its `worktree`: the view merges a repo's worktrees, so which one a click is
 * about is in the frame, never in the connection. An empty worktree id is a
 * malformed frame — the room would have to guess which canvas to write.
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
  if (parsed.type === "abort") {
    if (worktree === null) return null;
    return { type: "abort", worktree };
  }
  if (parsed.type === "onboard") {
    if (worktree === null) return null;
    if ("focus" in parsed && typeof parsed.focus === "string") return { type: "onboard", worktree, focus: parsed.focus };
    return { type: "onboard", worktree };
  }
  if (parsed.type === "set_autonomous") {
    if (worktree === null) return null;
    // a toggle is a boolean: anything else is a frame that does not say which way
    if (!("on" in parsed) || typeof parsed.on !== "boolean") return null;
    return { type: "set_autonomous", worktree, on: parsed.on };
  }
  if (parsed.type === "switch_project") {
    if (!("path" in parsed) || typeof parsed.path !== "string" || parsed.path.trim().length === 0) return null;
    return { type: "switch_project", path: parsed.path.trim() };
  }
  if (parsed.type === "create_project") {
    if (!("path" in parsed) || typeof parsed.path !== "string" || parsed.path.trim().length === 0) return null;
    // absent, null and explicit null are the same request: the folder only
    const raw = "github" in parsed ? parsed.github : null;
    if (raw === null || raw === undefined) return { type: "create_project", path: parsed.path.trim(), github: null };
    if (typeof raw !== "object" || !("visibility" in raw)) return null;
    if (raw.visibility !== "public" && raw.visibility !== "private") return null;
    return { type: "create_project", path: parsed.path.trim(), github: { visibility: raw.visibility } };
  }
  if (parsed.type === "select_project") {
    if (!("projectId" in parsed) || typeof parsed.projectId !== "string" || parsed.projectId.length === 0) return null;
    return { type: "select_project", projectId: parsed.projectId };
  }
  // a worktree is opened by PATH: the browser knows the paths `hello` listed,
  // the agent is what resolves one to the id every later frame carries
  if (parsed.type === "open_worktree") {
    if (!("path" in parsed) || typeof parsed.path !== "string" || parsed.path.trim().length === 0) return null;
    const open: Extract<ClientMsg, { type: "open_worktree" }> = { type: "open_worktree", path: parsed.path.trim() };
    // the harness to start: named or resolved by the agent, never guessed here
    if ("backend" in parsed && parsed.backend !== null && parsed.backend !== undefined) {
      if (typeof parsed.backend !== "string" || parsed.backend.trim().length === 0) return null;
      open.backend = parsed.backend.trim();
    }
    // both are choices made at launch, so both are booleans or absent
    if ("autonomous" in parsed && parsed.autonomous !== undefined) {
      if (typeof parsed.autonomous !== "boolean") return null;
      open.autonomous = parsed.autonomous;
    }
    if ("remember" in parsed && parsed.remember !== undefined) {
      if (typeof parsed.remember !== "boolean") return null;
      open.remember = parsed.remember;
    }
    return open;
  }
  if (parsed.type === "focus_terminal") {
    if (worktree === null) return null;
    return { type: "focus_terminal", worktree };
  }
  if (parsed.type === "close_worktree") {
    if (worktree === null) return null;
    return { type: "close_worktree", worktree };
  }
  if (parsed.type === "diff") {
    if (worktree === null) return null;
    if (!("revA" in parsed) || typeof parsed.revA !== "number" || !Number.isInteger(parsed.revA)) return null;
    if (!("revB" in parsed) || typeof parsed.revB !== "number" || !Number.isInteger(parsed.revB)) return null;
    return { type: "diff", worktree, revA: parsed.revA, revB: parsed.revB };
  }
  if (parsed.type === "pty_open" || parsed.type === "pty_resize") {
    if (worktree === null) return null;
    // a terminal size must be a real geometry: the pty is resized with it
    if (!("cols" in parsed) || typeof parsed.cols !== "number" || !Number.isInteger(parsed.cols) || parsed.cols <= 0) {
      return null;
    }
    if (!("rows" in parsed) || typeof parsed.rows !== "number" || !Number.isInteger(parsed.rows) || parsed.rows <= 0) {
      return null;
    }
    return { type: parsed.type, worktree, cols: parsed.cols, rows: parsed.rows };
  }
  if (parsed.type === "pty_input") {
    if (worktree === null) return null;
    if (!("data" in parsed) || typeof parsed.data !== "string") return null;
    return { type: "pty_input", worktree, data: parsed.data };
  }
  if (parsed.type === "pty_close") {
    if (worktree === null) return null;
    return { type: "pty_close", worktree };
  }
  if (parsed.type === "discover") return { type: "discover" };
  // no fields: which machine's chooser to open is the connection's project,
  // and the answer goes back to this socket alone
  if (parsed.type === "pick_folder") return { type: "pick_folder" };
  if (parsed.type === "adopt") {
    if (!("pid" in parsed) || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    return { type: "adopt", pid: parsed.pid };
  }
  if (parsed.type !== "utterance") return null;
  if (worktree === null) return null;
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
  // absent = on: the product-first first turn is the default, and a browser
  // that sends the flag at all sends a boolean
  if ("productFirst" in parsed) {
    if (typeof parsed.productFirst !== "boolean") return null;
    return { type: "utterance", worktree, referent, text: parsed.text, productFirst: parsed.productFirst };
  }
  return { type: "utterance", worktree, referent, text: parsed.text };
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

  constructor(opts: WsHubOptions) {
    const mount: ConnectionHandler = (socket, _request, tenant) => {
      this.#clients.add(socket);
      this.#tenants.set(socket, tenant);
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
   * The agent that held `from` re-attached to `to`: its browsers asked for that
   * switch, so they follow it instead of watching a project nothing runs in.
   */
  move(from: string, to: string): void {
    const members = this.#rooms.get(from);
    if (members === undefined) return;
    for (const socket of [...members]) this.join(socket, to);
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
    this.#clients.delete(socket);
    this.#ungreeted.delete(socket);
    this.#tenants.delete(socket);
    const key = this.#joined.get(socket);
    if (key === undefined) return;
    this.#joined.delete(socket);
    this.#rooms.get(key)?.delete(socket);
  }
}
