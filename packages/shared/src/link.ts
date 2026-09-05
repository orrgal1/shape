/**
 * Two wires live here, both "the link", both types-only (imported by every
 * package, so this file must stay erasable).
 *
 * 1. The LOOPBACK link (harness-side process ↔ agent). Anything that runs next
 *    to the harness and is not the harness itself — the MCP server Shape ships
 *    (`packages/link/src/mcp.ts`), a harness hook (`packages/link/src/hook.ts`),
 *    a future adapter sidecar — speaks `LinkClientMsg` / `LinkServerMsg` over
 *    `ws://127.0.0.1:<port>/link`, served by the agent on the user's machine.
 *    These processes never hold server credentials: the agent is their proxy.
 *
 * 2. The AGENT link (agent ↔ Shape server). `AgentToServerMsg` /
 *    `ServerToAgentMsg` is everything the server needs from the machine the
 *    harness and repo live on, and everything it asks that machine to do. In
 *    local mode both ends are in one process over an in-memory pair; remotely
 *    it is a WebSocket at `/agent` (docs/notes/PLAN.md §Link v2).
 *
 * Every frame after `attach` is implicitly scoped to the socket's project: the
 * server never trusts a project id in a frame body. Within that project, a
 * frame about one harness names its `worktree` explicitly — one agent observes
 * one harness per worktree that reports in, and the socket cannot say which.
 */

