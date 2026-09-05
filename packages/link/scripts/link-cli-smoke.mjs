#!/usr/bin/env node
/**
 * The two canvas channels answer the same: `src/cli.ts` against
 * `src/omp-extension.ts`, both driven through a real bridge.
 *
 * The CLI exists so a session with no `canvas` tool can still draw, which is
 * only true if a call made through it is INDISTINGUISHABLE from the same call
 * made by the extension. So this smoke sends one fixture batch down each path
 * and diffs everything the caller and the canvas can see: the receipt text, the
 * graph the ops produced, and the revision snapshots that were filed.
 *
 * Two bridges, not one, and that is the whole design: applying the same ops to
 * one graph twice gives the second call a different receipt (`rev` has moved,
 * the upserts are updates rather than inserts), so a single-bridge comparison
 * would be comparing two different questions. Each path therefore gets its own
 * port, its own SHAPE_HOME and its own identically-seeded target repo, and what
 * legitimately differs between two temp directories — their paths, the git HEAD
 * they were committed at, timestamps — is normalized out before the diff.
 *
 * Usage (from packages/link): node scripts/link-cli-smoke.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const linkPkg = dirname(here);
const repo = dirname(dirname(linkPkg));
const bridgePkg = join(repo, "packages", "bridge");
const cli = join(linkPkg, "src", "cli.ts");

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** generous by default: a cold bridge extracts reality and launches a pty first */
async function waitFor(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(50);
  }
}

/** a port nothing holds: bound, read back, released */
async function freePort() {
  const server = createServer();
  const { promise, resolve, reject } = Promise.withResolvers();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  const port = await promise;
  await new Promise((r) => server.close(r));
  return port;
}

/**
 * sha256(machine + realpath(git common dir)) — how the agent keys a project
 * (bridge/src/agent/runtime.ts), and therefore how its rows are found.
 */
function projectKeyOf(cwd) {
  const dotGit = join(realpathSync(cwd), ".git");
  const common = existsSync(dotGit) ? realpathSync(dotGit) : realpathSync(cwd);
  return createHash("sha256").update(`${hostname()}:${common}`).digest("hex");
}

/**
 * A committed one-package workspace: enough for the bridge to key a project,
 * list a worktree and extract a reality layer. Both targets are seeded
 * identically and with the same package names, so everything the two canvases
 * derive from the code is equal by construction.
 */
async function seedTarget(dir) {
  await mkdir(join(dir, "packages", "core", "src"), { recursive: true });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "fixture", private: true }, null, 2)}\n`);
  await writeFile(
    join(dir, "packages", "core", "package.json"),
    `${JSON.stringify({ name: "@fixture/core", version: "0.0.1" }, null, 2)}\n`,
  );
  await writeFile(join(dir, "packages", "core", "src", "index.ts"), "export const totals = [];\n");
  // The fixture repo has to be committed (the bridge keys a project off the git
  // common dir and reads HEAD for the reality layer) and it has to be
  // committable on ANY machine: the identity is passed in rather than read from
  // the developer's config, hooks are pointed at nothing so a global
  // pre-commit policy cannot refuse it, and the branch is named rather than
  // inherited from init.defaultBranch.
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=.git/no-hooks", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "fixture");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

// ---------------------------------------------------------------------------
// the bridge under test
// ---------------------------------------------------------------------------

const running = [];
/** every temp directory this run made, removed in the `finally` however it ends */
const scratch = [];

/**
 * One real bridge on its own port, over its own target repo and SHAPE_HOME.
 * Nothing is launched in it: a caller speaking from inside the target is what
 * makes a session appear, so the bridge is ready as soon as its hub listens.
 */
async function startBridge(tag) {
  const port = await freePort();
  const target = await mkdtemp(join(tmpdir(), `vh-linkcli-${tag}-`));
  const home = await mkdtemp(join(tmpdir(), `vh-linkcli-home-${tag}-`));
  // registered before anything can throw: a seed that fails must not leak a dir
  scratch.push(target, home);
  await seedTarget(target);
  const worktree = realpathSync(target);

  const child = spawn(process.execPath, ["src/index.ts", "--cwd", target, "--port", String(port)], {
    cwd: bridgePkg,
    env: {
      ...process.env,
      // no herdr probe against the developer's own terminal, one detected
      // harness, and no automatic map: the canvas has to be empty until the
      // fixture call writes to it, or the two graphs would differ by whatever
      // the skeleton happened to draw.
      SHAPE_LAUNCHER: "none",
      SHAPE_FORCE_HARNESSES: "omp",
      SHAPE_AUTO_MAP: "0",
      SHAPE_HOME: home,
      HOME: home,
      GIT_AUTHOR_NAME: "smoke",
      GIT_AUTHOR_EMAIL: "smoke@example.com",
      GIT_COMMITTER_NAME: "smoke",
      GIT_COMMITTER_EMAIL: "smoke@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const bridge = {
    tag,
    port,
    target,
    home,
    worktree,
    child,
    link: `ws://127.0.0.1:${port}/link`,
    db: join(home, ".shape", "shape.db"),
    log: () => log,
  };
  running.push(bridge);

  await waitFor(`${tag}: bridge listening`, () => log.includes("canvas at ws://"));
  return bridge;
}

