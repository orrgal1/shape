/**
 * The canvas server: browsers on `BRIDGE_WS_PATH`, agents on `AGENT_WS_PATH`
 * and — in local mode — over an in-memory link handed to `attachAgent`. Both
 * sources produce the same `ServerEnd`, so nothing below this line knows how a
 * link is carried.
 *
 * Projects live in a registry: one row per (tenant, project key), with a
 * status. Nothing here opens, creates or picks a project — a project is in the
 * registry because a session reported in, either as an agent that attached or
 * as a repo a discovery scan saw one in (`discovered`). ACTIVE means the
 * server holds a ROOM for it: its canvases are loaded, its sessions stream and
 * a browser can watch it. INACTIVE means every record is kept and nothing runs
 * — no room, and the agent link that was feeding it is closed. Which of the
 * two a project is, is the one thing a browser decides (`set_project_status`);
 * which of the active ones it watches is the other (`select_project`).
 *
 * A room is kept after its agent leaves: the graph, the revisions and the
 * transcript are the project's, not the agent's, and a browser watching an
 * agentless room gets a read-only canvas rather than an empty one. An `attach`
 * therefore either opens a room or re-binds the agentless one that project
 * already has. A restart is the same story over a longer gap: `restore()`
 * loads every row — both statuses — and reopens a room for each active one,
 * agentless, before the first socket arrives. Local mode restores too: the
 * projects a machine had are the projects it has.
 *
 * The tenant comes from the upgrade (`server/auth.ts`) and is the one thing a
 * frame can never claim: it decides which room key a project key lands in,
 * which projects a browser is told about, and which of them `select_project`
 * can reach. Without a token table there is exactly one tenant, `local`, which
 * is what local mode has always been.
 */