import type {
  AgentState,
  BackendInfo,
  CanvasOp,
  ManagerHandle,
  ProjectTools,
  RealityLayer,
  WorktreeInfo,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Loopback link (harness-side process ↔ agent)
// ---------------------------------------------------------------------------

/** one harness event, already projected into the terms the canvas cares about */
export type AgentEvent =
  | { kind: "state"; state: "idle" | "streaming" | "compacting" }
  /** one whole assistant message (the sender coalesces deltas) */
  | { kind: "text"; text: string }
  /**
   * One fragment of the message being written right now. Never stored: the
   * room folds it into the live "now" line and forgets it — the `text` that
   * follows is the message of record.
   */
  | { kind: "text_delta"; delta: string }
  /** `paths` are path-ish tokens for codeRefs matching; `summary` is human */
  | { kind: "tool_start"; name: string; paths: string[]; summary: string }
  | { kind: "tool_end"; name: string; isError: boolean }
  | { kind: "turn_end" }
  /**
   * Which session/model the harness is on. `sessionFile` is optional because
   * only a harness that logs to disk has one to name.
   */
  | {
      kind: "session";
      sessionId: string | null;
      sessionFile?: string | null;
      model: { provider: string; id: string } | null;
    };

/**
 * Harness-side process → agent. Every frame names the working directory the
 * caller runs in: Shape runs one harness per worktree, and the cwd is the only
 * thing that says which of them a hook or an MCP sidecar belongs to (the agent
 * maps it to a worktree id).
 */
export type LinkClientMsg =
  /**
   * First frame of a session-bearing client (the omp extension): the harness
   * itself is on the link, so it can say what it is, which session it resumed
   * or started, and what it can be asked to do. A client that only forwards
   * (the MCP sidecar, a hook) never sends one — it has no session to announce.
   * `harness` is a free string, not a closed union: a launcher can host kinds
   * Shape has no adapter for.
   */
  | {
      type: "hello";
      cwd: string;
      harness: string;
      sessionId: string | null;
      sessionFile: string | null;
      model: { provider: string; id: string } | null;
      capabilities: { steer: boolean; tool: boolean };
    }
  /** a host-tool round trip carried over the socket; answered to the SAME socket only, correlated by `id` */
  | { type: "canvas_call"; cwd: string; id: string; args: unknown }
  | { type: "agent_event"; cwd: string; event: AgentEvent }
  /** receipt for `deliver`: `queued` when it landed mid-turn and waits its turn */
  | { type: "delivered"; cwd: string; id: string; mode: "prompt" | "steer"; queued: boolean }
  /** the harness session is going away (user quit the TUI, harness exited) */
  | { type: "bye"; cwd: string; reason: string };

/**
 * Agent → harness-side process. Answers (`canvas_result`, `error`) go to the
 * socket that asked; the rest are asks of the session on the other end, so
 * only a client that sent `hello` ever sees them.
 */
export type LinkServerMsg =
  | { type: "canvas_result"; id: string; text: string; isError: boolean }
  /** put this utterance into the session: as a fresh prompt, or into the running turn */
  | { type: "deliver"; id: string; body: string; mode: "prompt" | "steer" }
  /** stop the running turn */
  | { type: "abort" }
  /** autonomous mode changed: while on, the harness approves its own tool calls */
  | { type: "autonomous"; on: boolean }
  /** a frame the agent could not parse; the caller's socket alone hears it */
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Agent link (agent ↔ Shape server)
// ---------------------------------------------------------------------------

/** the harness session the agent is observing in one worktree, as far as it knows */
export interface AgentSession {
  sessionId: string | null;
  sessionName: string | null;
  model: { provider: string; id: string } | null;
}

/**
 * One running harness of a project: one per worktree with a session reporting
 * in, so a session is only ever meaningful together with the worktree it is
 * running in. This is the unit `attach` lists and `session_started` adds.
 */
export interface WorktreeSession {
  /** the worktree id (realpath of its directory) this harness runs in */
  worktree: string;
  session: AgentSession;
  /** the harness this session runs on, and what it can do */
  backend: BackendInfo;
  /** what it is doing right now */
  state: AgentState;
}

/** the project an agent is attached to; `cwd` is a label to the server, an authority only to the agent */
export interface AgentProject {
  /** stable across restarts: derived by the agent from machine + realpath(the repo's common dir) */
  key: string;
  /** what a picker shows: basename of cwd */
  label: string;
  cwd: string;
  /**
   * The project's harness: the one the first session that reported in runs
   * on. `null` while no session is on the link.
   */
  backend: BackendInfo | null;
  /** what is installed where this agent runs, and whether herdr is there */
  tools: ProjectTools;
  /** the repo already contains source code (automatic map gate) */
  targetHasCode: boolean;
  /**
   * Absolute path on the agent's machine of the per-project directive the
   * agent wrote (what Shape is, this project's link URL, the `canvas`
   * contract). Null when it could not be written — the directive is a
   * convenience, so nothing else depends on it.
   */
  directivePath: string | null;
  /**
   * The manager session in this project's herdr workspace, as the agent found
   * or opened it. Null when the project's launcher is not herdr, or when the
   * manager could not be reached — a project open never fails over a manager.
   * Absent from an older agent, and from a stored registry row that predates
   * this.
   */
  manager: ManagerHandle | null;
  /**
   * For every worktree the agent lists, the project key an older Shape would
   * have derived for it — machine + realpath of the worktree DIRECTORY, from
   * before the key came off the repo's common dir. Keyed by worktree id. The
   * server adopts a canvas stored under one of these onto the current key, so
   * an upgrade does not strand the graph a user already drew. Empty from an
   * older agent, and empty in a stored registry row that predates this.
   */
  legacyKeys: Record<string, string>;
  /**
   * The herdr panes this bridge PROCESS has briefed with the project's Shape
   * directive (issue #5, §Injection). Pane ids, not worktrees: a project's
   * sessions are panes, several of them can share one worktree, and each is
   * briefed at most once per process. Process-scoped on purpose — a restarted
   * bridge cannot know what the sessions were told before it, so it tells them
   * again. Empty from an older agent, and empty in a stored registry row that
   * predates this.
   */
  injected: string[];
}

/**
 * Agent → server. `attach` is always first: it is a runtime's one announcement
 * of the project it observes, sent again only when the link came back after a
 * gap. It never retargets — a runtime is one project for its whole life, and
 * the room's project never changes under it.
 * Frames carrying an `id` answer a server request of the same id.
 */
export type AgentToServerMsg =
  | {
      type: "attach";
      project: AgentProject;
      /**
       * every worktree of the project's repo; the first entry the agent lists
       * for `project.cwd` is the main one
       */
      worktrees: WorktreeInfo[];
      /**
       * the harnesses reporting in to this agent, one per worktree. May be
       * empty: the server opens the room with no running session and waits for
       * `session_started`.
       */
      sessions: WorktreeSession[];
      /**
       * reality per worktree at attach time, keyed by worktree id. A worktree
       * whose extraction found nothing (or is unavailable) has no entry.
       */
      realities: Record<string, RealityLayer>;
    }
  /** a harness started reporting in from `worktree` (a link `hello`, a hook, a canvas call) */
  | { type: "session_started"; worktree: string; session: AgentSession; backend: BackendInfo }
  /** that worktree's harness is gone (it said `bye`, or the agent lost it) */
  | { type: "session_stopped"; worktree: string; reason: string }
  | { type: "agent_event"; worktree: string; event: AgentEvent }
  /** the harness (native host tool or loopback link) wants to write to the canvas */
  | { type: "canvas_call"; worktree: string; id: string; args: unknown }
  /** re-derived reality (startup, or HEAD moved while the agent went idle); per worktree, because HEADs differ */
  | { type: "reality"; worktree: string; reality: RealityLayer; head: string | null }
  /** answers `list_worktrees`; also pushed unsolicited when the agent notices a change */
  | { type: "worktrees"; id: string | null; worktrees: WorktreeInfo[] }
  /** answers `synthesize_skeleton`, echoing the request's worktree */
  | { type: "skeleton_result"; worktree: string; id: string; ops: CanvasOp[] }
  /** an adapter error worth showing the user (becomes a browser `error` frame) */
  | { type: "agent_error"; message: string }
  /** the agent cannot continue this project */
  | { type: "agent_exit"; reason: string }
  /**
   * The panes this agent has briefed with the directive: the FULL current list,
   * which REPLACES the room's copy rather than adding to it, sent after every
   * injection pass that briefed somebody. A list, not a count, so a room that
   * hears it twice cannot double-count — and so a re-attach and a later frame
   * say the same thing.
   */
  | { type: "injected"; paneIds: string[] }
  | { type: "detached"; reason: string };

/**
 * Server → agent. Requests carry an `id` the agent echoes in its answer, and
 * everything that acts on one harness names its worktree.
 */
export type ServerToAgentMsg =
  | { type: "attached"; projectId: string }
  | { type: "error"; message: string }
  | { type: "canvas_result"; id: string; text: string; isError: boolean }
  /**
   * Bring that worktree's harness terminal forward: `agent.focus` on its herdr
   * tab. Answered by `agent_error` when it could not be done.
   */
  | { type: "focus_terminal"; worktree: string }
  | { type: "list_worktrees"; id: string }
  | { type: "extract_reality"; worktree: string }
  | { type: "synthesize_skeleton"; worktree: string; id: string };
