/**
 * Shape bridge: drives a coding-agent CLI in a target project through the
 * backend seam (`src/backend/`, omp first), exposes the `canvas` host tool to
 * the agent, and serves the browser canvas over WebSocket.
 *
 * Run: node src/index.ts [--cwd <dir>] [--port <n>] [--backend <id>] [--omp "<cmd ...>"]
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { diffSnapshots } from "../../shared/src/delta.ts";
import { BRIDGE_PORT, BRIDGE_WS_PATH, CANVAS_TOOL_SCHEMA } from "../../shared/src/index.ts";
import type {
  AgentState,
  BackendInfo,
  ClientMsg,
  DriftMap,
  GraphDoc,
  RealityLayer,
  Referent,
  ServerMsg,
  SessionInfo,
  WorktreeInfo,
} from "../../shared/src/index.ts";
import { createBackend, loadShapeConfig } from "./backend/index.ts";
import type { Backend, BackendEvents } from "./backend/types.ts";
import {
  composeSurveyPrompt,
  hasSourceCode,
  onboardingOpGate,
  synthesizeSkeleton,
} from "./onboarding.ts";
import { PREAMBLE } from "./preamble.ts";
import { PtyManager, isPtyMsg } from "./pty.ts";
import { pushRecent } from "./recents.ts";
import { SnapshotStore } from "./snapshots.ts";
import { composeUtterance } from "./steering.ts";
import { GraphStore } from "./store.ts";
import { WsHub } from "./ws.ts";
import { ensureGitExclude, listWorktrees } from "./worktrees.ts";

const CANVAS_TOOL_DESCRIPTION = `Maintain the visual canvas the user is watching — this is their only view of your work.

ops (batch, applied per-op): upsert_node, remove_node (rejected while it has children), upsert_edge, remove_edge, set_phase.
ids are slugs: ^[a-z0-9][a-z0-9-]*$. Node summary is REQUIRED: one sentence stating what the bubble promises, <= 200 chars; a bubble that cannot be summarized in one sentence is at the wrong altitude.
Hierarchy is parentId (null = root); edges are ONLY non-hierarchical relations (depends | dataflow | relates) — never an edge to mean "contains".
Phases: idea -> concept -> component -> building -> built | failed. Set codeRefs (workspace-relative path prefixes) once a bubble owns files.
summary = the bubble's stable promise. status (optional, <= 140 chars) = what is happening in it RIGHT NOW; refresh it on bubbles you are building and omit it when done — an upsert without status clears it.
PLAIN ENGLISH, NO JARGON: every label, summary, status, edge label and note is read by a non-programmer steering by voice — everyday words, outcomes not mechanisms, no acronyms or protocol/library/file-format names or code identifiers unless the bubble is literally about that thing. Only codeRefs stay technical.
Call this as you think and work, in the same turn your understanding changes. The result tells you what applied; rejections come back as JSON repair receipts ({code, subject, evidence, supportedFixes}) — apply a supported fix and resend just the rejected ops.`;

interface Cli {
  cwd: string;
  port: number;
  /** `--backend <id>`: beats both config files */
  backend?: string;
  /** `--omp "<cmd ...>"`: replaces the omp adapter's command */
  ompCommand?: string[];
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = { cwd: process.cwd(), port: BRIDGE_PORT };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    if (arg === "--cwd" && next !== undefined) {
      cli.cwd = resolve(next);
      i++;
    } else if (arg === "--port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) throw new Error(`--port expects a number, got ${next}`);
      cli.port = parsed;
      i++;
    } else if (arg === "--backend" && next !== undefined) {
      cli.backend = next.trim();
      i++;
    } else if (arg === "--omp" && next !== undefined) {
      cli.ompCommand = next.trim().split(/\s+/).filter((token) => token.length > 0);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return cli;
}

