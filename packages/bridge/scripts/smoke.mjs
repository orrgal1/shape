#!/usr/bin/env node
/**
 * Bridge dev smoke test. Runs the real bridge over throwaway repositories and
 * asserts both observation-only session behavior and explicit control mapping.
 * The bridge starts no harness and sends no prompt to one. Sessions are
 * observed when a harness dials the loopback link from its own working
 * directory, so every session here is started by this script
 * (`scripts/fake-omp-tui.mjs`) and driven through its stdin like a real TUI.
 *
 * Usage (from packages/bridge): node scripts/smoke.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { requestControl as sendControlRequest } from "../../../scripts/lib/client.mjs";

const PORT = Number(process.env.SMOKE_PORT ?? 4409);

/**
 * Every bridge below inherits this environment. A smoke must not depend on what
 * happens to be installed on the machine running it, and it must never touch
 * the developer's own terminal: `SHAPE_LAUNCHER=none` skips the herdr probe
 * altogether, so no manager tab is opened in a real herdr and every observed
 * session reports `terminal: "none"`. Detection reports exactly one harness.
 */
process.env.SHAPE_LAUNCHER = "none";
process.env.SHAPE_FORCE_HARNESSES = "omp";
/**
 * Browser-visible state uses stable Git branch refs. Physical checkout paths
 * remain only in agent-link routing and the public worktree inventory.
 */
const branchId = (name) => `refs/heads/${name}`;
const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(20);
  }
}

