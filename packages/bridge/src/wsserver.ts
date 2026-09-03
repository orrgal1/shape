/**
 * One HTTP listener, several WebSocket endpoints by path. Local mode mounts
 * the browser hub (`/ws`, server side) and the loopback link (`/link`, agent
 * side) on the same port; remote mode gives each process its own instance.
 *
 * Owns nothing but sockets: every mount gets raw connections and does its own
 * validation and bookkeeping. The one exception is identity — a mount may hand
 * in an `authorize` hook, and a connection it refuses never becomes a socket
 * at all (401 at the upgrade). Everything below the mount therefore knows the
 * tenant of every connection it is given, and no frame carries a token.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LOCAL_TENANT } from "./server/auth.ts";

export type ConnectionHandler = (socket: WebSocket, request: IncomingMessage, tenant: string) => void;

export interface MountOptions {
  /**
   * The tenant this connection speaks for, or null to refuse it. Absent ⇒ the
   * mount is unauthenticated and every connection is `LOCAL_TENANT`.
   */
  authorize?: (request: IncomingMessage) => string | null;
}

interface Mount {
  wss: WebSocketServer;
  handler: ConnectionHandler;
  authorize: ((request: IncomingMessage) => string | null) | null;
}

export class SocketServer {
  readonly #http: Server;
  readonly #host: string;
  readonly #port: number;
  readonly #mounts = new Map<string, Mount>();

  constructor(opts: { port: number; host?: string }) {
    this.#host = opts.host ?? "127.0.0.1";
    this.#port = opts.port;
    this.#http = createServer((_req, res) => {
      res.statusCode = 426;
      res.setHeader("content-type", "text/plain");
      res.end("websocket endpoints only\n");
    });
    this.#http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = request.url === undefined ? "" : new URL(request.url, "http://localhost").pathname;
      const mount = this.#mounts.get(path);
      if (mount === undefined) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      const tenant = mount.authorize === null ? LOCAL_TENANT : mount.authorize(request);
      if (tenant === null) {
        // no socket, so no room to leak and nothing to close later: a client
        // that guessed wrong learns it from the HTTP status
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      mount.wss.handleUpgrade(request, socket, head, (ws) => mount.handler(ws, request, tenant));
    });
  }

  /** `path` must start with "/"; mounting the same path twice is a programming error */
  mount(path: string, handler: ConnectionHandler, opts?: MountOptions): void {
    if (this.#mounts.has(path)) throw new Error(`socket path ${path} already mounted`);
    const wss = new WebSocketServer({ noServer: true });
    this.#mounts.set(path, { wss, handler, authorize: opts?.authorize ?? null });
  }

  listen(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.#http.once("error", reject);
    this.#http.listen(this.#port, this.#host, () => {
      this.#http.off("error", reject);
      resolve();
    });
    return promise;
  }

  /** the address a client on this machine uses for `path` */
  url(path: string): string {
    return `ws://${this.#host}:${this.#port}${path}`;
  }

  get port(): number {
    return this.#port;
  }

  close(): Promise<void> {
    for (const { wss } of this.#mounts.values()) {
      for (const client of wss.clients) client.close();
      wss.close();
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#http.close(() => resolve());
    // keep-alive connections would hold close() open; drop them
    this.#http.closeAllConnections();
    return promise;
  }
}
