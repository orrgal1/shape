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
 *    it is a WebSocket at `/agent` (PLAN.md §Link v2).
 *
 * Every frame after `attach` is implicitly scoped to the socket's project: the
 * server never trusts a project id in a frame body. Within that project, a
 * frame about one harness names its `worktree` explicitly — one agent runs one
 * harness per worktree the user opened, and the socket cannot say which.
 */

import type {
  AgentState,
  BackendInfo,
  CanvasOp,
  DiscoveredSession,
  ProjectTools,
  RealityLayer,
  WorktreeInfo,
} from "./index.ts";
import type { PtyClientMsg, PtyServerMsg } from "./pty.ts";

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
   * `harness` is a free string, not the closed `Harness` union: a launcher can
   * host kinds Shape has no adapter for.
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

/** the harness session the agent is driving in one worktree, as far as it knows */
export interface AgentSession {
  sessionId: string | null;
  sessionName: string | null;
  model: { provider: string; id: string } | null;
}

/**
 * One running harness of a project: Shape runs one per worktree the user
 * opened, so a session is only ever meaningful together with the worktree it
 * is running in. This is the unit `attach` lists and `session_started` adds.
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
   * The project's harness: the one the first opened worktree runs. A project
   * always resolves one (omp when nothing else was chosen), so this is `null`
   * only while no session is running — every harness exited or was closed —
   * until the next one starts.
   */
  backend: BackendInfo | null;
  /** what is installed where this agent runs, and which launcher it picked */
  tools: ProjectTools;
  /** the repo already contains source code (onboarding CTA gate) */
  targetHasCode: boolean;
  /** `gh` is installed and signed in here, so a new project can be published */
  canPublish: boolean;
  /**
   * Absolute path on the agent's machine of the per-project directive the
   * agent wrote (what Shape is, this project's link URL, the `canvas`
   * contract). Null when it could not be written — the directive is a
   * convenience, so nothing else depends on it.
   */
  directivePath: string | null;
  /**
   * For every worktree the agent lists, the project key an older Shape would
   * have derived for it — machine + realpath of the worktree DIRECTORY, from
   * before the key came off the repo's common dir. Keyed by worktree id. The
   * server adopts a canvas stored under one of these onto the current key, so
   * an upgrade does not strand the graph a user already drew. Empty from an
   * older agent, and empty in a stored registry row that predates this.
   */
  legacyKeys: Record<string, string>;
}

/**
 * Agent → server. `attach` is always first; sending it again on the same link
 * is a retarget (the agent switched projects) and replaces the room's project.
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
       * the harnesses this agent is running, one per opened worktree. May be
       * empty: the server opens the room with no running session and waits for
       * `open_worktree`.
       */
      sessions: WorktreeSession[];
      /**
       * reality per worktree at attach time, keyed by worktree id. A worktree
       * whose extraction found nothing (or is unavailable) has no entry.
       */
      realities: Record<string, RealityLayer>;
      /** agent sessions running on this machine, for the adopt picker */
      discovered: DiscoveredSession[];
      /** this machine's recent project paths, most recent first */
      recentProjects: string[];
    }
  /** a harness came up in `worktree`: the agent started it, or adopted one into it */
  | { type: "session_started"; worktree: string; session: AgentSession; backend: BackendInfo }
  /** that worktree's harness is gone (closed, exited, disposed by a retarget) */
  | { type: "session_stopped"; worktree: string; reason: string }
  | { type: "agent_event"; worktree: string; event: AgentEvent }
  /** the harness (native host tool or loopback link) wants to write to the canvas */
  | { type: "canvas_call"; worktree: string; id: string; args: unknown }
  /** re-derived reality (startup, or HEAD moved while the agent went idle); per worktree, because HEADs differ */
  | { type: "reality"; worktree: string; reality: RealityLayer; head: string | null }
  /** answers `list_worktrees`; also pushed unsolicited when the agent notices a change */
  | { type: "worktrees"; id: string | null; worktrees: WorktreeInfo[] }
  /** answers `discover` */
  | { type: "sessions"; id: string | null; sessions: DiscoveredSession[] }
  | { type: "recents"; paths: string[] }
  /**
   * Answers `pick_folder`: the folder the user chose, or `null` when they
   * closed the chooser. The agent does not act on it — it is the browser that
   * decides what to open — so this frame only carries the path back.
   */
  | { type: "folder_picked"; path: string | null }
  /** receipt for `deliver`: how it went out; `queued` when a prompt landed mid-turn on a backend that cannot steer */
  | { type: "delivered"; worktree: string; id: string; mode: "prompt" | "steer"; queued: boolean }
  /** answers `synthesize_skeleton`, echoing the request's worktree */
  | { type: "skeleton_result"; worktree: string; id: string; ops: CanvasOp[] }
  /** answers `file_index`: project-relative paths of every tracked (or, for a non-git target, every walked) file */
  | { type: "file_index"; worktree: string; id: string; files: string[] }
  /** an adapter error worth showing the user (becomes a browser `error` frame) */
  | { type: "agent_error"; message: string }
  /** the harness died; the agent cannot continue this project */
  | { type: "agent_exit"; reason: string }
  | { type: "detached"; reason: string }
  /**
   * The harness's terminal wants to be on screen: `open: true` answers a
   * `focus_terminal` under the pty launcher, where "focus" can only mean the
   * browser's own drawer. A launcher whose terminal is the user's (herdr)
   * focuses it for real and never sends this.
   */
  | { type: "terminal"; worktree: string; open: boolean }
  /**
   * A `create` finished. Sent after the agent's own post-create `switch`, so it
   * travels the ordinary outbox and lands in the NEW room once it is attached.
   * Everything short of "the folder does not exist" is a warning, not a
   * failure: the user is standing in the new project either way.
   */
  | {
      type: "created";
      path: string;
      repo: "initialized" | "existing";
      github: { url: string } | null;
      warnings: string[];
    }
  | PtyServerMsg;

