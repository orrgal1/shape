/**
 * omp adapter: the real interactive TUI, in a real terminal, with Shape's
 * extension loaded into it.
 *
 * `omp --extension <packages/link/src/omp-extension.ts>` is the whole
 * integration. The extension dials the loopback link (`SHAPE_LINK`), greets
 * with `hello`, registers the canvas tool, forwards every omp event as an
 * `AgentEvent`, and turns the frames this adapter sends — `deliver`, `abort`,
 * `autonomous` — into session actions. So this file holds almost no protocol:
 * it composes an argv, waits for the greeting, and speaks the link.
 *
 * Two things do not ride the link, by omp's own design: the approval mode
 * (only `--approval-mode` at launch changes it) and the session to resume
 * (`--resume`). Both are therefore argv, decided once when the session starts.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendCapabilities } from "../../../../shared/src/index.ts";
import type { LinkServerMsg } from "../../../../shared/src/link.ts";
import type { LinkHello } from "../external.ts";
import type { Launched } from "../launcher/types.ts";
import type { Backend, BackendEvents, BackendStart } from "./types.ts";

/**
 * The extension's path, not its import: the bridge must run against a checkout
 * where packages/link is present but not built or importable from here, and
 * omp loads a `.ts` file directly.
 * `<repo>/packages/bridge/src/agent/backend/omp.ts` -> repo.
 *
 * Exported because the manager session (`../manager.ts`) has to load the same
 * extension and hand it to every builder omp it launches: one path, one truth.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
export const OMP_EXTENSION = join(REPO_ROOT, "packages", "link", "src", "omp-extension.ts");

/**
 * How long a launched omp gets to greet. Generous because this covers the TUI
 * coming up, the extension loading and the socket dialling on a cold machine;
 * past it, something is wrong that waiting will not fix.
 */
const HELLO_TIMEOUT_MS = 60_000;

/** a `deliver` the session never acknowledged is a delivery nobody can trust */
const DELIVER_TIMEOUT_MS = 30_000;

/**
 * What omp can do before it has said so. `hello.capabilities` refines
 * `steerMidTurn`/`hostTool` — a build with no `sendUserMessage` cannot steer,
 * and one where the tool failed to register has no canvas — and the launcher
 * decides where the terminal is.
 */
const CAPABILITIES: BackendCapabilities = {
  steerMidTurn: true,
  hostTool: true,
  events: "native",
  resume: true,
  terminal: "pane",
};

export class OmpBackend implements Backend {
  readonly id = "omp";
  readonly label = "oh-my-pi";

  /** the executable and its leading args (`--omp "<cmd ...>"`), argv[0] first */
  readonly #command: string[];
  #capabilities: BackendCapabilities = CAPABILITIES;
  #events: BackendEvents | null = null;
  #launched: Launched | null = null;
  /** the greeted link client's own channel: how this adapter talks to omp */
  #send: ((msg: LinkServerMsg) => void) | null = null;
  #sessionId: string | null = null;
  #model: { provider: string; id: string } | null = null;
  #autonomous = false;
  #disposed = false;
  /** resolved by the first `hello`; `start` returns on it */
  #greeted: PromiseWithResolvers<void> | null = null;
  #deliverSeq = 0;
  /** `deliver` ids waiting for their receipt */
  readonly #inflight = new Map<string, { settle: () => void; fail: (err: Error) => void }>();

  constructor(opts: { command: string[] }) {
    if (opts.command.length === 0) throw new Error('backend "omp" has no command');
    this.#command = [...opts.command];
  }

  get capabilities(): BackendCapabilities {
    return this.#capabilities;
  }

