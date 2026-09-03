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
 * server never trusts a project id in a frame body.
 */

import type {
  BackendInfo,
  CanvasOp,
  DiscoveredSession,
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
  /** `paths` are path-ish tokens for codeRefs matching; `summary` is human */
  | { kind: "tool_start"; name: string; paths: string[]; summary: string }
  | { kind: "tool_end"; name: string; isError: boolean }
  | { kind: "turn_end" }
  | { kind: "session"; sessionId: string | null; model: { provider: string; id: string } | null };

export type LinkClientMsg =
  /** a host-tool round trip carried over the socket; answered to the SAME socket only, correlated by `id` */
  | { type: "canvas_call"; id: string; args: unknown }
  | { type: "agent_event"; event: AgentEvent };

export type LinkServerMsg =
  | { type: "canvas_result"; id: string; text: string; isError: boolean }
  /** a frame the agent could not parse; the caller's socket alone hears it */
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Agent link (agent ↔ Shape server)
// ---------------------------------------------------------------------------

/** the harness session the agent is driving, as far as it knows */
export interface AgentSession {
  sessionId: string | null;
  sessionName: string | null;
  model: { provider: string; id: string } | null;
}

/** the project an agent is attached to; `cwd` is a label to the server, an authority only to the agent */
export interface AgentProject {
  /** stable across restarts: derived by the agent from machine + realpath(cwd) */
  key: string;
  /** what a picker shows: basename of cwd */
  label: string;
  cwd: string;
  backend: BackendInfo;
  /** the repo already contains source code (onboarding CTA gate) */
  targetHasCode: boolean;
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
      session: AgentSession;
      /** reality at attach time (null when extraction found nothing / is unavailable) */
      reality: RealityLayer | null;
      worktrees: WorktreeInfo[];
      sessions: DiscoveredSession[];
      /** this machine's recent project paths, most recent first */
      recentProjects: string[];
    }
  | { type: "agent_event"; event: AgentEvent }
  /** the harness (native host tool or loopback link) wants to write to the canvas */
  | { type: "canvas_call"; id: string; args: unknown }
  /** re-derived reality (startup, or HEAD moved while the agent went idle) */
  | { type: "reality"; reality: RealityLayer; head: string | null }
  /** answers `list_worktrees`; also pushed unsolicited when the agent notices a change */
  | { type: "worktrees"; id: string | null; worktrees: WorktreeInfo[] }
  /** answers `discover` */
  | { type: "sessions"; id: string | null; sessions: DiscoveredSession[] }
  | { type: "recents"; paths: string[] }
  /** receipt for `deliver`: how it went out; `queued` when a prompt landed mid-turn on a backend that cannot steer */
  | { type: "delivered"; id: string; mode: "prompt" | "steer"; queued: boolean }
  /** answers `synthesize_skeleton` */
  | { type: "skeleton_result"; id: string; ops: CanvasOp[] }
  /** answers `file_index`: project-relative paths of every tracked (or, for a non-git target, every walked) file */
  | { type: "file_index"; id: string; files: string[] }
  /** an adapter error worth showing the user (becomes a browser `error` frame) */
  | { type: "agent_error"; message: string }
  /** the harness died; the agent cannot continue this project */
  | { type: "agent_exit"; reason: string }
  | { type: "detached"; reason: string }
  | PtyServerMsg;

/** Server → agent. Requests carry an `id` the agent echoes in its answer. */
export type ServerToAgentMsg =
  | { type: "attached"; projectId: string; preamble: string }
  | { type: "error"; message: string }
  | { type: "canvas_result"; id: string; text: string; isError: boolean }
  /**
   * A composed utterance. The agent decides `steer` vs `prompt` (only it has
   * live backend state) and prepends the preamble from `attached` to the first
   * fresh prompt of a harness session.
   */
  | { type: "deliver"; id: string; body: string }
  | { type: "abort" }
  /** retarget: dispose the harness, open `path`, start again, then re-`attach` */
  | { type: "switch"; path: string; backend?: string; resumeSessionId?: string }
  /** resolve a discovered pid (fresh scan) and `switch` to it */
  | { type: "adopt"; pid: number }
  | { type: "discover"; id: string }
  | { type: "list_worktrees"; id: string }
  | { type: "extract_reality" }
  | { type: "synthesize_skeleton"; id: string }
  | { type: "file_index"; id: string }
  | PtyClientMsg;
