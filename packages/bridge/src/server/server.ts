/**
 * The canvas server: browsers on `BRIDGE_WS_PATH`, agents on `AGENT_WS_PATH`
 * and — in local mode — over an in-memory link handed to `attachAgent`. Both
 * sources produce the same `ServerEnd`, so nothing below this line knows how a
 * link is carried.
 *
 * One room per project key, kept after its agent leaves: the graph, the
 * revisions and the transcript are the project's, not the agent's, and a
 * browser watching an agentless room gets a read-only canvas rather than an
 * empty one. An `attach` therefore either opens a room, re-binds an agentless
 * one, or retargets the room this very link already holds. A restart is the
 * same story over a longer gap: `restore()` reopens every project the storage
 * remembers, agentless, before the first socket arrives.
 */

import type { WebSocket } from "ws";
import {
  AGENT_WS_PATH,
  type ProjectSummary,
  type ServerMsg,
} from "../../../shared/src/index.ts";
import { socketServerEnd, type ServerEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import { ProjectRoom, type AttachMsg } from "./room.ts";
import type { Storage } from "./storage.ts";
import { WsHub } from "./ws.ts";

export interface ShapeServerOptions {
  sockets: SocketServer;
  /** where rooms keep their files, and which projects a restart reopens */
  storage: Storage;
}

export class ShapeServer {
  readonly #hub: WsHub;
  readonly #rooms = new Map<string, ProjectRoom>();
  /** the project key each open agent link is bound to */
  readonly #links = new Map<ServerEnd, string>();
  /** the room a new browser joins: the most recently attached project */
  #defaultKey: string | null = null;
  /** attaches are serialized: a retarget must finish loading before the next starts */
  #attaching: Promise<void> = Promise.resolve();
  readonly #storage: Storage;

  constructor(opts: ShapeServerOptions) {
    this.#storage = opts.storage;
    this.#hub = new WsHub({
      sockets: opts.sockets,
      defaultRoom: () => this.#defaultKey,
      hello: async (key) => {
        const room = this.#rooms.get(key);
        return room === undefined ? null : room.hello();
      },
      onMessage: (msg, socket, reply) => {
        if (msg.type === "select_project") {
          void this.#select(socket, msg.projectId, reply);
          return;
        }
        const key = this.#hub.roomOf(socket);
        if (key === null) return;
        this.#rooms.get(key)?.handleClient(msg, reply);
      },
    });
    opts.sockets.mount(AGENT_WS_PATH, (socket) => this.attachAgent(socketServerEnd(socket)));
  }

  /**
   * Reopen the projects the storage remembers, before anything can reach the
   * server. Rooms come back agentless: the graph and the revisions are there to
   * read and to diff, and the agent that returns takes the ordinary re-bind
   * path. Resolves with how many rooms opened, which is what the operator is
   * told. A storage without a registry (local mode) restores nothing.
   */
  async restore(): Promise<number> {
    const rows = await this.#storage.listProjects();
    for (const row of rows) {
      const key = row.project.key;
      if (this.#rooms.has(key)) continue;
      const room = this.#newRoom(key);
      await room.restore(row);
      this.#rooms.set(key, room);
    }
    // a browser connecting before any agent is back is greeted by the project
    // seen most recently, instead of waiting ungreeted for the first attach
    const newest = this.#projects()[0];
    if (newest !== undefined) this.#defaultKey = newest.projectId;
    return this.#rooms.size;
  }

  /**
   * Take over one agent link. Local mode calls this with its in-memory end; a
   * socket on `AGENT_WS_PATH` lands here too. The room a link belongs to is
   * decided by the `attach` it sends, never by the order links arrive in.
   */
  attachAgent(end: ServerEnd): void {
    end.onMessage((msg) => {
      if (msg.type === "attach") {
        this.#queue(() => this.#attach(end, msg));
        return;
      }
      const room = this.#roomFor(end);
      // a room takes its own frames straight, answers to its requests included
      if (room !== undefined) {
        room.handleAgent(msg);
        return;
      }
      // no room yet: this frame overtook the attach that opens one (a
      // reconnecting agent starts talking at once), so it waits for it
      this.#queue(() => {
        this.#roomFor(end)?.handleAgent(msg);
      });
    });

    // ordered behind any in-flight attach: the close of a link mid-attach must
    // not report the room agentless before it is even bound
    end.onClose((reason) => {
      this.#queue(() => this.#linkClosed(end, reason));
    });
  }

  /**
   * Agent work runs in arrival order — a retarget must finish loading before
   * the next frame is handled. A failure is logged and dropped: it must not
   * wedge the queue for every link that comes after it.
   */
  #queue(work: () => void | Promise<void>): void {
    this.#attaching = this.#attaching.then(work).catch((err: unknown) => {
      console.error(`[bridge] agent frame failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async #attach(end: ServerEnd, msg: AttachMsg): Promise<void> {
    if (end.closed) return;
    const key = msg.project.key;
    const existing = this.#rooms.get(key);
    // a room whose agent is still there belongs to that agent alone
    if (existing !== undefined && existing.agentConnected && !existing.attachedTo(end)) {
      end.send({ type: "error", message: "project already has an attached agent" });
      end.close("project already has an attached agent");
      return;
    }

    const previous = this.#links.get(end);
    const room = existing ?? this.#newRoom(key);
    // loaded before it is reachable: nothing may see a half-open room. The
    // link is bound right after, because the hello below asks the agent
    // questions whose answers must find their room.
    await room.retarget(msg, end);
    this.#rooms.set(key, room);
    this.#links.set(end, key);
    this.#defaultKey = key;
    // the row a restart reopens this room from; a stale one costs a project
    void room.saveProject();

    if (previous !== undefined && previous !== key) {
      // the agent switched projects: its browsers asked for that, so they
      // follow, and the project it left keeps its graph without an agent
      this.#hub.move(previous, key);
      this.#rooms.get(previous)?.agentGone(`agent switched to ${msg.project.cwd}`);
    }

    const hello = await room.hello();
    // a fresh room's browsers were greeted on connect (or are owed one below);
    // only a retarget, a re-attach or a switch is news to sockets already joined
    if (existing !== undefined || previous !== undefined) this.#hub.broadcastTo(key, hello);
    // the sockets that beat the first attach are joined here and greeted once
    this.#hub.greetPending(key, hello);
    this.#broadcastProjects();
  }

  /**
   * A room's wiring: what it broadcasts reaches its own watchers, the project
   * list is the server's to answer, and its files are wherever the storage puts
   * them. Both an attach and a restore open rooms this way.
   */
  #newRoom(key: string): ProjectRoom {
    return new ProjectRoom({
      broadcast: (out: ServerMsg) => this.#hub.broadcastTo(key, out),
      projects: () => this.#projects(),
      onProjectsChanged: () => this.#broadcastProjects(),
      storage: this.#storage,
    });
  }

  /** A browser asked to watch another project this server hosts. */
  async #select(socket: WebSocket, projectId: string, reply: (msg: ServerMsg) => void): Promise<void> {
    const room = this.#rooms.get(projectId);
    if (room === undefined) {
      reply({ type: "error", message: `unknown project ${projectId}` });
      return;
    }
    this.#hub.join(socket, projectId);
    reply(await room.hello());
  }

  #linkClosed(end: ServerEnd, reason: string): void {
    const key = this.#links.get(end);
    this.#links.delete(end);
    const room = key === undefined ? undefined : this.#rooms.get(key);
    // a link that never opened a room, or one the room has since replaced with
    // a reconnect, takes nothing down with it
    if (room === undefined || !room.attachedTo(end)) {
      console.error(`[bridge] agent link closed: ${reason}`);
      return;
    }
    room.agentGone(`agent link closed: ${reason}`);
  }

  #roomFor(end: ServerEnd): ProjectRoom | undefined {
    const key = this.#links.get(end);
    return key === undefined ? undefined : this.#rooms.get(key);
  }

  /** every project this server hosts, most recently seen first */
  #projects(): ProjectSummary[] {
    const summaries: ProjectSummary[] = [];
    for (const room of this.#rooms.values()) summaries.push(room.summary());
    summaries.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
    return summaries;
  }

  #broadcastProjects(): void {
    this.#hub.broadcast({ type: "projects", projects: this.#projects() });
  }
}
