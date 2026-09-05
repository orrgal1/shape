/**
 * The bridge end of the link: external processes talking the same WebSocket.
 *
 * Two frames, both from `packages/shared/src/link.ts`:
 * - `canvas_call` — the universal canvas channel for harnesses that cannot host
 *   a tool for us. The MCP server Shape ships (`packages/link/src/mcp.ts`) is
 *   just a caller: it forwards the tool arguments, we apply them to the graph,
 *   and the result goes back to the socket that asked, correlated by `id`.
 * - `agent_event` — one already-projected harness event, fed into that
 *   worktree's `AgentEvents` sink. A session that speaks the link at all —
 *   the omp extension, Claude Code's hooks, a transcript tail — therefore
 *   gives Shape activity, transcript lines and agent state, and that is the
 *   ONLY way Shape learns any of it: it starts nothing and drives nothing.
 *
 * Both name the working directory the caller runs in, and that is how they are
 * routed: a session is only meaningful once the cwd it came from has been
 * resolved to one of the project's worktrees, which is also how a session
 * becomes visible in the first place (`agent/runtime.ts` registers a worktree's
 * session the moment a caller from it speaks).
 *
 * The link is trusted exactly as much as the browser is: the socket is bound to
 * 127.0.0.1 and every frame was already validated in `agent/linkparse.ts`.
 */

import type { AgentState } from "../../../shared/src/index.ts";
import type { LinkClientMsg, LinkServerMsg } from "../../../shared/src/link.ts";

/** the session-bearing client's opening frame, as the validator hands it over */
export type LinkHello = Extract<LinkClientMsg, { type: "hello" }>;

/**
 * One worktree's event sink, for as long as a session is reporting in from it.
 * Every frame the runtime produces out of these names that worktree, so the
 * room can file it against the right canvas without guessing.
 */
export interface AgentEvents {
  onAgentState(state: AgentState): void;
  /** one whole assistant message, coalesced by whoever reported it */
  onAssistantText(text: string): void;
  /** a fragment of the message being written right now, for the live "now" line */
  onTextDelta(delta: string): void;
  onToolStart(call: {
    name: string;
    /** path-ish tokens from the call's arguments, for codeRefs matching */
    paths: string[];
    /** short human summary of the call's primary argument ("" when there is none) */
    summary: string;
  }): void;
  onToolEnd(info: { name: string; isError: boolean }): void;
  /** the turn is over as far as tool activity goes */
  onTurnEnd(): void;
  /**
   * The harness told us which session/model it is on. Reported whenever it
   * arrives, which may be long after the session started: a hook-driven
   * session cannot know its own id until the harness says so.
   */
  onSession(info: { sessionId: string | null; model: { provider: string; id: string } | null }): void;
}

/** The session a link caller's cwd belongs to, as the runtime resolves it. */
export interface LinkTarget {
  /** apply canvas ops in that worktree and answer with what the agent should see */
  applyCanvas: (args: unknown) => Promise<{ text: string; isError: boolean }>;
  /** that worktree's event sink */
  events: AgentEvents;
  /**
   * The two frames only a harness ON the link can send: it announced itself
   * (which is when Shape learns what the session really is), and its session
   * ended. A caller that is not the harness — a hook, the MCP sidecar — never
   * sends them.
   */
  onHello: (hello: LinkHello) => void;
  onBye: (reason: string) => void;
}

export interface ExternalIoOptions {
  /**
   * Which worktree a caller belongs to, by the cwd it reports, or a refusal
   * with a sentence the agent can read: a cwd outside the project has no sink
   * to write to.
   */
  route: (cwd: string) => LinkTarget | { error: string };
}

export class ExternalIo {
  readonly #route: ExternalIoOptions["route"];

  constructor(opts: ExternalIoOptions) {
    this.#route = opts.route;
  }

  /**
   * Deliver one frame. Answers false when `route` refused the caller's cwd: no
   * project this process hosts contains it. The mount remembers that verdict,
   * because a project that appears later has to reach a caller that has
   * already spoken (`kickRefused` in `link.ts`).
   */
  handle(msg: LinkClientMsg, reply: (msg: LinkServerMsg) => void): boolean {
    const target = this.#route(msg.cwd);
    if ("error" in target) {
      // a canvas call is a tool the harness is BLOCKED on: it hears the refusal
      // as a failed tool result, not as an `error` frame it does not read
      if (msg.type === "canvas_call") reply({ type: "canvas_result", id: msg.id, text: target.error, isError: true });
      else reply({ type: "error", message: target.error });
      return false;
    }
    this.#deliver(msg, target, reply);
    return true;
  }

  #deliver(msg: LinkClientMsg, target: LinkTarget, reply: (msg: LinkServerMsg) => void): void {
    if (msg.type === "canvas_call") {
      const { id } = msg;
      // a canvas result belongs to the caller alone; the graph broadcast is the
      // part everyone else sees
      target.applyCanvas(msg.args).then(
        (result) => reply({ type: "canvas_result", id, text: result.text, isError: result.isError }),
        (err: unknown) =>
          reply({
            type: "canvas_result",
            id,
            text: `canvas call failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }),
      );
      return;
    }
    if (msg.type === "hello") {
      target.onHello(msg);
      return;
    }
    if (msg.type === "delivered") {
      // a harness that still acknowledges a prompt Shape did not send: Shape
      // delivers nothing any more, so the receipt has no reader — and having
      // said it is not an error worth answering
      return;
    }
    if (msg.type === "bye") {
      target.onBye(msg.reason);
      return;
    }
    const events = target.events;
    const event = msg.event;
    switch (event.kind) {
      case "state":
        events.onAgentState(event.state);
        return;
      case "text":
        events.onAssistantText(event.text);
        return;
      case "text_delta":
        // the live "now" line only: a delta is never stored
        events.onTextDelta(event.delta);
        return;
      case "tool_start":
        events.onToolStart({ name: event.name, paths: event.paths, summary: event.summary });
        return;
      case "tool_end":
        events.onToolEnd({ name: event.name, isError: event.isError });
        return;
      case "turn_end":
        events.onTurnEnd();
        return;
      case "session":
        // a hook-driven session cannot name itself: the harness tells the
        // bridge which session and model it is on, whenever it knows
        events.onSession({ sessionId: event.sessionId, model: event.model });
        return;
    }
  }
}