interface RealityModule {
  extractReality: (cwd: string) => Promise<RealityLayer>;
  computeDrift: (doc: Pick<GraphDoc, "nodes" | "edges">, reality: RealityLayer) => DriftMap;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Backend failures arrive as Errors whose message is already user-facing. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class Bridge {
  readonly #cli: Cli;
  /** current target project; changed by switch_project */
  #cwd: string;
  #store: GraphStore;
  #snapshots: SnapshotStore;
  #hub: WsHub | null = null;
  /** the harness we drive; re-created per target project */
  #backend: Backend | null = null;
  /** wire projection of `#backend`; assigned with it in #createBackend */
  #backendInfo!: BackendInfo;
  /** shared project shell; retargeted, never re-created, across switches */
  #pty!: PtyManager;
  #agent: AgentState = "idle";
  /** assigned by #openProject, which always runs before the first hello */
  #session!: SessionInfo;
  #activity = new Set<string>();
  #promptSent = false;
  #delivering: Promise<void> = Promise.resolve();
  #targetHasCode = false;
  #recents: string[] = [];
  #switching = false;
  /** onboarding validation mode: armed from `onboard` until the next terminal agent_end */
  #onboarding = false;
  #realityHead: string | null = null;
  #realityModule: RealityModule | null = null;
  #realityBusy = false;

  constructor(cli: Cli) {
    this.#cli = cli;
    this.#cwd = cli.cwd;
    this.#store = new GraphStore(cli.cwd);
    this.#snapshots = new SnapshotStore(cli.cwd);
  }

  async start(): Promise<void> {
    await this.#createBackend();
    await this.#openProject();
    await this.#startBackend();
    this.#pty = new PtyManager({ cwd: this.#cwd, broadcast: (msg) => this.#broadcast(msg) });

    const hub = new WsHub({
      port: this.#cli.port,
      hello: () => this.#hello(),
      onMessage: (msg) => this.#onClientMsg(msg),
    });
    this.#hub = hub;
    await hub.listening();
    console.error(
      `[bridge] canvas at ws://127.0.0.1:${this.#cli.port}${BRIDGE_WS_PATH} (target ${this.#cwd})`,
    );
  }

  /** Worktrees are re-detected on every hello (connect and post-switch). */
  async #hello(): Promise<ServerMsg> {
    this.#session = { ...this.#session, worktrees: await listWorktrees(this.#cwd) };
    return {
      type: "hello",
      graph: this.#store.doc,
      session: this.#session,
      agent: this.#agent,
      recentProjects: this.#recents,
      revisions: await this.#snapshots.list(),
    };
  }

  /** Load (or start) the graph for `#cwd`, extract reality, answer targetHasCode. */
  async #openProject(): Promise<void> {
    this.#store = new GraphStore(this.#cwd);
    this.#snapshots = new SnapshotStore(this.#cwd);
    await this.#store.load();
    // the rev we opened at must be diffable, not just the ones we go on to make
    await this.#snapshots.save(this.#store.doc);
    const hasPackages = await this.#startupReality();
    this.#targetHasCode = hasPackages || (await hasSourceCode(this.#cwd));
    this.#session = {
      sessionId: null,
      sessionName: null,
      model: null,
      cwd: this.#cwd,
      targetHasCode: this.#targetHasCode,
      worktrees: await listWorktrees(this.#cwd),
      backend: this.#backendInfo,
    };
    await ensureGitExclude(this.#cwd);
    this.#recents = await pushRecent(this.#cwd);
  }