/** the browser hub's opening frame: one graph and one revision list per worktree */
async function hubHello(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const { promise, resolve, reject } = Promise.withResolvers();
  let hello = null;
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "hello" && hello === null) {
      hello = frame;
      resolve(frame);
    }
  });
  socket.on("error", reject);
  const timer = setTimeout(() => reject(new Error(`no hello from the hub on ${port}`)), 20_000);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

/** one worktree's stored revision snapshots, oldest first; null until persisted */
function storedRevisions(bridge) {
  if (!existsSync(bridge.db)) return null;
  let db = null;
  try {
    db = new DatabaseSync(bridge.db);
    return db
      .prepare("SELECT snapshot FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY rev ASC")
      .all("local", projectKeyOf(bridge.target), bridge.worktree)
      .map((row) => JSON.parse(row.snapshot));
  } catch {
    // mid-write, or the schema is not there yet: "not yet" either way
    return null;
  } finally {
    db?.close();
  }
}

async function stopBridge(bridge) {
  const { child } = bridge;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = Promise.withResolvers();
  child.once("exit", exited.resolve);
  const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited.promise;
  clearTimeout(killer);
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

/** fields that are a fact about WHEN or WHERE, not about what the ops did */
const VOLATILE = new Set(["head", "at", "extractedAt"]);

/**
 * The same value as seen from either bridge. Two temp repos cannot share a
 * path or a commit sha, and two runs cannot share a clock — so those are the
 * only things replaced, and anything else that differs is a real difference
 * between the two channels.
 */
function normalize(value, paths) {
  const scrub = (v) => {
    if (typeof v === "string") {
      let out = v;
      for (const path of paths) out = out.split(path).join("<target>");
      return out;
    }
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const [key, inner] of Object.entries(v)) out[key] = VOLATILE.has(key) ? "<volatile>" : scrub(inner);
      return out;
    }
    return v;
  };
  return scrub(value);
}

const shown = (value) => JSON.stringify(value).slice(0, 400);

