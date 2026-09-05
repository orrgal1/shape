/**
 * The loopback link endpoint (`ws://127.0.0.1:<port>/link`): harness-side
 * processes — the MCP server (`packages/link/src/mcp.ts`), a Claude Code hook
 * (`packages/link/src/hook.ts`), the omp extension — talking to the agent
 * runtime that watches their worktree.
 *
 * It terminates on the AGENT half by design: those callers are children of the
 * harness, they hold no server credentials, and everything they say is how
 * Shape learns a session exists at all (`ExternalIo` feeds the runtime's
 * per-worktree `AgentEvents` sink). A `canvas_call` is answered on the socket
 * that asked and nowhere else; the graph broadcast is the part everyone sees.
 *
 * Trusted exactly as much as the browser hub is: loopback bind plus per-frame
 * validation in `linkparse.ts`.
 */

import type { WebSocket } from "ws";
import { LINK_WS_PATH } from "../../../shared/src/index.ts";
import type { LinkServerMsg } from "../../../shared/src/link.ts";
import type { SocketServer } from "../wsserver.ts";
import type { ExternalIoOptions } from "./external.ts";
import { ExternalIo } from "./external.ts";
import { parseLinkMsg } from "./linkparse.ts";

/**
 * Boundary refusal, same wording as the browser hub's: a frame the agent cannot
 * make sense of is rejected whole, never half-applied. Pre-serialized because
 * it is a constant.
 */
const REFUSAL = JSON.stringify({ type: "error", message: "unparseable client message" } satisfies LinkServerMsg);

export interface LoopbackLinkOptions {
  /**
   * Which harness a caller belongs to, by the cwd it reports. The runtime owns
   * the answer: it is the only thing that knows the repo's worktrees and which
   * of them have a harness running.
   */
  route: ExternalIoOptions["route"];
}

export interface LoopbackLink {
  /** drop every connected caller (runtime stop, link teardown) */
  close(): void;
  /**
   * The cwds of callers that greeted and have not gone away: which sessions
   * have a Shape-aware harness on the link RIGHT NOW. Raw as they said them —
   * canonicalizing a directory is the runtime's job, and only it knows the
   * repo's worktrees.
   */
  greeted(): string[];
}

export function mountLoopbackLink(sockets: SocketServer, opts: LoopbackLinkOptions): LoopbackLink {
  const io = new ExternalIo({ route: opts.route });
  const clients = new Set<WebSocket>();
  /**
   * How many live sockets greeted for each cwd. A count, not a set: a harness
   * being restarted in the same directory overlaps its successor for a moment
   * (the old socket closes after the new one greets), and the directory is
   * linked throughout — dropping it on the first goodbye would report a live
   * session as unaware of Shape.
   */
  const linked = new Map<string, number>();

  /** one caller of `cwd` is gone; the directory stays linked while others hold it */
  const leave = (cwd: string): void => {
    const left = (linked.get(cwd) ?? 0) - 1;
    if (left > 0) linked.set(cwd, left);
    else linked.delete(cwd);
  };

  sockets.mount(LINK_WS_PATH, (socket) => {
    clients.add(socket);
    /**
     * The cwd of the session this socket greeted for, if any. A harness that
     * drops its socket without saying goodbye (killed, crashed, the terminal
     * closed) has still ended its session, and the canvas has to stop showing
     * it — so a close is replayed as the `bye` it never sent. A second goodbye
     * for a session already dropped is no news to the runtime.
     */
    let greeted: string | null = null;
    // no hello here: a link client is not a browser, it only ever gets answers
    // to what it asked
    socket.on("message", (data) => {
      const msg = parseLinkMsg(data.toString());
      if (msg === null) {
        socket.send(REFUSAL);
        return;
      }
      if (msg.type === "hello") {
        // a socket that greets twice re-targets: the directory it held first
        // loses this caller, or a restart in place would never be released
        if (greeted !== null) leave(greeted);
        greeted = msg.cwd;
        linked.set(msg.cwd, (linked.get(msg.cwd) ?? 0) + 1);
      }
      if (msg.type === "bye" && greeted !== null) {
        leave(greeted);
        greeted = null;
      }
      io.handle(msg, (out) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
      });
    });
    const gone = (reason: string): void => {
      clients.delete(socket);
      const cwd = greeted;
      greeted = null;
      if (cwd === null) return;
      leave(cwd);
      io.handle({ type: "bye", cwd, reason }, () => undefined);
    };
    socket.on("close", () => gone("the harness closed the link"));
    socket.on("error", () => gone("the link to the harness failed"));
  });

  return {
    close(): void {
      for (const socket of clients) socket.close();
      clients.clear();
    },
    greeted(): string[] {
      return [...linked.keys()];
    },
  };
}