  /** The argv a launch runs. Exposed so a smoke can assert the launch line. */
  argv(opts: { autonomous: boolean; resumeSessionId?: string | undefined }): string[] {
    const argv = [...this.#command, "--extension", OMP_EXTENSION];
    // the ONLY way to change omp's approval gate is at launch
    if (opts.autonomous) argv.push("--approval-mode", "yolo");
    if (opts.resumeSessionId !== undefined && opts.resumeSessionId.length > 0) {
      argv.push("--resume", opts.resumeSessionId);
    }
    return argv;
  }

  async start(opts: BackendStart): Promise<Launched> {
    this.#events = opts.events;
    this.#autonomous = opts.autonomous;
    this.#capabilities = { ...CAPABILITIES, terminal: opts.launcher.terminal };
    const greeted = Promise.withResolvers<void>();
    this.#greeted = greeted;

    const launched = await opts.launcher.launch({
      cwd: opts.cwd,
      worktree: opts.worktree,
      project: opts.project,
      kind: "omp",
      argv: this.argv({ autonomous: opts.autonomous, ...(opts.resumeSessionId === undefined ? {} : { resumeSessionId: opts.resumeSessionId }) }),
      env: { SHAPE_LINK: opts.linkUrl, SHAPE_WORKTREE: opts.worktree },
      label: `shape ${opts.cwd.split("/").pop() ?? "session"}`,
    });
    this.#launched = launched;
    // a TUI that dies before greeting (a bad flag, no auth) must not be waited
    // out for a minute
    const offExit = launched.onExit((code) => {
      greeted.reject(new Error(`omp exited before it connected to Shape (code=${String(code)})`));
      this.#events?.onExit(`omp exited (code=${String(code)})`);
    });
    const timer = setTimeout(() => {
      greeted.reject(
        new Error(
          `omp did not connect to Shape within ${String(HELLO_TIMEOUT_MS / 1000)}s — is the extension at ${OMP_EXTENSION} loading?`,
        ),
      );
    }, HELLO_TIMEOUT_MS);

    try {
      await greeted.promise;
    } catch (err) {
      offExit();
      clearTimeout(timer);
      // the session is unusable and nobody asked for a terminal full of it
      await launched.kill().catch(() => undefined);
      this.#launched = null;
      throw err;
    }
    clearTimeout(timer);
    return launched;
  }

  session(): { sessionId: string | null; model: { provider: string; id: string } | null } {
    return { sessionId: this.#sessionId, model: this.#model };
  }

  /**
   * Put an utterance into the session and wait for the extension's receipt:
   * only then has omp really taken it (a prompt while the session is mid-turn
   * comes back `queued`). The id is the adapter's own — the room's deliver id
   * is a different namespace and the link never sees it.
   */
  async send(message: string, mode: "prompt" | "steer"): Promise<void> {
    const send = this.#send;
    if (send === null) throw new Error("the omp session is not connected to Shape");
    const id = `d-${String(++this.#deliverSeq)}`;
    const { promise, resolve: settle, reject: fail } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      this.#inflight.delete(id);
      fail(new Error(`the omp session did not acknowledge the message within ${String(DELIVER_TIMEOUT_MS / 1000)}s`));
    }, DELIVER_TIMEOUT_MS);
    this.#inflight.set(id, {
      settle: () => {
        clearTimeout(timer);
        settle();
      },
      fail: (err) => {
        clearTimeout(timer);
        fail(err);
      },
    });
    send({ type: "deliver", id, body: message, mode });
    await promise;
  }

  async abort(): Promise<void> {
    const send = this.#send;
    if (send === null) throw new Error("the omp session is not connected to Shape");
    send({ type: "abort" });
  }

  /**
   * Best effort by omp's own contract: the extension's `tool_call` hook can
   * allow a call, but the TUI's approval gate is a separate stage that only
   * `--approval-mode` at launch opens. A session started with autonomous off
   * therefore still asks the user, and this tells the extension to stop adding
   * its own opinion on top.
   */
  async setAutonomous(on: boolean): Promise<void> {
    this.#autonomous = on;
    this.#send?.({ type: "autonomous", on });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const launched = this.#launched;
    this.#launched = null;
    this.#send = null;
    this.#events = null;
    const inflight = [...this.#inflight.values()];
    this.#inflight.clear();
    for (const entry of inflight) entry.fail(new Error("the omp session was closed"));
    if (launched === null) return;
    await launched.kill().catch((err: unknown) => {
      console.error(`[bridge] could not close the omp session: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // -------------------------------------------------------------------------
  // the loopback link: the harness itself talking
  // -------------------------------------------------------------------------

  /**
   * omp greeted us. This is what "the session started" means for this adapter:
   * the session id and model are known, the extension's real capabilities
   * replace the assumed ones, and the socket it greeted on is the channel
   * every later `deliver` goes out on (a reconnect re-greets and replaces it).
   */
  onHello(hello: LinkHello, send: (msg: LinkServerMsg) => void): void {
    if (this.#disposed) return;
    this.#send = send;
    this.#sessionId = hello.sessionId;
    this.#model = hello.model;
    this.#capabilities = {
      ...this.#capabilities,
      steerMidTurn: hello.capabilities.steer,
      hostTool: hello.capabilities.tool,
    };
    this.#greeted?.resolve();
    this.#greeted = null;
    // the launch flag opened the gate; this tells the extension to stop
    // second-guessing each call while it is open
    if (this.#autonomous) send({ type: "autonomous", on: true });
  }

  onDelivered(receipt: { id: string; mode: "prompt" | "steer"; queued: boolean }): void {
    const entry = this.#inflight.get(receipt.id);
    if (entry === undefined) return;
    this.#inflight.delete(receipt.id);
    entry.settle();
  }

  /** The session ended on its own (the user quit the TUI, omp shut down). */
  onBye(reason: string): void {
    if (this.#disposed) return;
    this.#send = null;
    this.#events?.onExit(`the omp session ended: ${reason}`);
  }
}
