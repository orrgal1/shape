/**
 * One HTTP listener, several WebSocket endpoints by path. Local mode mounts
 * the browser hub (`/ws`, server side) and the loopback link (`/link`, agent
 * side) on the same port; remote mode gives each process its own instance.
 *
 * Owns nothing but sockets: every mount gets raw connections and does its own
 * validation and bookkeeping.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

export type ConnectionHandler = (socket: WebSocket, request: IncomingMessage) => void;

export class SocketServer {
  readonly #http: Server;
  readonly #host: string;
  readonly #port: number;
  readonly #mounts = new Map<string, { wss: WebSocketServer; handler: ConnectionHandler }>();

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
      mount.wss.handleUpgrade(request, socket, head, (ws) => mount.handler(ws, request));
    });
  }

  /** `path` must start with "/"; mounting the same path twice is a programming error */
  mount(path: string, handler: ConnectionHandler): void {
    if (this.#mounts.has(path)) throw new Error(`socket path ${path} already mounted`);
    this.#mounts.set(path, { wss: new WebSocketServer({ noServer: true }), handler });
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
