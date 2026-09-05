/**
 * The loopback link endpoint (`ws://127.0.0.1:<port>/link`): harness-side
 * processes — the MCP server (`packages/link/src/mcp.ts`), a Claude Code hook
 * (`packages/link/src/hook.ts`), the omp extension — talking to the fleet,
 * which routes each of them to the runtime hosting their repo.
 *
 * One mount for the whole process, not one per project: a caller names the
 * directory it runs in and nothing else, so which project it belongs to is an
 * answer only the fleet has. A caller no project claims is refused and
 * remembered — activating its project is what gets it hung up on, so its own
 * reconnect delivers it to the runtime that now exists.
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
   * Which session a caller belongs to, by the cwd it reports. The fleet owns
   * the answer: only its runtimes know their repos' worktrees, and only it
   * knows which projects are active at all.
   */
  route: ExternalIoOptions["route"];
}

export interface LoopbackLink {
  /** drop every connected caller (fleet stop, link teardown) */
  close(): void;
  /**
   * The cwds of callers that greeted and have not gone away: which directories
   * have a session on the link RIGHT NOW. Raw as they said them —
   * canonicalizing a directory is the fleet's job, and only its runtimes know
   * the repos' worktrees.
   */
  greeted(): string[];
  /**
   * Hang up on every caller whose latest `hello` was refused, because a
   * project that now exists may be the one it belongs to. The client re-dials
   * and re-greets by itself — the omp extension backs off 1–8 s, the MCP
   * sidecar reconnects per call, and a hook is one-shot anyway — which is why
   * closing the socket is the whole of it: nothing here has a way to reach a
   * caller that is not asking.
   */
  kickRefused(): void;
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

  /**
   * Sockets whose latest `hello` named a directory no project claims. They are
   * held so `kickRefused` can hang up once a project for them exists: the
   * caller has already spoken, and only a fresh `hello` gets it a session.
   */
  const refused = new Set<WebSocket>();

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
      const routed = io.handle(msg, (out) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
      });
      // only a hello asks for a session; the verdict on the others is this
      // one's, and re-dialling would not change it
      if (msg.type !== "hello") return;
      if (routed) refused.delete(socket);
      else refused.add(socket);
    });
    const gone = (reason: string): void => {
      clients.delete(socket);
      refused.delete(socket);
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
      refused.clear();
    },
    greeted(): string[] {
      return [...linked.keys()];
    },
    kickRefused(): void {
      const kicked = [...refused];
      refused.clear();
      for (const socket of kicked) socket.close();
    },
  };
}