/**
 * Server → agent. Requests carry an `id` the agent echoes in its answer, and
 * everything that acts on one harness names its worktree. `switch` and
 * `create` are the exceptions on purpose: they retarget the WHOLE agent at
 * another project, disposing every harness it runs.
 */
export type ServerToAgentMsg =
  | { type: "attached"; projectId: string; preamble: string }
  | { type: "error"; message: string }
  | { type: "canvas_result"; id: string; text: string; isError: boolean }
  /**
   * A composed utterance for one worktree's harness. The agent decides `steer`
   * vs `prompt` (only it has live backend state) and prepends the preamble
   * from `attached` to the first fresh prompt of a harness session.
   */
  | { type: "deliver"; worktree: string; id: string; body: string }
  | { type: "abort"; worktree: string }
  /**
   * Run a harness in the worktree at `path` — a worktree of the project the
   * agent is already attached to. Answered by `session_started`, or by
   * `agent_error` when the harness could not be started.
   *
   * `backend` names the harness explicitly and beats every config layer.
   * `autonomous` starts it with its own approvals off. `remember: true` writes
   * the choice to `<cwd>/.shape/config.json`, so the next open needs no card.
   */
  | {
      type: "open_worktree";
      path: string;
      backend?: string;
      resumeSessionId?: string;
      autonomous?: boolean;
      remember?: boolean;
    }
  /**
   * Bring that worktree's harness terminal forward: `agent.focus` on a herdr
   * tab, or a `terminal { open: true }` back to the browser under the pty
   * launcher. Answered by `agent_error` when it could not be done.
   */
  | { type: "focus_terminal"; worktree: string }
  /** dispose the harness running in `worktree`; answered by `session_stopped` */
  | { type: "close_worktree"; worktree: string }
  /** retarget: dispose every harness, open `path`, start again, then re-`attach` */
  | { type: "switch"; path: string; backend?: string; resumeSessionId?: string }
  /** create a project at `path` (folder, version control, optional GitHub), then `switch` onto it */
  | { type: "create"; path: string; github: { visibility: "public" | "private" } | null }
  /** resolve a discovered pid (fresh scan) and `switch` to it */
  | { type: "adopt"; pid: number }
  /**
   * Open the machine's native folder chooser, because the browser cannot: no
   * web API gives it an absolute path. Answered with `folder_picked`, or with
   * an `agent_error` starting with `pick_folder` when there is no chooser to
   * open (or it failed).
   */
  | { type: "pick_folder" }
  | { type: "discover"; id: string }
  | { type: "list_worktrees"; id: string }
  | { type: "extract_reality"; worktree: string }
  | { type: "synthesize_skeleton"; worktree: string; id: string }
  | { type: "file_index"; worktree: string; id: string }
  | PtyClientMsg;
