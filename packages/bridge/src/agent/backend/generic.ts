/**
 * The adapter for every harness Shape has no integration with — codex,
 * opencode, gemini, cursor-agent, amp, copilot and whatever herdr learns to
 * recognize next.
 *
 * It presumes nothing. The harness is started by its own name, its state comes
 * from the LAUNCHER watching the pane (herdr's own agent detection), and an
 * utterance goes in as typing. There is no canvas tool: what the canvas says
 * stays what the user and the harnesses that do speak to Shape put there —
 * this session simply appears on it as activity.
 *
 * herdr only, and that is not a limitation to route around: without it Shape
 * would have to detect "is it thinking" by scraping a pty, which is exactly
 * the guessing this layer exists to avoid.
 */

import type { BackendCapabilities, HarnessId } from "../../../../shared/src/index.ts";
import { harnessLabel } from "../detect.ts";
import type { AgentStatus, Launched } from "../launcher/types.ts";
import type { Backend, BackendEvents, BackendStart } from "./types.ts";

/**
 * What Shape can honestly claim for a harness it only watches: typing lands in
 * the harness's own queue (never mid-turn), there is no host tool, and every
 * event comes from the launcher rather than the harness.
 */
const CAPABILITIES: BackendCapabilities = {
  steerMidTurn: false,
  hostTool: false,
  events: "none",
  resume: false,
  terminal: "external",
};

/**
 * What the canvas is told when herdr sees the harness waiting on a question
 * only the terminal can show (an approval prompt, a choice). Shape cannot
 * answer it, so it says where the answer has to happen.
 */
const BLOCKED_LINE = "waiting for you in the terminal";

export class GenericBackend implements Backend {
  readonly id: HarnessId;
  readonly label: string;
  #capabilities: BackendCapabilities = CAPABILITIES;
  #events: BackendEvents | null = null;
  #launched: Launched | null = null;
  #disposed = false;
  /** last state reported upward, so a repeated herdr status is not news */
  #state: AgentStatus | null = null;

  constructor(opts: { id: HarnessId }) {
    this.id = opts.id;
    this.label = harnessLabel(opts.id);
  }

  get capabilities(): BackendCapabilities {
    return this.#capabilities;
  }

  async start(opts: BackendStart): Promise<Launched> {
    this.#events = opts.events;
    if (opts.launcher.id !== "herdr") {
      throw new Error(
        `${this.label} needs herdr to be driven by Shape: herdr is what reports whether it is working or waiting. Install herdr, or pick a harness Shape talks to directly.`,
      );
    }
    this.#capabilities = { ...CAPABILITIES, terminal: opts.launcher.terminal };
    const launched = await opts.launcher.launch({
      cwd: opts.cwd,
      worktree: opts.worktree,
      project: opts.project,
      // the id IS herdr's kind: that is how the detected harnesses are named
      kind: this.id,
      argv: [this.id],
      env: { SHAPE_WORKTREE: opts.worktree },
      label: `shape ${opts.cwd.split("/").pop() ?? "session"}`,
    });
    this.#launched = launched;
    launched.onStatus?.((status) => this.#onStatus(status));
    launched.onExit((code) => {
      if (this.#disposed) return;
      this.#events?.onExit(`${this.label} exited (code=${String(code)})`);
    });
    return launched;
  }

  /** Nothing tells Shape this harness's session id; herdr knows, Shape does not ask. */
  session(): { sessionId: string | null; model: { provider: string; id: string } | null } {
    return { sessionId: null, model: null };
  }

  /**
   * Whatever the bridge decided, the harness reads one utterance typed at its
   * prompt: this adapter never claims to steer, so `mode` is not taken.
   */
  async send(message: string): Promise<void> {
    const launched = this.#launched;
    if (launched?.type === undefined) throw new Error(`${this.label} is not running`);
    await launched.type(message);
  }

  async abort(): Promise<void> {
    const launched = this.#launched;
    if (launched?.interrupt === undefined) throw new Error(`${this.label} cannot be interrupted from here`);
    await launched.interrupt();
  }

  async setAutonomous(on: boolean): Promise<void> {
    throw new Error(
      `Shape cannot turn ${this.label}'s approvals ${on ? "off" : "on"} — it has no way in but the terminal`,
    );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#events = null;
    const launched = this.#launched;
    this.#launched = null;
    if (launched === null) return;
    await launched.kill().catch((err: unknown) => {
      console.error(`[bridge] could not close the ${this.label} session: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * herdr's five states, projected onto the two Shape draws with. `blocked` is
   * idle plus a line saying so: as far as the canvas is concerned nothing is
   * being produced, and the user needs to know where to go. `unknown` is not
   * evidence of anything and changes nothing.
   */
  #onStatus(status: AgentStatus): void {
    if (this.#disposed || status === this.#state) return;
    const events = this.#events;
    if (events === null) return;
    const previous = this.#state;
    this.#state = status;
    switch (status) {
      case "working":
        events.onAgentState("streaming");
        return;
      case "idle":
      case "done":
        // a turn that produced something is over; one that never started is not
        if (previous === "working") events.onTurnEnd();
        events.onAgentState("idle");
        return;
      case "blocked":
        events.onAgentState("idle");
        events.onAssistantText(BLOCKED_LINE);
        return;
      case "unknown":
        return;
    }
  }
}