  /**
   * Resolve the effective config for `#cwd` (user config, then the project's,
   * then CLI flags) and instantiate its backend. An unknown id is a startup
   * error naming the ones we know.
   */
  async #createBackend(): Promise<void> {
    const config = await loadShapeConfig({
      cwd: this.#cwd,
      backend: this.#cli.backend,
      ompCommand: this.#cli.ompCommand,
    });
    const backend = createBackend(config.backend, config);
    this.#backend = backend;
    this.#backendInfo = { id: backend.id, label: backend.label, capabilities: backend.capabilities };
  }

  /** Start the harness in `#cwd`, register the canvas tool, prime session state. */
  async #startBackend(): Promise<void> {
    const backend = this.#backend;
    if (backend === null) throw new Error("bridge: no backend to start");
    await backend.start({
      cwd: this.#cwd,
      events: this.#backendEvents(),
      canvasTool: { description: CANVAS_TOOL_DESCRIPTION, schema: CANVAS_TOOL_SCHEMA },
    });
    try {
      const state = await backend.state();
      this.#session = {
        ...this.#session,
        sessionId: state.sessionId,
        sessionName: state.sessionName,
        model: state.model,
      };
    } catch (err) {
      console.error(`[bridge] ${errText(err)}`);
    }
  }

  /** The bridge half of the seam: canvas, transcript, activity, reality. */
  #backendEvents(): BackendEvents {
    return {
      onAgentState: (state) => {
        // idle IS the end of a turn: onboarding validation disarms and the
        // reality layer is worth re-deriving.
        if (state === "idle") {
          this.#onboarding = false;
          void this.#refreshReality();
        }
        this.#setAgent(state);
      },
      onAssistantText: (text) => this.#broadcast({ type: "transcript", role: "assistant", text }),
      onToolStart: (call) => {
        this.#broadcast({
          type: "transcript",
          role: "tool",
          text: call.summary === "" ? call.name : `${call.name} ${call.summary}`,
        });
        const hits = this.#nodesForPaths(call.paths);
        if (hits.length > 0) this.#setActivity([...this.#activity, ...hits]);
      },
      onToolEnd: (info) => {
        if (info.isError) this.#broadcast({ type: "transcript", role: "tool", text: `${info.name} failed` });
      },
      onTurnEnd: () => this.#setActivity([]),
      onCanvasCall: (args) => this.#canvasCall(args),
      onExit: (reason) => {
        console.error(`[bridge] ${reason}`);
        this.#broadcast({ type: "error", message: reason });
        setTimeout(() => process.exit(1), 50);
      },
      onError: (message) => this.#error(message),
    };
  }

  /** Apply a canvas call and answer the agent with what landed. */
  async #canvasCall(args: unknown): Promise<{ text: string; isError: boolean }> {
    const outcome = this.#store.applyCanvasCall(
      args,
      this.#onboarding ? onboardingOpGate(this.#cwd) : null,
    );
    this.#broadcast({ type: "transcript", role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      void this.#graphChanged();
      this.#broadcast({ type: "graph", graph: this.#store.doc });
    }
    return { text: outcome.text, isError: outcome.isError };
  }

  // -------------------------------------------------------------------------
  // browser -> agent
  // -------------------------------------------------------------------------

  /**
   * Utterance/onboard/switch delivery is serialized: two prompts racing an idle
   * session would have the second one rejected for lacking a streaming behavior,
   * and a retarget must never land mid-delivery. The live child is resolved when
   * the queued work runs, not when it is queued.
   */
  #onClientMsg(msg: ClientMsg): void {
    if (isPtyMsg(msg)) {
      // the terminal is its own channel: never queued behind agent delivery
      this.#pty.handle(msg);
      return;
    }
    if (msg.type === "abort") {
      // aborts must not queue behind an in-flight delivery
      const backend = this.#backend;
      if (backend === null) return;
      backend.abort().catch((err: unknown) => this.#error(errText(err)));
      return;
    }
    if (msg.type === "switch_project") {
      if (this.#switching) {
        this.#error("switch_project rejected: a project switch is already in progress");
        return;
      }
      this.#switching = true;
      this.#delivering = this.#delivering.then(() => this.#switchProject(msg.path));
      return;
    }
    if (msg.type === "diff") {
      // read-only: must not queue behind an in-flight delivery
      void this.#diff(msg.revA, msg.revB);
      return;
    }
    if (msg.type === "onboard") {
      this.#delivering = this.#delivering.then(() => this.#onboard(msg.focus));
      return;
    }
    this.#delivering = this.#delivering.then(() => this.#deliver(msg.text, msg.referent));
  }

  async #deliver(text: string, referent: Referent | null): Promise<void> {
    const backend = this.#backend;
    if (backend === null) return;
    this.#broadcast({ type: "transcript", role: "user", text });
    await this.#send(backend, composeUtterance(this.#store, text, referent));
  }

  /** Compare two stored revisions; an unknown rev is the client's mistake. */
  async #diff(revA: number, revB: number): Promise<void> {
    const snapshots = this.#snapshots;
    const [a, b] = await Promise.all([snapshots.load(revA), snapshots.load(revB)]);
    if (a === null || b === null) {
      this.#error(`unknown revision ${a === null ? revA : revB}`);
      return;
    }
    this.#broadcast({ type: "delta", delta: diffSnapshots(a, b) });
  }

  /**
   * Retarget the bridge at another project: stop the current turn and harness,
   * flush the graph, re-open the new project, re-read config, start a fresh
   * backend, re-hello. The terminal follows the new target.
   */
  async #switchProject(rawPath: string): Promise<void> {
    try {
      const expanded = rawPath.startsWith("~")
        ? join(homedir(), rawPath.slice(1))
        : rawPath;
      const target = resolve(expanded);
      if (!(await isDirectory(target))) {
        this.#error(`switch_project rejected: "${rawPath}" is not an existing directory`);
        return;
      }
      if (target === this.#cwd) {
        this.#broadcast(await this.#hello());
        return;
      }

      const old = this.#backend;
      this.#backend = null;
      if (old !== null) await old.dispose();
      await this.#store.persist();

      this.#cwd = target;
      this.#pty.retarget(target);
      this.#agent = "idle";
      this.#activity = new Set();
      this.#promptSent = false; // a new session earns the preamble again
      this.#onboarding = false;
      this.#realityHead = null;

      // config is per-project: the new target may name a different backend
      await this.#createBackend();
      await this.#openProject();
      await this.#startBackend();
      this.#broadcast(await this.#hello());
      console.error(`[bridge] switched target to ${target}`);
    } catch (err) {
      this.#error(`switch_project failed: ${String(err)}`);
      setTimeout(() => process.exit(1), 50);
    } finally {
      this.#switching = false;
    }
  }

  /**
   * Onboarding (onboarding.md): mechanical skeleton first, then the survey turn
   * with codeRefs validation armed.
   */
  async #onboard(focus: string | undefined): Promise<void> {
    const backend = this.#backend;
    if (backend === null) return;
    if (this.#store.doc.nodes.length > 0) {
      this.#error("onboard rejected: the canvas already has bubbles — steer them instead of remapping");
      return;
    }

    const scoped = focus === undefined || focus.trim().length === 0 ? "" : ` — focus: ${focus.trim()}`;
    this.#broadcast({ type: "transcript", role: "user", text: `Map this project${scoped}` });

    const ops = await synthesizeSkeleton(this.#cwd, this.#store.doc.reality);
    if (ops.length > 0) {
      const outcome = this.#store.applyCanvasCall({
        ops,
        note: `mechanical skeleton: ${this.#store.doc.reality.nodes.length} workspace package(s)`,
      });
      this.#broadcast({ type: "transcript", role: "tool", text: outcome.transcript });
      if (outcome.changed) {
        void this.#graphChanged();
        this.#broadcast({ type: "graph", graph: this.#store.doc });
      }
      if (outcome.isError) this.#error(`skeleton synthesis rejected: ${outcome.text}`);
    } else {
      this.#broadcast({
        type: "transcript",
        role: "tool",
        text: "canvas: no workspace packages detected — survey starts from an empty canvas",
      });
    }

    this.#onboarding = true;
    await this.#send(backend, composeSurveyPrompt(this.#store.doc, focus));
  }

  /**
   * Steer into a running turn when the backend can; otherwise the message goes
   * as a prompt and the harness picks it up when the turn ends. The first
   * prompt of a session carries the preamble.
   */
  async #send(backend: Backend, composed: string): Promise<void> {
    let streaming = false;
    try {
      streaming = (await backend.state()).streaming;
    } catch (err) {
      this.#error(errText(err));
    }

    const mode: "prompt" | "steer" = backend.capabilities.steerMidTurn && streaming ? "steer" : "prompt";
    const message = streaming || this.#promptSent ? composed : `${PREAMBLE}${composed}`;
    if (!streaming) this.#promptSent = true;
    if (mode === "prompt" && streaming) {
      this.#broadcast({
        type: "transcript",
        role: "tool",
        text: `${backend.label} cannot be interrupted mid-turn — queued for the next turn`,
      });
    }

    try {
      await backend.send(message, mode);
    } catch (err) {
      this.#error(errText(err));
    }
  }

  /** intent nodes whose codeRefs prefix any of these paths */
  #nodesForPaths(tokens: string[]): string[] {
    if (tokens.length === 0) return [];
    const rels: string[] = [];
    for (const token of tokens) {
      const abs = isAbsolute(token) ? token : resolve(this.#cwd, token);
      const rel = relative(this.#cwd, abs);
      if (rel.length > 0 && !rel.startsWith("..")) rels.push(rel);
    }
    if (rels.length === 0) return [];
    const hits: string[] = [];
    for (const node of this.#store.doc.nodes) {
      const refs = node.codeRefs;
      if (refs === undefined || refs.length === 0) continue;
      const prefixes = refs.map((r) => r.replace(/^\.\//, "").replace(/\/+$/, ""));
      if (rels.some((rel) => prefixes.some((p) => p.length > 0 && (rel === p || rel.startsWith(`${p}/`))))) {
        hits.push(node.id);
      }
    }
    return hits;
  }

  // -------------------------------------------------------------------------
  // reality layer
  // -------------------------------------------------------------------------

  async #loadReality(): Promise<RealityModule | null> {
    if (this.#realityModule !== null) return this.#realityModule;
    let mod: unknown;
    // Dynamic on purpose: the reality extractor is an optional capability. A
    // static import would make a missing/broken reality.ts abort bridge
    // startup, taking down steering and the canvas with it.
    try {
      mod = await import("./reality.ts");
    } catch (err) {
      console.error(`[bridge] reality extractor unavailable: ${String(err)}`);
      return null;
    }
    if (
      mod === null ||
      typeof mod !== "object" ||
      !("extractReality" in mod) ||
      typeof mod.extractReality !== "function" ||
      !("computeDrift" in mod) ||
      typeof mod.computeDrift !== "function"
    ) {
      console.error("[bridge] reality module does not export extractReality/computeDrift");
      return null;
    }
    // Shape verified above; the cast only names the two validated functions.
    this.#realityModule = mod as RealityModule;
    return this.#realityModule;
  }

  #gitHead(): Promise<string | null> {
    const { promise, resolve: settle } = Promise.withResolvers<string | null>();
    execFile("git", ["rev-parse", "HEAD"], { cwd: this.#cwd }, (err, stdout) => {
      settle(err !== null ? null : stdout.trim() || null);
    });
    return promise;
  }

  /**
   * One extraction at startup so the reality layer is present from minute zero
   * (it also answers `targetHasCode` for TS workspaces). Returns whether any
   * package was found.
   */
  async #startupReality(): Promise<boolean> {
    const mod = await this.#loadReality();
    if (mod === null) return false;
    try {
      const reality = await mod.extractReality(this.#cwd);
      this.#realityHead = reality.head ?? (await this.#gitHead());
      const unchanged = JSON.stringify(this.#store.doc.reality) === JSON.stringify(reality);
      if (!unchanged) {
        this.#store.setReality(reality, mod.computeDrift(this.#store.doc, reality));
        await this.#graphChanged();
      }
      console.error(`[bridge] reality at startup: ${reality.nodes.length} package(s)`);
      return reality.nodes.length > 0;
    } catch (err) {
      console.error(`[bridge] startup reality extraction failed: ${String(err)}`);
      return false;
    }
  }

  async #refreshReality(): Promise<void> {
    if (this.#realityBusy) return;
    this.#realityBusy = true;
    try {
      const head = await this.#gitHead();
      if (head === null || head === this.#realityHead) return;
      const mod = await this.#loadReality();
      if (mod === null) return;
      const reality = await mod.extractReality(this.#cwd);
      const drift = mod.computeDrift(this.#store.doc, reality);
      this.#store.setReality(reality, drift);
      this.#realityHead = head;
      await this.#graphChanged();
      this.#broadcast({ type: "graph", graph: this.#store.doc });
      console.error(`[bridge] reality refreshed at ${head.slice(0, 8)} (${reality.nodes.length} packages)`);
    } catch (err) {
      console.error(`[bridge] reality refresh failed: ${String(err)}`);
    } finally {
      this.#realityBusy = false;
    }
  }

  // -------------------------------------------------------------------------

  #setAgent(state: AgentState): void {
    if (this.#agent === state) return;
    this.#agent = state;
    this.#broadcast({ type: "agent", state });
  }

  #setActivity(nodeIds: string[]): void {
    const next = new Set(nodeIds);
    if (next.size === this.#activity.size && [...next].every((id) => this.#activity.has(id))) return;
    this.#activity = next;
    this.#broadcast({ type: "activity", nodeIds: [...next] });
  }

  /**
   * The graph's rev advanced: flush it and file a revision snapshot. A snapshot
   * that actually landed grows the set of revisions clients can diff over, so
   * they get the fresh list. The store is captured because a project switch may
   * retarget `#snapshots` before the write settles.
   */
  #graphChanged(): Promise<void> {
    const persisted = this.#store.persist();
    const snapshots = this.#snapshots;
    void snapshots.save(this.#store.doc).then(async (info) => {
      if (info === null) return;
      this.#broadcast({ type: "revisions", revisions: await snapshots.list() });
    });
    return persisted;
  }

  #broadcast(msg: ServerMsg): void {
    this.#hub?.broadcast(msg);
  }

  #error(message: string): void {
    console.error(`[bridge] ${message}`);
    this.#broadcast({ type: "error", message });
  }
}

// A bad --backend id or a broken config file is a startup error, not a stack
// trace: the operator needs to read what went wrong.
try {
  const bridge = new Bridge(parseArgv(process.argv.slice(2)));
  await bridge.start();
} catch (err) {
  console.error(`[bridge] startup failed: ${errText(err)}`);
  process.exit(1);
}
