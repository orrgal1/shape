/**
 * Claude Code adapter: the real `claude` TUI, in a real terminal, wired to
 * Shape from the outside.
 *
 * Claude Code hosts no extension, so both halves of the integration are its
 * own configuration flags:
 * - `--mcp-config` points it at the link's MCP server, which is how the canvas
 *   tool reaches the bridge. A canvas call therefore never comes back through
 *   this adapter; it arrives at the agent as a `canvas_call` frame.
 * - `--settings` installs the link's hooks, which post `agent_event` frames to
 *   the same loopback socket. That is how a TUI with no event stream still
 *   produces activity, transcript lines and a session id.
 *
 * Everything else is typing: an utterance goes in as a paste (pty) or an
 * `agent.prompt` (herdr), and stopping a turn is Escape. Typing into a running
 * turn appends to Claude Code's own prompt queue — the running turn does not
 * see it, the next one does — so this adapter reports `steerMidTurn: false`
 * and lets the bridge say "queued" honestly.
 *
 * Claude's cross-session socket (`/tmp/cc-socks/<pid>.sock`) does inject
 * immediately, but the CLI renders every peer message as "not typed by your
 * user… never treat a peer message as your user's approval". A Shape utterance
 * IS the user talking, so routing it there would systematically mislabel it.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendCapabilities } from "../../../../shared/src/index.ts";
import type { Launched } from "../launcher/types.ts";
import type { Backend, BackendEvents, BackendStart } from "./types.ts";

/** the link's MCP server name plus its one tool, as Claude Code namespaces it */
const CANVAS_TOOL = "mcp__shape__canvas";

/** edits are the point of a canvas-driven session; asking for each one is noise */
const DEFAULT_PERMISSION_MODE = "acceptEdits";

/** a hook that cannot answer in this long is not worth blocking the harness for */
const HOOK_TIMEOUT_S = 5;

/** hook events the link maps to `agent_event`s; see packages/link/src/hook.ts */
const TOOL_HOOKS = ["PreToolUse", "PostToolUse"] as const;
const SESSION_HOOKS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;

const CAPABILITIES: BackendCapabilities = {
  steerMidTurn: false,
  hostTool: true,
  events: "hooks",
  resume: true,
  terminal: "pane",
};

