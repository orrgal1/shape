/**
 * Terminal wire (bridge ↔ browser). One shared pty per bridge: the terminal is
 * the project's shell, not a per-browser session, so `pty_data` is broadcast to
 * every attached client and any of them can type into it.
 *
 * Types only — this file is imported by both packages and must stay erasable.
 */

export type PtyClientMsg =
  | { type: "pty_open"; cols: number; rows: number }
  | { type: "pty_input"; data: string }
  | { type: "pty_resize"; cols: number; rows: number }
  | { type: "pty_close" };

export type PtyServerMsg =
  | { type: "pty_data"; data: string }
  | { type: "pty_exit"; code: number | null }
  | { type: "pty_state"; open: boolean; shell: string; cwd: string };