/** the first place two normalized values differ, as a path — a readable FAIL detail */
function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return `${path || "<root>"}: ${shown(a)} !== ${shown(b)}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const diff = firstDiff(a[key], b[key], `${path}/${key}`);
    if (diff !== null) return diff;
  }
  return `${path || "<root>"}: ${shown(a)} !== ${shown(b)}`;
}

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

/**
 * The batch both channels send: two upserts, a child, an edge and a note — one
 * of every op shape a session actually uses on a fresh canvas. Phases stay at
 * `idea`, which is the one altitude the link-gap warnings are not asked at, so
 * the receipt is about the ops and nothing else.
 */
const FIXTURE = {
  ops: [
    {
      op: "upsert_node",
      node: { id: "bill-splitter", parentId: null, label: "Bill Splitter", summary: "Splits a restaurant bill between friends.", phase: "idea" },
    },
    {
      op: "upsert_node",
      node: { id: "money-rules", parentId: "bill-splitter", label: "Money rules", summary: "Works out who owes what after every expense.", phase: "idea" },
    },
    {
      op: "upsert_node",
      node: { id: "who-paid", parentId: "bill-splitter", label: "Who paid", summary: "Remembers who put the card down each time.", phase: "idea" },
    },
    {
      op: "upsert_edge",
      edge: { id: "who-paid--money-rules", source: "who-paid", target: "money-rules", kind: "dataflow", label: "what was paid" },
    },
  ],
  note: "the link CLI smoke fixture",
};

/** empty ops: refused before a single op applies, so it can be sent freely */
const PROBE = { ops: [] };

// ---------------------------------------------------------------------------
// the extension path: the real extension, a stub `pi`, a real link
// ---------------------------------------------------------------------------

/** a zod-compatible builder that records the schema instead of compiling it */
function zNode(spec) {
  return {
    spec,
    optional: () => zNode({ ...spec, optional: true }),
    nullable: () => zNode({ ...spec, nullable: true }),
    describe: (text) => zNode({ ...spec, description: text }),
    min: (n) => zNode({ ...spec, min: n }),
    max: (n) => zNode({ ...spec, max: n }),
  };
}

const zod = {
  object: (shape) => zNode({ type: "object", shape }),
  array: (items) => zNode({ type: "array", items }),
  string: () => zNode({ type: "string" }),
  number: () => zNode({ type: "number" }),
  boolean: () => zNode({ type: "boolean" }),
  enum: (values) => zNode({ type: "enum", values }),
  unknown: () => zNode({ type: "unknown" }),
};

/** the documented `pi` surface the extension touches, and a ctx in `cwd` */
function makePi(cwd) {
  const handlers = new Map();
  const state = { tools: [], logs: [], timers: new Set() };
  const pi = {
    on(event, handler) {
      const list = handlers.get(event);
      if (list === undefined) handlers.set(event, [handler]);
      else list.push(handler);
    },
    registerTool(definition) {
      state.tools.push(definition);
    },
    sendUserMessage() {},
    logger: { info: (message) => state.logs.push(message) },
    zod,
  };
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "link-cli-smoke", getSessionFile: () => null },
    models: { current: () => ({ provider: "fake", id: "fake-1" }) },
    abort: () => {},
    setInterval: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      state.timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => {
      clearInterval(timer);
      state.timers.delete(timer);
    },
  };
  const fire = async (event, payload = {}) => {
    for (const handler of [...(handlers.get(event) ?? [])]) await handler(payload, ctx);
  };
  return { pi, ctx, state, fire };
}

/**
 * Drive the real extension against `bridge` and return the receipt its `canvas`
 * tool handed back. The probe loop is how "the link is up" is established: the
 * extension dials on its own backoff tick, and an empty ops batch is the one
 * call that can be retried without changing the graph it is asking about.
 */
async function extensionReceipt(bridge) {
  process.env.SHAPE_LINK = bridge.link;
  const { default: extension } = await import(new URL("../src/omp-extension.ts", import.meta.url));
  const { pi, ctx, state, fire } = makePi(bridge.worktree);
  extension(pi);
  const canvas = state.tools.find((t) => t.name === "canvas");
  if (canvas === undefined) throw new Error("the extension registered no canvas tool");
  await fire("session_start");

  await waitFor("the extension's link to open", async () => {
    const probe = await canvas.execute("probe", PROBE, undefined, undefined, ctx);
    return !probe.content[0].text.startsWith("Shape server unreachable");
  });

  const result = await canvas.execute("fixture", FIXTURE, undefined, undefined, ctx);
  const receipt = { text: result.content[0].text, isError: result.isError === true };
  return {
    receipt,
    async close() {
      await fire("session_shutdown");
      for (const timer of state.timers) clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// the CLI path: the real cli.ts, spawned from inside the worktree
// ---------------------------------------------------------------------------

/** run `node cli.ts …` the way the directive tells a session to run it */
function runCli(args, cwd, link) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, SHAPE_LINK: link },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { promise, resolve } = Promise.withResolvers();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.once("exit", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

/** the single JSON line the CLI prints, or a readable failure */
function cliJson(run, label) {
  const line = run.stdout.trim();
  if (line === "") throw new Error(`${label}: no stdout (exit ${run.code}): ${run.stderr.trim()}`);
  if (line.includes("\n")) throw new Error(`${label}: expected one line, got ${JSON.stringify(line)}`);
  return JSON.parse(line);
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

let extensionSession = null;

try {
  // --- the extension path ---------------------------------------------------
  const ext = await startBridge("ext");
  extensionSession = await extensionReceipt(ext);
  const extReceipt = extensionSession.receipt;
  check(
    "the extension's canvas tool applied the fixture",
    extReceipt.isError === false && extReceipt.text.startsWith("applied 4 op(s);"),
    extReceipt.text.split("\n")[0],
  );
  const extHello = await hubHello(ext.port);
  const extRevisions = await waitFor("the extension path's revision snapshot", () => {
    const rows = storedRevisions(ext);
    return rows !== null && rows.length > 0 ? rows : false;
  });

  // --- the CLI path ---------------------------------------------------------
  const cliBridge = await startBridge("cli");
  const cliRun = await runCli(["canvas", JSON.stringify(FIXTURE)], cliBridge.target, cliBridge.link);
  const cliReceipt = cliJson(cliRun, "cli canvas");
  check(
    "`cli.ts canvas` prints one receipt line and exits 0 on a call that applied",
    cliRun.code === 0 && cliReceipt.isError === false && typeof cliReceipt.text === "string",
    `exit ${cliRun.code} ${shown(cliReceipt)}`,
  );
  const cliHello = await hubHello(cliBridge.port);
  const cliRevisions = await waitFor("the CLI path's revision snapshot", () => {
    const rows = storedRevisions(cliBridge);
    return rows !== null && rows.length > 0 ? rows : false;
  });

  // --- the comparison ------------------------------------------------------
  const paths = [ext.worktree, ext.target, ext.home, cliBridge.worktree, cliBridge.target, cliBridge.home];
  const extGraph = normalize(extHello.graphs[ext.worktree], paths);
  const cliGraph = normalize(cliHello.graphs[cliBridge.worktree], paths);

  check(
    "the same ops through either channel produce the same receipt",
    JSON.stringify(extReceipt) === JSON.stringify(cliReceipt),
    `${shown(extReceipt)} vs ${shown(cliReceipt)}`,
  );
  check(
    "the same ops through either channel produce the same graph",
    JSON.stringify(extGraph) === JSON.stringify(cliGraph),
    firstDiff(extGraph, cliGraph) ?? "",
  );
  check(
    "the graph is the fixture, on both",
    extGraph.rev === cliGraph.rev &&
      extGraph.nodes.map((n) => n.id).join(",") === "bill-splitter,money-rules,who-paid" &&
      extGraph.edges.map((e) => e.id).join(",") === "who-paid--money-rules",
    `rev=${extGraph.rev} nodes=${extGraph.nodes.map((n) => n.id).join(",")}`,
  );
  check(
    "either channel files the same number of revisions",
    extRevisions.length === cliRevisions.length,
    `${extRevisions.length} vs ${cliRevisions.length}`,
  );
  const extSnapshots = normalize(extRevisions, paths);
  const cliSnapshots = normalize(cliRevisions, paths);
  check(
    "every filed revision snapshot matches, op for op",
    JSON.stringify(extSnapshots) === JSON.stringify(cliSnapshots),
    firstDiff(extSnapshots, cliSnapshots) ?? "",
  );
  check(
    "the revisions are the ops the call applied",
    extSnapshots.every((s) => Array.isArray(s.nodes)) &&
      extSnapshots.at(-1).nodes.map((n) => n.id).sort().join(",") === "bill-splitter,money-rules,who-paid",
    shown(extSnapshots.at(-1)?.nodes?.map((n) => n.id)),
  );

  // --- `cli.ts status` -----------------------------------------------------
  const inside = await runCli(["status"], cliBridge.target, cliBridge.link);
  const insideJson = cliJson(inside, "cli status (inside)");
  check(
    "`cli.ts status` from inside the worktree reports a reachable bridge and that worktree",
    inside.code === 0 && insideJson.reachable === true && insideJson.worktree === cliBridge.worktree &&
      insideJson.cwd === cliBridge.worktree && insideJson.link === cliBridge.link,
    shown(insideJson),
  );
  check(
    "`cli.ts status` from inside reports what the bridge says about the cwd",
    typeof insideJson.session === "string" && insideJson.session.includes("applied 0 op(s)"),
    shown(insideJson.session),
  );

  const outside = await mkdtemp(join(tmpdir(), "vh-linkcli-outside-"));
  scratch.push(outside);
  const away = await runCli(["status"], outside, cliBridge.link);
  const awayJson = cliJson(away, "cli status (outside)");
  check(
    "`cli.ts status` from outside the project reports the routing refusal, bridge still reachable",
    away.code === 0 && awayJson.reachable === true && awayJson.worktree === null &&
      awayJson.session.includes("is not part of"),
    shown(awayJson),
  );

  const down = await runCli(["status", "--link", "ws://127.0.0.1:1/link"], cliBridge.target, cliBridge.link);
  const downJson = cliJson(down, "cli status (unreachable)");
  check(
    "--link overrides SHAPE_LINK, and an unreachable bridge is exit 1 with the url named",
    down.code === 1 && downJson.reachable === false && downJson.link === "ws://127.0.0.1:1/link" &&
      downJson.session.includes("ws://127.0.0.1:1/link"),
    shown(downJson),
  );
} catch (err) {
  check("the smoke ran to the end", false, err instanceof Error ? err.message : String(err));
  for (const bridge of running) process.stderr.write(`\n--- ${bridge.tag} bridge log ---\n${bridge.log()}\n`);
} finally {
  await extensionSession?.close();
  for (const bridge of running) await stopBridge(bridge);
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
}

for (const line of results) console.log(line);
console.log(failed === 0 ? `link CLI smoke: ${results.length} checks passed` : `link CLI smoke: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
