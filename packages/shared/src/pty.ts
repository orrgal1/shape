/**
 * Terminal wire (bridge ↔ browser, and server ↔ agent). One shared pty per
 * WORKTREE: the terminal is that worktree's shell, not a per-browser session,
 * so `pty_data` is broadcast to every attached client and any of them can type
 * into it. Every frame names its worktree, because one project now has as many
 * terminals as it has open worktrees and a frame with no worktree could only
 * guess which one it belongs to.
 *
 * Types only — this file is imported by both packages and must stay erasable.
 */

export type PtyClientMsg =
  | { type: "pty_open"; worktree: string; cols: number; rows: number }
  | { type: "pty_input"; worktree: string; data: string }
  | { type: "pty_resize"; worktree: string; cols: number; rows: number }
  | { type: "pty_close"; worktree: string };

export type PtyServerMsg =
  | { type: "pty_data"; worktree: string; data: string }
  | { type: "pty_exit"; worktree: string; code: number | null }
  | { type: "pty_state"; worktree: string; open: boolean; shell: string; cwd: string };