/** frames the fake harness sent and received, in order */
function ompFrames(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * A canvas receipt, read the way the agent reads it: one summary line, then a
 * pretty-printed JSON block per kind — what was refused, then what landed with
 * a cross-layer link still owed (user decision 2026-09-04). A `{` in column 0
 * only ever starts a block, because everything nested is indented.
 */
function receipts(text) {
  const out = { rejections: [], warnings: [] };
  for (const block of text.slice(text.indexOf("\n") + 1).split(/\n(?=\{)/)) {
    if (!block.startsWith("{")) continue;
    Object.assign(out, JSON.parse(block));
  }
  return out;
}

/** every file under `dir`, root-relative posix — the non-git fallback for a FileIndex */
function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * A committed pnpm workspace in the target dir: gives the bridge a real git HEAD
 * so the reality-refresh trigger fires when a session goes idle. `scope` names
 * the workspace packages (@<scope>/auth, @<scope>/db) so two seeded projects are
 * distinguishable on the wire.
 */
async function seedWorkspace(dir, scope) {
  await mkdir(join(dir, "packages", "auth", "src"), { recursive: true });
  await mkdir(join(dir, "packages", "db", "src"), { recursive: true });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: scope, private: true }, null, 2));
  await writeFile(
    join(dir, "packages", "auth", "package.json"),
    JSON.stringify({ name: `@${scope}/auth`, version: "0.0.1", dependencies: { [`@${scope}/db`]: "workspace:*" } }, null, 2),
  );
  await writeFile(join(dir, "packages", "db", "package.json"), JSON.stringify({ name: `@${scope}/db`, version: "0.0.1" }, null, 2));
  await writeFile(join(dir, "packages", "auth", "src", "index.ts"), `import { users } from "@${scope}/db";\nexport const login = () => users;\n`);
  await writeFile(join(dir, "packages", "db", "src", "index.ts"), "export const users = [];\n");
  // plain JavaScript, on purpose: the reality scan has to read .js/.mjs the way
  // it reads TypeScript, or a project written in JS maps as an empty shell
  await writeFile(join(dir, "packages", "db", "src", "backup.mjs"), "export function backupUsers() {\n  return [];\n}\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  // `-b smoke`, not the default branch: a machine may carry a global
  // `pre-commit` hook that refuses every commit on main/master (this one does),
  // and a fixture repo the smoke throws away must not depend on which.
  git("init", "-q", "-b", "smoke");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** the fake harness logs to <its cwd>/fake-omp.log */
const ompLogIn = (dir) => join(dir, "fake-omp.log");

const FAKE_OMP = join(process.cwd(), "scripts", "fake-omp-tui.mjs");

/**
 * A session, started the way every session Shape sees is started: by somebody
 * else. The fake harness dials the bridge's loopback link itself, greets it
 * from `worktree`, and runs one turn per line typed into its stdin — the bridge
 * neither launches it nor ever sends it anything.
 */
function startSession({ worktree, port, holdMs = 0, resume = null, log = ompLogIn(worktree) }) {
  const child = spawn(process.execPath, [FAKE_OMP, ...(resume === null ? [] : ["--resume", resume])], {
    cwd: worktree,
    env: {
      ...process.env,
      SHAPE_LINK: `ws://127.0.0.1:${port}/link`,
      SHAPE_WORKTREE: realpathSync(worktree),
      FAKE_OMP_LOG: log,
      FAKE_OMP_TURN_HOLD_MS: String(holdMs),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`[session ${basename(worktree)}] ${d}`));
  child.stdout.resume();
  const session = {
    child,
    log,
    /** the user typed a prompt into this pane and hit enter */
    type: (text) => child.stdin.write(`${JSON.stringify({ type: "typed", text })}\n`),
    /** the pane was closed: the harness says `bye` on its way out */
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = Promise.withResolvers();
      child.once("exit", exited.resolve);
      child.kill("SIGTERM");
      await exited.promise;
    },
  };
  return session;
}

const target = await mkdtemp(join(tmpdir(), "vh-smoke-a-"));
/**
 * A second repo, which nothing seeds and nobody opens: it becomes a project
 * because a session dials the link from inside it, which is the only way a
 * project ever enters the registry.
 */
const targetB = await mkdtemp(join(tmpdir(), "vh-smoke-b-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-smoke-home-"));
await seedWorkspace(target, "t");
await seedWorkspace(targetB, "b");

// two more worktrees of target A's repo, each on its own branch: one that runs
// a session of its own, one that only ever hears from a link caller
const worktree = join(tmpdir(), `vh-smoke-wt-${process.pid}`);
execFileSync("git", ["worktree", "add", "-b", "variation", worktree], { cwd: target, stdio: "ignore" });
const worktree2 = join(tmpdir(), `vh-smoke-wt2-${process.pid}`);
execFileSync("git", ["worktree", "add", "-b", "variation-2", worktree2], { cwd: target, stdio: "ignore" });
/** a third variation, added under the running bridge: the worktree list must follow */
const worktree3 = join(tmpdir(), `vh-smoke-wt3-${process.pid}`);
/**
 * Physical worktree ids stay in agent-link routing and worktree inventory.
 * Browser graph and session state is keyed by the stable branch refs below.
 * `wtA`, `wtVariation`, and `wt2` are checkouts of one project; `wtB` is another.
 */
const wtA = realpathSync(target);
const wtVariation = realpathSync(worktree);
const wt2 = realpathSync(worktree2);
const wtB = realpathSync(targetB);
const branchA = branchId("smoke");
const branchVariation = branchId("variation");
const branch2 = branchId("variation-2");
const branchB = branchId("smoke");
const frames = [];
let bridge = null;
let socket = null;
/** every session this run started, so the teardown can take them all down */
const sessions = [];

/** local mode keeps every project's canvas in one database under SHAPE_HOME */
const shapeDb = join(fakeHome, ".shape", "shape.db");

/**
 * sha256(machine + realpath(git common dir)) — how the agent keys a project
 * (src/agent/runtime.ts). Every worktree of a repo resolves to the same common
 * dir, so a variation is another canvas of the SAME project, not a new one.
 */
function projectKeyOf(cwd) {
  const dotGit = join(realpathSync(cwd), ".git");
  const common = existsSync(dotGit) ? realpathSync(dotGit) : realpathSync(cwd);
  return createHash("sha256").update(`${hostname()}:${common}`).digest("hex");
}

/**
 * sha256(machine + realpath(the DIRECTORY)) — how a Shape from before
 * `repoIdentity` keyed a project. Every canvas drawn back then is stored under
 * one of these, and the first attach moves it onto `projectKeyOf`.
 */
function legacyProjectKeyOf(dir) {
  return createHash("sha256").update(`${hostname()}:${realpathSync(dir)}`).digest("hex");
}

/**
 * Read rows out of a bridge's own database while it runs. A database that is
 * not there yet — or busy mid-write — is just "not yet", so the callers can
 * poll it exactly as they polled the files it replaced.
 */
function dbRowsIn(file, sql, ...params) {
  if (!existsSync(file)) return null;
  let db = null;
  try {
    db = new DatabaseSync(file);
    return db.prepare(sql).all(...params);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

const dbRows = (sql, ...params) => dbRowsIn(shapeDb, sql, ...params);

/** One branch's stored effective canvas; null until the bridge has persisted it. */
function storedGraph(cwd, branch = branchId("smoke")) {
  const rows = dbRows(
    "SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?",
    "local",
    projectKeyOf(cwd),
    branch,
  );
  return rows === null || rows.length === 0 ? null : JSON.parse(rows[0].doc);
}

/** One branch's stored revision snapshots, oldest first. */
function storedRevisions(cwd, branch = branchId("smoke")) {
  const rows = dbRows(
    "SELECT snapshot FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY rev ASC",
    "local",
    projectKeyOf(cwd),
    branch,
  );
  return rows === null ? [] : rows.map((row) => JSON.parse(row.snapshot));
}

/** a websocket that is open, with every frame it receives pushed onto `sink` */
async function openSocket(url, sink) {
  const ws = new WebSocket(url);
  ws.on("message", (data) => sink.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  ws.once("open", opened.resolve);
  ws.once("error", opened.reject);
  await opened.promise;
  return ws;
}
let controlSequence = 0;

/** Use the production client for one request-correlated local control exchange. */
function requestControl(port, label, request) {
  return sendControlRequest(
    { ...request, requestId: `${label}-${++controlSequence}` },
    { server: `http://127.0.0.1:${port}` },
  );
}

// --- store.applyCanvasCall: shared validation, receipts and link warnings ---
// In-process (node strips types, same as the bridge child): every rule below
// lives entirely in GraphStore, no wire round-trip needed. There is no gate to
// interleave with any more — the server validates a canvas call the same way
// whoever made it, because it never asks for one.
{
  const { GraphStore } = await import(new URL("../src/server/store.ts", import.meta.url));
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  // The store is scoped by tenant, project, and public branch identity.
  const storeDb = openSqliteStorage(join(tmpdir(), `vh-smoke-store-${process.pid}`, "shape.db"));
  const store = new GraphStore(storeDb, "local", "shared-validation", branchA);
  const mkNode = (id, parentId = null) => ({
    op: "upsert_node",
    node: { id, parentId, label: id, summary: `promise of ${id}`, phase: "idea" },
  });
  const revBefore = store.doc.rev;
  const outcome = store.applyCanvasCall({
    ops: [mkNode("sm-root"), mkNode("sm-orphan", "no-such-parent"), mkNode("sm-child", "sm-root")],
  });
  check(
    "mixed call: accepted ops applied and bumped rev",
    outcome.changed === true && store.doc.rev === revBefore + 1 &&
      outcome.text.startsWith(`applied 2 op(s); rev=${store.doc.rev}`) &&
      store.node("sm-root") !== undefined && store.node("sm-child")?.parentId === "sm-root",
    outcome.text.split("\n")[0],
  );
  check(
    "mixed call with survivors is not an error result",
    outcome.isError === false && !store.doc.nodes.some((n) => n.id === "sm-orphan"),
  );
  const mixed = receipts(outcome.text).rejections;
  const sharedRej = mixed.find((r) => r.code === "op/unknown-parent");
  check(
    "a refused op is reported at its own index, whatever landed around it",
    mixed.length === 1 && sharedRej.index === 1 && sharedRej.subject.path === "/ops/1/node/parentId" &&
      sharedRej.subject.id === "sm-orphan" && sharedRej.evidence.parentId === "no-such-parent",
    JSON.stringify(mixed.map((r) => `${r.index}:${r.code}`)),
  );
  check(
    "every receipt carries the full structured shape",
    mixed.every(
      (r) =>
        typeof r.code === "string" && (r.severity === "error" || r.severity === "warning") &&
        typeof r.message === "string" && typeof r.subject?.path === "string" &&
        r.evidence !== null && typeof r.evidence === "object" &&
        Array.isArray(r.supportedFixes) && r.supportedFixes.length >= 1,
    ),
  );
  const emptyCall = store.applyCanvasCall({ ops: [] });
  const badArgs = receipts(emptyCall.text).rejections[0];
  check(
    "a call with no ops in it is refused at the boundary, at no op index",
    emptyCall.isError === true && emptyCall.changed === false && badArgs?.code === "canvas/bad-args" &&
      badArgs.index === -1 && badArgs.subject.path === "/ops",
    emptyCall.text.split("\n")[0],
  );

  // --- connection is the default: link warnings on the receipt -------------
  // (user decision 2026-09-04) A bubble nothing on another layer reaches is a
  // link gap: the op still lands, and the receipt says which link is owed.
  const gapCall = store.applyCanvasCall({
    ops: [
      { op: "upsert_node", node: { id: "sm-product", parentId: null, layer: "product", label: "The whole thing", summary: "What this promises a person.", phase: "component" } },
      { op: "upsert_node", node: { id: "sm-capability", parentId: "sm-product", layer: "product", label: "Split a bill", summary: "Lets friends share one cost.", phase: "component" } },
    ],
  });
  const gapWarnings = receipts(gapCall.text).warnings;
  const gap = gapWarnings[0];
  check(
    "an unconnected capability lands and the receipt warns instead of rejecting",
    gapCall.isError === false && gapCall.changed === true &&
      store.node("sm-capability") !== undefined && gapCall.text.includes('"warnings"') &&
      gapWarnings.length === 1 && gap.code === "link/unrealized" && gap.severity === "warning" &&
      gap.index === 1 && gap.subject.path === "/ops/1/node/realizes" &&
      gap.subject.id === "sm-capability" && gap.subject.label === "Split a bill" &&
      gap.evidence.gap === "unrealized" && gap.supportedFixes.length >= 1 &&
      gap.message.includes("names no build bubble in `realizes`"),
    JSON.stringify(gapWarnings.map((w) => `${w.index}:${w.code}:${w.subject.path}`)),
  );
  check(
    "the product root is never asked what realizes it",
    !gapWarnings.some((w) => w.subject.id === "sm-product"),
    JSON.stringify(gapWarnings.map((w) => w.subject.id)),
  );
  // an idea is allowed to stand alone: nobody knows yet what would realize it
  const earlyCall = store.applyCanvasCall({
    ops: [{ op: "upsert_node", node: { id: "sm-someday", parentId: "sm-product", layer: "product", label: "Someday", summary: "A promise nobody has started.", phase: "idea" } }],
  });
  check(
    "a bubble too early to be wired is not asked for its links",
    earlyCall.warnings.length === 0 && !earlyCall.text.includes('"warnings"') &&
      store.node("sm-someday") !== undefined,
    earlyCall.text,
  );
  // A caller may explicitly suppress link warnings for a deliberately partial
  // semantic edit; suppression is scoped to that call.
  const quietCall = store.applyCanvasCall(
    { ops: [{ op: "upsert_node", node: { id: "sm-quiet", parentId: "sm-product", layer: "product", label: "See who owes", summary: "Shows who still owes what.", phase: "component" } }] },
    { linkWarnings: false },
  );
  check(
    "link warnings can be turned off for one call, and then the receipt is silent",
    quietCall.warnings.length === 0 && !quietCall.text.includes('"warnings"') &&
      store.node("sm-quiet") !== undefined,
    quietCall.text,
  );
  // a finished part nothing attests is a claim, and it hears about all three
  const partCall = store.applyCanvasCall({
    ops: [{ op: "upsert_node", node: { id: "sm-part", parentId: null, label: "Money rules", summary: "Works out who owes what.", phase: "built" } }],
  });
  check(
    "a built part with no capability, no infrastructure and no check hears the gaps it has",
    partCall.warnings.map((w) => w.code).join(",") === "link/unserved,link/unattested" &&
      partCall.warnings.every((w) => w.subject.path === "/ops/0/node" && w.subject.id === "sm-part"),
    JSON.stringify(partCall.warnings.map((w) => `${w.code}:${w.subject.path}`)),
  );

  // --- altitude and the layers: shared rules, on every caller --------------
  const secondRootCall = store.applyCanvasCall({
    ops: [{ op: "upsert_node", node: { id: "sm-other-product", parentId: null, layer: "product", label: "Another product", summary: "A second promise at the top.", phase: "component" } }],
  });
  const secondRoot = receipts(secondRootCall.text).rejections.find((r) => r.code === "op/second-root");
  check(
    "a second top-level product bubble is rejected, the receipt naming the root there already is",
    secondRoot?.index === 0 && secondRoot.subject.path === "/ops/0/node/parentId" &&
      secondRoot.evidence.rootId === "sm-product" &&
      secondRoot.supportedFixes.some((f) => f.includes("sm-product")) &&
      store.node("sm-other-product") === undefined,
    JSON.stringify(secondRoot),
  );
  // "verify" was the correctness layer's name until it was renamed. A stored
  // row that still says so is migrated on load (below); off the wire it is
  // simply not one of the four layers, so the bubble lands on the default one
  // rather than on a layer nothing renders.
  const staleLayerCall = store.applyCanvasCall({
    ops: [{ op: "upsert_node", node: { id: "sm-stale-layer", parentId: null, layer: "verify", label: "On a layer that is gone", summary: "The correctness layer was called verify once.", phase: "built" } }],
  });
  check(
    "a layer the wire does not know is not a layer: the bubble lands on the build layer",
    staleLayerCall.text.startsWith("applied 1 op(s);") &&
      (store.node("sm-stale-layer")?.layer ?? "build") === "build",
    JSON.stringify(store.node("sm-stale-layer") ?? null),
  );
  const badPhaseCall = store.applyCanvasCall({ ops: [{ op: "set_phase", id: "sm-part", phase: "bogus" }] });
  const badPhase = receipts(badPhaseCall.text).rejections.find((r) => r.code === "op/bad-phase");
  check(
    "bad-phase receipt: subject annotated from the live node, allowed values in evidence",
    badPhase?.index === 0 && badPhase.subject.id === "sm-part" && badPhase.subject.label === "Money rules" &&
      badPhase.evidence.allowed.includes("building"),
    JSON.stringify(badPhase),
  );
  // `next` is still part of the tool contract, so a harness that ends a turn on
  // a card is not made to change its calls — but Shape is a picture now and
  // nothing reads a card, so it is checked and dropped
  const cardCall = store.applyCanvasCall({
    ops: [{ op: "upsert_node", node: { id: "sm-carded", parentId: null, label: "Carded", summary: "Landed alongside a malformed card.", phase: "idea" } }],
    next: { summary: 42 },
  });
  const badCard = receipts(cardCall.text).rejections.find((r) => r.code === "op/bad-next");
  check(
    "a malformed card is refused at /next, at no op index, and the ops still land",
    badCard?.index === -1 && badCard.subject.path === "/next" && badCard.severity === "error" &&
      badCard.supportedFixes.length >= 1 && cardCall.text.startsWith("applied 1 op(s);") &&
      store.node("sm-carded") !== undefined,
    JSON.stringify({ first: cardCall.text.split("\n")[0], receipt: badCard }),
  );
  check(
    "and no card of any kind ever becomes part of the canvas",
    !JSON.stringify(store.doc).includes("42"),
    JSON.stringify(store.doc.nodes.map((n) => n.id)),
  );
  storeDb.close();
}

// --- the whole of it, over one bridge --------------------------------------
// One project with three variations and sessions that report in from two of
// them, a second project that enters the registry because a session dialed the
// link from inside it, and everything the browser may ask a read-only Shape
// for: which project to watch, whether it is active at all, a comparison of
// two snapshots, and a session's own terminal.
try {
  bridge = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", target, "--port", String(PORT), "--db", shapeDb],
    {
      cwd: process.cwd(),
      // SHAPE_HOME/HOME keep the directive and everything else this bridge
      // writes out of the developer's own home dir
      env: { ...process.env, SHAPE_HOME: fakeHome, HOME: fakeHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(`[bridge] ${d}`);
  });
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (d) => process.stderr.write(`[bridge:out] ${d}`));

  await waitFor("bridge listening", () => stderr.includes("canvas at ws://"));
  socket = await openSocket(`ws://127.0.0.1:${PORT}/ws`, frames);

  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check(
    "hello carries one branch-keyed canvas and the project's physical cwd",
    hello.graphs?.[branchA] !== undefined && hello.session?.cwd === wtA,
    `session=${JSON.stringify(hello.session)} graphs=${JSON.stringify(Object.keys(hello.graphs ?? {}))}`,
  );
  check(
    "hello reports an empty intent layer",
    hello.graphs[branchA].nodes.length === 0 && hello.graphs[branchA].edges.length === 0,
  );
  check(
    // the whole of the read-only model in one frame: a bridge starts nothing,
    // so a project nobody is working in has no sessions and no agent states
    "a bridge that has started nothing reports no sessions and no agent state",
    hello.session.sessions.length === 0 && Object.keys(hello.agents).length === 0,
    JSON.stringify({ sessions: hello.session.sessions, agents: hello.agents }),
  );
  check(
    "hello says what this machine has, and that there is no launcher to reach a terminal through",
    hello.tools?.launcher === null &&
      Array.isArray(hello.tools.launchers) &&
      hello.tools.harnesses.some((t) => t.id === "omp"),
    JSON.stringify(hello.tools ?? null),
  );
  check("a project with no herdr has no manager session", hello.session.manager === null, JSON.stringify(hello.session.manager));

  // --- startup reality extraction -------------------------------------------
  const pkgs = hello.graphs[branchA].reality.nodes.map((n) => n.id).sort();
  check("reality extracted before the first hello", pkgs.join(",") === "r:@t/auth,r:@t/db", pkgs.join(","));
  check(
    "reality layer records git HEAD",
    typeof hello.graphs[branchA].reality.head === "string",
    String(hello.graphs[branchA].reality.head).slice(0, 8),
  );
  check("targetHasCode from workspace packages", hello.session.targetHasCode === true);

  // --- every variation of the repo is on the view ---------------------------
  const wtList = hello.session.worktrees;
  const mainEntry = wtList.find((w) => w.id === wtA);
  const variation = wtList.find((w) => w.id === wtVariation);
  check(
    "hello lists every worktree of the target's repo",
    wtList.length === 3,
    JSON.stringify(wtList.map((w) => `${w.path}@${w.branch}`)),
  );
  check(
    "each worktree is identified by the realpath of its directory, main one first",
    wtList[0]?.id === wtA && mainEntry?.path === wtA && variation?.path === wtVariation,
    JSON.stringify(wtList.map((w) => `${w.id}|${w.path}`)),
  );
  check(
    "worktree branch and head are reported",
    variation?.branch === "variation" && typeof variation.head === "string" && variation.head.length === 40 &&
      typeof mainEntry?.branch === "string" && mainEntry.branch.length > 0,
    JSON.stringify({ branch: variation?.branch, head: variation?.head?.slice(0, 8), main: mainEntry?.branch }),
  );
  const branchList = hello.session.branches;
  const mainBranch = branchList.find((branch) => branch.id === branchA);
  const variationBranch = branchList.find((branch) => branch.id === branchVariation);
  check(
    "public branch metadata is stable and does not use physical worktree paths as IDs",
    branchList.length === 3 &&
      mainBranch?.branch === "smoke" &&
      mainBranch.path === wtA &&
      mainBranch.isDefault === true &&
      mainBranch.mappedCommit === null &&
      mainBranch.live === false &&
      variationBranch?.branch === "variation" &&
      variationBranch.path === wtVariation &&
      variationBranch.live === false &&
      Object.keys(mainBranch).sort().join(",") === "branch,head,id,isDefault,live,mappedCommit,path",
    JSON.stringify(branchList),
  );
  check(
    "hello carries a canvas and revision list keyed by each public branch ID",
    hello.graphs[branchVariation] !== undefined &&
      hello.graphs[branch2] !== undefined &&
      Array.isArray(hello.revisions[branchA]) &&
      Array.isArray(hello.revisions[branchVariation]) &&
      Array.isArray(hello.revisions[branch2]),
    JSON.stringify({ graphs: Object.keys(hello.graphs), revisions: Object.keys(hello.revisions) }),
  );
  check(
    "every variation of a repo is one project: the key is the repo's, not a directory's",
    hello.projectId === projectKeyOf(target),
    `${hello.projectId} / ${projectKeyOf(target)}`,
  );
  // --- the registry: every project this server knows, on the greeting -------
  // Startup reality does not make an empty intent graph live and does not
  // invent a harness session; both branch and project remain non-live.
  const seeded = hello.projects.find((p) => p.projectId === projectKeyOf(target));
  check(
    "hello lists the seeded project as active with no harness session",
    hello.projects.length === 1 && seeded.cwd === wtA && seeded.status === "active" && seeded.liveSessions === 0 &&
      seeded.manager === false && seeded.injected === 0,
    JSON.stringify(hello.projects),
  );
  check(
    "a project summary says what is true of the project, never what its agent is doing",
    !("harness" in seeded) && !("agentConnected" in seeded),
    JSON.stringify(Object.keys(seeded)),
  );
  // Live session canvas calls below require an explicit committed baseline.
  // Empty semantic maps are valid: they establish the selected exact commits
  // without inventing bubbles before a person or mapping skill describes them.
  const { repositoryIdentity: describeRepository } = await import(new URL("../src/agent/worktrees.ts", import.meta.url));
  const repository = await describeRepository(target);
  const baselineCommits = [];
  for (const branch of [branchA, branchVariation, branch2]) {
    const state = await requestControl(PORT, `baseline-read-${branch}`, {
      type: "map_read",
      repository,
      branch,
    });
    const commit = execFileSync("git", ["rev-parse", branch], { cwd: target, encoding: "utf8" }).trim();
    baselineCommits.push(
      await requestControl(PORT, `baseline-commit-${branch}`, {
        type: "map_commit",
        repository,
        branch,
        expectedRevision: state.revision,
        expectedMappedCommit: state.mappedCommit,
        commit,
        mode: "initial",
        ops: [],
        reality: hello.graphs[branch].reality,
        note: "bridge smoke empty committed baseline",
      }),
    );
  }
  check(
    "each branch is explicitly mapped before live session edits",
    baselineCommits.every(
      (response, index) =>
        response.type === "map_committed" &&
        response.branch === [branchA, branchVariation, branch2][index] &&
        typeof response.mappedCommit === "string",
    ),
    JSON.stringify(baselineCommits),
  );

  /**
   * The browser asks to watch one of the projects it was told about, and is
   * answered with a hello for it on its own socket. Every project list read
   * below comes off one of these: the list is recomputed for every greeting.
   */
  const watch = async (projectId, label) => {
    const at = frames.length;
    socket.send(JSON.stringify({ type: "select_project", projectId }));
    return waitFor(label, () => frames.slice(at).find((f) => f.type === "hello" && f.projectId === projectId), 30_000);
  };

  // --- a session reports in -------------------------------------------------
  // Nothing above started it and nothing below tells it what to do: it dialed
  // the link from inside the main worktree, and that is the whole of how Shape
  // learns it is there.
  const mainAt = frames.length;
  const mainSession = startSession({ worktree: target, port: PORT, holdMs: 1200 });
  sessions.push(mainSession);
  const named = await waitFor("session_started for the harness that greeted", () =>
    frames.slice(mainAt).find((f) => f.type === "session_started" && f.worktree === branchA && f.backend.id === "omp"),
  );
  check(
    "a harness that greets the link becomes a named session of the variation it runs in",
    named.backend.label === "omp" && typeof named.session.sessionId === "string" &&
      named.session.sessionId.startsWith("fake-tui-") && named.session.model?.id === "fake-1",
    JSON.stringify(named),
  );
  check(
    "what Shape can do with an observed session: read it, and reach its terminal only if herdr is there",
    named.backend.capabilities.steerMidTurn === false &&
      named.backend.capabilities.hostTool === true &&
      named.backend.capabilities.events === "native" &&
      named.backend.capabilities.resume === false &&
      named.backend.capabilities.terminal === "none",
    JSON.stringify(named.backend.capabilities),
  );
  const unnamed = frames
    .slice(mainAt, frames.indexOf(named))
    .find((f) => f.type === "session_started" && f.worktree === branchA);
  check(
    "a session is on the canvas before it has a name: a caller on the link is already one",
    unnamed?.backend.id === "unknown" && unnamed.backend.label === "agent" &&
      unnamed.backend.capabilities.events === "hooks",
    JSON.stringify(unnamed?.backend ?? null),
  );
  const oneRunning = await waitFor("a session frame listing the one running harness", () =>
    frames
      .slice(mainAt)
      .find(
        (f) =>
          f.type === "session" && f.session.sessions.length === 1 &&
          f.session.sessions[0].backend.id === "omp",
      ),
  );
  check(
    "the project's public session facts name the branch the harness runs on",
    oneRunning.session.sessions[0].worktree === branchA && oneRunning.session.sessions[0].backend.id === "omp",
    JSON.stringify(oneRunning.session.sessions.map((s) => `${s.worktree}:${s.backend.id}`)),
  );

  const withSession = await watch(projectKeyOf(target), "hello while the harness is running");
  check(
    "a harness reporting in is the project's one live session, on the count the switcher shows",
    withSession.projects.find((p) => p.projectId === projectKeyOf(target)).liveSessions === 1,
    JSON.stringify(withSession.projects.map((p) => `${p.label}:${p.liveSessions}`)),
  );

  // --- one turn, typed at the harness's own pane ----------------------------
  const turnAt = frames.length;
  mainSession.type("build me an auth service");

  await waitFor("agent:streaming", () =>
    frames.slice(turnAt).find((f) => f.type === "agent" && f.worktree === branchA && f.state === "streaming"),
  );
  check("agent -> streaming", true);

  const live = await waitFor("the live line while the harness is writing", () =>
    frames.slice(turnAt).find((f) => f.type === "now" && f.worktree === branchA && f.text !== null),
  );
  check(
    "the message being written arrives as a folded live line, tail only",
    live.text.length <= 120 && live.text.startsWith("ack: build me an auth service"),
    JSON.stringify(live.text),
  );

  const assistant = await waitFor("assistant transcript", () =>
    frames.slice(turnAt).find((f) => f.type === "transcript" && f.role === "assistant" && f.text.startsWith("ack: ")),
  );
  check(
    "assistant transcript coalesced on the whole message",
    assistant.text === "ack: build me an auth service — sketching the canvas.",
    JSON.stringify(assistant.text),
  );
  check(
    "the file the harness opened is a transcript line of its own",
    frames
      .slice(turnAt)
      .some((f) => f.type === "transcript" && f.role === "tool" && f.text === "write packages/auth/src/index.ts"),
  );

  const graph = await waitFor("graph with the new stub nodes", () =>
    frames.slice(turnAt).find((f) => f.type === "graph" && f.worktree === branchA && f.graph.nodes.some((n) => n.id === "user-db")),
  );
  const ids = graph.graph.nodes.map((n) => n.id).sort();
  check("graph broadcast contains the stub nodes", ids.join(",") === "auth-service,user-db", ids.join(","));
  check(
    "graph broadcast contains the stub edge",
    graph.graph.edges.map((e) => e.id).join(",") === "auth-service--user-db",
    graph.graph.edges.map((e) => e.id).join(","),
  );
  check(
    "the canvas call is a transcript line the reader can see",
    frames
      .slice(turnAt)
      .some((f) => f.type === "transcript" && f.role === "tool" && f.text === "canvas: initial decomposition"),
  );

  const applied = await waitFor("the canvas receipt the harness got back", () =>
    ompFrames(mainSession.log).find((f) => f.type === "canvas_result" && f.__dir === "in"),
  );
  check(
    "a canvas call is answered on the caller's own link, with what landed",
    applied.text.startsWith("applied 3 op(s);") && applied.isError === false &&
      graph.graph.nodes.find((n) => n.id === "user-db")?.codeRefs === undefined,
    applied.text.split("\n")[0],
  );

  const activity = await waitFor("activity from the canvas call", () =>
    frames.slice(turnAt).find((f) => f.type === "activity" && f.nodeIds.includes("user-db")),
  );
  check(
    "a canvas call lights exactly the bubbles it wrote",
    activity.nodeIds.slice().sort().join(",") === "auth-service,user-db",
    activity.nodeIds.join(","),
  );

  await waitFor("activity cleared on turn_end", () =>
    frames.slice(frames.indexOf(activity) + 1).find((f) => f.type === "activity" && f.worktree === branchA && f.nodeIds.length === 0),
  );
  check("activity cleared on turn_end", true);
  await waitFor("the live line cleared at the end of the turn", () => {
    const last = frames.slice(turnAt).filter((f) => f.type === "now" && f.worktree === branchA).at(-1);
    return last !== undefined && last.text === null ? last : null;
  }, 20_000);
  check("a turn that ends leaves nothing being said", true);
  await waitFor("agent:idle after the turn", () =>
    frames.slice(turnAt).find((f) => f.type === "agent" && f.worktree === branchA && f.state === "idle"),
  );
  const spoken = frames.slice(turnAt).filter((f) => f.type === "transcript" && f.worktree === branchA && f.role === "assistant");
  check(
    "a delta is never a transcript line: the whole message of record is, once",
    spoken.length === 1,
    `${spoken.length} assistant line(s): ${JSON.stringify(spoken.map((f) => f.text.slice(0, 40)))}`,
  );

  // --- structured repair receipts, over the real wire -----------------------
  const badAt = frames.length;
  mainSession.type("bad-op probe");
  const badResult = await waitFor("bad-op canvas result", () =>
    ompFrames(mainSession.log).find((f) => f.type === "canvas_result" && f.text.includes("op/unknown-parent")),
  );
  const badText = badResult.text;
  check("receipts keep the one-line human summary first", badText.startsWith("applied 0 op(s);"), badText.split("\n")[0]);
  check("all-rejected batch is an error result", badResult.isError === true);
  const badReceipts = receipts(badText).rejections;
  const orphan = badReceipts.find((r) => r.code === "op/unknown-parent");
  check(
    "unknown-parent receipt: annotated subject + evidence + fixes",
    orphan?.index === 0 && orphan.subject.path === "/ops/0/node/parentId" && orphan.subject.id === "orphan" &&
      orphan.evidence.parentId === "no-such-parent" && Array.isArray(orphan.evidence.knownNodeIds) &&
      orphan.supportedFixes.length >= 1 && orphan.severity === "error",
    JSON.stringify(orphan),
  );
  const wirePhase = badReceipts.find((r) => r.code === "op/bad-phase");
  check(
    "bad-phase receipt names the live node it was aimed at",
    wirePhase?.index === 1 && wirePhase.subject.id === "auth-service" && wirePhase.subject.label === "Auth Service",
    JSON.stringify(wirePhase),
  );
  const unknownOp = badReceipts.find((r) => r.code === "op/unknown-op");
  check(
    "unknown-op receipt lists the supported ops as a fix",
    unknownOp?.index === 2 && unknownOp.supportedFixes.some((f) => f.includes("upsert_node")),
    JSON.stringify(unknownOp),
  );
  check(
    "an all-rejected batch did not bump rev",
    !frames.slice(badAt).some((f) => f.type === "graph" && f.worktree === branchA && f.graph.rev > graph.graph.rev),
  );
  await waitFor("agent:idle after the bad-op turn", () =>
    frames.slice(badAt).find((f) => f.type === "agent" && f.worktree === branchA && f.state === "idle"),
  );

  // --- persistence ----------------------------------------------------------
  const persisted = await waitFor(
    "the project's graph in the bridge's database",
    () => {
      const doc = storedGraph(target);
      return doc !== null && doc.nodes.length === 2 ? doc : null;
    },
  );
  check(
    "the graph is persisted as one row of the bridge's database",
    persisted.rev >= 1 && persisted.nodes.length === 2 && persisted.edges.length === 1,
    `rev=${persisted.rev} nodes=${persisted.nodes.length} edges=${persisted.edges.length}`,
  );

  // --- revision snapshots + diff --------------------------------------------
  const snapshots = await waitFor("revision snapshots in the database", () => {
    const found = storedRevisions(target);
    return found.length >= 2 ? found : null;
  });
  const revs = snapshots.map((snapshot) => snapshot.rev);
  const snapshotAt = (rev) => snapshots.find((snapshot) => snapshot.rev === rev);

  check(
    "one snapshot row per revision, keyed by project and public branch",
    revs.length >= 2 && revs[revs.length - 1] === persisted.rev,
    `revs=${revs.join(",")} docRev=${persisted.rev}`,
  );
  const first = revs[0];
  const last = revs[revs.length - 1];
  const opening = snapshotAt(first);
  check(
    "the oldest snapshot is an empty canvas before the real changes",
    opening.nodes.length === 0 &&
      opening.edges.length === 0 &&
      typeof opening.at === "string" &&
      first < last &&
      (persisted.nodes.length > 0 || persisted.edges.length > 0),
    `first=${first} last=${last} opening=${opening.nodes.length}/${opening.edges.length} final=${persisted.nodes.length}/${persisted.edges.length}`,
  );
  check(
    "hello carries a revision list per public branch",
    hello.revisions[branchA].every((r) => typeof r.rev === "number" && typeof r.at === "string"),
    JSON.stringify(hello.revisions[branchA]),
  );
  const revList = await waitFor("revisions broadcast after a snapshot", () =>
    frames.find((f) => f.type === "revisions" && f.worktree === branchA && f.revisions.length >= 2),
  );
  check(
    "a new snapshot broadcasts an ascending revision list",
    revList.revisions.every((r, i, all) => i === 0 || all[i - 1].rev < r.rev),
    JSON.stringify(revList.revisions.map((r) => r.rev)),
  );

  const finalNodeIds = persisted.nodes.map((n) => n.id).sort().join(",");
  const finalEdgeIds = persisted.edges.map((e) => e.id).sort().join(",");
  socket.send(JSON.stringify({ type: "diff", worktree: branchA, revA: first, revB: last }));
  const delta = await waitFor("delta frame", () =>
    frames.find((f) => f.type === "delta" && f.delta.revA === first && f.delta.revB === last),
  );
  check(
    "diff over the whole history reports every node and edge as added",
    delta.delta.nodes.added.map((n) => n.id).sort().join(",") === finalNodeIds &&
      delta.delta.edges.added.map((e) => e.id).sort().join(",") === finalEdgeIds &&
      delta.delta.nodes.removed.length === 0 &&
      delta.delta.nodes.changed.length === 0 &&
      delta.delta.edges.removed.length === 0 &&
      delta.delta.edges.changed.length === 0,
    JSON.stringify({
      added: delta.delta.nodes.added.map((n) => n.id),
      edges: delta.delta.edges.added.map((e) => e.id),
      changed: delta.delta.nodes.changed.length,
      removed: delta.delta.nodes.removed.length,
    }),
  );

  socket.send(JSON.stringify({ type: "diff", worktree: branchA, revA: last, revB: first }));
  const reversed = await waitFor("delta for the reversed pair", () =>
    frames.find((f) => f.type === "delta" && f.delta.revA === last && f.delta.revB === first),
  );
  check(
    "reversing the pair reports the same nodes and edges as removed",
    reversed.delta.nodes.removed.map((n) => n.id).sort().join(",") === finalNodeIds &&
      reversed.delta.edges.removed.map((e) => e.id).sort().join(",") === finalEdgeIds &&
      reversed.delta.nodes.added.length === 0 &&
      reversed.delta.edges.added.length === 0,
    JSON.stringify(reversed.delta.nodes.removed.map((n) => n.id)),
  );

  socket.send(JSON.stringify({ type: "diff", worktree: branchA, revA: first, revB: 9999 }));
  const badDiff = await waitFor("bogus diff refused", () =>
    frames.find((f) => f.type === "error" && f.message.startsWith("unknown revision")),
  );
  check("diff against a nonexistent revision is refused", badDiff.message === "unknown revision 9999", badDiff.message);

  // --- the one thing the browser may still ask Shape to do ------------------
  // And the reasons it is refused: there is no herdr on this machine, so no
  // session has a terminal Shape can reach at all.
  const focusAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: branchA }));
  const noTerminal = await waitFor("the reason a terminal cannot be reached", () =>
    frames.slice(focusAt).find((f) => f.type === "error"),
  );
  check(
    "a session on a machine with no herdr has no terminal to go to, and the browser is told why",
    noTerminal.message === `there is no terminal to go to on ${mainEntry.branch}`,
    noTerminal.message,
  );
  const idleFocusAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: branchVariation }));
  const nothingRunning = await waitFor("the reason a variation has no terminal", () =>
    frames.slice(idleFocusAt).find((f) => f.type === "error"),
  );
  check(
    "a variation nothing is reporting in from has no session to go to",
    nothingRunning.message === "nothing is reporting in from variation",
    nothingRunning.message,
  );
  const strangeAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: "/tmp/not-a-variation" }));
  const strange = await waitFor("a frame about a worktree of another project", () =>
    frames.slice(strangeAt).find((f) => f.type === "error"),
  );
  check(
    "a frame about a directory that is not a variation of this project is refused",
    strange.message === "/tmp/not-a-variation is not a variation of this project",
    strange.message,
  );

  // --- several variations at once, on one canvas ----------------------------
  // A second session, in another worktree of the same repo. One project, one
  // view, with browser state keyed by public branch.
  const secondAt = frames.length;
  const varSession = startSession({ worktree, port: PORT, holdMs: 1200 });
  sessions.push(varSession);
  await waitFor("session_started for the second variation", () =>
    frames.slice(secondAt).find((f) => f.type === "session_started" && f.worktree === branchVariation && f.backend.id === "omp"),
  );
  const bothSessions = await waitFor("a session frame listing both harnesses", () =>
    frames.slice(secondAt).find((f) => f.type === "session" && f.session.sessions.length === 2),
  );
  check(
    "one project shows one public session per branch that has one",
    bothSessions.session.sessions.map((s) => s.worktree).sort().join(",") === [branchA, branchVariation].sort().join(","),
    JSON.stringify(bothSessions.session.sessions.map((s) => s.worktree)),
  );

  const varTurnAt = frames.length;
  varSession.type("shape the variation");
  const varGraph = await waitFor("a graph frame for the variation", () =>
    frames.slice(varTurnAt).find((f) => f.type === "graph" && f.worktree === branchVariation && f.graph.nodes.some((n) => n.id === "auth-service")),
  );
  check(
    "what a session draws lands on ITS canvas and on no other",
    varGraph.worktree === branchVariation &&
      !frames.slice(varTurnAt).some((f) => f.type === "graph" && f.worktree !== branchVariation),
    JSON.stringify([...new Set(frames.slice(varTurnAt).filter((f) => f.type === "graph").map((f) => f.worktree))]),
  );
  const varStored = await waitFor("the variation's own graph row", () => storedGraph(target, branchVariation));
  check(
    "one project, one key, a canvas row per branch",
    varStored.nodes.some((n) => n.id === "auth-service") &&
      storedGraph(target, branchA).nodes.length === 2 &&
      (storedGraph(target, branch2)?.nodes.length ?? 0) === 0,
    JSON.stringify({
      variation: varStored.nodes.length,
      main: storedGraph(target, branchA).nodes.length,
      untouched: storedGraph(target, branch2)?.nodes.length ?? 0,
    }),
  );
  await waitFor("the variation's turn to end", () =>
    frames.slice(varTurnAt).find((f) => f.type === "agent" && f.worktree === branchVariation && f.state === "idle"),
  );

  // --- where a link caller runs is which canvas it writes -------------------
  // A tool started deeper inside a variation reports the directory it runs in,
  // and that is what places its writes. It never greeted, so Shape knows it
  // only through what reaches the link — which is a session all the same.
  const linkUrl = `ws://127.0.0.1:${PORT}/link`;
  const wt2LinkFrames = [];
  const wt2LinkAt = frames.length;
  const wt2Link = await openSocket(linkUrl, wt2LinkFrames);
  wt2Link.send(
    JSON.stringify({
      type: "canvas_call",
      // a subdirectory of the variation, as a tool launched deeper in it would report
      cwd: join(worktree2, "packages", "auth"),
      id: "smoke-wt2-link",
      args: {
        ops: [
          {
            op: "upsert_node",
            node: {
              id: "second-only",
              parentId: null,
              label: "Second only",
              summary: "Written by a tool running inside the second variation.",
              phase: "idea",
            },
          },
        ],
        note: "from inside the second variation",
      },
    }),
  );
  const wt2LinkResult = await waitFor("canvas_result for the in-variation link call", () =>
    wt2LinkFrames.find((f) => f.type === "canvas_result" && f.id === "smoke-wt2-link"),
  );
  check(
    "canvas_call is answered on the calling socket, correlated by id",
    wt2LinkResult.isError === false && wt2LinkResult.text.startsWith("applied 1 op(s);"),
    wt2LinkResult.text.split("\n")[0],
  );
  const wt2LinkGraph = await waitFor("graph broadcast for the in-variation link call", () =>
    frames.slice(wt2LinkAt).find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "second-only")),
  );
  check(
    "where the caller runs is which canvas it writes: the second variation's",
    wt2LinkGraph.worktree === branch2 && !frames.slice(wt2LinkAt).some((f) => f.type === "graph" && f.worktree === branchA),
    wt2LinkGraph.worktree,
  );
  // announced twice: once as a directory somebody is working in, and again the
  // moment the call itself proves the canvas tool is really registered there
  const overheard = frames
    .slice(wt2LinkAt)
    .find((f) => f.type === "session_started" && f.worktree === branch2 && f.backend.capabilities.hostTool);
  check(
    "a tool call is proof a session is there: it is drawn as one, known only through the link",
    overheard?.backend.id === "unknown" && overheard.backend.label === "agent" &&
      overheard.backend.capabilities.events === "hooks",
    JSON.stringify(overheard?.backend ?? null),
  );
  check(
    "a canvas result never reaches a socket that did not ask for it",
    !frames.some((f) => f.type === "canvas_result"),
    JSON.stringify(frames.filter((f) => f.type === "canvas_result")),
  );

  // --- what the picture says the code did since -----------------------------
  // Drift is computed from the canvas against the code, and it is SHOWN, never
  // asked about: two bubbles that between them cover both packages, with no
  // edge declared, and a HEAD that has moved.
  const driftAt = frames.length;
  wt2Link.send(
    JSON.stringify({
      type: "canvas_call",
      cwd: wtVariation,
      id: "smoke-drift-1",
      args: {
        ops: [
          {
            op: "upsert_node",
            node: {
              id: "deep-db",
              parentId: null,
              label: "Deep DB",
              summary: "Keeps the user records the rest of it reads.",
              phase: "built",
              codeRefs: ["packages/db"],
            },
          },
        ],
        note: "the other half of the code",
      },
    }),
  );
  await waitFor("the second bubble on the variation's canvas", () =>
    frames.slice(driftAt).find((f) => f.type === "graph" && f.worktree === branchVariation && f.graph.nodes.some((n) => n.id === "deep-db")),
  );
  execFileSync(
    "git",
    ["-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "--allow-empty", "-m", "moved"],
    { cwd: worktree, stdio: "ignore" },
  );
  const movedAt = frames.length;
  varSession.type("plain probe");
  const drifted = await waitFor(
    "the graph the reality refresh left behind",
    () =>
      frames
        .slice(movedAt)
        .find((f) => f.type === "graph" && f.worktree === branchVariation && (f.graph.drift?.["auth-service"] ?? []).length > 0),
    30_000,
  );
  check(
    "a turn that ends on a moved HEAD re-reads the code, and the gap shows up as drift",
    drifted.graph.drift["auth-service"].some((note) => note.includes("no edge is declared")) &&
      drifted.graph.reality.head !== hello.graphs[branchVariation].reality.head,
    JSON.stringify(drifted.graph.drift),
  );
  check(
    "and nothing was asked of the session about it: drift is shown, never prompted",
    ompFrames(varSession.log).every((f) => f.__dir !== "in" || f.type === "canvas_result"),
    JSON.stringify([...new Set(ompFrames(varSession.log).filter((f) => f.__dir === "in").map((f) => f.type))]),
  );
  await waitFor("the drift turn to end", () =>
    frames.slice(movedAt).find((f) => f.type === "agent" && f.worktree === branchVariation && f.state === "idle"),
  );

  // --- the link is a boundary like the browser is ---------------------------
  const linkFrames = [];
  const linkAt = frames.length;
  const linkSocket = await openSocket(linkUrl, linkFrames);
  linkSocket.send(
    JSON.stringify({
      type: "agent_event",
      cwd: wtVariation,
      event: {
        kind: "tool_start",
        name: "Edit",
        paths: ["packages/auth/src/index.ts"],
        summary: "packages/auth/src/index.ts",
      },
    }),
  );
  const linkActivity = await waitFor("activity from an external tool_start", () =>
    frames.slice(linkAt).find((f) => f.type === "activity" && f.worktree === branchVariation && f.nodeIds.length > 0),
  );
  check(
    "an external tool_start maps its paths onto the codeRefs node",
    linkActivity.nodeIds.join(",") === "auth-service",
    linkActivity.nodeIds.join(","),
  );
  linkSocket.send(
    JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "text", text: "the link is speaking" } }),
  );
  await waitFor("transcript from an external text event", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant" && f.text === "the link is speaking"),
  );
  check("an external text event lands in the transcript", true);
  const externalEndAt = frames.length;
  linkSocket.send(JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "turn_end" } }));
  await waitFor("activity cleared by an external turn_end", () =>
    frames.slice(externalEndAt).find((f) => f.type === "activity" && f.worktree === branchVariation && f.nodeIds.length === 0),
  );
  check("an external turn_end ends the turn's activity", true);

  linkSocket.send(
    JSON.stringify({
      type: "agent_event",
      cwd: wtVariation,
      event: { kind: "session", sessionId: "link-session-1", model: { provider: "anthropic", id: "claude-x" } },
    }),
  );
  const probeFrames = [];
  const sessionProbe = await openSocket(`ws://127.0.0.1:${PORT}/ws`, probeFrames);
  const probeHello = await waitFor("hello for the session probe", () =>
    probeFrames.find(
      (f) =>
        f.type === "hello" &&
        f.session.sessions.some((sess) => sess.worktree === branchVariation && sess.session.sessionId === "link-session-1"),
    ),
  );
  const probeSession = probeHello.session.sessions.find((sess) => sess.worktree === branchVariation);
  check(
    "a session id and model reported on the link become the session of the variation it runs in",
    probeSession.session.model?.id === "claude-x",
    JSON.stringify({ worktree: probeSession.worktree, session: probeSession.session }),
  );
  check(
    "and a browser joining late is greeted with every branch's effective state",
    probeHello.agents[branchVariation] === "idle" && probeHello.agents[branchA] === "idle" &&
      Object.keys(probeHello.graphs).sort().join(",") === [branchA, branchVariation, branch2].sort().join(","),
    JSON.stringify({ agents: probeHello.agents, graphs: Object.keys(probeHello.graphs) }),
  );
  sessionProbe.close();

  linkSocket.send(JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "not-an-event" } }));
  const badEvent = await waitFor("unknown event kind refused", () => linkFrames.find((f) => f.type === "error"));
  check(
    "an unknown agent_event kind is refused at the boundary",
    badEvent.message === "unparseable client message",
    badEvent.message,
  );
  linkSocket.send(
    JSON.stringify({
      type: "agent_event",
      cwd: wtVariation,
      event: { kind: "tool_start", name: "Edit", paths: "packages/auth", summary: "" },
    }),
  );
  linkSocket.send(JSON.stringify({ type: "canvas_call", cwd: wtVariation, args: { ops: [] } }));
  await waitFor("mistyped link frames refused", () => linkFrames.filter((f) => f.type === "error").length >= 3);
  check("a mistyped event field and an id-less canvas_call are both refused", true);

  // --- the canvas tool as an MCP server, end to end -------------------------
  // Resolved from the link package, not this one: the sdk is its dependency.
  const linkPkg = join(process.cwd(), "..", "link");
  const linkRequire = createRequire(join(linkPkg, "package.json"));
  const { Client } = await import(
    pathToFileURL(linkRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(linkRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
  );
  const mcpClient = new Client({ name: "shape-smoke", version: "0.0.1" });
  await mcpClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(linkPkg, "src", "mcp.ts")],
      // the harness starts its MCP server where it is working, and that cwd is
      // what places every call it makes: this one is in the variation
      cwd: worktree,
      env: { ...process.env, SHAPE_BRIDGE_URL: linkUrl },
      stderr: "inherit",
    }),
  );
  const listed = await mcpClient.listTools();
  check(
    "the MCP server exposes exactly the canvas tool, with the canvas schema",
    listed.tools.length === 1 && listed.tools[0].name === "canvas" &&
      listed.tools[0].inputSchema.required.join(",") === "ops",
    JSON.stringify(listed.tools.map((t) => t.name)),
  );
  check(
    "the MCP tool carries the bridge's own tool description",
    listed.tools[0].description.includes("PLAIN ENGLISH, NO JARGON:"),
    listed.tools[0].description.slice(0, 60),
  );
  const mcpCall = await mcpClient.callTool({
    name: "canvas",
    arguments: {
      ops: [
        {
          op: "upsert_node",
          node: {
            id: "mcp-linked",
            parentId: null,
            label: "Through MCP",
            summary: "Arrived on the canvas through the MCP server.",
            phase: "idea",
          },
        },
      ],
      note: "via mcp",
    },
  });
  check(
    "a canvas call over MCP is applied and answered to the caller",
    mcpCall.isError !== true && mcpCall.content[0].text.startsWith("applied 1 op(s);"),
    JSON.stringify(mcpCall.content),
  );
  await waitFor("graph gained the node the MCP client asked for", () =>
    frames.find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "mcp-linked")),
  );
  check("an MCP tool call reaches the canvas the browser is watching", true);
  await mcpClient.close();

  // --- harness hooks as the events channel ----------------------------------
  const transcriptPath = join(fakeHome, "hook-transcript.jsonl");
  await writeFile(
    transcriptPath,
    `${[
      { type: "user", message: { role: "user", content: "make the login part quicker" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Tightened how the login part checks passwords." }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );

  const runHook = async (payload) => {
    const child = spawn(process.execPath, [join(linkPkg, "src", "hook.ts")], {
      env: { ...process.env, SHAPE_BRIDGE_URL: linkUrl },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let hookErr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      hookErr += d;
    });
    child.stdin.end(JSON.stringify(payload));
    const exited = Promise.withResolvers();
    child.once("exit", (code) => exited.resolve(code));
    return { code: await exited.promise, stderr: hookErr };
  };

  const clearedAt = frames.length;
  const preToolHook = await runHook({
    hook_event_name: "PreToolUse",
    session_id: "link-session-1",
    cwd: worktree,
    tool_name: "Edit",
    tool_input: { file_path: "packages/auth/src/login.ts", old_string: "slow", new_string: "fast" },
  });
  check(
    "the hook exits 0 and stays silent, whatever the harness asked",
    preToolHook.code === 0 && preToolHook.stderr === "",
    `code=${preToolHook.code} stderr=${preToolHook.stderr.slice(0, 200)}`,
  );
  const hookActivity = await waitFor("activity from a PreToolUse hook", () =>
    frames.slice(clearedAt).find((f) => f.type === "activity" && f.worktree === branchVariation && f.nodeIds.includes("auth-service")),
  );
  check(
    "a harness hook lights up the bubble whose code the tool touched",
    hookActivity.nodeIds.includes("auth-service"),
    hookActivity.nodeIds.join(","),
  );

  // the session is idle at this point, so "back to idle" is only observable
  // after a prompt-submit hook has marked it streaming
  const promptAt = frames.length;
  const promptHook = await runHook({
    hook_event_name: "UserPromptSubmit",
    session_id: "link-session-1",
    cwd: worktree,
    prompt: "make the login part quicker",
  });
  check("the UserPromptSubmit hook exits 0", promptHook.code === 0, `code=${promptHook.code}`);
  await waitFor("streaming from the UserPromptSubmit hook", () =>
    frames.slice(promptAt).find((f) => f.type === "agent" && f.worktree === branchVariation && f.state === "streaming"),
  );
  check("a prompt-submit hook marks the session streaming", true);

  const stopAt = frames.length;
  const stopHook = await runHook({
    hook_event_name: "Stop",
    session_id: "link-session-1",
    transcript_path: transcriptPath,
    cwd: worktree,
  });
  check("the Stop hook exits 0", stopHook.code === 0, `code=${stopHook.code}`);
  await waitFor("transcript from the Stop hook", () =>
    frames.find(
      (f) => f.type === "transcript" && f.role === "assistant" &&
        f.text === "Tightened how the login part checks passwords.",
    ),
  );
  check("the Stop hook reports the last assistant message from the transcript file", true);
  await waitFor("turn end from the Stop hook", () =>
    frames.slice(stopAt).find((f) => f.type === "activity" && f.worktree === branchVariation && f.nodeIds.length === 0),
  );
  await waitFor("idle from the Stop hook", () =>
    frames.slice(stopAt).find((f) => f.type === "agent" && f.worktree === branchVariation && f.state === "idle"),
  );
  check("the Stop hook clears activity and returns the session to idle", true);
  linkSocket.close();
  wt2Link.close();

  // --- a session that goes away ---------------------------------------------
  const stopSessionAt = frames.length;
  await mainSession.stop();
  const stopped = await waitFor("session_stopped for the harness that was closed", () =>
    frames.slice(stopSessionAt).find((f) => f.type === "session_stopped" && f.worktree === branchA),
  );
  check(
    "a harness that says goodbye takes its session off the canvas, and says why",
    stopped.reason === "terminated",
    stopped.reason,
  );
  const leftRunning = await waitFor("a session frame without the closed harness", () =>
    frames
      .slice(stopSessionAt)
      .find((f) => f.type === "session" && !f.session.sessions.some((s) => s.worktree === branchA)),
  );
  check(
    "the branch stays on the view with its canvas; only its session is gone",
    leftRunning.session.sessions.some((s) => s.worktree === branchVariation) &&
      leftRunning.session.worktrees.some((w) => w.id === wtA),
    JSON.stringify(leftRunning.session.sessions.map((s) => s.worktree)),
  );

  // --- the room writes nothing onto a canvas it was not asked to map --------
  check(
    "a project whose canvas the room never seeded has no audit line at all",
    (dbRows("SELECT entry FROM audit WHERE tenant = ? AND key = ?", "local", projectKeyOf(target)) ?? []).length === 0,
    JSON.stringify(dbRows("SELECT entry FROM audit WHERE tenant = ? AND key = ?", "local", projectKeyOf(target))),
  );

  // --- another repo reports in: a project enters the registry ---------------
  // Nothing opens it. A harness dials the link from inside a repo no active
  // project contains, is refused, and is hung up on the moment that project
  // exists — its own re-dial is what gets it a session.
  const bKey = projectKeyOf(targetB);
  const bAt = frames.length;
  const bSession = startSession({ worktree: targetB, port: PORT });
  sessions.push(bSession);
  const refusal = await waitFor("the refusal the caller in the second repo heard", () =>
    ompFrames(bSession.log).find((f) => f.__dir === "in" && f.type === "error"),
  );
  check(
    "a caller no active project contains is refused, and told which directory nothing claims",
    refusal.message === `no active project contains ${wtB}`,
    refusal.message,
  );
  const bothActive = await waitFor(
    "the project list with the second repo on it",
    () =>
      frames.slice(bAt).find(
        (f) =>
          f.type === "projects" && f.projects.length === 2 && f.projects.every((p) => p.status === "active") &&
          f.projects.find((p) => p.projectId === bKey)?.liveSessions === 1,
      ),
    30_000,
  );
  check(
    "the repo it dialed from becomes a project of its own, active, with that session live in it",
    bothActive.projects.find((p) => p.projectId === bKey).cwd === wtB &&
      bothActive.projects.some((p) => p.projectId === projectKeyOf(target)),
    JSON.stringify(bothActive.projects.map((p) => `${p.label}:${p.status}:${p.liveSessions}`)),
  );
  const redialled = await waitFor(
    "the caller hung up on, dialling again",
    () => {
      const said = ompFrames(bSession.log);
      const greetings = said.filter((f) => f.type === "hello" && f.__dir === "out");
      return said.some((f) => f.type === "__closed") && greetings.length >= 2 ? greetings : null;
    },
    30_000,
  );
  check(
    "hanging up is the whole of it: the client re-dials by itself and greets again",
    redialled.length === 2,
    JSON.stringify(ompFrames(bSession.log).filter((f) => f.type === "__closed" || f.type === "hello").map((f) => f.type)),
  );

  const helloB = await watch(bKey, "hello for the second project");
  check(
    "watching it answers this browser with that project alone: its physical cwd and public branch canvas",
    helloB.session.cwd === wtB && Object.keys(helloB.graphs).join(",") === branchB,
    JSON.stringify({ cwd: helloB.session.cwd, graphs: Object.keys(helloB.graphs) }),
  );
  const placed = await waitFor("the re-greeted session on the second project's canvas", () =>
    helloB.session.sessions.find((s) => s.worktree === branchB && s.backend.id === "omp") ??
      frames
        .slice(frames.indexOf(helloB))
        .flatMap((f) => (f.type === "session" ? f.session.sessions : [])).find((s) => s.worktree === branchB && s.backend.id === "omp"),
  );
  const repositoryB = await describeRepository(targetB);
  const mapStateB = await requestControl(PORT, "baseline-read-second-project", {
    type: "map_read",
    repository: repositoryB,
    branch: branchB,
  });
  const commitB = execFileSync("git", ["rev-parse", branchB], { cwd: targetB, encoding: "utf8" }).trim();
  const mappedB = await requestControl(PORT, "baseline-commit-second-project", {
    type: "map_commit",
    repository: repositoryB,
    branch: branchB,
    expectedRevision: mapStateB.revision,
    expectedMappedCommit: mapStateB.mappedCommit,
    commit: commitB,
    mode: "initial",
    ops: [],
    reality: helloB.graphs[branchB].reality,
    note: "bridge smoke second-project empty baseline",
  });
  check(
    "the discovered project's branch is explicitly mapped before its live turn",
    mappedB.type === "map_committed" && mappedB.mappedCommit === commitB,
    JSON.stringify(mappedB),
  );
  check(
    "and the caller that was refused is a named session of the project that now claims it",
    placed.session.sessionId.startsWith("fake-tui-"),
    JSON.stringify(placed.session),
  );

  // --- parked: every record kept, nothing running ---------------------------
  const parkedAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: bKey, status: "inactive" }));
  const parked = await waitFor("the list after the second project was parked", () =>
    frames
      .slice(parkedAt)
      .find((f) => f.type === "projects" && f.projects.find((p) => p.projectId === bKey)?.status === "inactive"),
  );
  check(
    "a project marked inactive stays on the list, parked, and the other one is untouched",
    parked.projects.length === 2 && parked.projects.find((p) => p.projectId === projectKeyOf(target)).status === "active",
    JSON.stringify(parked.projects.map((p) => `${p.label}:${p.status}`)),
  );
  const moved = await waitFor("the browser that was watching it, greeted elsewhere", () =>
    frames.slice(parkedAt).find((f) => f.type === "hello" && f.projectId === projectKeyOf(target)),
  );
  check(
    "a browser watching a project that is parked is moved onto the tenant's newest active one",
    moved.session.cwd === wtA,
    moved.session.cwd,
  );
  const refusedAt = frames.length;
  socket.send(JSON.stringify({ type: "select_project", projectId: bKey }));
  const refusedSelect = await waitFor("the parked project refused", () =>
    frames.slice(refusedAt).find((f) => f.type === "error"),
  );
  check(
    "there is nothing to watch in a parked project, and the browser is told exactly that",
    refusedSelect.message === `project ${bKey} is inactive`,
    refusedSelect.message,
  );
  const parkedRow = await waitFor("the parked row in the database", () => {
    const rows = dbRows("SELECT status, status_changed_at FROM projects WHERE tenant = ? AND key = ?", "local", bKey);
    return rows === null || rows.length === 0 || rows[0].status !== "inactive" ? null : rows[0];
  });
  check(
    "the status is stored with the moment it moved: a restart finds the project as it was left",
    parkedRow.status === "inactive" && parkedRow.status_changed_at.length > 0,
    JSON.stringify(parkedRow),
  );
  const unheardAt = ompFrames(bSession.log).length;
  bSession.type("plain probe");
  const unheard = await waitFor("what the session in the parked project hears", () =>
    ompFrames(bSession.log).slice(unheardAt).find((f) => f.__dir === "in" && f.type === "error"),
  );
  check(
    "a session left running in a parked project is refused, and reporting in never revives it",
    unheard.message === `no active project contains ${wtB}` &&
      frames
        .slice(parkedAt)
        .every((f) => f.type !== "projects" || f.projects.find((p) => p.projectId === bKey).status === "inactive"),
    unheard.message,
  );

  // --- and back: the room returns with everything the project had -----------
  const regreetLogAt = ompFrames(bSession.log).length;
  const revivedAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: bKey, status: "active" }));
  const revived = await waitFor("the list after the second project came back", () =>
    frames
      .slice(revivedAt)
      .find((f) => f.type === "projects" && f.projects.find((p) => p.projectId === bKey)?.status === "active"),
  );
  check(
    "marking it active again gives it a room, and the switcher says so",
    revived.projects.length === 2 && revived.projects.every((p) => p.status === "active"),
    JSON.stringify(revived.projects.map((p) => `${p.label}:${p.status}`)),
  );
  const helloBack = await watch(bKey, "hello for the project that came back");
  check(
    "and a browser can watch it again, on the branch canvas it always had",
    helloBack.session.cwd === wtB && Object.keys(helloBack.graphs).join(",") === branchB,
    JSON.stringify({ cwd: helloBack.session.cwd, graphs: Object.keys(helloBack.graphs) }),
  );
  await waitFor(
    "the revived pane to reconnect and re-greet",
    () =>
      ompFrames(bSession.log)
        .slice(regreetLogAt)
        .find((frame) => frame.type === "hello" && frame.__dir === "out"),
    30_000,
  );
  const rejoined = await waitFor(
    "SessionInfo to carry the revived pane's original session",
    () =>
      frames
        .slice(revivedAt)
        .filter((frame) => frame.type === "session")
        .flatMap((frame) => frame.session.sessions)
        .find(
          (session) =>
            session.worktree === branchB &&
            session.session.sessionId === placed.session.sessionId,
        ),
    30_000,
  );
  check(
    "the same pane re-joins the public branch before its next turn",
    rejoined.backend.id === "omp",
    JSON.stringify(rejoined),
  );
  const unknownAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: "no-such-project", status: "inactive" }));
  const unknown = await waitFor("a status change aimed at a project nobody has", () =>
    frames.slice(unknownAt).find((f) => f.type === "error"),
  );
  check(
    "an id this tenant has no row for is unknown, and only the socket that asked hears about it",
    unknown.message === "unknown project no-such-project",
    unknown.message,
  );

  // The pane process survived parking. Its old link did not, so only type
  // after the fresh hello is represented in SessionInfo; that next turn must
  // then reach the browser on the same public branch.
  const spokeAt = frames.length;
  bSession.type("plain probe");
  await waitFor("the revived project's session output", () =>
    frames
      .slice(spokeAt)
      .find((f) => f.type === "transcript" && f.worktree === branchB && f.role === "assistant"),
  );
  const liveAgain = await watch(bKey, "hello for the revived project with its session on it");
  check(
    "the revived caller is a public branch session and restores the live count",
    liveAgain.session.sessions.some((session) => session.worktree === branchB) &&
      liveAgain.projects.find((p) => p.projectId === bKey).liveSessions === 1,
    JSON.stringify({ sessions: liveAgain.session.sessions, projects: liveAgain.projects }),
  );
  const byeAt = frames.length;
  await bSession.stop();
  await waitFor("the goodbye from the pane that closed", () =>
    frames.slice(byeAt).find((f) => f.type === "session_stopped" && f.worktree === branchB),
  );
  const emptied = await watch(bKey, "hello after the second project's pane closed");
  check(
    "a session that says goodbye takes the project's live count back to zero",
    emptied.projects.find((p) => p.projectId === bKey).liveSessions === 0,
    JSON.stringify(emptied.projects.map((p) => `${p.label}:${p.liveSessions}`)),
  );

  // --- a variation added under a running bridge -----------------------------
  // The worktree list is re-detected on every hello, so a variation created
  // just now is on the very next greeting, with a canvas of its own.
  execFileSync("git", ["worktree", "add", "-b", "variation-3", worktree3], { cwd: target, stdio: "ignore" });
  const wt3 = realpathSync(worktree3);
  const helloWt3 = await watch(projectKeyOf(target), "hello after a third variation was added");
  check(
    "a worktree added while the bridge runs appears as physical metadata and a public branch canvas",
    helloWt3.session.worktrees.length === 4 &&
      helloWt3.session.worktrees.some((w) => w.id === wt3 && w.branch === "variation-3") &&
      helloWt3.graphs[branchId("variation-3")] !== undefined,
    JSON.stringify(helloWt3.session.worktrees.map((w) => `${basename(w.path)}@${w.branch}`)),
  );
  await varSession.stop();

  // the file a harness Shape never registered a tool in reads to find the
  // canvas: written under SHAPE_HOME per project, rewritten on every attach
  const { CANVAS_TOOL_DESCRIPTION } = await import(new URL("../../shared/src/index.ts", import.meta.url));
  const directiveFile = join(fakeHome, ".shape", "server", "projects", projectKeyOf(target), "shape-directive.md");
  const directive = await readFile(directiveFile, "utf8");
  check(
    "the project's shape-directive.md names the link, the fallback CLI and the canvas contract verbatim",
    directive.includes(`ws://127.0.0.1:${PORT}/link`) &&
      directive.includes(join("packages", "link", "src", "cli.ts")) &&
      directive.includes(CANVAS_TOOL_DESCRIPTION.split("\n")[0]),
    JSON.stringify(directive.slice(0, 200)),
  );
  check(
    "hello points a launcher at the directive it wrote",
    hello.session.directivePath === directiveFile,
    `${hello.session.directivePath} / ${directiveFile}`,
  );

  // --- a restart: the registry IS the fleet ---------------------------------
  // The same database and no `--cwd` at all. Every row comes back and only the
  // active ones get a room, so the parked project is on the list with nothing
  // to watch in it.
  const parkAgainAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: bKey, status: "inactive" }));
  await waitFor("the second project parked again, before the restart", () =>
    frames
      .slice(parkAgainAt)
      .find((f) => f.type === "projects" && f.projects.find((p) => p.projectId === bKey)?.status === "inactive"),
  );
  socket.close();
  bridge.kill("SIGKILL");
  await sleep(200);
  const restartFrames = [];
  bridge = spawn(process.execPath, ["src/index.ts", "--port", String(PORT), "--db", shapeDb], {
    cwd: process.cwd(),
    env: { ...process.env, SHAPE_HOME: fakeHome, HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let restartErr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    restartErr += d;
    process.stderr.write(`[bridge:again] ${d}`);
  });
  await waitFor("the bridge back up on the same database", () => restartErr.includes("canvas at ws://"), 30_000);
  socket = await openSocket(`ws://127.0.0.1:${PORT}/ws`, restartFrames);
  const helloAgain = await waitFor("hello after the restart", () => restartFrames.find((f) => f.type === "hello"), 30_000);
  check(
    "a bridge started with no target at all comes up on the projects its registry has",
    helloAgain.projects.length === 2 &&
      helloAgain.projects.find((p) => p.projectId === bKey).status === "inactive" &&
      helloAgain.projects.find((p) => p.projectId === projectKeyOf(target)).status === "active" &&
      helloAgain.projectId === projectKeyOf(target),
    JSON.stringify(helloAgain.projects.map((p) => `${p.label}:${p.status}`)),
  );
  check(
    "the canvas the run before drew is the canvas it opens",
    helloAgain.graphs[branchA].nodes.map((n) => n.id).sort().join(",") === "auth-service,user-db",
    JSON.stringify(Object.keys(helloAgain.graphs)),
  );
  const parkedAfterAt = restartFrames.length;
  socket.send(JSON.stringify({ type: "select_project", projectId: bKey }));
  const stillParked = await waitFor("the parked project refused after the restart", () =>
    restartFrames.slice(parkedAfterAt).find((f) => f.type === "error"),
  );
  check(
    "only the active rows got a room back: the parked one has nothing to watch",
    stillParked.message === `project ${bKey} is inactive`,
    stillParked.message,
  );
} catch (err) {
  check("smoke run completed", false, String(err));
} finally {
  for (const session of sessions) await session.stop();
  socket?.close();
  bridge?.kill("SIGKILL");
  await sleep(100);
  await rm(target, { recursive: true, force: true });
  await rm(targetB, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
  await rm(worktree2, { recursive: true, force: true });
  await rm(worktree3, { recursive: true, force: true });
}

// --- retired path-keyed canvas files ----------------------------------------
// A pre-database `.shape/graph.json` has no trustworthy repository+branch
// checkpoint, but its graph and revision history remain valuable. Startup
// adopts them as visible uncommitted effective state, keeps mappedCommit null,
// and quarantines the source files while preserving unrelated configuration.
{
  const legacyTarget = await mkdtemp(join(tmpdir(), "vh-smoke-legacy-"));
  const legacyHome = await mkdtemp(join(tmpdir(), "vh-smoke-legacy-home-"));
  await seedWorkspace(legacyTarget, "lg");
  const legacyDb = join(legacyHome, "shape.db");
  const legacyPort = PORT + 4;
  const legacyFrames = [];
  let legacyBridge = null;
  let legacySocket = null;
  try {
    await mkdir(join(legacyTarget, ".shape", "revisions"), { recursive: true });
    await writeFile(
      join(legacyTarget, ".shape", "graph.json"),
      JSON.stringify({
        rev: 1,
        nodes: [{ id: "old-canvas", parentId: null, label: "Old canvas", summary: "Drawn before the database existed.", phase: "built" }],
        edges: [],
      }),
    );
    await writeFile(
      join(legacyTarget, ".shape", "revisions", "1.json"),
      JSON.stringify({ rev: 1, at: "2020-01-01T00:00:00.000Z", nodes: [], edges: [] }),
    );
    await writeFile(join(legacyTarget, ".shape", "config.json"), "{}\n");

    legacyBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", legacyTarget, "--port", String(legacyPort), "--db", legacyDb],
      {
        cwd: process.cwd(),
        env: { ...process.env, SHAPE_HOME: legacyHome, HOME: legacyHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let legacyErr = "";
    legacyBridge.stderr.setEncoding("utf8");
    legacyBridge.stderr.on("data", (d) => {
      legacyErr += d;
    });
    await waitFor("bridge listening for the project with a canvas on disk", () => legacyErr.includes("canvas at ws://"), 30_000);
    legacySocket = await openSocket(`ws://127.0.0.1:${legacyPort}/ws`, legacyFrames);
    const helloLegacy = await waitFor(
      "hello for the project whose canvas was left by an older Shape",
      () => legacyFrames.find((f) => f.type === "hello"),
      30_000,
    );
    const legacyBranch = helloLegacy.session.branches.find((branch) => branch.id === branchA);
    check(
      "a historical path-keyed graph remains visible without becoming a trusted checkpoint",
      helloLegacy.graphs[branchA].nodes.some((node) => node.id === "old-canvas") &&
        legacyBranch?.mappedCommit === null,
      JSON.stringify({ graph: helloLegacy.graphs[branchA], branch: legacyBranch }),
    );
    check(
      "its revision history retains the original timestamp",
      helloLegacy.revisions[branchA].some((revision) => revision.rev === 1 && revision.at === "2020-01-01T00:00:00.000Z"),
      JSON.stringify(helloLegacy.revisions[branchA]),
    );
    const imported = dbRowsIn(
      legacyDb,
      "SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?",
      "local",
      projectKeyOf(legacyTarget),
      branchA,
    );
    check(
      "the adopted effective graph is stored under the repository and public branch",
      (imported ?? []).length === 1 && JSON.parse(imported[0].doc).nodes.some((node) => node.id === "old-canvas"),
      JSON.stringify(imported),
    );
    check(
      "the files it came from are moved aside, and the project's own config is untouched",
      !existsSync(join(legacyTarget, ".shape", "graph.json")) &&
        !existsSync(join(legacyTarget, ".shape", "revisions")) &&
        existsSync(join(legacyTarget, ".shape", "imported", "graph.json")) &&
        existsSync(join(legacyTarget, ".shape", "imported", "revisions", "1.json")) &&
        existsSync(join(legacyTarget, ".shape", "config.json")),
      String(readdirSync(join(legacyTarget, ".shape"))),
    );
  } catch (err) {
    check("the imported-canvas run completed", false, String(err));
  } finally {
    legacySocket?.close();
    legacyBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(legacyTarget, { recursive: true, force: true });
    await rm(legacyHome, { recursive: true, force: true });
  }
}

// --- a canvas stored under the project key an older Shape derived -----------
// The rows are written before the bridge exists, exactly as the upgrade finds
// them: sha256(machine + the DIRECTORY), which is how a Shape from before
// `repoIdentity` keyed a project. This build keys the same project off its
// repo's common dir, so the first attach has to move them — the canvas the
// user drew is the canvas they get back, and the project is on the list once.
{
  const oldKeyTarget = await mkdtemp(join(tmpdir(), "vh-smoke-oldkey-"));
  const oldKeyHome = await mkdtemp(join(tmpdir(), "vh-smoke-oldkey-home-"));
  await seedWorkspace(oldKeyTarget, "ok");
  const wtOldKey = realpathSync(oldKeyTarget);
  const oldKey = legacyProjectKeyOf(oldKeyTarget);
  const oldKeyNode = { id: "old-key-canvas", parentId: null, label: "Drawn under the old key", summary: "Must survive the upgrade.", phase: "built" };
  const oldKeyDb = join(oldKeyHome, "shape.db");
  const oldKeyPort = PORT + 5;
  const oldKeyFrames = [];
  let oldKeyBridge = null;
  let oldKeySocket = null;
  try {
    const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
    const seeded = openSqliteStorage(oldKeyDb);
    await seeded.saveGraph("local", oldKey, wtOldKey, { rev: 7, nodes: [oldKeyNode], edges: [] });
    await seeded.saveRevision("local", oldKey, wtOldKey, {
      rev: 7,
      at: "2026-01-01T00:00:00.000Z",
      nodes: [oldKeyNode],
      edges: [],
    });
    await seeded.saveProject({
      project: {
        key: oldKey,
        label: basename(oldKeyTarget),
        cwd: wtOldKey,
        backend: null,
        tools: { launcher: null, launchers: [], harnesses: [], directoryPicker: false },
        targetHasCode: true,
        directivePath: null,
        manager: null,
        legacyKeys: {},
        injected: [],
      },
      tenant: "local",
      worktrees: [{ id: wtOldKey, path: wtOldKey, branch: "smoke", head: null }],
      sessions: [],
      liveSessions: 0,
      status: "active",
      statusChangedAt: "2026-01-01T00:00:00.000Z",
      lastSeen: "2026-01-01T00:00:00.000Z",
    });
    seeded.close();

    oldKeyBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", oldKeyTarget, "--port", String(oldKeyPort), "--db", oldKeyDb],
      {
        cwd: process.cwd(),
        env: { ...process.env, SHAPE_HOME: oldKeyHome, HOME: oldKeyHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let oldKeyErr = "";
    oldKeyBridge.stderr.setEncoding("utf8");
    oldKeyBridge.stderr.on("data", (d) => {
      oldKeyErr += d;
    });
    await waitFor("bridge listening for the project stored under the old key", () => oldKeyErr.includes("canvas at ws://"), 30_000);
    oldKeySocket = await openSocket(`ws://127.0.0.1:${oldKeyPort}/ws`, oldKeyFrames);
    const helloOldKey = await waitFor(
      "hello for the project whose canvas was stored under the old project key",
      () => oldKeyFrames.find((f) => f.type === "hello" && f.projectId === projectKeyOf(oldKeyTarget)),
      30_000,
    );
    check(
      "a canvas stored under the previous project key opens as this project's",
      helloOldKey.graphs[branchA].nodes.some((n) => n.id === "old-key-canvas") && helloOldKey.graphs[branchA].rev >= 7,
      JSON.stringify({ nodes: helloOldKey.graphs[branchA].nodes.map((n) => n.id), rev: helloOldKey.graphs[branchA].rev }),
    );
    check(
      "its revisions came with it, timestamps and all",
      helloOldKey.revisions[branchA].some((r) => r.rev === 7 && r.at === "2026-01-01T00:00:00.000Z"),
      JSON.stringify(helloOldKey.revisions[branchA]),
    );
    const adopted = dbRowsIn(
      oldKeyDb,
      "SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?",
      "local",
      projectKeyOf(oldKeyTarget),
      branchA,
    );
    check(
      "the row now lives under the key this build derives from the repo",
      (adopted ?? []).length === 1 && JSON.parse(adopted[0].doc).nodes.some((n) => n.id === "old-key-canvas"),
      JSON.stringify(adopted),
    );
    check(
      "and nothing is left under the old one: one project, one canvas",
      (dbRowsIn(oldKeyDb, "SELECT worktree FROM graphs WHERE tenant = ? AND key = ?", "local", oldKey) ?? []).length === 0 &&
        (dbRowsIn(oldKeyDb, "SELECT key FROM projects WHERE tenant = ? AND key = ?", "local", oldKey) ?? []).length === 0,
      JSON.stringify({
        graphs: dbRowsIn(oldKeyDb, "SELECT worktree FROM graphs WHERE tenant = ? AND key = ?", "local", oldKey),
        projects: dbRowsIn(oldKeyDb, "SELECT key FROM projects WHERE tenant = ? AND key = ?", "local", oldKey),
      }),
    );
    check(
      "the registry says so too: the switcher shows one project, not the same repo twice",
      helloOldKey.projects.length === 1 && helloOldKey.projects[0].projectId === projectKeyOf(oldKeyTarget),
      JSON.stringify(helloOldKey.projects.map((p) => `${p.projectId.slice(0, 6)}:${p.label}:${p.status}`)),
    );
  } catch (err) {
    check("the old-project-key run completed", false, String(err));
  } finally {
    oldKeySocket?.close();
    oldKeyBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(oldKeyTarget, { recursive: true, force: true });
    await rm(oldKeyHome, { recursive: true, force: true });
  }
}

// --- structure down to classes and functions -------------------------------
// Its own project, its own bridge, its own port: the run above tore its target
// down, and the parts of a file only mean anything against a project that has
// them. Three claims are checked end to end — that the parser reads every shape
// a top-level part is written in, that reality reads the parts out of a real
// file, and that touching that file lights the bubble anchored to one of its
// parts.
{
  const { extractSymbols } = await import(new URL("../src/agent/symbols.ts", import.meta.url));

  // the parser alone, on the four shapes a top-level part is written in
  const fixture = [
    "export const handler = async (req) => req;",
    "const helper = function () {};",
    "export class Store {}",
    "function local() {}",
    "",
  ].join("\n");
  const fixtureParts = await extractSymbols(
    "/fixture",
    ["/fixture/src/api.ts"],
    () => "r:fixture",
    async () => fixture,
  );
  check(
    "a const holding an arrow function, a const holding a function expression, a class and a plain function are all parts",
    fixtureParts.map((s) => `${s.name}:${s.kind}:${s.exported}`).join(",") ===
      "handler:function:true,helper:function:false,Store:class:true,local:function:false",
    JSON.stringify(fixtureParts.map((s) => `${s.name}:${s.kind}:${s.exported}`)),
  );

  const symTarget = await mkdtemp(join(tmpdir(), "vh-smoke-sym-"));
  const symHome = await mkdtemp(join(tmpdir(), "vh-smoke-symhome-"));
  await seedWorkspace(symTarget, "sym");
  const partsRel = "packages/auth/src/parts.ts";
  // line numbers below are asserted, so this text is laid out on purpose:
  // Ledger on 5, addExpense on 9, settle on 11, keepInternal on 13, tallied on 15
  await writeFile(
    join(symTarget, partsRel),
    `/**
 * The parts a survey can point at.
 */

export class Ledger {
  total = 0;
}

export const addExpense = (amount: number): number => amount;

export default function settle(): void {}

function keepInternal(): void {}

function tallied(): number {
  return 0;
}

export { tallied };
`,
  );
  const symGit = (...args) => execFileSync("git", args, { cwd: symTarget, stdio: "ignore" });
  symGit("add", "-A");
  symGit("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "parts");

  const symPort = PORT + 1;
  const symFrames = [];
  let symBridge = null;
  let symSocket = null;
  let symLink = null;
  try {
    symBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", symTarget, "--port", String(symPort), "--db", join(symHome, "shape.db")],
      {
        cwd: process.cwd(),
        env: { ...process.env, SHAPE_HOME: symHome, HOME: symHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let symErr = "";
    symBridge.stderr.setEncoding("utf8");
    symBridge.stderr.on("data", (d) => {
      symErr += d;
    });
    await waitFor("bridge listening for the parts project", () => symErr.includes("canvas at ws://"));

    symSocket = await openSocket(`ws://127.0.0.1:${symPort}/ws`, symFrames);
    const symWt = realpathSync(symTarget);
    const symHello = await waitFor("hello for the parts project", () => symFrames.find((f) => f.type === "hello"));

    const reality = symHello.graphs[branchA].reality;
    const parts = reality.symbols.filter((s) => s.file === partsRel);
    const partOf = (name) => parts.find((s) => s.name === name);
    check(
      "reality reads a file's top-level classes and functions",
      parts.map((s) => s.name).join(",") === "Ledger,addExpense,settle,keepInternal,tallied",
      parts.map((s) => s.name).join(","),
    );
    check(
      "an exported class is recorded as a class, on its own line, in its own package",
      partOf("Ledger")?.kind === "class" && partOf("Ledger").exported === true &&
        partOf("Ledger").line === 5 && partOf("Ledger").pkg === "r:@sym/auth" &&
        partOf("Ledger").id === `s:${partsRel}#Ledger`,
      JSON.stringify(partOf("Ledger") ?? null),
    );
    check(
      "a const holding an arrow function is recorded as a function",
      partOf("addExpense")?.kind === "function" && partOf("addExpense").exported === true &&
        partOf("addExpense").line === 9,
      JSON.stringify(partOf("addExpense") ?? null),
    );
    check(
      "a default-exported function is recorded under its own name",
      partOf("settle")?.kind === "function" && partOf("settle").exported === true &&
        partOf("settle").line === 11,
      JSON.stringify(partOf("settle") ?? null),
    );
    check(
      "a function nobody exports is recorded, and says so",
      partOf("keepInternal")?.kind === "function" && partOf("keepInternal").exported === false &&
        partOf("keepInternal").line === 13,
      JSON.stringify(partOf("keepInternal") ?? null),
    );
    check(
      "a function exported by a later export list counts as exported",
      partOf("tallied")?.exported === true && partOf("tallied").line === 15,
      JSON.stringify(partOf("tallied") ?? null),
    );
    check(
      "a const that is not a function is not a part of the code",
      !reality.symbols.some((s) => s.name === "users"),
      JSON.stringify(reality.symbols.filter((s) => s.name === "users")),
    );
    const jsPart = reality.symbols.find((s) => s.file === "packages/db/src/backup.mjs");
    check(
      "a plain JavaScript file is scanned like any other source file",
      jsPart?.name === "backupUsers" && jsPart.kind === "function" && jsPart.exported === true,
      JSON.stringify(jsPart ?? reality.symbols.map((s) => s.file)),
    );

    const { repositoryIdentity: describeSymbolRepository } = await import(new URL("../src/agent/worktrees.ts", import.meta.url));
    const symbolRepository = await describeSymbolRepository(symTarget);
    const symbolMapState = await requestControl(symPort, "symbol-baseline-read", {
      type: "map_read",
      repository: symbolRepository,
      branch: branchA,
    });
    const symbolCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: symTarget, encoding: "utf8" }).trim();
    await requestControl(symPort, "symbol-baseline-commit", {
      type: "map_commit",
      repository: symbolRepository,
      branch: branchA,
      expectedRevision: symbolMapState.revision,
      expectedMappedCommit: symbolMapState.mappedCommit,
      commit: symbolCommit,
      mode: "initial",
      ops: [],
      reality,
      note: "symbol smoke empty committed baseline",
    });

    // a bubble anchored to one part of a file lights up when that file is touched
    const symLinkFrames = [];
    symLink = await openSocket(`ws://127.0.0.1:${symPort}/link`, symLinkFrames);
    symLink.send(
      JSON.stringify({
        type: "canvas_call",
        cwd: symWt,
        id: "smoke-parts-1",
        args: {
          ops: [
            {
              op: "upsert_node",
              node: {
                id: "the-ledger",
                parentId: null,
                label: "The ledger",
                summary: "Keeps the running total.",
                phase: "built",
                codeRefs: [`${partsRel}#Ledger`],
              },
            },
          ],
        },
      }),
    );
    const partsResult = await waitFor("canvas_result for the part-anchored bubble", () =>
      symLinkFrames.find((f) => f.type === "canvas_result" && f.id === "smoke-parts-1"),
    );
    check(
      "a bubble may claim one part of a file",
      partsResult.isError === false && partsResult.text.startsWith("applied 1 op(s);"),
      partsResult.text.split("\n")[0],
    );
    symLink.send(
      JSON.stringify({
        type: "agent_event",
        cwd: symWt,
        event: { kind: "tool_start", name: "Edit", paths: [partsRel], summary: partsRel },
      }),
    );
    const partsActivity = await waitFor("activity for the part-anchored bubble", () =>
      symFrames.find((f) => f.type === "activity" && f.nodeIds.includes("the-ledger")),
    );
    check(
      "touching the file lights the bubble anchored to a part of it",
      partsActivity.nodeIds.join(",") === "the-ledger",
      partsActivity.nodeIds.join(","),
    );
  } catch (err) {
    check("the parts run completed", false, String(err));
  } finally {
    symSocket?.close();
    symLink?.close();
    symBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(symTarget, { recursive: true, force: true });
    await rm(symHome, { recursive: true, force: true });
  }
}

// --- the infra layer is found in the code ----------------------------------
// Its own project, its own bridge, its own port, for the same reason as the
// block above: infrastructure is read out of a project's configuration, so it
// needs a project that has some. What the extractor reads out of the files is
// the whole of it — Shape shows the infrastructure it found, and asks nobody
// about it.
{
  const { parseAgentToServerMsg } = await import(new URL("../src/linkframes.ts", import.meta.url));

  const infraTarget = await mkdtemp(join(tmpdir(), "vh-smoke-infra-"));
  const infraHome = await mkdtemp(join(tmpdir(), "vh-smoke-infrahome-"));
  await seedWorkspace(infraTarget, "inf");
  await mkdir(join(infraTarget, "packages", "api", "src"), { recursive: true });
  await mkdir(join(infraTarget, ".github", "workflows"), { recursive: true });
  await writeFile(
    join(infraTarget, "docker-compose.yml"),
    `version: "3"
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: secret
  cache:
    image: redis:7-alpine
  api:
    build: .
    ports:
      - "3000:3000"
volumes:
  pgdata:
`,
  );
  await writeFile(join(infraTarget, "fly.toml"), 'app = "inf"\n\n[env]\n  PORT = "3000"\n');
  await writeFile(
    join(infraTarget, ".github", "workflows", "ci.yml"),
    "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  );
  await writeFile(
    join(infraTarget, "packages", "api", "package.json"),
    JSON.stringify({ name: "@inf/api", version: "0.0.1", dependencies: { pg: "^8.11.0", stripe: "^14.0.0" } }, null, 2),
  );
  await writeFile(join(infraTarget, "packages", "api", "src", "index.ts"), "export const serve = () => 0;\n");
  await writeFile(
    join(infraTarget, ".env.example"),
    "DATABASE_URL=postgres://localhost:5432/app\nUNRELATED_SETTING=1\n",
  );
  const infraGit = (...args) => execFileSync("git", args, { cwd: infraTarget, stdio: "ignore" });
  infraGit("add", "-A");
  infraGit("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "infra");

  const infraPort = PORT + 2;
  const infraFrames = [];
  let infraBridge = null;
  let infraSocket = null;
  try {
    infraBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", infraTarget, "--port", String(infraPort), "--db", join(infraHome, "shape.db")],
      {
        cwd: process.cwd(),
        env: { ...process.env, SHAPE_HOME: infraHome, HOME: infraHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let infraErr = "";
    infraBridge.stderr.setEncoding("utf8");
    infraBridge.stderr.on("data", (d) => {
      infraErr += d;
    });
    await waitFor("bridge listening for the configured project", () => infraErr.includes("canvas at ws://"));

    infraSocket = await openSocket(`ws://127.0.0.1:${infraPort}/ws`, infraFrames);
    const infraWt = realpathSync(infraTarget);
    const infraHello = await waitFor("hello for the configured project", () =>
      infraFrames.find((f) => f.type === "hello"),
    );

    const found = infraHello.graphs[branchA].reality.infra;
    const item = (id) => found.find((i) => i.id === id);
    check(
      // one line per kind, and inside a kind by label: the same order every run,
      // so the ghost strip never shuffles under the user
      "the infra layer is read out of the project's own configuration",
      found.map((i) => i.id).join(",") ===
        "i:cache-redis,i:ci-pipeline-github-workflows-ci-yml,i:database-postgres,i:external-stripe,i:host-fly-io,i:host-container-api",
      found.map((i) => i.id).join(","),
    );
    check(
      "everything that names the same database becomes one database, with every file behind it",
      item("i:database-postgres")?.kind === "database" &&
        item("i:database-postgres").label === "Postgres database (docker-compose.yml: db)" &&
        item("i:database-postgres").evidence.join(",") === ".env.example,docker-compose.yml,packages/api/package.json" &&
        item("i:database-postgres").hint.startsWith("a Postgres database, read from the service"),
      JSON.stringify(item("i:database-postgres") ?? null),
    );
    check(
      "a cache is told apart from a database by the image it runs",
      item("i:cache-redis")?.kind === "cache" &&
        item("i:cache-redis").evidence.join(",") === "docker-compose.yml",
      JSON.stringify(item("i:cache-redis") ?? null),
    );
    check(
      "a service that builds its own image is somewhere the code runs",
      item("i:host-container-api")?.kind === "host" &&
        item("i:host-container-api").label === 'The "api" service runs in a container (docker-compose.yml)',
      JSON.stringify(item("i:host-container-api") ?? null),
    );
    check(
      "a platform config says where the whole thing runs",
      item("i:host-fly-io")?.kind === "host" && item("i:host-fly-io").label === "Runs on Fly.io (fly.toml)" &&
        item("i:host-fly-io").evidence.join(",") === "fly.toml",
      JSON.stringify(item("i:host-fly-io") ?? null),
    );
    check(
      "a workflow file is a pipeline, named by what it does",
      item("i:ci-pipeline-github-workflows-ci-yml")?.kind === "ci" &&
        item("i:ci-pipeline-github-workflows-ci-yml").label === "Build and test pipeline (.github/workflows/ci.yml)",
      JSON.stringify(item("i:ci-pipeline-github-workflows-ci-yml") ?? null),
    );
    check(
      "a service someone else runs is read out of the dependencies",
      item("i:external-stripe")?.kind === "external" &&
        item("i:external-stripe").evidence.join(",") === "packages/api/package.json",
      JSON.stringify(item("i:external-stripe") ?? null),
    );
    check(
      "a settings file that configures nothing infrastructural adds nothing",
      !found.some((i) => i.evidence.includes("pnpm-workspace.yaml") || i.label.includes("UNRELATED_SETTING")),
      found.map((i) => i.evidence.join("+")).join(" | "),
    );

    // --- the boundary: an extraction from an agent that predates all this ----
    const older = parseAgentToServerMsg(
      JSON.stringify({
        type: "reality",
        worktree: "/tmp/older-agent",
        head: "abc123",
        reality: { nodes: [], edges: [], extractedAt: null, head: "abc123" },
      }),
    );
    check(
      "an extraction with no parts and no infrastructure lists is a valid frame, read as none of either",
      older?.type === "reality" && older.reality.symbols.length === 0 && older.reality.infra.length === 0,
      JSON.stringify(older),
    );
    const mixed = parseAgentToServerMsg(
      JSON.stringify({
        type: "reality",
        worktree: "/tmp/older-agent",
        head: null,
        reality: {
          nodes: [],
          edges: [],
          extractedAt: null,
          head: null,
          symbols: [
            { id: "s:a.ts#A", file: "a.ts", name: "A", kind: "class", exported: true, line: 1, pkg: null },
            { id: "s:a.ts#B", file: "a.ts", name: "B", kind: "widget", exported: true, line: 2, pkg: null },
          ],
          infra: [
            { id: "i:database-postgres", label: "Postgres database", kind: "database", evidence: ["docker-compose.yml"], hint: "a database" },
            { id: "i:host-nonsense", label: "Nonsense", kind: "not-a-kind", evidence: [], hint: "" },
            { id: "i:host-unproven", label: "Unproven", kind: "host", hint: "no evidence array at all" },
          ],
        },
      }),
    );
    check(
      "one malformed row never costs the whole extraction: it is dropped, the rest stands",
      mixed?.type === "reality" && mixed.reality.symbols.map((s) => s.id).join(",") === "s:a.ts#A" &&
        mixed.reality.infra.map((i) => i.id).join(",") === "i:database-postgres",
      JSON.stringify({
        symbols: mixed?.reality.symbols.map((s) => s.id),
        infra: mixed?.reality.infra.map((i) => i.id),
      }),
    );
  } catch (err) {
    check("the infra run completed", false, String(err));
  } finally {
    infraSocket?.close();
    infraBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(infraTarget, { recursive: true, force: true });
    await rm(infraHome, { recursive: true, force: true });
  }
}

// --- the correctness layer is found in the code ----------------------------
// Its own project, its own bridge, its own port, for the same reason as the two
// blocks above: verification is read out of a project's own test files, scripts
// and pipelines, so it needs a project that has some. Checked end to end — what
// the extractor reads, and that a build bubble reads as verified from the
// extraction alone.
{
  const { GraphStore } = await import(new URL("../src/server/store.ts", import.meta.url));
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  const { parseAgentToServerMsg } = await import(new URL("../src/linkframes.ts", import.meta.url));
  const { capabilityVerification, verificationOf } = await import(
    new URL("../../shared/src/index.ts", import.meta.url)
  );

  const vTarget = await mkdtemp(join(tmpdir(), "vh-smoke-correctness-"));
  const vHome = await mkdtemp(join(tmpdir(), "vh-smoke-correctnesshome-"));
  await seedWorkspace(vTarget, "vfy");
  await mkdir(join(vTarget, "packages", "api", "src"), { recursive: true });
  await mkdir(join(vTarget, "scripts"), { recursive: true });
  await mkdir(join(vTarget, ".github", "workflows"), { recursive: true });
  await mkdir(join(vTarget, "docs"), { recursive: true });
  await writeFile(
    join(vTarget, "packages", "api", "package.json"),
    JSON.stringify(
      { name: "@vfy/api", version: "0.0.1", scripts: { test: "vitest run", typecheck: "tsc --noEmit" } },
      null,
      2,
    ),
  );
  await writeFile(join(vTarget, "packages", "api", "src", "a.ts"), "export const a = () => 1;\n");
  await writeFile(join(vTarget, "packages", "api", "src", "b.ts"), "export const b = () => 2;\n");
  // never imported by a test and never named by a script: only the package dir
  // cover can reach it
  await writeFile(join(vTarget, "packages", "api", "src", "c.ts"), "export const c = () => 3;\n");
  await writeFile(
    join(vTarget, "packages", "api", "src", "a.test.ts"),
    'import { a } from "./a";\n\nif (a() !== 1) throw new Error("a");\n',
  );
  await writeFile(
    join(vTarget, "scripts", "smoke-api.mjs"),
    'import { b } from "../packages/api/src/b.ts";\n\nif (b() !== 2) throw new Error("b");\n',
  );
  await writeFile(
    join(vTarget, ".github", "workflows", "ci.yml"),
    "name: ci\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
  );
  // outside every package and every cover: what an unverified bubble points at
  await writeFile(join(vTarget, "docs", "plan.md"), "# plan\n");
  const vGit = (...args) => execFileSync("git", args, { cwd: vTarget, stdio: "ignore" });
  vGit("add", "-A");
  vGit("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "correctness");

  const vPort = PORT + 3;
  const vFrames = [];
  let vBridge = null;
  let vSocket = null;
  try {
    vBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", vTarget, "--port", String(vPort), "--db", join(vHome, "shape.db")],
      {
        cwd: process.cwd(),
        env: { ...process.env, SHAPE_HOME: vHome, HOME: vHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let vErr = "";
    vBridge.stderr.setEncoding("utf8");
    vBridge.stderr.on("data", (d) => {
      vErr += d;
    });
    await waitFor("bridge listening for the verified project", () => vErr.includes("canvas at ws://"));

    vSocket = await openSocket(`ws://127.0.0.1:${vPort}/ws`, vFrames);
    const vWt = realpathSync(vTarget);
    const vHello = await waitFor("hello for the verified project", () => vFrames.find((f) => f.type === "hello"));

    const found = vHello.graphs[branchA].reality.verification;
    const item = (id) => found.find((v) => v.id === id);
    check(
      // one line per kind, and inside a kind by label: the same order every run
      "the correctness layer is read out of the project's own tests, scripts and pipelines",
      found.map((v) => v.id).join(",") ===
        "v:check-github-workflows-ci-yml,v:check-typecheck,v:smoke-smoke-api,v:test-packages-api",
      found.map((v) => v.id).join(","),
    );
    check(
      "a package's test files are one item, covering the package and what they import",
      item("v:test-packages-api")?.kind === "test" &&
        item("v:test-packages-api").label === "Tests in packages/api (1 file)" &&
        item("v:test-packages-api").hint === "1 test file under packages/api" &&
        item("v:test-packages-api").evidence.join(",") === "packages/api/src/a.test.ts" &&
        item("v:test-packages-api").covers.join(",") === "packages/api,packages/api/src/a.ts",
      JSON.stringify(item("v:test-packages-api") ?? null),
    );
    check(
      "a smoke script covers the files it drives",
      item("v:smoke-smoke-api")?.kind === "smoke" &&
        item("v:smoke-smoke-api").label === "Smoke checks: smoke-api" &&
        item("v:smoke-smoke-api").evidence.join(",") === "scripts/smoke-api.mjs" &&
        item("v:smoke-smoke-api").covers.includes("packages/api/src/b.ts"),
      JSON.stringify(item("v:smoke-smoke-api") ?? null),
    );
    check(
      "a manifest script that checks the code itself is a static check on its package",
      item("v:check-typecheck")?.kind === "check" &&
        item("v:check-typecheck").label === "Static checks: typecheck" &&
        item("v:check-typecheck").evidence.join(",") === "packages/api/package.json" &&
        item("v:check-typecheck").covers.join(",") === "packages/api",
      JSON.stringify(item("v:check-typecheck") ?? null),
    );
    check(
      "a pipeline is what runs on every push, over every package",
      item("v:check-github-workflows-ci-yml")?.kind === "check" &&
        item("v:check-github-workflows-ci-yml").label === "Checks run on every push (.github/workflows/ci.yml)" &&
        item("v:check-github-workflows-ci-yml").evidence.join(",") === ".github/workflows/ci.yml" &&
        item("v:check-github-workflows-ci-yml").covers.join(",") === "packages/api,packages/auth,packages/db",
      JSON.stringify(item("v:check-github-workflows-ci-yml") ?? null),
    );
    check(
      "a plain `test` script is not verification on its own, and no file is invented",
      !found.some((v) => v.label.includes("Static checks: test")) &&
        found.every((v) => v.evidence.length > 0 && v.hint.length > 0),
      found.map((v) => `${v.label}: ${v.evidence.join("+")}`).join(" | "),
    );

    // --- what a build bubble can show for it ---------------------------------
    const correctnessDoc = {
      nodes: [
        { id: "the-product", parentId: null, label: "The service", summary: "Answers.", phase: "built", layer: "product", realizes: ["the-a", "the-notes"] },
        { id: "the-a", parentId: null, label: "The first part", summary: "Answers one way.", phase: "built", codeRefs: ["packages/api/src/a.ts"] },
        { id: "the-c", parentId: null, label: "The third part", summary: "Answers another way.", phase: "built", codeRefs: ["packages/api/src/c.ts"] },
        { id: "the-notes", parentId: null, label: "The plan", summary: "Says what is coming.", phase: "built", codeRefs: ["docs/plan.md"] },
      ],
      reality: vHello.graphs[branchA].reality,
    };
    check(
      "a build bubble is verified by the extraction alone when a test covers its file",
      verificationOf(correctnessDoc, "the-a") === "verified",
      verificationOf(correctnessDoc, "the-a"),
    );
    check(
      // the prefix rule runs both ways, so the package-wide cover reaches a file
      // inside it that no test imports by name
      "a file no test imports is still verified by the cover of the package it lives in",
      verificationOf(correctnessDoc, "the-c") === "verified",
      verificationOf(correctnessDoc, "the-c"),
    );
    check(
      "a bubble no cover reaches reads as unverified",
      verificationOf(correctnessDoc, "the-notes") === "unverified",
      verificationOf(correctnessDoc, "the-notes"),
    );
    check(
      "a capability is only as verified as the parts that keep it",
      capabilityVerification(correctnessDoc, "the-product") === "partial",
      capabilityVerification(correctnessDoc, "the-product"),
    );

    // --- the boundary: an extraction from an agent that predates the layer ----
    const older = parseAgentToServerMsg(
      JSON.stringify({
        type: "reality",
        worktree: "/tmp/older-agent",
        head: "abc123",
        reality: { nodes: [], edges: [], extractedAt: null, head: "abc123" },
      }),
    );
    check(
      "an extraction with no verification list is a valid frame, read as none found",
      older?.type === "reality" && older.reality.verification.length === 0,
      JSON.stringify(older?.reality.verification ?? null),
    );
    const mixed = parseAgentToServerMsg(
      JSON.stringify({
        type: "reality",
        worktree: "/tmp/older-agent",
        head: null,
        reality: {
          nodes: [],
          edges: [],
          extractedAt: null,
          head: null,
          verification: [
            { id: "v:test-packages-api", label: "Tests", kind: "test", evidence: ["a.test.ts"], hint: "one test", covers: ["packages/api"] },
            { id: "v:test-nonsense", label: "Nonsense", kind: "not-a-kind", evidence: [], hint: "", covers: [] },
            { id: "v:test-uncovered", label: "Uncovered", kind: "test", evidence: ["b.test.ts"], hint: "no covers array at all" },
          ],
        },
      }),
    );
    check(
      "one malformed verification row never costs the whole extraction: it is dropped, the rest stands",
      mixed?.type === "reality" && mixed.reality.verification.map((v) => v.id).join(",") === "v:test-packages-api",
      JSON.stringify(mixed?.reality.verification.map((v) => v.id) ?? null),
    );

    // --- the other boundary: a graph row written before the layer was renamed -
    // The layer was called "verify" until it was renamed to "correctness". A
    // stored row still saying so is read, never re-validated, so loading maps it
    // — otherwise a project mapped by an older bridge would come back with its
    // checks scattered onto the build layer.
    const legacyHome = await mkdtemp(join(tmpdir(), "vh-smoke-legacy-layer-"));
    const legacyStorage = openSqliteStorage(join(legacyHome, "legacy.db"));
    await legacyStorage.saveGraph("local", "legacy-layer", branchA, {
      rev: 4,
      nodes: [
        {
          id: "the-api-checks",
          parentId: null,
          label: "The API checks",
          summary: "Starts the service and reads a balance back.",
          phase: "built",
          layer: "verify",
          kind: "test",
          codeRefs: ["packages/api/test"],
          verifies: ["the-api"],
        },
      ],
      edges: [],
      reality: { nodes: [], edges: [], symbols: [], infra: [], verification: [], extractedAt: null, head: null },
      drift: {},
    });
    const legacyStore = new GraphStore(legacyStorage, "local", "legacy-layer", branchA);
    await legacyStore.load();
    check(
      'a stored row on the retired "verify" layer loads onto the correctness layer',
      legacyStore.node("the-api-checks")?.layer === "correctness" &&
        JSON.stringify(legacyStore.node("the-api-checks")?.verifies) === '["the-api"]',
      JSON.stringify(legacyStore.node("the-api-checks")),
    );
    legacyStorage.close();
    await rm(legacyHome, { recursive: true, force: true });
  } catch (err) {
    check("the correctness run completed", false, String(err));
  } finally {
    vSocket?.close();
    vBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(vTarget, { recursive: true, force: true });
    await rm(vHome, { recursive: true, force: true });
  }
}

// --- explicit mapping and live overlay --------------------------------------
// A session attaching to an unmapped branch must not trigger a survey or draw
// anything. Mapping starts only when an authenticated control client commits a
// semantic document. Later live edits are visible but never replace that
// committed baseline.
{
  const controlTarget = await mkdtemp(join(tmpdir(), "vh-smoke-control-"));
  const controlHome = await mkdtemp(join(tmpdir(), "vh-smoke-control-home-"));
  await seedWorkspace(controlTarget, "ctl");
  const controlPort = PORT + 7;
  const controlFrames = [];
  const controlDb = join(controlHome, "shape.db");
  let controlBridge = null;
  let controlSocket = null;
  let controlSession = null;
  try {
    controlBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", controlTarget, "--port", String(controlPort), "--db", controlDb],
      {
        cwd: process.cwd(),
        env: { ...process.env, SHAPE_HOME: controlHome, HOME: controlHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let controlErr = "";
    controlBridge.stderr.setEncoding("utf8");
    controlBridge.stderr.on("data", (d) => {
      controlErr += d;
    });
    await waitFor("bridge listening for explicit mapping", () => controlErr.includes("canvas at ws://"), 30_000);

    controlSocket = await openSocket(`ws://127.0.0.1:${controlPort}/ws`, controlFrames);
    const initialHello = await waitFor(
      "hello for the unmapped branch",
      () => controlFrames.find((frame) => frame.type === "hello"),
      30_000,
    );
    check(
      "an unmapped branch starts empty and has no committed checkpoint",
      initialHello.graphs[branchA].nodes.length === 0 &&
        initialHello.session.branches.find((branch) => branch.id === branchA)?.mappedCommit === null,
      JSON.stringify({
        nodes: initialHello.graphs[branchA].nodes.length,
        branches: initialHello.session.branches,
      }),
    );

    const attachedAt = controlFrames.length;
    controlSession = startSession({ worktree: controlTarget, port: controlPort });
    await waitFor(
      "the observed session on the unmapped branch",
      () =>
        controlFrames
          .slice(attachedAt)
          .find((frame) => frame.type === "session_started" && frame.worktree === branchA && frame.backend.id === "omp"),
      30_000,
    );
    await sleep(750);
    check(
      "attaching a session causes no unsolicited survey or canvas write",
      !controlFrames
        .slice(attachedAt)
        .some((frame) => frame.type === "graph" && frame.worktree === branchA && frame.graph.nodes.length > 0) &&
        !controlFrames
          .slice(attachedAt)
          .some((frame) => frame.type === "transcript" && frame.worktree === branchA && frame.role === "tool"),
      JSON.stringify(
        controlFrames
          .slice(attachedAt)
          .filter((frame) => frame.type === "graph" || frame.type === "transcript")
          .map((frame) => frame.type),
      ),
    );

    const { repositoryIdentity } = await import(new URL("../src/agent/worktrees.ts", import.meta.url));
    const repository = await repositoryIdentity(controlTarget);
    const state = await requestControl(controlPort, "explicit-read", {
      type: "map_read",
      repository,
      branch: branchA,
    });
    check(
      "map_read reports no committed baseline before an explicit map",
      state.type === "map_state" && state.branch === branchA && state.mappedCommit === null && state.doc === null,
      JSON.stringify(state),
    );

    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: controlTarget, encoding: "utf8" }).trim();
    const committed = await requestControl(controlPort, "explicit-commit", {
      type: "map_commit",
      repository,
      branch: branchA,
      expectedRevision: state.revision,
      expectedMappedCommit: state.mappedCommit,
      commit,
      mode: "initial",
      ops: [
        {
          op: "upsert_node",
          node: {
            id: "ctl-auth",
            parentId: null,
            label: "Authentication",
            summary: "Authenticates people before they use the system.",
            phase: "built",
            kind: "service",
            codeRefs: ["packages/auth"],
          },
        },
        {
          op: "upsert_node",
          node: {
            id: "ctl-db",
            parentId: null,
            label: "Records",
            summary: "Stores the user records authentication depends on.",
            phase: "built",
            kind: "database",
            codeRefs: ["packages/db"],
          },
        },
        {
          op: "upsert_edge",
          edge: {
            id: "ctl-auth--ctl-db",
            source: "ctl-auth",
            target: "ctl-db",
            kind: "depends",
          },
        },
      ],
      reality: initialHello.graphs[branchA].reality,
      note: "bridge smoke explicit map",
    });
    check(
      "map_commit records the exact requested branch and commit",
      committed.type === "map_committed" && committed.branch === branchA && committed.mappedCommit === commit,
      JSON.stringify(committed),
    );
    const mappedGraph = await waitFor(
      "the explicit committed map on the browser",
      () =>
        controlFrames.find(
          (frame) =>
            frame.type === "graph" &&
            frame.worktree === branchA &&
            frame.graph.nodes.some((node) => node.id === "ctl-auth") &&
            frame.graph.nodes.some((node) => node.id === "ctl-db"),
        ),
      30_000,
    );
    check(
      "the explicit map is the branch's visible graph",
      mappedGraph.graph.edges.some((edge) => edge.id === "ctl-auth--ctl-db"),
      JSON.stringify(mappedGraph.graph),
    );

    await requestControl(controlPort, "explicit-live-start", {
      type: "live_update",
      repository,
      branch: branchA,
      sessionId: "bridge-smoke-live",
      state: "start",
      note: "bridge smoke live session",
    });
    const liveAt = controlFrames.length;
    const live = await requestControl(controlPort, "explicit-live", {
      type: "live_update",
      repository,
      branch: branchA,
      sessionId: "bridge-smoke-live",
      state: "working",
      ops: [
        {
          op: "upsert_node",
          node: {
            id: "ctl-live",
            parentId: null,
            label: "Work in progress",
            summary: "A live-only edit that has not been mapped.",
            phase: "idea",
          },
        },
      ],
      note: "editing an unmapped idea",
    });
    check(
      "live_update advances the visible branch without changing its checkpoint",
      live.type === "live_updated" && live.mappedCommit === commit && live.revision > committed.revision,
      JSON.stringify(live),
    );
    await waitFor(
      "the live overlay on the browser",
      () =>
        controlFrames
          .slice(liveAt)
          .find(
            (frame) =>
              frame.type === "graph" &&
              frame.worktree === branchA &&
              frame.graph.nodes.some((node) => node.id === "ctl-live"),
          ),
      30_000,
    );
    const baseline = await requestControl(controlPort, "explicit-baseline", {
      type: "map_read",
      repository,
      branch: branchA,
    });
    check(
      "map_read keeps the committed baseline distinct from live overlay edits",
      baseline.type === "map_state" &&
        baseline.mappedCommit === commit &&
        baseline.revision === live.revision &&
        baseline.doc.nodes.some((node) => node.id === "ctl-auth") &&
        !baseline.doc.nodes.some((node) => node.id === "ctl-live"),
      JSON.stringify(baseline),
    );
    await requestControl(controlPort, "explicit-live-stop", {
      type: "live_update",
      repository,
      branch: branchA,
      sessionId: "bridge-smoke-live",
      state: "stop",
    });

    const refreshedAt = controlFrames.length;
    controlSocket.send(JSON.stringify({ type: "select_project", projectId: repository.id }));
    const refreshed = await waitFor(
      "hello after the explicit map",
      () => controlFrames.slice(refreshedAt).find((frame) => frame.type === "hello"),
      30_000,
    );
    check(
      "public branch metadata exposes the committed checkpoint",
      refreshed.session.branches.find((branch) => branch.id === branchA)?.mappedCommit === commit,
      JSON.stringify(refreshed.session.branches),
    );
  } catch (err) {
    check("the explicit mapping run completed", false, String(err));
  } finally {
    await controlSession?.stop();
    controlSocket?.close();
    controlBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(controlTarget, { recursive: true, force: true });
    await rm(controlHome, { recursive: true, force: true });
  }
}


console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
