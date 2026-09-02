/**
 * Shape bridge: spawns `omp --mode rpc` in a target project, exposes the
 * `canvas` host tool to the agent, and serves the browser canvas over WebSocket.
 *
 * Run: node src/index.ts [--cwd <dir>] [--port <n>] [--omp "<cmd ...>"]
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { diffSnapshots } from "../../shared/src/delta.ts";
import { BRIDGE_PORT, BRIDGE_WS_PATH, CANVAS_TOOL_SCHEMA } from "../../shared/src/index.ts";
import type {
  AgentState,
  ClientMsg,
  DriftMap,
  GraphDoc,
  RealityLayer,
  Referent,
  ServerMsg,
  SessionInfo,
  WorktreeInfo,
} from "../../shared/src/index.ts";
import {
  composeSurveyPrompt,
  hasSourceCode,
  onboardingOpGate,
  synthesizeSkeleton,
} from "./onboarding.ts";
import { PREAMBLE } from "./preamble.ts";
import { RpcClient } from "./rpc.ts";
import type { RpcFrame } from "./rpc.ts";
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
  command: string[];
}

function parseArgv(argv: string[]): Cli {
  let cwd = process.cwd();
  let port = BRIDGE_PORT;
  let raw: string[] | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    if (arg === "--cwd" && next !== undefined) {
      cwd = resolve(next);
      i++;
    } else if (arg === "--port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) throw new Error(`--port expects a number, got ${next}`);
      port = parsed;
      i++;
    } else if (arg === "--omp" && next !== undefined) {
      raw = next.trim().split(/\s+/).filter((t) => t.length > 0);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  const command = raw ?? ["omp"];
  // Script arguments are resolved against the bridge's cwd, not the target
  // project's — the child runs with cwd = target dir.
  const resolved = command.map((token, idx) => {
    if (idx === 0 || token.startsWith("-") || isAbsolute(token)) return token;
    const abs = resolve(process.cwd(), token);
    return existsSync(abs) ? abs : token;
  });
  if (!resolved.includes("--mode")) resolved.push("--mode", "rpc");
  return { cwd, port, command: resolved };
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

function sessionFromState(
  data: unknown,
  cwd: string,
  targetHasCode: boolean,
  worktrees: WorktreeInfo[],
): SessionInfo {
  const session: SessionInfo = { sessionId: null, sessionName: null, model: null, cwd, targetHasCode, worktrees };
  if (data === null || typeof data !== "object") return session;
  if ("sessionId" in data && typeof data.sessionId === "string") session.sessionId = data.sessionId;
  if ("sessionName" in data && typeof data.sessionName === "string") session.sessionName = data.sessionName;
  if ("model" in data && data.model !== null && typeof data.model === "object") {
    const m = data.model;
    if ("provider" in m && typeof m.provider === "string" && "id" in m && typeof m.id === "string") {
      session.model = { provider: m.provider, id: m.id };
    }
  }
  return session;
}

/** Path-ish tokens out of a tool's (truncated) argument projection. */
function argPaths(args: unknown): string[] {
  if (args === null || typeof args !== "object") return [];
  const tokens: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    for (const token of value.split(/[\s'"`,;:()]+/)) {
      if (token.length > 0) tokens.push(token);
    }
  }
  return tokens;
}

function primaryArg(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  for (const key of ["path", "file", "command", "pattern", "query", "url"]) {
    if (key in args) {
      const value: unknown = Reflect.get(args, key);
      if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}...` : value;
    }
  }
  return "";
}

class Bridge {
  readonly #cli: Cli;
  /** current target project; changed by switch_project */
  #cwd: string;
  #store: GraphStore;
  #snapshots: SnapshotStore;
  #hub: WsHub | null = null;
  #rpc: RpcClient | null = null;
  #agent: AgentState = "idle";
  #session: SessionInfo;
  #assistant = "";
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
    this.#session = {
      sessionId: null,
      sessionName: null,
      model: null,
      cwd: cli.cwd,
      targetHasCode: false,
      worktrees: [],
    };
  }

  async start(): Promise<void> {
    await this.#openProject();
    await this.#startChild();

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
    };
    await ensureGitExclude(this.#cwd);
    this.#recents = await pushRecent(this.#cwd);
  }

  /** Spawn omp in `#cwd`, register the canvas tool, prime session state. */
  async #startChild(): Promise<void> {
    const rpc = new RpcClient({
      command: this.#cli.command,
      cwd: this.#cwd,
      onEvent: (frame) => this.#onFrame(frame),
      onStderr: (text) => process.stderr.write(text),
      onExit: (code, signal) => {
        const message = `omp exited (code=${code} signal=${signal})`;
        console.error(`[bridge] ${message}`);
        this.#hub?.broadcast({ type: "error", message });
        setTimeout(() => process.exit(code === 0 ? 1 : (code ?? 1)), 50);
      },
    });
    this.#rpc = rpc;

    const ready = await rpc.ready;
    console.error(`[bridge] omp ready (protocol ${String(ready.protocolVersion ?? "?")})`);

    const tools = await rpc.request({
      type: "set_host_tools",
      tools: [
        {
          name: "canvas",
          label: "Canvas",
          description: CANVAS_TOOL_DESCRIPTION,
          parameters: CANVAS_TOOL_SCHEMA,
          loadMode: "essential",
        },
      ],
    });
    if (!tools.success) throw new Error(`set_host_tools failed: ${tools.error ?? "unknown"}`);
    console.error("[bridge] registered host tool: canvas");

    const state = await rpc.request({ type: "get_state" });
    if (state.success) {
      this.#session = sessionFromState(state.data, this.#cwd, this.#targetHasCode, this.#session.worktrees);
      const data = state.data;
      if (data !== null && typeof data === "object") {
        if ("isCompacting" in data && data.isCompacting === true) this.#agent = "compacting";
        else if ("isStreaming" in data && data.isStreaming === true) this.#agent = "streaming";
      }
    } else {
      console.error(`[bridge] get_state failed: ${state.error ?? "unknown"}`);
    }
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
    if (msg.type === "abort") {
      // aborts must not queue behind an in-flight delivery
      const rpc = this.#rpc;
      if (rpc === null) return;
      rpc.request({ type: "abort" }).then(
        (res) => {
          if (!res.success) this.#error(`abort failed: ${res.error ?? "unknown"}`);
        },
        (err: unknown) => this.#error(`abort failed: ${String(err)}`),
      );
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
    const rpc = this.#rpc;
    if (rpc === null) return;
    this.#broadcast({ type: "transcript", role: "user", text });
    await this.#send(rpc, composeUtterance(this.#store, text, referent));
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
   * Retarget the bridge at another project: stop the current turn and child,
   * flush the graph, re-open the new project, spawn a fresh omp, re-hello.
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

      const old = this.#rpc;
      this.#rpc = null;
      if (old !== null) {
        old.send({ type: "abort" }); // best effort: stop whatever turn is running
        await old.dispose();
      }
      await this.#store.persist();

      this.#cwd = target;
      this.#agent = "idle";
      this.#assistant = "";
      this.#activity = new Set();
      this.#promptSent = false; // a new session earns the preamble again
      this.#onboarding = false;
      this.#realityHead = null;

      await this.#openProject();
      await this.#startChild();
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
    const rpc = this.#rpc;
    if (rpc === null) return;
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
    await this.#send(rpc, composeSurveyPrompt(this.#store.doc, focus));
  }

  /** get_state -> steer while streaming, else prompt; first prompt carries the preamble. */
  async #send(rpc: RpcClient, composed: string): Promise<void> {
    let streaming = false;
    try {
      const state = await rpc.request({ type: "get_state" });
      const data = state.data;
      if (state.success && data !== null && typeof data === "object" && "isStreaming" in data) {
        streaming = data.isStreaming === true;
      }
    } catch (err) {
      this.#error(`get_state failed: ${String(err)}`);
    }

    const message = streaming || this.#promptSent ? composed : `${PREAMBLE}${composed}`;
    if (!streaming) this.#promptSent = true;

    try {
      const res = await rpc.request(
        streaming ? { type: "steer", message } : { type: "prompt", message },
      );
      if (!res.success) this.#error(`${streaming ? "steer" : "prompt"} failed: ${res.error ?? "unknown"}`);
    } catch (err) {
      this.#error(`delivery failed: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // agent -> browser
  // -------------------------------------------------------------------------

  #onFrame(frame: RpcFrame): void {
    switch (frame.type) {
      case "agent_start":
        this.#setAgent("streaming");
        return;
      case "agent_end":
        if (frame.isTerminal !== false) {
          // the survey turn is over: structure validation returns to normal
          this.#onboarding = false;
          this.#setAgent("idle");
          void this.#refreshReality();
        }
        return;
      case "auto_compaction_start":
        this.#setAgent("compacting");
        return;
      case "auto_compaction_end":
        this.#setAgent("streaming");
        return;
      case "message_update":
        this.#onDelta(frame.assistantMessageEvent);
        return;
      case "message_end":
        this.#flushAssistant();
        return;
      case "turn_end":
        this.#flushAssistant();
        this.#setActivity([]);
        return;
      case "tool_execution_start":
        this.#onToolStart(frame);
        return;
      case "tool_execution_end":
        this.#onToolEnd(frame);
        return;
      case "host_tool_call":
        this.#onHostToolCall(frame);
        return;
      case "extension_error":
        this.#error(`extension error: ${String(frame.error ?? "unknown")}`);
        return;
      case "bridge_parse_error":
        console.error(`[bridge] unparseable omp frame: ${String(frame.line)}`);
        return;
      default:
        return;
    }
  }

  #onDelta(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    if (!("type" in event) || event.type !== "text_delta") return;
    if (!("delta" in event) || typeof event.delta !== "string") return;
    this.#assistant += event.delta;
  }

  #flushAssistant(): void {
    const text = this.#assistant.trim();
    this.#assistant = "";
    if (text.length > 0) this.#broadcast({ type: "transcript", role: "assistant", text });
  }

  #onToolStart(frame: RpcFrame): void {
    const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
    const args = "args" in frame ? frame.args : frame.input;
    const arg = primaryArg(args);
    this.#broadcast({ type: "transcript", role: "tool", text: arg === "" ? name : `${name} ${arg}` });

    const hits = this.#nodesForPaths(argPaths(args));
    if (hits.length > 0) this.#setActivity([...this.#activity, ...hits]);
  }

  #onToolEnd(frame: RpcFrame): void {
    if (frame.isError !== true) return;
    const name = typeof frame.toolName === "string" ? frame.toolName : "tool";
    this.#broadcast({ type: "transcript", role: "tool", text: `${name} failed` });
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

  #onHostToolCall(frame: RpcFrame): void {
    const rpc = this.#rpc;
    const id = frame.id;
    if (rpc === null || typeof id !== "string") return;

    if (frame.toolName !== "canvas") {
      rpc.send({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: `unknown host tool "${String(frame.toolName)}"` }] },
      });
      return;
    }

    const outcome = this.#store.applyCanvasCall(
      frame.arguments,
      this.#onboarding ? onboardingOpGate(this.#cwd) : null,
    );
    rpc.send({
      type: "host_tool_result",
      id,
      ...(outcome.isError ? { isError: true } : {}),
      result: { content: [{ type: "text", text: outcome.text }] },
    });
    this.#broadcast({ type: "transcript", role: "tool", text: outcome.transcript });
    if (outcome.changed) {
      void this.#graphChanged();
      this.#broadcast({ type: "graph", graph: this.#store.doc });
    }
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

const bridge = new Bridge(parseArgv(process.argv.slice(2)));
await bridge.start();
