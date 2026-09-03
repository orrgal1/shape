/**
 * The canvas server: browsers on `BRIDGE_WS_PATH`, agents over the link. An
 * agent's first `attach` opens the room it names; every later `attach` on the
 * same link is a retarget (it switched projects).
 *
 * Phase 0 hosts exactly one room, because local mode attaches exactly one
 * agent — but nothing here knows how that link is carried, so the same class
 * serves a socket-attached agent unchanged.
 */

import type { ServerMsg } from "../../../shared/src/index.ts";
import type { ServerEnd } from "../transport.ts";
import type { SocketServer } from "../wsserver.ts";
import { ProjectRoom, type AttachMsg } from "./room.ts";
import { WsHub } from "./ws.ts";

export interface ShapeServerOptions {
  sockets: SocketServer;
}

export class ShapeServer {
  readonly #hub: WsHub;
  #link: ServerEnd | null = null;
  #room: ProjectRoom | null = null;
  /** attaches are serialized: a retarget must finish loading before the next starts */
  #attaching: Promise<void> = Promise.resolve();

  constructor(opts: ShapeServerOptions) {
    this.#hub = new WsHub({
      sockets: opts.sockets,
      // a browser that beat the agent's first attach here has nothing to be
      // told yet; it is greeted the moment the room opens
      hello: () => this.#room?.hello() ?? null,
      onMessage: (msg, reply) => this.#room?.handleClient(msg, reply),
    });
  }

  /** null until the agent's first `attach` was processed */
  get room(): ProjectRoom | null {
    return this.#room;
  }

  attachAgent(end: ServerEnd): void {
    if (this.#link !== null) throw new Error("shape server: an agent is already attached");
    this.#link = end;

    end.onMessage((msg) => {
      if (msg.type === "attach") {
        this.#attaching = this.#attaching.then(() => this.#attach(end, msg));
        return;
      }
      this.#room?.handleAgent(msg);
    });

    end.onClose((reason) => {
      const room = this.#room;
      if (room === null) {
        console.error(`[bridge] agent link closed: ${reason}`);
        return;
      }
      room.agentGone(`agent link closed: ${reason}`);
    });
  }

  async #attach(end: ServerEnd, msg: AttachMsg): Promise<void> {
    const existing = this.#room;
    const room = existing ?? new ProjectRoom({ link: end, broadcast: (out: ServerMsg) => this.#hub.broadcast(out) });
    await room.retarget(msg);
    this.#room = room;
    // a retarget is news to every browser; a first open is owed only to the
    // ones that connected before there was a room — later sockets were greeted
    // on connect and must not hear the same hello twice
    const hello = await room.hello();
    if (existing === null) this.#hub.greetPending(hello);
    else this.#hub.broadcast(hello);
  }
}