import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import {
  AGENT_WS_PATH,
  type ProjectStatus,
  type ProjectSummary,
  type ServerMsg,
  type WorktreeInfo,
} from "../../../shared/src/index.ts";
import { socketServerEnd, type ServerEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import { LOCAL_TENANT, tokenFromRequest, type TokenTable } from "./auth.ts";
import { ProjectRoom, type AttachMsg } from "./room.ts";
import type { Storage, StoredProject } from "./storage.ts";
import { WsHub } from "./ws.ts";

/** one project with a room open: what an agent runtime is started for */
export interface ActiveProject {
  key: string;
  /** the repo's main worktree */
  cwd: string;
  tenant: string;
}

/**
 * One repo a discovery scan found a session in — a herdr agent, a caller on
 * the loopback link, or a directory the operator seeded. This is how a project
 * enters the registry: nobody picks one.
 */
export interface SeenRepo {
  /** the project key the agent side derived for the repo */
  key: string;
  /** the repo's main worktree */
  cwd: string;
  label: string;
  worktrees: WorktreeInfo[];
  /** worktree ids with a live session in them right now */
  live: string[];
}

export interface ShapeServerOptions {
  sockets: SocketServer;
  /** where rooms keep their records, and which projects a restart reopens */
  storage: Storage;
  /**
   * The tokens this server admits. Absent or null ⇒ unauthenticated: every
   * connection is the `local` tenant, which is local mode and — for a remote
   * server — only ever a loopback bind (`server-cli.ts` refuses the rest).
   */
  auth?: TokenTable | null;
  /**
   * Take over a pre-SQLite `<cwd>/.shape/graph.json` the first time a project
   * is opened. Local mode only: the repos a remote server's projects live in
   * are on other machines. Default false.
   */
  importLegacy?: boolean;
  /** called whenever the number of connected browsers changes (0 ⇒ nobody is watching) */
  onBrowsers?: (count: number) => void;
  /**
   * A project just became active — a row discovery inserted, or a status an
   * operator flipped back. Local mode starts the agent runtime that will feed
   * its room; a remote server has nothing to start.
   */
  onActivated?: (project: ActiveProject) => void;
}

/** Link and storage failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ShapeServer {
  readonly #hub: WsHub;
  /**
   * Every project this server knows, keyed `<tenant>/<projectKey>` — both
   * statuses, the whole registry as the storage has it. An ACTIVE entry has a
   * room in `#rooms`; an inactive one is a row and its records, nothing more.
   */
  readonly #registry = new Map<string, StoredProject>();
  /** every open room, keyed `<tenant>/<projectKey>`; only ACTIVE projects have one */
  readonly #rooms = new Map<string, ProjectRoom>();
  /** the room key each open agent link is bound to */
  readonly #links = new Map<ServerEnd, string>();
  /** per tenant, the room a new browser of that tenant joins: its newest project */
  readonly #defaultKeys = new Map<string, string>();
  /**
   * Registry work runs one at a time: attaches, discovery and status changes
   * all mutate the rows and the room map, and a status flip landing halfway
   * through an attach would leave a room open for an inactive project.
   */
  #serial: Promise<void> = Promise.resolve();
  readonly #storage: Storage;
  readonly #auth: TokenTable | null;
  readonly #importLegacy: boolean;
  readonly #onBrowsers: ((count: number) => void) | null;
  readonly #onActivated: ((project: ActiveProject) => void) | null;

  constructor(opts: ShapeServerOptions) {
    this.#storage = opts.storage;
    this.#auth = opts.auth ?? null;
    this.#importLegacy = opts.importLegacy ?? false;
    this.#onBrowsers = opts.onBrowsers ?? null;
    this.#onActivated = opts.onActivated ?? null;
    this.#hub = new WsHub({
      sockets: opts.sockets,
      authorize: (request) => this.#authorize(request),
      defaultRoom: (tenant) => this.#defaultKeys.get(tenant) ?? null,
      hello: async (key) => {
        const room = this.#rooms.get(key);
        return room === undefined ? null : room.hello();
      },
      onClients: (count) => this.#onBrowsers?.(count),
      onMessage: (msg, socket, reply) => {
        // which project, and whether it is one at all, are the server's: a room
        // knows nothing about its siblings and an inactive project has no room
        if (msg.type === "select_project") {
          void this.#select(socket, msg.projectId, reply);
          return;
        }
        if (msg.type === "set_project_status") {
          void this.setProjectStatus(this.#hub.tenantOf(socket), msg.projectId, msg.status).then(
            // success is the `projects` broadcast every browser of the tenant
            // gets; only the refusal is this socket's alone
            (error) => {
              if (error !== null) reply({ type: "error", message: error });
            },
            (err: unknown) => reply({ type: "error", message: errText(err) }),
          );
          return;
        }
        const key = this.#hub.roomOf(socket);
        if (key === null) return;
        this.#rooms.get(key)?.handleClient(msg);
      },
    });
    opts.sockets.mount(
      AGENT_WS_PATH,
      (socket, _request, tenant) => this.attachAgent(socketServerEnd(socket), tenant),
      { authorize: (request) => this.#authorize(request) },
    );
  }

  /**
   * Who this connection is, decided once at the upgrade for both mounts.
   * Unauthenticated ⇒ everyone is the local tenant. Authenticated ⇒ a
   * connection with no token, or one this server does not know, is refused
   * (401) and never becomes a socket at all.
   */
  #authorize(request: IncomingMessage): string | null {
    const auth = this.#auth;
    if (auth === null) return LOCAL_TENANT;
    const token = tokenFromRequest(request);
    return token === null ? null : auth.tenantOf(token);
  }

  /**
   * Load the registry, before anything can reach the server: every row of
   * every tenant, and a room for each ACTIVE one. Rooms come back agentless —
   * the graph and the revisions are there to read and to diff, and the agent
   * that returns takes the ordinary re-bind path — while an inactive row is
   * kept as a row: its records are safe and nothing runs for it. Resolves with
   * how many rooms opened, which is what the operator is told.
   */
  async restore(): Promise<number> {
    const rows = await this.#storage.listProjects();
    for (const row of rows) {
      const key = `${row.tenant}/${row.project.key}`;
      this.#registry.set(key, row);
      if (row.status !== "active" || this.#rooms.has(key)) continue;
      await this.#openRoom(key, row);
    }
    // a browser connecting before any agent is back is greeted by the ACTIVE
    // project ITS tenant saw most recently, instead of waiting ungreeted
    for (const room of this.#rooms.values()) {
      const tenant = room.tenant;
      if (this.#defaultKeys.has(tenant)) continue;
      const newest = this.#newestActiveKey(tenant);
      if (newest !== null) this.#defaultKeys.set(tenant, newest);
    }
    return this.#rooms.size;
  }

  /**
   * The projects a room is open for: what local mode starts an agent runtime
   * per. Every one of them is a repo on this machine that a session reported
   * in from at some point, and none of them was picked by hand.
   */
  activeProjects(tenant: string = LOCAL_TENANT): ActiveProject[] {
    const projects: ActiveProject[] = [];
    for (const row of this.#registry.values()) {
      if (row.tenant !== tenant || row.status !== "active") continue;
      projects.push({ key: row.project.key, cwd: row.project.cwd, tenant });
    }
    return projects;
  }

  /**
   * What a discovery scan found: for each repo a session is running in, the
   * worktrees and which of them are live. A repo already in the registry has
   * its row updated and its room told, with the status left exactly as it is —
   * a scan must never revive a project an operator parked. A repo that is new
   * here becomes an ACTIVE row with a synthesized project (no graph derived
   * yet, no harness known), its room opens agentless, and `onActivated` starts
   * the runtime that fills the rest in.
   *
   * A `complete` scan saw the whole machine, so every project of the tenant it
   * does not mention has nothing live in it and its count goes to zero — a
   * session that ended must not be shown running until the next one starts.
   * One caller reporting in (`complete` false) says nothing about the rest.
   */
  discovered(tenant: string, repos: SeenRepo[], complete = false): Promise<void> {
    return this.#serialize(async () => {
      let changed = false;
      const mentioned = new Set<string>();
      for (const repo of repos) {
        const key = `${tenant}/${repo.key}`;
        mentioned.add(key);
        const row = this.#registry.get(key);
        if (row === undefined) {
          await this.#insert(tenant, key, repo);
          changed = true;
          continue;
        }
        if (await this.#seen(key, row, repo.worktrees, repo.live)) changed = true;
      }
      if (complete) {
        for (const [key, row] of this.#registry) {
          if (row.tenant !== tenant || mentioned.has(key)) continue;
          if (await this.#seen(key, row, row.worktrees, [])) changed = true;
        }
      }
      if (changed) this.#broadcastProjects(tenant);
    });
  }

  /**
   * One known project as a scan saw it. Resolves with whether the switcher's
   * picture of it (worktrees, live count) moved.
   */
  async #seen(key: string, row: StoredProject, worktrees: WorktreeInfo[], live: string[]): Promise<boolean> {
    const known = new Set(row.worktrees.map((info) => info.id));
    const same =
      row.liveSessions === live.length && worktrees.length === known.size && worktrees.every((info) => known.has(info.id));
    const room = this.#rooms.get(key);
    // the room counts the sessions on its own link too, so what the scan saw
    // is only half of what is live there and it keeps the scan's half itself
    room?.noteSeen(worktrees, live);
    // a scan that repeats the last one every 30 s must not rewrite every row
    if (same) return false;
    row.worktrees = worktrees;
    row.liveSessions = live.length;
    if (room === undefined) {
      // an inactive project keeps its data current: the switcher shows what
      // is running in it, and marking it active again finds it up to date
      await this.#storage.saveProject(row).catch((err: unknown) => {
        console.error(`[bridge] failed to save project registry: ${errText(err)}`);
      });
    } else {
      void room.saveProject();
    }
    return true;
  }

  /**
   * Mark a project active or inactive — the one input a browser has. Resolves
   * null when it was done, else the line the caller is owed: an id no tenant of
   * this server knows is the only refusal there is. The same status again is
   * nothing at all.
   *
   * Going inactive closes the room (its records are flushed and filed, and the
   * agent link feeding it is told why it is going away) and moves the browsers
   * that were watching onto this tenant's newest active project; going active
   * reopens the room from the row and lets local mode start a runtime for it.
   */
  setProjectStatus(tenant: string, projectId: string, status: ProjectStatus): Promise<string | null> {
    return this.#serialize(async () => {
      const key = `${tenant}/${projectId}`;
      const row = this.#registry.get(key);
      if (row === undefined) return `unknown project ${projectId}`;
      if (row.status === status) return null;
      const stored = await this.#storage.setProjectStatus(tenant, projectId, status);
      // the registry is loaded from the storage and nothing else writes rows:
      // a row that is here but not there is a database that went away under us
      if (!stored) return `unknown project ${projectId}`;
      row.status = status;
      row.statusChangedAt = new Date().toISOString();
      if (status === "inactive") await this.#deactivate(tenant, key);
      else await this.#activate(tenant, key, row);
      this.#broadcastProjects(tenant);
      return null;
    });
  }

  /**
   * Take over one agent link. Local mode calls this with its in-memory end (and
   * no tenant: there is only the local one); a socket on `AGENT_WS_PATH` lands
   * here with the tenant its token named. The room a link belongs to is decided
   * by the `attach` it sends, never by the order links arrive in.
   */
  attachAgent(end: ServerEnd, tenant: string = LOCAL_TENANT): void {
    end.onMessage((msg) => {
      if (msg.type === "attach") {
        this.#queue(() => this.#attach(end, msg, tenant));
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
   * Agent work runs in arrival order — an attach must finish loading before the
   * next frame is handled. A failure is logged and dropped: it must not wedge
   * the queue for every link that comes after it.
   */
  #queue(work: () => void | Promise<void>): void {
    this.#serial = this.#serial.then(work).catch((err: unknown) => {
      console.error(`[bridge] agent frame failed: ${errText(err)}`);
    });
  }

  /**
   * The same queue, for work whose answer a caller waits on (a status change, a
   * discovery scan). The chain itself never breaks: a failure is this caller's
   * to handle, not the next one's to inherit.
   */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#serial.then(work);
    this.#serial = done.then(
      () => {},
      () => {},
    );
    return done;
  }

  async #attach(end: ServerEnd, msg: AttachMsg, tenant: string): Promise<void> {
    if (end.closed) return;
    // the same repo path on two tenants' machines yields the same project key,
    // and they must not meet: the tenant is what keeps those rooms apart
    const key = `${tenant}/${msg.project.key}`;
    const known = this.#registry.get(key);
    // an inactive project has no room and nothing running for it, so the
    // runtime that just reported in is told why and its link goes away. Only
    // marking the project active again brings it back.
    if (known !== undefined && known.status === "inactive") {
      const line = `project ${known.project.label} is inactive`;
      end.send({ type: "error", message: line });
      end.close(line);
      return;
    }
    const existing = this.#rooms.get(key);
    // a room whose agent is still there belongs to that agent alone
    if (existing !== undefined && existing.agentConnected && !existing.attachedTo(end)) {
      end.send({ type: "error", message: "project already has an attached agent" });
      end.close("project already has an attached agent");
      return;
    }

    // no room means a project nothing has reported in from yet — a fresh one,
    // or an active row whose room somehow did not open; the attach opens it
    const room = existing ?? this.#newRoom(key, tenant);
    // loaded before it is reachable: nothing may see a half-open room. The
    // link is bound right after, because the hello below asks the agent
    // questions whose answers must find their room.
    await room.retarget(msg, end);
    this.#rooms.set(key, room);
    this.#links.set(end, key);
    this.#defaultKeys.set(tenant, key);
    // the row a restart reopens this room from, and the registry entry the
    // switcher reads for it; a stale one costs a project
    void room.saveProject();
    this.#remember(key, room.row());
    // The attach names the keys an older Shape derived for this repo's
    // worktrees, and `retarget` has just moved their canvases onto the current
    // one (the storage drops the legacy registry row with the last of them). A
    // restart had meanwhile opened a room for such a row, and that room is now
    // this very project a second time: it is FORGOTTEN, never closed, because
    // closing it would file the canvases it no longer owns back under the key
    // they were adopted from.
    const orphaned: WebSocket[] = [];
    for (const legacy of Object.values(msg.project.legacyKeys)) {
      const stale = `${tenant}/${legacy}`;
      if (stale === key) continue;
      // the storage drops the legacy row whether or not it had a room (a parked
      // one has none), and the switcher must not go on listing it
      this.#registry.delete(stale);
      if (!this.#rooms.delete(stale)) continue;
      if (this.#defaultKeys.get(tenant) === stale) this.#defaultKeys.set(tenant, key);
      orphaned.push(...this.#hub.leave(stale));
    }

    const hello = await room.hello();
    // a fresh room's browsers were greeted on connect (or are owed one below);
    // only a re-attach onto a room that was already there is news to sockets
    // already joined
    if (existing !== undefined) this.#hub.broadcastTo(key, hello);
    // the browsers that were watching this project under its old key are on it
    // under the new one, and hear the same greeting
    for (const socket of orphaned) {
      this.#hub.join(socket, key);
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(hello));
    }
    // the sockets that beat the first attach are joined here and greeted once
    this.#hub.greetPending(tenant, key, hello);
    this.#broadcastProjects(tenant);
  }

  /**
   * A room's wiring: what it broadcasts reaches its own watchers, the project
   * list is the server's to answer, and its records are the storage's — under
   * the tenant that owns the room. Attaches, restores and discovery all open
   * rooms this way.
   */
  #newRoom(key: string, tenant: string): ProjectRoom {
    return new ProjectRoom({
      broadcast: (out: ServerMsg) => this.#hub.broadcastTo(key, out),
      projects: () => this.#projects(tenant),
      onProjectsChanged: () => this.#broadcastProjects(tenant),
      storage: this.#storage,
      tenant,
      importLegacy: this.#importLegacy,
    });
  }

  /** One registry row's room, loaded from what the row remembers and agentless. */
  async #openRoom(key: string, row: StoredProject): Promise<ProjectRoom> {
    const room = this.#newRoom(key, row.tenant);
    await room.restore(row);
    this.#rooms.set(key, room);
    return room;
  }

  /**
   * A repo the scan saw for the first time: an ACTIVE row with a project
   * synthesized from what a directory listing can tell — no graph derived, no
   * harness, no tools. The agent runtime `onActivated` starts is what attaches
   * and fills those in; until then the room is a readable, empty canvas.
   */
  async #insert(tenant: string, key: string, repo: SeenRepo): Promise<void> {
    const now = new Date().toISOString();
    const row: StoredProject = {
      project: {
        key: repo.key,
        label: repo.label,
        cwd: repo.cwd,
        backend: null,
        tools: { launcher: null, launchers: [], harnesses: [] },
        targetHasCode: false,
        directivePath: null,
        manager: null,
        legacyKeys: {},
      },
      tenant,
      worktrees: repo.worktrees,
      sessions: [],
      liveSessions: repo.live.length,
      status: "active",
      statusChangedAt: now,
      lastSeen: now,
    };
    this.#registry.set(key, row);
    const room = await this.#openRoom(key, row);
    room.noteSeen(repo.worktrees, repo.live);
    void room.saveProject();
    await this.#opened(tenant, key, room);
    this.#onActivated?.({ key: repo.key, cwd: repo.cwd, tenant });
  }

  /**
   * The project is active again: its room comes back from the row, exactly as a
   * restart would reopen it, and the runtime that feeds it is started.
   */
  async #activate(tenant: string, key: string, row: StoredProject): Promise<void> {
    const room = await this.#openRoom(key, row);
    await this.#opened(tenant, key, room);
    this.#onActivated?.({ key: row.project.key, cwd: row.project.cwd, tenant });
  }

  /**
   * The project is inactive: its room is closed and forgotten, and the
   * browsers that were watching it are moved onto this tenant's newest active
   * project — or left waiting, exactly like a socket that connected before its
   * tenant had one.
   */
  async #deactivate(tenant: string, key: string): Promise<void> {
    const room = this.#rooms.get(key);
    this.#rooms.delete(key);
    // unjoined before the close, in the same tick the room left the map: a
    // frame a watcher sends meanwhile must find "no room" the way an early
    // socket does, not a room that is halfway through filing its records
    const watchers = this.#hub.leave(key);
    if (room !== undefined) {
      // its records are flushed and filed, and the link feeding it is closed;
      // the registry then keeps what the room knew — the sessions that were
      // running and where, which is what a resume reads off an inactive row
      await room.close();
      this.#remember(key, room.row());
    }
    const next = this.#newestActiveKey(tenant);
    // a tenant whose default room was this one takes its newest remaining
    // project, or none at all: the next browser then waits like an early one
    if (this.#defaultKeys.get(tenant) === key) {
      if (next === null) this.#defaultKeys.delete(tenant);
      else this.#defaultKeys.set(tenant, next);
    }
    if (next === null || watchers.length === 0) return;
    const nextRoom = this.#rooms.get(next);
    if (nextRoom === undefined) return;
    const hello = JSON.stringify(await nextRoom.hello());
    for (const socket of watchers) {
      this.#hub.join(socket, next);
      if (socket.readyState === socket.OPEN) socket.send(hello);
    }
  }

  /**
   * A room opened with no attach behind it — discovery, or a project marked
   * active again. Its tenant may have browsers waiting for a first project to
   * watch, and a tenant with no default room takes this one.
   */
  async #opened(tenant: string, key: string, room: ProjectRoom): Promise<void> {
    if (!this.#defaultKeys.has(tenant)) this.#defaultKeys.set(tenant, key);
    this.#hub.greetPending(tenant, key, await room.hello());
  }

  /**
   * The registry entry for a project whose room just wrote its row. The status
   * and its stamp are the registry's alone — `setProjectStatus` moves them and
   * nothing else, exactly as the storage treats an existing row — so a save
   * from a room mid-turn can never resurrect a project just parked.
   */
  #remember(key: string, row: StoredProject): void {
    const known = this.#registry.get(key);
    this.#registry.set(
      key,
      known === undefined ? row : { ...row, status: known.status, statusChangedAt: known.statusChangedAt },
    );
  }

  /** the tenant's most recently seen open room: where an orphaned browser goes */
  #newestActiveKey(tenant: string): string | null {
    let best: { key: string; lastSeen: string } | null = null;
    for (const [key, room] of this.#rooms) {
      if (room.tenant !== tenant) continue;
      const { lastSeen } = room.summary();
      if (best === null || lastSeen > best.lastSeen) best = { key, lastSeen };
    }
    return best?.key ?? null;
  }

  /**
   * A browser asked to watch another project this server hosts. Another
   * tenant's project is not "forbidden" to it, it is unknown: the id names a
   * room key it cannot form. An inactive one it can see in its own list, and
   * is told what is wrong with it — there is nothing to watch until it is
   * marked active.
   */
  async #select(socket: WebSocket, projectId: string, reply: (msg: ServerMsg) => void): Promise<void> {
    const tenant = this.#hub.tenantOf(socket);
    const key = `${tenant}/${projectId}`;
    const known = this.#registry.get(key);
    if (known !== undefined && known.status === "inactive") {
      reply({ type: "error", message: `project ${projectId} is inactive` });
      return;
    }
    const room = this.#rooms.get(key);
    if (room === undefined) {
      reply({ type: "error", message: `unknown project ${projectId}` });
      return;
    }
    this.#hub.join(socket, key);
    reply(await room.hello());
  }

  #linkClosed(end: ServerEnd, reason: string): void {
    const key = this.#links.get(end);
    this.#links.delete(end);
    const room = key === undefined ? undefined : this.#rooms.get(key);
    // a link that never opened a room, one whose room has since been closed
    // (the project was marked inactive), or one the room has replaced with a
    // reconnect, takes nothing down with it
    if (key === undefined || room === undefined || !room.attachedTo(end)) {
      console.error(`[bridge] agent link closed: ${reason}`);
      return;
    }
    room.agentGone(`agent link closed: ${reason}`);
    this.#remember(key, room.row());
  }

  #roomFor(end: ServerEnd): ProjectRoom | undefined {
    const key = this.#links.get(end);
    return key === undefined ? undefined : this.#rooms.get(key);
  }

  /**
   * One tenant's projects, most recently seen first; no other tenant's exist to
   * it. Every open room answers for itself, and every row without one is an
   * inactive project: it has no room to count what is running in it, so what
   * the last scan saw is what it shows.
   */
  #projects(tenant: string): ProjectSummary[] {
    const summaries: ProjectSummary[] = [];
    for (const room of this.#rooms.values()) {
      if (room.tenant === tenant) summaries.push(room.summary());
    }
    for (const [key, row] of this.#registry) {
      if (row.tenant !== tenant || this.#rooms.has(key)) continue;
      summaries.push({
        projectId: row.project.key,
        label: row.project.label,
        cwd: row.project.cwd,
        status: row.status,
        liveSessions: row.liveSessions,
        manager: row.project.manager !== null,
        // nothing is owed a project nothing is running for
        caughtUp: true,
        injected: 0,
        lastSeen: row.lastSeen,
      });
    }
    summaries.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
    return summaries;
  }

  #broadcastProjects(tenant: string): void {
    this.#hub.broadcastToTenant(tenant, { type: "projects", projects: this.#projects(tenant) });
  }
}