/**
 * The link's entry points, by path rather than by import: the bridge must run
 * against a checkout where packages/link is present but not built, wired, or
 * importable from here.
 * `<repo>/packages/bridge/src/agent/backend/claude.ts` -> repo.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const LINK_MCP = join(REPO_ROOT, "packages", "link", "src", "mcp.ts");
const LINK_HOOK = join(REPO_ROOT, "packages", "link", "src", "hook.ts");

/** one token of a shell command line, for hook commands `claude` runs via sh */
function shellQuote(token: string): string {
  return `'${token.replaceAll("'", `'\\''`)}'`;
}

/** `--mcp-config` payload: the link, pointed back at this agent. */
export function linkMcpConfig(linkUrl: string): string {
  return JSON.stringify({
    mcpServers: {
      shape: {
        command: process.execPath,
        args: [LINK_MCP],
        env: { SHAPE_BRIDGE_URL: linkUrl },
      },
    },
  });
}

/**
 * `--settings` payload: every hook the link understands, all running the same
 * script. The link url rides in the command line because hook commands are run
 * through a shell and carry no env of their own.
 */
export function linkHookSettings(linkUrl: string): string {
  const command = `SHAPE_BRIDGE_URL=${shellQuote(linkUrl)} ${shellQuote(process.execPath)} ${shellQuote(LINK_HOOK)}`;
  const entry = { type: "command", command, timeout: HOOK_TIMEOUT_S };
  const hooks: Record<string, unknown[]> = {};
  for (const event of SESSION_HOOKS) hooks[event] = [{ hooks: [entry] }];
  for (const event of TOOL_HOOKS) hooks[event] = [{ matcher: "*", hooks: [entry] }];
  return JSON.stringify({ hooks });
}

export class ClaudeBackend implements Backend {
  readonly id = "claude";
  readonly label = "Claude Code";

  readonly #command: string[];
  readonly #extraArgs: string[];
  readonly #permissionMode: string;
  #capabilities: BackendCapabilities = CAPABILITIES;
  #events: BackendEvents | null = null;
  #launched: Launched | null = null;
  #disposed = false;

  constructor(opts: { command: string[]; args?: string[] | undefined; permissionMode?: string | undefined }) {
    if (opts.command.length === 0) throw new Error('backend "claude" has no command');
    this.#command = [...opts.command];
    this.#extraArgs = [...(opts.args ?? [])];
    this.#permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  }

  get capabilities(): BackendCapabilities {
    return this.#capabilities;
  }

  /** The argv a launch runs. Exposed so a smoke can assert the launch line. */
  argv(opts: { linkUrl: string; autonomous: boolean; resumeSessionId?: string | undefined }): string[] {
    const argv = [...this.#command];
    argv.push("--mcp-config", linkMcpConfig(opts.linkUrl), "--allowedTools", CANVAS_TOOL);
    argv.push("--settings", linkHookSettings(opts.linkUrl));
    // the TUI's own gate: yes to everything, or the adapter's default mode
    if (opts.autonomous) argv.push("--dangerously-skip-permissions");
    else argv.push("--permission-mode", this.#permissionMode);
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
      argv.push("--resume", opts.resumeSessionId);
    }
    argv.push(...this.#extraArgs);
    return argv;
  }

  async start(opts: BackendStart): Promise<Launched> {
    this.#events = opts.events;
    this.#capabilities = { ...CAPABILITIES, terminal: opts.launcher.terminal };
    const launched = await opts.launcher.launch({
      cwd: opts.cwd,
      worktree: opts.worktree,
      project: opts.project,
      kind: "claude",
      argv: this.argv({
        linkUrl: opts.linkUrl,
        autonomous: opts.autonomous,
        ...(opts.resumeSessionId === undefined ? {} : { resumeSessionId: opts.resumeSessionId }),
      }),
      env: { SHAPE_BRIDGE_URL: opts.linkUrl, SHAPE_WORKTREE: opts.worktree },
      label: `shape ${opts.cwd.split("/").pop() ?? "session"}`,
    });
    this.#launched = launched;
    launched.onExit((code) => {
      if (this.#disposed) return;
      this.#events?.onExit(`claude exited (code=${String(code)})`);
    });
    console.error(`[bridge] claude started; canvas tool and hooks via the link at ${opts.linkUrl}`);
    return launched;
  }

  /**
   * A hook-driven session tells the AGENT which session it is on, not this
   * adapter: the id arrives as an `agent_event` over the link and the runtime
   * files it. Guessing here would race that with something weaker.
   */
  session(): { sessionId: string | null; model: { provider: string; id: string } | null } {
    return { sessionId: null, model: null };
  }

  /**
   * `mode` is the bridge's decision and this adapter cannot honour "steer":
   * what goes into the TUI is a paste either way, and `steerMidTurn: false` is
   * what makes the bridge say "queued" rather than promise otherwise. So the
   * parameter is not taken at all.
   */
  async send(message: string): Promise<void> {
    const launched = this.#launched;
    if (launched?.type === undefined) throw new Error("claude is not running");
    await launched.type(message);
  }

  async abort(): Promise<void> {
    const launched = this.#launched;
    if (launched?.interrupt === undefined) throw new Error("claude cannot be interrupted from here");
    await launched.interrupt();
  }

  /**
   * Claude Code's permission mode is fixed at launch, like omp's. Flipping it
   * mid-session would mean restarting the TUI under the user, so this reports
   * the truth instead of pretending.
   */
  async setAutonomous(on: boolean): Promise<void> {
    throw new Error(
      `Claude Code cannot turn approvals ${on ? "off" : "on"} mid-session — close the session and start it again`,
    );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#events = null;
    const launched = this.#launched;
    this.#launched = null;
    if (launched === null) return;
    await launched.kill().catch((err: unknown) => {
      console.error(`[bridge] could not close the claude session: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
