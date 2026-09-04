#!/usr/bin/env node
/**
 * Bridge dev smoke test. Runs the real bridge against scripts/fake-omp-tui.mjs
 * under the pty launcher in a throwaway target dir, drives it over WebSocket,
 * and asserts the wire contract.
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

const PORT = Number(process.env.SMOKE_PORT ?? 4409);

// Every bridge below inherits this environment. A smoke must not depend on
// what happens to be installed on the machine running it: the launcher is
// Shape's own pty (never a herdr tab in the developer's terminal), and
// detection reports exactly one harness — `omp`, which `--omp` points at the
// fake. One detected harness is also what makes a project with no configured
// backend resolve to omp, the way a single-harness machine does.
process.env.SHAPE_LAUNCHER = "pty";
process.env.SHAPE_FORCE_HARNESSES = "omp";
/**
 * Every bridge in this file drives onboarding by hand: it seeds a workspace
 * WITH code, then sends `onboard` and asserts what came back. A room that maps
 * such a project by itself the moment a session starts would be answering those
 * frames before the test does, so the automatic map is off — except in the
 * block that is about it, which spawns its own bridge without this.
 */
const NO_AUTO_MAP = { SHAPE_AUTO_MAP: "0" };
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

/** frames the fake omp received, in order */
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

/**
 * A pid is gone. The proof a harness process ended is the process itself: it
 * runs in a terminal Shape closes, and a killed TUI has no chance to write a
 * farewell anywhere.
 */
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
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
 * so the reality-refresh trigger fires on terminal agent_end. `scope` names the
 * workspace packages (@<scope>/auth, @<scope>/db) so two seeded projects are
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
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** the fake child logs to <its cwd>/fake-omp.log */
const ompLogIn = (dir) => join(dir, "fake-omp.log");

const target = await mkdtemp(join(tmpdir(), "vh-smoke-a-"));
const targetB = await mkdtemp(join(tmpdir(), "vh-smoke-b-"));
/** a project whose canvas was left behind by a Shape that predates the database */
const legacyTarget = await mkdtemp(join(tmpdir(), "vh-smoke-legacy-"));
/**
 * A project whose canvas is stored under the project key Shape derived before
 * the key came off the repo's common dir: machine + the DIRECTORY. Its rows are
 * seeded below, before the bridge starts, and the first attach on it has to
 * adopt them.
 */
const oldKeyTarget = await mkdtemp(join(tmpdir(), "vh-smoke-oldkey-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-smoke-home-"));
await seedWorkspace(target, "t");
await seedWorkspace(targetB, "b");
await seedWorkspace(legacyTarget, "lg");
await seedWorkspace(oldKeyTarget, "ok");
// HOME is pointed at fakeHome for the bridge child, so "~/proj" is this dir
const homeProj = join(fakeHome, "proj");
await mkdir(homeProj, { recursive: true });
await seedWorkspace(homeProj, "h");

// two more worktrees of target A's repo, each on its own branch: one the link
// and pane sections drive, one the "several variations at once" section opens
const worktree = join(tmpdir(), `vh-smoke-wt-${process.pid}`);
execFileSync("git", ["worktree", "add", "-b", "variation", worktree], { cwd: target, stdio: "ignore" });
const worktree2 = join(tmpdir(), `vh-smoke-wt2-${process.pid}`);
execFileSync("git", ["worktree", "add", "-b", "variation-2", worktree2], { cwd: target, stdio: "ignore" });
/**
 * A third worktree, added mid-run by the "next and autonomy" section: it needs
 * a variation whose canvas is still empty AND has a harness in it, and every
 * other one has been drawn on by the time that section runs.
 */
const worktree3 = join(tmpdir(), `vh-smoke-wt3-${process.pid}`);
/**
 * A fourth worktree, added mid-run by the section that opens a variation the
 * way the start card does: it needs one nobody has opened yet, so the harness
 * it starts is the one those choices produced.
 */
const worktree4 = join(tmpdir(), `vh-smoke-wt4-${process.pid}`);
/**
 * Worktree ids: the realpath of each directory, which is what every frame that
 * is about one canvas carries. `wtA` and `wtVariation` are two variations of
 * ONE project (they share its key); the others are each their own project's
 * only worktree.
 */
const wtA = realpathSync(target);
const wtVariation = realpathSync(worktree);
const wt2 = realpathSync(worktree2);
const wtB = realpathSync(targetB);
const wtHome = realpathSync(homeProj);
const wtLegacy = realpathSync(legacyTarget);
const wtOldKey = realpathSync(oldKeyTarget);
const ompLog = ompLogIn(target);
// where `create_project` puts its projects, and the fake gh's argv log
const createRoot = await mkdtemp(join(tmpdir(), "vh-smoke-new-"));
/** the same directory as the agent reports it: a project's cwd is always a realpath */
const createRootReal = realpathSync(createRoot);
const fakeGh = join(process.cwd(), "scripts", "fake-gh.mjs");
const fakeGhLog = join(createRoot, "gh.log");
const frames = [];
let bridge = null;
let socket = null;

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
 * Read rows out of the bridge's own database while it runs. A database that is
 * not there yet — or busy mid-write — is just "not yet", so the callers can
 * poll it exactly as they polled the files it replaced.
 */
function dbRows(sql, ...params) {
  if (!existsSync(shapeDb)) return null;
  let db = null;
  try {
    db = new DatabaseSync(shapeDb);
    return db.prepare(sql).all(...params);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** one worktree's stored canvas; null until the bridge has persisted it */
function storedGraph(cwd, worktree = realpathSync(cwd)) {
  const rows = dbRows(
    "SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?",
    "local",
    projectKeyOf(cwd),
    worktree,
  );
  return rows === null || rows.length === 0 ? null : JSON.parse(rows[0].doc);
}

/** one worktree's stored revision snapshots, oldest first */
function storedRevisions(cwd, worktree = realpathSync(cwd)) {
  const rows = dbRows(
    "SELECT snapshot FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY rev ASC",
    "local",
    projectKeyOf(cwd),
    worktree,
  );
  return rows === null ? [] : rows.map((row) => JSON.parse(row.snapshot));
}

// --- store.applyCanvasCall: gate vetoes interleaved with shared rejections ---
// In-process (node strips types, same as the bridge child): the index
// interleaving lives entirely in GraphStore, no wire round-trip needed.
{
  const { GraphStore } = await import(new URL("../src/server/store.ts", import.meta.url));
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  // the constructor takes the storage and the (tenant, project, worktree) the graph is under
  const storeDb = openSqliteStorage(join(tmpdir(), `vh-smoke-store-${process.pid}`, "shape.db"));
  const store = new GraphStore(storeDb, "local", "gate-veto", "/tmp/gate-veto");
  const mkNode = (id, parentId = null) => ({
    op: "upsert_node",
    node: { id, parentId, label: id, summary: `promise of ${id}`, phase: "idea" },
  });
  // ops 0 and 4 are gate-vetoed, op 2 is shared-rejected (unknown parent);
  // ops 1 and 3 are accepted — so shared applyOps sees the rejected op at
  // admitted index 1 and the store must map it back to original index 2.
  const gate = (op) =>
    op.op === "upsert_node" && op.node?.id?.startsWith("vetoed-")
      ? {
          code: "onboarding/unknown-coderef",
          severity: "error",
          message: `codeRefs path "packages/nope" does not exist`,
          subject: { path: "/node/codeRefs/0", id: op.node.id, label: op.node.label },
          evidence: { ref: "packages/nope" },
          supportedFixes: ["point codeRefs at an existing workspace path"],
        }
      : null;
  const revBefore = store.doc.rev;
  const outcome = store.applyCanvasCall(
    { ops: [mkNode("vetoed-a"), mkNode("sm-root"), mkNode("sm-orphan", "no-such-parent"), mkNode("sm-child", "sm-root"), mkNode("vetoed-b")] },
    gate,
  );
  check(
    "mixed call: accepted ops applied and bumped rev",
    outcome.changed === true && store.doc.rev === revBefore + 1 &&
      outcome.text.startsWith(`applied 2 op(s); rev=${store.doc.rev}`) &&
      store.node("sm-root") !== undefined && store.node("sm-child")?.parentId === "sm-root",
    outcome.text.split("\n")[0],
  );
  check(
    "mixed call with survivors is not an error result",
    outcome.isError === false && !store.doc.nodes.some((n) => n.id === "sm-orphan" || n.id.startsWith("vetoed-")),
  );
  const mixed = receipts(outcome.text).rejections;
  check(
    "receipts sorted by original op index, both kinds present",
    mixed.map((r) => r.index).join(",") === "0,2,4" &&
      mixed.map((r) => r.code).join(",") === "onboarding/unknown-coderef,op/unknown-parent,onboarding/unknown-coderef",
    JSON.stringify(mixed.map((r) => `${r.index}:${r.code}`)),
  );
  const [vetoA, sharedRej, vetoB] = mixed;
  check(
    "gate veto receipts absolutized to their op index",
    vetoA.subject.path === "/ops/0/node/codeRefs/0" && vetoA.subject.id === "vetoed-a" &&
      vetoB.subject.path === "/ops/4/node/codeRefs/0" && vetoB.subject.id === "vetoed-b",
    JSON.stringify([vetoA.subject, vetoB.subject]),
  );
  check(
    "shared rejection re-indexed from admitted position (1) to original (2)",
    sharedRej.index === 2 && sharedRej.subject.path === "/ops/2/node/parentId" &&
      sharedRej.subject.id === "sm-orphan" && sharedRej.evidence.parentId === "no-such-parent",
    JSON.stringify({ index: sharedRej.index, path: sharedRej.subject.path }),
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
  // the switch the product-first turn is off: the layers a link would point at
  // are exactly what that turn may not draw yet
  const quietCall = store.applyCanvasCall(
    { ops: [{ op: "upsert_node", node: { id: "sm-quiet", parentId: "sm-product", layer: "product", label: "See who owes", summary: "Shows who still owes what.", phase: "component" } }] },
    null,
    { linkWarnings: false },
  );
  check(
    "link warnings can be turned off for a turn, and then the receipt is silent",
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
}

// --- product layer: onboarding gate + steering composer --------------------
// In-process for the same reason as the block above: the gate is a pure
// function of the doc, and the composer is a pure function of the store.
{
  const { GraphStore } = await import(new URL("../src/server/store.ts", import.meta.url));
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  const { onboardingOpGate } = await import(new URL("../src/server/onboarding.ts", import.meta.url));
  const { composeUtterance } = await import(new URL("../src/server/steering.ts", import.meta.url));
  const { gitFileIndexSync } = await import(new URL("../src/agent/reality.ts", import.meta.url));
  const { buildFileIndex } = await import(new URL("../../shared/src/fileindex.ts", import.meta.url));

  // the gate now takes the project's file index, not a cwd: the fixture is a
  // committed workspace, so this is the same index the bridge itself would build
  const targetIndex = gitFileIndexSync(target) ?? buildFileIndex(walkFiles(target));

  const store = new GraphStore(
    openSqliteStorage(join(tmpdir(), `vh-smoke-product-${process.pid}`, "shape.db")),
    "local",
    "product-layer",
  );
  // the build layer a survey would already have on the canvas
  store.applyCanvasCall({
    ops: [
      {
        op: "upsert_node",
        node: { id: "money-rules", parentId: null, label: "Money rules", summary: "Works out who owes what after every expense.", phase: "built", codeRefs: ["packages/auth"] },
      },
    ],
  });
  const product = (id, label, parentId, realizes) => ({
    op: "upsert_node",
    node: { id, parentId, label, summary: `${label} — the promise a person gets.`, phase: "component", layer: "product", ...(realizes === undefined ? {} : { realizes }) },
  });
  // `target` is a committed workspace, so the codeRefs half of the gate is live.
  // The survey's product pass opens with the root: the product itself, which owes
  // neither codeRefs nor realizes.
  const rootCall = store.applyCanvasCall(
    { ops: [product("bill-splitter", "Bill Splitter", null)] },
    onboardingOpGate(targetIndex, store.doc),
  );
  check(
    "survey accepts the product root with no realizes and no codeRefs",
    rootCall.text.startsWith("applied 1 op(s);") && store.node("bill-splitter")?.layer === "product" &&
      store.node("bill-splitter")?.realizes === undefined && store.node("bill-splitter")?.codeRefs === undefined,
    rootCall.text.split("\n")[0],
  );
  const outcome = store.applyCanvasCall(
    {
      ops: [
        product("see-who-owes", "See who owes what", "bill-splitter"),
        product("split-a-bill", "Split a bill", "bill-splitter", ["money-rules"]),
        { op: "upsert_node", node: { id: "ghost-part", parentId: null, label: "Ghost", summary: "A part nobody wrote." , phase: "built" } },
      ],
    },
    onboardingOpGate(targetIndex, store.doc),
  );
  const productReceipts = receipts(outcome.text).rejections;
  const unrealized = productReceipts.find((r) => r.code === "onboarding/unrealized-product");
  check(
    "survey vetoes a capability under the root that nothing on the build side realizes",
    unrealized?.index === 0 && unrealized.subject.path === "/ops/0/node/realizes" &&
      unrealized.subject.id === "see-who-owes" && unrealized.severity === "error" &&
      unrealized.supportedFixes.length >= 1 && store.node("see-who-owes") === undefined,
    JSON.stringify(unrealized),
  );
  check(
    "survey accepts a capability with a real realizes and no codeRefs at all",
    outcome.text.startsWith("applied 1 op(s);") &&
      store.node("split-a-bill")?.codeRefs === undefined &&
      store.node("split-a-bill")?.parentId === "bill-splitter" &&
      store.node("split-a-bill")?.realizes?.join(",") === "money-rules",
    outcome.text.split("\n")[0],
  );
  check(
    "the codeRefs bar still holds for build bubbles in the same call",
    productReceipts.some((r) => r.index === 2 && r.code === "onboarding/no-coderefs"),
    JSON.stringify(productReceipts.map((r) => `${r.index}:${r.code}`)),
  );
  // a capability that forgets its parent: shared validation rejects it and the
  // receipt names the root to hang it under
  const second = store.applyCanvasCall(
    { ops: [product("plan-a-trip", "Plan a trip", null, ["money-rules"])] },
    onboardingOpGate(targetIndex, store.doc),
  );
  const secondRoot = receipts(second.text).rejections.find((r) => r.code === "op/second-root");
  check(
    "a second top-level product bubble is rejected, receipt naming the root",
    secondRoot?.index === 0 && secondRoot.subject.path === "/ops/0/node/parentId" &&
      secondRoot.evidence.rootId === "bill-splitter" &&
      secondRoot.supportedFixes.some((f) => f.includes("bill-splitter")) &&
      store.node("plan-a-trip") === undefined,
    JSON.stringify(secondRoot),
  );
  // a status refresh omits layer and realizes; the bubble must stay a grounded
  // capability rather than becoming a build bubble that owes codeRefs
  const refresh = store.applyCanvasCall(
    {
      ops: [{ op: "upsert_node", node: { id: "split-a-bill", parentId: "bill-splitter", label: "Split a bill", summary: "Split a bill — the promise a person gets.", phase: "component", status: "reading the routes" } }],
    },
    onboardingOpGate(targetIndex, store.doc),
  );
  check(
    "re-upserting a capability without layer keeps it a capability, not a codeRefs debt",
    refresh.text.startsWith("applied 1 op(s);") && store.node("split-a-bill")?.layer === "product" &&
      store.node("split-a-bill")?.status === "reading the routes",
    refresh.text.split("\n")[0],
  );

  const root = composeUtterance(store, "call it something friendlier", { kind: "node", id: "bill-splitter" });
  check(
    "root referent composes as the product and lists its capabilities as neighbors",
    root.includes('Referent: the product "Bill Splitter" (id: bill-splitter)') &&
      root.includes('Neighbors: split-a-bill "Split a bill" [capability]') &&
      !root.includes("Realized by:"),
    root.split("\n").slice(1, 3).join(" | "),
  );
  const capability = composeUtterance(store, "make this the first thing people see", { kind: "node", id: "split-a-bill" });
  check(
    "capability referent composes Realized by with the build bubble's label",
    capability.includes('Referent: product capability "Split a bill" (id: split-a-bill)') &&
      capability.includes('Realized by: money-rules "Money rules"') &&
      capability.includes("bill-splitter [parent]") &&
      capability.includes("make this the first thing people see"),
    capability.split("\n").slice(1, 3).join(" | "),
  );
  const part = composeUtterance(store, "speed this up", { kind: "node", id: "money-rules" });
  check(
    "build referent composes Serves with the capability it is under",
    part.includes('Referent: component "Money rules" (id: money-rules)') &&
      part.includes('Serves: split-a-bill "Split a bill"'),
    part.split("\n").slice(1, 3).join(" | "),
  );
  // legal AFTER onboarding: this is how the user says "I want this next"
  store.applyCanvasCall({ ops: [product("see-who-owes", "See who owes what", "bill-splitter")] });
  const promise = composeUtterance(store, "build this next", { kind: "node", id: "see-who-owes" });
  check(
    "capability nothing realizes composes the unrealized line",
    promise.includes("Realized by: nothing yet — no part on the build side makes this capability real") &&
      /Realized by: .*\nNeighbors: /.test(promise),
    promise.split("\n")[2],
  );
}

// --- backend seam: config precedence + unknown-id startup error ------------
// Two extra bridge processes: one whose harness command comes only from
// ~/.shape/config.json (no --omp flag), one whose project config names a
// backend that does not exist.
{
  const cfgTarget = await mkdtemp(join(tmpdir(), "vh-smoke-cfg-"));
  const cfgHome = await mkdtemp(join(tmpdir(), "vh-smoke-cfghome-"));
  const fakeOmp = join(process.cwd(), "scripts", "fake-omp-tui.mjs");
  await mkdir(join(cfgHome, ".shape"), { recursive: true });
  await writeFile(
    join(cfgHome, ".shape", "config.json"),
    JSON.stringify({ backend: "omp", backends: { omp: { command: [process.execPath, fakeOmp] } } }),
  );

  const cfgPort = PORT + 1;
  const viaConfig = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", cfgTarget, "--port", String(cfgPort)],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...NO_AUTO_MAP, SHAPE_HOME: cfgHome, HOME: cfgHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let cfgErr = "";
  viaConfig.stderr.setEncoding("utf8");
  viaConfig.stderr.on("data", (d) => {
    cfgErr += d;
  });
  try {
    await waitFor("bridge listening with a config-supplied command", () => cfgErr.includes("canvas at ws://"));
    const started = ompFrames(ompLogIn(cfgTarget)).find((f) => f.type === "__start");
    check(
      "SHAPE_HOME config's command array is the harness that gets spawned",
      started !== undefined &&
        started.cwd === realpathSync(cfgTarget) &&
        // and it is started as a harness on the link, not as a piped protocol:
        // the canvas tool rides in on the extension omp is launched with
        started.argv.includes("--extension"),
      JSON.stringify(started ?? null),
    );
  } catch (err) {
    check("bridge starts from a SHAPE_HOME config alone", false, String(err));
  } finally {
    viaConfig.kill("SIGKILL");
    await sleep(100);
  }

  // project config wins over the user's and over the built-in default
  const projectConfig = join(cfgTarget, ".shape", "config.json");
  await mkdir(join(cfgTarget, ".shape"), { recursive: true });
  await writeFile(projectConfig, JSON.stringify({ backend: "nope" }));
  const bad = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", cfgTarget, "--port", String(PORT + 2), "--omp", `${process.execPath} ${fakeOmp}`],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...NO_AUTO_MAP, SHAPE_HOME: cfgHome, HOME: cfgHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let badErr = "";
  bad.stderr.setEncoding("utf8");
  bad.stderr.on("data", (d) => {
    badErr += d;
  });
  const badExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 8000);
    bad.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  check(
    "a project config naming an unknown harness fails startup and lists the ones Shape can start",
    badExit !== 0 && badExit !== "timeout" && /unknown harness "nope"/.test(badErr) &&
      /Shape can start omp, claude/.test(badErr),
    `exit=${badExit} stderr=${badErr.trim().split("\n").pop() ?? ""}`,
  );
  bad.kill("SIGKILL");

  await rm(projectConfig, { force: true });
  check("the offending project config is gone again", !existsSync(projectConfig));
  await rm(cfgTarget, { recursive: true, force: true });
  await rm(cfgHome, { recursive: true, force: true });
}

// --- a canvas stored under the project key an older Shape derived -----------
// Written before the bridge exists, exactly as the upgrade finds it: the graph,
// its revisions, an audit line and a registry row, all under
// sha256(machine + the directory). The attach that switches onto this project
// has to move them onto the key this build derives from the repo's common dir.
const OLD_KEY = legacyProjectKeyOf(oldKeyTarget);
const OLD_KEY_NODE = { id: "old-key-canvas", parentId: null, label: "Drawn under the old key", summary: "Must survive the upgrade.", phase: "built" };
{
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  const seeded = openSqliteStorage(shapeDb);
  await seeded.saveGraph("local", OLD_KEY, wtOldKey, { rev: 7, nodes: [OLD_KEY_NODE], edges: [] });
  await seeded.saveRevision("local", OLD_KEY, wtOldKey, {
    rev: 7,
    at: "2026-01-01T00:00:00.000Z",
    nodes: [OLD_KEY_NODE],
    edges: [],
  });
  await seeded.appendAudit("local", OLD_KEY, wtOldKey, {
    kind: "deliver",
    id: "old-key-steer",
    referent: null,
    text: "steered before the upgrade",
    at: "2026-01-01T00:00:00.000Z",
    tenant: "local",
    projectId: OLD_KEY,
    worktree: wtOldKey,
  });
  await seeded.saveProject({
    project: {
      key: OLD_KEY,
      label: basename(oldKeyTarget),
      cwd: wtOldKey,
      backend: { id: "omp", label: "omp", capabilities: { steerMidTurn: true, hostTool: true, events: "native", resume: true, terminal: "pane" } },
      targetHasCode: true,
      canPublish: false,
      legacyKeys: {},
    },
    tenant: "local",
    worktrees: [{ id: wtOldKey, path: wtOldKey, branch: "main", head: null }],
    sessions: [],
    lastSeen: "2026-01-01T00:00:00.000Z",
  });
  seeded.close();
}

try {
  bridge = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", target, "--port", String(PORT), "--omp", "node scripts/fake-omp-tui.mjs"],
    {
      cwd: process.cwd(),
      // held turns keep the session streaming long enough to test the steer branch;
      // SHAPE_HOME/HOME keep recents.json and "~" out of the real home dir.
      // SHAPE_GH is the fake gh: publishing is exercised without a real account,
      // and the git identity makes the initial commit possible in a bare temp dir.
      env: {
        ...process.env,
        ...NO_AUTO_MAP,
        FAKE_OMP_TURN_HOLD_MS: "1200",
        SHAPE_HOME: fakeHome,
        HOME: fakeHome,
        SHAPE_GH: fakeGh,
        FAKE_GH_LOG: fakeGhLog,
        GIT_AUTHOR_NAME: "smoke",
        GIT_AUTHOR_EMAIL: "smoke@example.com",
        GIT_COMMITTER_NAME: "smoke",
        GIT_COMMITTER_EMAIL: "smoke@example.com",
      },
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
  // the canvas tool is not registered over a wire any more: the harness is
  // launched with the extension that registers it, on the link it is given
  const mainStart = await waitFor("the harness process the bridge launched", () =>
    ompFrames(ompLog).find((f) => f.type === "__start"),
  );
  check(
    "the harness is launched as a session on the loopback link, with the canvas extension",
    mainStart.argv.includes("--extension") && mainStart.link.startsWith("ws://") && mainStart.link.endsWith("/link"),
    `${JSON.stringify(mainStart.argv)} ${String(mainStart.link)}`,
  );

  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  socket.once("open", opened.resolve);
  socket.once("error", opened.reject);
  await opened.promise;

  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check(
    "hello carries one canvas per variation + session + per-variation agent state",
    hello.graphs?.[wtA] !== undefined && hello.session?.cwd === wtA && hello.agents?.[wtA] === "idle",
    `session=${JSON.stringify(hello.session)} graphs=${JSON.stringify(Object.keys(hello.graphs ?? {}))}`,
  );
  check(
    "hello reports an empty intent layer",
    hello.graphs[wtA].nodes.length === 0 && hello.graphs[wtA].edges.length === 0,
  );
  // the harness facts are per variation now: one running session, in the
  // worktree the CLI was pointed at
  const started = hello.session.sessions.find((s) => s.worktree === wtA);
  const backend = started?.backend;
  check(
    "hello names the backend it is driving, against the variation it runs in",
    started?.worktree === wtA && backend?.id === "omp" && backend.label === "oh-my-pi",
    JSON.stringify(hello.session.sessions),
  );
  check(
    "hello carries the backend's capability object",
    backend?.capabilities !== undefined &&
      backend.capabilities.steerMidTurn === true &&
      backend.capabilities.hostTool === true &&
      backend.capabilities.events === "native" &&
      backend.capabilities.resume === true &&
      backend.capabilities.terminal === "pane",
    JSON.stringify(backend?.capabilities ?? null),
  );
  check(
    "hello says how this project starts a harness, and what it found to start",
    hello.tools?.launcher === "pty" &&
      Array.isArray(hello.tools.harnesses) &&
      hello.tools.harnesses.some((t) => t.id === "omp") &&
      Array.isArray(hello.tools.launchers),
    JSON.stringify(hello.tools ?? null),
  );

  // --- startup reality extraction -------------------------------------------
  if (existsSync("src/reality.ts")) {
    const pkgs = hello.graphs[wtA].reality.nodes.map((n) => n.id).sort();
    check("reality extracted before the first hello", pkgs.length === 2, pkgs.join(","));
    check(
      "reality layer records git HEAD",
      typeof hello.graphs[wtA].reality.head === "string",
      String(hello.graphs[wtA].reality.head).slice(0, 8),
    );
    check("targetHasCode from workspace packages", hello.session.targetHasCode === true);
  } else {
    check("targetHasCode from the source-file fallback", hello.session.targetHasCode === true);
  }

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
  check(
    "hello carries a canvas for every variation nobody opened, and a revision list for each",
    hello.graphs[wtVariation] !== undefined &&
      hello.graphs[wt2] !== undefined &&
      Array.isArray(hello.revisions[wtA]) &&
      Array.isArray(hello.revisions[wtVariation]) &&
      Array.isArray(hello.revisions[wt2]),
    JSON.stringify({ graphs: Object.keys(hello.graphs), revisions: Object.keys(hello.revisions) }),
  );
  check(
    "only the worktree the bridge was started in has a session, and only it has an agent state",
    hello.session.sessions.length === 1 &&
      hello.session.sessions[0].worktree === wtA &&
      hello.agents[wtVariation] === undefined,
    JSON.stringify({ sessions: hello.session.sessions.map((s) => s.worktree), agents: Object.keys(hello.agents) }),
  );
  check(
    "every variation of a repo is one project: the key is the repo's, not a directory's",
    hello.projectId === projectKeyOf(target),
    `${hello.projectId} / ${projectKeyOf(target)}`,
  );
  check(
    "`.shape/` was added to the repo's shared info/exclude",
    readFileSync(join(target, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l.trim() === ".shape/").length === 1,
  );

  // --- onboarding stage 1: mechanical skeleton ------------------------------
  socket.send(JSON.stringify({ type: "onboard", worktree: wtA, focus: "the auth path" }));

  const skeleton = await waitFor("skeleton graph", () =>
    frames.find((f) => f.type === "graph" && f.worktree === wtA && f.graph.nodes.some((n) => n.id === "t-auth")),
  );
  const skeletonIds = skeleton.graph.nodes.map((n) => n.id).sort();
  const tAuth = skeleton.graph.nodes.find((n) => n.id === "t-auth");
  check("skeleton has one node per workspace package", skeletonIds.join(",") === "t-auth,t-db", skeletonIds.join(","));
  check(
    "skeleton nodes are built with real codeRefs and a placeholder promise",
    tAuth.phase === "built" && tAuth.codeRefs.join(",") === "packages/auth" && tAuth.label === "auth" && tAuth.summary === "Workspace package at packages/auth — survey pending.",
    JSON.stringify(tAuth),
  );
  check(
    "skeleton has a depends edge per reality edge",
    skeleton.graph.edges.length === 1 && skeleton.graph.edges[0].id === "t-auth--t-db" && skeleton.graph.edges[0].kind === "depends",
    JSON.stringify(skeleton.graph.edges),
  );

  // --- onboarding stage 2: survey prompt ------------------------------------
  const survey = await waitFor("survey prompt", () =>
    ompFrames(ompLog).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("<onboarding-survey>")),
  );
  check("survey prompt carried the preamble (first delivery of the process)", survey.body.includes("<canvas-harness>"));
  check(
    "survey prompt states the anti-diary rule and the boundary test verbatim",
    survey.body.includes("NOT from README or doc prose") &&
      survey.body.includes("can you state what it promises to the rest of the system in one sentence, and would deleting it break a named set of importers?"),
  );
  check(
    "survey prompt states the altitude bound and demands grouping",
    survey.body.includes("3-5 top-level bubbles") &&
      survey.body.includes("The skeleton is flat on purpose; your first job is to group it") &&
      survey.body.includes("introduce named parent bubbles"),
  );
  check(
    "survey prompt states the product pass: root first, then 3-5 capabilities under it",
    survey.body.includes("9. Then the product pass, and it starts from ONE bubble: the product itself.") &&
      survey.body.includes('`layer: "product"` with `parentId: null`') &&
      /is the only top-level product bubble: a second one is rejected with `op\/second-root`/.test(survey.body) &&
      /the root stands for the entire build layer it needs no `realizes`/.test(survey.body) &&
      /Then hang 3-5\s+capability bubbles under it/.test(survey.body) &&
      /Every capability under the root MUST\s+set `realizes` to the ids of those build bubbles/.test(survey.body) &&
      /a capability without one is rejected/.test(survey.body) &&
      survey.body.includes("Product bubbles need no"),
  );
  // the preamble is one hard-wrapped paragraph, so these phrases are read off a
  // whitespace-flattened copy: what is asserted is the sentence, not the column
  // it happens to break at
  const surveyFlat = survey.body.replace(/\s+/g, " ");
  check(
    "preamble opens greenfield work at the product root and names all three cross-layer links",
    surveyFlat.includes("FOUR LAYERS — PRODUCT, BUILD, INFRA and CORRECTNESS.") &&
      surveyFlat.includes("THE WHOLE GRAPH STARTS FROM ONE BUBBLE: the product.") &&
      surveyFlat.includes("second top-level product bubble: a capability that forgets its parent comes back rejected with `op/second-root`") &&
      surveyFlat.includes("Starting from nothing, start in the product layer, and start with the product bubble itself.") &&
      surveyFlat.includes("create the root from the user's idea, then turn that idea into 3 to 5 capability bubbles underneath it") &&
      surveyFlat.includes("They meet through exactly three links — `realizes` on a capability") &&
      surveyFlat.includes("`hosts` on a piece of infrastructure, the ids of the build bubbles that run on it or use it") &&
      surveyFlat.includes("`verifies` on a check, the ids of the build bubbles it attests") &&
      surveyFlat.includes('Set `layer: "product"` on a capability bubble') &&
      surveyFlat.includes('`layer: "correctness"` on a check'),
  );
  check(
    // user decision 2026-09-04: the agent is told the default before it can
    // break it, and told what the canvas answers with when it does
    "preamble states that connection is the default and names the warning it comes back as",
    surveyFlat.includes("CONNECTION IS THE DEFAULT: whatever can be linked to something in another layer should be.") &&
      surveyFlat.includes("a capability that delivers it, the infrastructure it runs on, and something that checks it") &&
      surveyFlat.includes("the canvas answers with a `link/...` warning on the tool receipt") &&
      surveyFlat.includes("which you write in the same turn rather than leaving for later") &&
      // the same-turn verification rule is untouched by it
      surveyFlat.includes("A BUILT BUBBLE NOTHING VERIFIES IS A CLAIM."),
  );
  check(
    "the survey says the default outright and closes on the whole connected picture",
    /Connection is the default on this canvas, not an extra: a capability whose realizers you/.test(survey.body) &&
      surveyFlat.includes("every capability names the parts that realize it") &&
      surveyFlat.includes("every top-level build group is reached by a capability, by the infrastructure it runs on and by something that checks it") &&
      surveyFlat.includes("closing it is part of this survey rather than something to leave for later"),
  );
  check("survey prompt lists the mechanical skeleton", /- t-auth "auth" — "Workspace package at packages\/auth/.test(survey.body));
  check("survey prompt carries the user focus", survey.body.includes('User focus for this survey: "the auth path"'));

  // --- plain-English register (CONTRACTS.md §Graph document) ----------------
  check(
    "preamble carries the register rule with a contrasting example",
    survey.body.includes("Register — PLAIN ENGLISH, NO JARGON.") &&
      survey.body.includes('BAD:  "Minimal JSONL RPC client, protocol v1, id-correlated request()"') &&
      survey.body.includes('GOOD: "Talks to the coding agent: sends it instructions and listens to everything it does"') &&
      survey.body.includes("`codeRefs` are the one exception"),
  );
  check(
    "survey prompt repeats the register rule for the summaries it asks for",
    survey.body.includes("2. PLAIN ENGLISH, NO JARGON.") &&
      survey.body.includes("outcomes, not mechanisms") &&
      survey.body.includes("replace every one of them with a plain-English promise"),
  );
  // The canvas tool no longer crosses a wire to be registered: the omp
  // extension registers it inside the harness from the one description the
  // bridge exports (packages/link/src/omp-extension.ts, and the MCP server
  // below). The rule it has to state is asserted on that description itself.
  const { CANVAS_TOOL_DESCRIPTION } = await import(new URL("../../shared/src/index.ts", import.meta.url));
  check(
    "canvas tool description states the register rule",
    CANVAS_TOOL_DESCRIPTION.includes("PLAIN ENGLISH, NO JARGON:") &&
      CANVAS_TOOL_DESCRIPTION.includes("Only codeRefs stay technical."),
    CANVAS_TOOL_DESCRIPTION.slice(0, 40),
  );

  // --- onboarding validation mode -------------------------------------------
  const surveyResult = await waitFor("survey canvas result", () =>
    ompFrames(ompLog).find((f) => f.type === "canvas_result" && f.text.includes("onboarding/unknown-coderef")),
  );
  const resultText = surveyResult.text;
  check("valid enrich applied, unpointable node rejected", resultText.startsWith("applied 1 op(s);"), JSON.stringify(resultText));
  const surveyReceipts = receipts(resultText).rejections;
  const ghost = surveyReceipts.find((r) => r.code === "onboarding/unknown-coderef");
  check(
    "survey veto receipt names the node, the missing path, and a fix",
    ghost?.index === 1 && ghost.subject.id === "ghost" && ghost.subject.path === "/ops/1/node/codeRefs/0" &&
      ghost.evidence.ref === "packages/nope" && ghost.supportedFixes.length >= 1 &&
      ghost.message.includes('codeRefs path "packages/nope" does not exist'),
    JSON.stringify(ghost),
  );

  const enriched = await waitFor("enriched graph", () =>
    frames.find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "t-auth" && n.status !== undefined)),
  );
  const surveyed = enriched.graph.nodes.find((n) => n.id === "t-auth");
  check("survey enrichment kept phase built and set status", surveyed.phase === "built" && surveyed.status === "reading how the other parts use it", JSON.stringify(surveyed));
  check("survey enrichment replaced the placeholder summary", surveyed.summary.startsWith("Validates credentials"), surveyed.summary);
  check("rejected node never entered the graph", !enriched.graph.nodes.some((n) => n.id === "ghost"));

  const persistedSurvey = await waitFor("the survey's graph in the bridge's database", () => storedGraph(target));
  check(
    "status persisted to the project's graph row",
    persistedSurvey.nodes.find((n) => n.id === "t-auth")?.status === "reading how the other parts use it",
  );

  await waitFor("agent:idle after the survey", () => frames.find((f) => f.type === "agent" && f.state === "idle"));
  check("survey turn ended", true);

  const surveyMark = await waitFor("the survey's mark on the canvas", () =>
    frames.find((f) => f.type === "graph" && f.worktree === wtA && f.graph.surveyed !== undefined),
  );
  check(
    "delivering the survey marks the canvas as mapped, at the HEAD it was mapped against",
    surveyMark.graph.surveyed.head === surveyMark.graph.reality.head &&
      typeof surveyMark.graph.surveyed.at === "string",
    JSON.stringify(surveyMark.graph.surveyed),
  );

  // A second onboard is not refused any more: a canvas with bubbles gets the
  // catch-up turn instead. This fixture's map covers every package and every
  // file the mechanics read and nothing has drifted, so there is nothing to
  // catch up — and saying that is the whole answer. The drifted half, where the
  // prompt lists what the map is missing, has its own bridge at the end of this
  // file.
  const catchUpAt = frames.length;
  socket.send(JSON.stringify({ type: "onboard", worktree: wtA }));
  const matched = await waitFor("the answer to a second onboard", () =>
    frames.slice(catchUpAt).find((f) => f.type === "error"),
  );
  check(
    "onboard on a canvas that already matches the code says so instead of refusing to look at it",
    matched.message === "onboard: the map already matches the code",
    matched.message,
  );

  // --- turn 1: normal utterance (validation mode must be off again) ---------
  socket.send(JSON.stringify({ type: "utterance", worktree: wtA, referent: null, text: "build me an auth service" }));

  await waitFor("agent:streaming", () => frames.find((f) => f.type === "agent" && f.state === "streaming"));
  check("agent -> streaming", true);

  const assistant = await waitFor("assistant transcript", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant" && f.text.startsWith("ack: ")),
  );
  check(
    "assistant transcript coalesced on message_end",
    assistant.text.endsWith(" — sketching the canvas."),
    JSON.stringify(assistant.text),
  );

  const graph = await waitFor("graph with the new stub nodes", () =>
    frames.find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "user-db")),
  );
  const ids = graph.graph.nodes.map((n) => n.id).sort();
  const edgeIds = graph.graph.edges.map((e) => e.id);
  check("graph broadcast contains the stub nodes", ids.join(",") === "auth-service,t-auth,t-db,user-db", ids.join(","));
  check("graph broadcast contains the stub edge", edgeIds.includes("auth-service--user-db"), edgeIds.join(","));

  const normalResult = await waitFor("normal-mode canvas result", () =>
    ompFrames(ompLog).find((f) => f.type === "canvas_result" && f.text.startsWith("applied 3 op(s);")),
  );
  check(
    "validation mode reset: codeRefs-less node accepted after agent_end",
    !normalResult.text.includes("rejected") &&
      graph.graph.nodes.find((n) => n.id === "user-db")?.codeRefs === undefined,
    normalResult.text,
  );

  const toolLine = frames.find((f) => f.type === "transcript" && f.role === "tool" && f.text === "canvas: initial decomposition");
  check("canvas tool transcript line", toolLine !== undefined);

  // the harness opens a file first and writes to the canvas after, so the file
  // is what lights up first — and the call then replaces it with what it wrote
  const activity = await waitFor("activity from the file the harness opened", () =>
    frames.find((f) => f.type === "activity" && f.nodeIds.includes("t-auth")),
  );
  check(
    "activity mapped tool path -> codeRefs node",
    activity.nodeIds.slice().sort().join(",") === "t-auth",
    activity.nodeIds.join(","),
  );

  const unionFrame = await waitFor("activity after the canvas call", () =>
    frames.slice(frames.indexOf(activity) + 1).find((f) => f.type === "activity" && f.nodeIds.includes("user-db")),
  );
  check(
    "a canvas call lights the bubbles it wrote, in place of the file it was reading",
    unionFrame.nodeIds.slice().sort().join(",") === "auth-service,user-db",
    unionFrame.nodeIds.join(","),
  );

  await waitFor("activity cleared", () =>
    frames.slice(frames.indexOf(unionFrame) + 1).find((f) => f.type === "activity" && f.nodeIds.length === 0),
  );
  check("activity cleared on turn_end", true);

  // --- structured repair receipts: malformed batch against the live bridge --
  await waitFor("agent:idle before the bad-op probe", () =>
    frames.filter((f) => f.type === "agent" && f.state === "idle").length >= 2 ? true : null,
  );
  socket.send(JSON.stringify({ type: "utterance", worktree: wtA, referent: null, text: "bad-op probe" }));
  const badResult = await waitFor("bad-op canvas result", () =>
    ompFrames(ompLog).find((f) => f.type === "canvas_result" && f.text.includes("op/unknown-parent")),
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
  const badPhase = badReceipts.find((r) => r.code === "op/bad-phase");
  check(
    "bad-phase receipt: subject annotated from the live node, allowed values in evidence",
    badPhase?.index === 1 && badPhase.subject.id === "auth-service" && badPhase.subject.label === "Auth Service" &&
      badPhase.evidence.allowed.includes("building"),
    JSON.stringify(badPhase),
  );
  const unknownOp = badReceipts.find((r) => r.code === "op/unknown-op");
  check(
    "unknown-op receipt lists the supported ops as a fix",
    unknownOp?.index === 2 && unknownOp.supportedFixes.some((f) => f.includes("upsert_node")),
    JSON.stringify(unknownOp),
  );
  const revBefore = graph.graph.rev;
  check("all-rejected batch did not bump rev", !frames.some((f) => f.type === "graph" && f.graph.rev > revBefore));
  await waitFor("agent:idle after the bad-op turn", () =>
    frames.filter((f) => f.type === "agent" && f.state === "idle").length >= 3 ? true : null,
  );

  // --- turn 2: utterance WITH referent --------------------------------------
  socket.send(
    JSON.stringify({
      type: "utterance",
      worktree: wtA,
      referent: { kind: "node", id: "auth-service" },
      text: "this should also handle token refresh",
    }),
  );

  const addressed = await waitFor("omp received the addressed instruction", () =>
    ompFrames(ompLog).find((f) => f.type === "deliver" && f.body.includes("token refresh")),
  );

  check("delivered as prompt or steer", addressed.mode === "prompt" || addressed.mode === "steer", addressed.mode);
  check("message contains <canvas-steering>", addressed.body.includes("<canvas-steering>"));
  check("message contains the node label", addressed.body.includes("Auth Service"));
  check("message contains the utterance", addressed.body.includes("this should also handle token refresh"));
  check(
    "message contains the neighbor line",
    /Neighbors: user-db \[dataflow "credentials"\]/.test(addressed.body),
    addressed.body.split("\n")[2],
  );
  check("later deliveries did not repeat the preamble", !addressed.body.includes("<canvas-harness>"));

  // --- turn 3: utterance with an EDGE referent while the turn is streaming ---
  await waitFor("turn 2 streaming", () =>
    frames.filter((f) => f.type === "transcript" && f.role === "assistant" && f.text.startsWith("ack: ")).length >= 2,
  );
  socket.send(
    JSON.stringify({
      type: "utterance",
      worktree: wtA,
      referent: { kind: "edge", id: "auth-service--user-db" },
      text: "make this async with a queue in between",
    }),
  );

  const steered = await waitFor("mid-stream delivery", () =>
    ompFrames(ompLog).find((f) => f.type === "deliver" && f.body.includes("make this async")),
  );
  check("mid-stream utterance delivered as steer", steered.mode === "steer", steered.mode);
  check(
    "edge referent resolved with endpoints",
    steered.body.includes("<canvas-steering>") &&
      /Referent: edge "credentials" \(id: auth-service--user-db\) — dataflow from auth-service to user-db/.test(steered.body) &&
      steered.body.includes('auth-service "Auth Service"'),
    steered.body.split("\n")[1],
  );
  await waitFor("steer echoed back to the panel", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant" && f.text.startsWith("steered:")),
  );
  check("steer acknowledgement reached the transcript", true);

  // --- persistence ----------------------------------------------------------
  const persisted = await waitFor(
    "the project's graph in the bridge's database",
    () => {
      const doc = storedGraph(target);
      return doc !== null && doc.nodes.length === 4 ? doc : null;
    },
  );
  check(
    "the graph is persisted as one row of the bridge's database",
    persisted.rev >= 1 && persisted.nodes.length === 4 && persisted.edges.length === 2,
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
    "one snapshot row per revision, keyed by project and rev",
    revs.length >= 2 && revs[revs.length - 1] === persisted.rev,
    `revs=${revs.join(",")} docRev=${persisted.rev}`,
  );
  const first = revs[0];
  const last = revs[revs.length - 1];
  const opening = snapshotAt(first);
  check(
    "the opening revision was snapshotted as an empty canvas",
    first === 0 && opening.nodes.length === 0 && opening.edges.length === 0 && typeof opening.at === "string",
    `rev=${first} nodes=${opening.nodes.length} at=${opening.at}`,
  );
  check(
    "hello carries a revision list per variation",
    Array.isArray(hello.revisions[wtA]) &&
      hello.revisions[wtA].every((r) => typeof r.rev === "number" && typeof r.at === "string"),
    JSON.stringify(hello.revisions[wtA]),
  );
  const revList = await waitFor("revisions broadcast after a snapshot", () =>
    frames.find((f) => f.type === "revisions" && f.worktree === wtA && f.revisions.length >= 2),
  );
  check(
    "a new snapshot broadcasts an ascending revision list",
    revList.revisions.every((r, i, all) => i === 0 || all[i - 1].rev < r.rev),
    JSON.stringify(revList.revisions.map((r) => r.rev)),
  );

  const finalNodeIds = persisted.nodes.map((n) => n.id).sort().join(",");
  const finalEdgeIds = persisted.edges.map((e) => e.id).sort().join(",");
  socket.send(JSON.stringify({ type: "diff", worktree: wtA, revA: first, revB: last }));
  const delta = await waitFor("delta frame", () =>
    frames.find((f) => f.type === "delta" && f.delta.revA === first && f.delta.revB === last),
  );
  check(
    "diff over the whole history reports every node and edge as added",
    delta.delta.nodes.added.map((n) => n.id).join(",") === finalNodeIds &&
      delta.delta.edges.added.map((e) => e.id).join(",") === finalEdgeIds &&
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

  // the survey turn only rewrote t-auth's promise: that pair of revisions must
  // read as one changed node, nothing added, nothing removed
  const surveyRev = revs.find((rev) =>
    (snapshotAt(rev).nodes.find((n) => n.id === "t-auth")?.summary ?? "").startsWith("Validates credentials"),
  );
  const skeletonRev = revs[revs.indexOf(surveyRev) - 1];
  socket.send(JSON.stringify({ type: "diff", worktree: wtA, revA: skeletonRev, revB: surveyRev }));
  const enrichment = await waitFor("delta for the survey enrichment", () =>
    frames.find((f) => f.type === "delta" && f.delta.revA === skeletonRev && f.delta.revB === surveyRev),
  );
  const promiseChange = enrichment.delta.nodes.changed;
  check(
    "consecutive-revision diff marks only the enriched node as changed",
    promiseChange.length === 1 &&
      promiseChange[0].before.id === "t-auth" &&
      promiseChange[0].before.summary.startsWith("Workspace package at") &&
      promiseChange[0].after.summary.startsWith("Validates credentials") &&
      enrichment.delta.nodes.added.length === 0 &&
      enrichment.delta.nodes.removed.length === 0 &&
      enrichment.delta.edges.added.length === 0 &&
      enrichment.delta.edges.changed.length === 0,
    JSON.stringify({ pair: [skeletonRev, surveyRev], changed: promiseChange.map((c) => c.after.id) }),
  );

  socket.send(JSON.stringify({ type: "diff", worktree: wtA, revA: last, revB: first }));
  const reversed = await waitFor("delta for the reversed pair", () =>
    frames.find((f) => f.type === "delta" && f.delta.revA === last && f.delta.revB === first),
  );
  check(
    "reversing the pair reports the same nodes and edges as removed",
    reversed.delta.nodes.removed.map((n) => n.id).join(",") === finalNodeIds &&
      reversed.delta.edges.removed.map((e) => e.id).join(",") === finalEdgeIds &&
      reversed.delta.nodes.added.length === 0 &&
      reversed.delta.edges.added.length === 0,
    JSON.stringify(reversed.delta.nodes.removed.map((n) => n.id)),
  );

  socket.send(JSON.stringify({ type: "diff", worktree: wtA, revA: first, revB: 9999 }));
  const badDiff = await waitFor("bogus diff refused", () =>
    frames.find((f) => f.type === "error" && f.message.startsWith("unknown revision")),
  );
  check("diff against a nonexistent revision is refused", badDiff.message === "unknown revision 9999", badDiff.message);

  // --- abort ----------------------------------------------------------------
  socket.send(JSON.stringify({ type: "abort", worktree: wtA }));
  await waitFor("abort forwarded", () => ompFrames(ompLog).some((f) => f.type === "abort"), 3000);
  check("abort forwarded to omp", true);

  // --- recents + project switching ------------------------------------------
  check("hello carries recentProjects", Array.isArray(hello.recentProjects) && hello.recentProjects[0] === wtA, JSON.stringify(hello.recentProjects));
  const childA = ompFrames(ompLog).find((f) => f.type === "__start");

  socket.send(JSON.stringify({ type: "switch_project", path: targetB }));
  const helloB = await waitFor("hello after switch", () =>
    frames.find((f) => f.type === "hello" && f.session.cwd === wtB),
  );
  check("switch_project re-hellos with the new target", helloB.session.cwd === wtB);
  const backendB = helloB.session.sessions.find((s) => s.worktree === wtB)?.backend;
  check(
    "the re-created backend is reported for the new target",
    backendB?.id === "omp" && backendB.capabilities.events === "native",
    JSON.stringify(helloB.session.sessions),
  );
  check(
    "new target starts from its own (empty) graph",
    helloB.graphs[wtB].nodes.length === 0 && helloB.graphs[wtB].rev !== persisted.rev,
    `rev=${helloB.graphs[wtB].rev} nodes=${helloB.graphs[wtB].nodes.length}`,
  );
  check(
    "the project it left is not on the new target's view: one project, its own worktrees",
    Object.keys(helloB.graphs).join(",") === wtB,
    Object.keys(helloB.graphs).join(","),
  );
  check(
    "new target's reality layer was extracted before the hello",
    helloB.graphs[wtB].reality.nodes.map((n) => n.id).sort().join(",") === "r:@b/auth,r:@b/db",
    helloB.graphs[wtB].reality.nodes.map((n) => n.id).join(","),
  );
  check("recents are most-recent-first and deduped", helloB.recentProjects.join(" | ") === `${wtB} | ${wtA}`, helloB.recentProjects.join(" | "));
  check(
    "recents.json written under SHAPE_HOME",
    JSON.parse(await readFile(join(fakeHome, ".shape", "recents.json"), "utf8"))[0] === wtB,
  );

  // the file a harness Shape never registered a tool in reads to find the
  // canvas: written under SHAPE_HOME per project, rewritten on every open
  const directiveFile = join(fakeHome, ".shape", "server", "projects", projectKeyOf(targetB), "shape-directive.md");
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
    helloB.session.directivePath === directiveFile,
    `${helloB.session.directivePath} / ${directiveFile}`,
  );

  const persistedA = storedGraph(target);
  check("the old project's graph was persisted before switching away", persistedA.nodes.length === 4 && persistedA.edges.length === 2, `nodes=${persistedA.nodes.length}`);

  await waitFor("the old harness process to go", () => gone(childA.pid));
  check("old omp child is gone and the bridge survived it", bridge.exitCode === null, `pid=${childA.pid} bridgeExit=${bridge.exitCode}`);

  socket.send(JSON.stringify({ type: "switch_project", path: join(targetB, "does-not-exist") }));
  const badSwitch = await waitFor("bad switch refused", () =>
    frames.find((f) => f.type === "error" && f.message.startsWith("switch_project rejected")),
  );
  check("non-directory path refused", badSwitch.message.includes("is not an existing directory"), badSwitch.message);
  check("no extra hello after the refused switch", frames.filter((f) => f.type === "hello").length === 2);

  socket.send(JSON.stringify({ type: "utterance", worktree: wtB, referent: null, text: "start the b project" }));
  const bPrompt = await waitFor("utterance reached the new child", () =>
    ompFrames(ompLogIn(targetB)).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("start the b project")),
  );
  check("post-switch utterance served by the new child", bPrompt !== undefined);
  check("new session earns the preamble again", bPrompt.body.includes("<canvas-harness>"));
  const childB = ompFrames(ompLogIn(targetB)).find((f) => f.type === "__start");
  check(
    "the new child is a different process in the new cwd",
    childB.pid !== childA.pid && childB.cwd === realpathSync(targetB),
    `A=${childA.pid} B=${childB.pid} cwd=${childB.cwd}`,
  );

  // --- "~" expansion + a switch cannot race another switch ------------------
  socket.send(JSON.stringify({ type: "switch_project", path: "~/proj" }));
  socket.send(JSON.stringify({ type: "switch_project", path: target }));
  const busy = await waitFor("concurrent switch refused", () =>
    frames.find((f) => f.type === "error" && f.message.includes("already in progress")),
  );
  check("second switch refused while one is in progress", busy.message.startsWith("switch_project rejected"), busy.message);

  const helloHome = await waitFor("hello for the home-relative target", () =>
    frames.find((f) => f.type === "hello" && f.session.cwd === wtHome),
  );
  check('"~" expanded against the home dir', helloHome.session.cwd === wtHome, helloHome.session.cwd);
  check(
    "home-relative project brought its own reality layer",
    helloHome.graphs[wtHome].reality.nodes.map((n) => n.id).sort().join(",") === "r:@h/auth,r:@h/db",
    helloHome.graphs[wtHome].reality.nodes.map((n) => n.id).join(","),
  );
  check("recents now lead with the home-relative project", helloHome.recentProjects[0] === wtHome, helloHome.recentProjects.length.toString());

  // --- several variations of one repo, each with its own harness ------------
  // Back on project A. Switching onto a repo the agent is not on is a full
  // retarget, and it opens a harness in exactly the directory it was given —
  // every other variation is on the view with a canvas and no session.
  const backAt = frames.length;
  socket.send(JSON.stringify({ type: "switch_project", path: target }));
  const helloA2 = await waitFor(
    "hello back on the first project",
    () => frames.slice(backAt).find((f) => f.type === "hello" && f.session.cwd === wtA),
    30_000,
  );
  check(
    "every variation of the repo is on the view, and only the opened one runs",
    Object.keys(helloA2.graphs).sort().join(",") === [wtA, wtVariation, wt2].sort().join(",") &&
      helloA2.session.sessions.map((s) => s.worktree).join(",") === wtA,
    JSON.stringify({ graphs: Object.keys(helloA2.graphs), sessions: helloA2.session.sessions.map((s) => s.worktree) }),
  );
  check(
    "each variation kept its own canvas: the turns above are the main one's alone",
    helloA2.graphs[wtA].nodes.map((n) => n.id).sort().join(",") === "auth-service,t-auth,t-db,user-db" &&
      helloA2.graphs[wtVariation].nodes.length === 0 &&
      helloA2.graphs[wt2].nodes.length === 0,
    JSON.stringify(Object.entries(helloA2.graphs).map(([id, g]) => `${id.split("/").pop()}:${g.nodes.length}`)),
  );

  const mainChild = ompFrames(ompLog).filter((f) => f.type === "__start").at(-1);
  const openAt = frames.length;
  socket.send(JSON.stringify({ type: "open_worktree", path: worktree2 }));
  const startedSecond = await waitFor(
    "session_started for the second variation",
    () => frames.slice(openAt).find((f) => f.type === "session_started" && f.worktree === wt2),
    30_000,
  );
  check(
    "open_worktree answers with the harness it started, against that variation",
    startedSecond.backend?.id === "omp" && startedSecond.session !== undefined,
    JSON.stringify(startedSecond),
  );
  const bothSessions = await waitFor("a session frame listing both harnesses", () =>
    frames.slice(openAt).find((f) => f.type === "session" && f.session.sessions.length === 2),
  );
  check(
    "the project runs one harness per opened variation and says which is which",
    bothSessions.session.sessions.map((s) => s.worktree).sort().join(",") === [wtA, wt2].sort().join(","),
    JSON.stringify(bothSessions.session.sessions.map((s) => s.worktree)),
  );
  const secondChild = await waitFor("a second fake-omp child for the second variation", () =>
    ompFrames(ompLogIn(worktree2)).find((f) => f.type === "__start"),
  );
  check(
    "the second harness is its own process, in the variation's own directory",
    secondChild.pid !== mainChild?.pid && secondChild.cwd === wt2,
    `main=${String(mainChild?.pid)} second=${secondChild.pid} cwd=${secondChild.cwd}`,
  );

  socket.send(JSON.stringify({ type: "utterance", worktree: wt2, referent: null, text: "shape the second variation", productFirst: false }));
  await waitFor("the utterance reached the second variation's harness", () =>
    ompFrames(ompLogIn(worktree2)).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("shape the second variation")),
  );
  check(
    "an utterance is served by the harness of the variation it named, and by no other",
    !ompFrames(ompLog).some((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("shape the second variation")),
  );
  const secondGraph = await waitFor("a graph frame for the second variation", () =>
    frames.slice(openAt).find((f) => f.type === "graph" && f.worktree === wt2 && f.graph.nodes.some((n) => n.id === "auth-service")),
  );
  check(
    "what that harness draws lands on ITS canvas and on no other",
    secondGraph.worktree === wt2 && !frames.slice(openAt).some((f) => f.type === "graph" && f.worktree !== wt2),
    JSON.stringify([...new Set(frames.slice(openAt).filter((f) => f.type === "graph").map((f) => f.worktree))]),
  );
  const secondStored = await waitFor("the second variation's own graph row", () => storedGraph(target, wt2));
  check(
    "one project, one key, a canvas row per variation",
    secondStored.nodes.some((n) => n.id === "auth-service") &&
      storedGraph(target, wtA).nodes.length === 4 &&
      (storedGraph(target, wtVariation)?.nodes.length ?? 0) === 0,
    JSON.stringify({
      second: secondStored.nodes.length,
      main: storedGraph(target, wtA).nodes.length,
      untouched: storedGraph(target, wtVariation)?.nodes.length ?? 0,
    }),
  );

  // a link caller says where it is running, and that is what places its writes
  const wt2LinkFrames = [];
  const wt2Link = new WebSocket(`ws://127.0.0.1:${PORT}/link`);
  wt2Link.on("message", (data) => wt2LinkFrames.push(JSON.parse(data.toString())));
  {
    const opened = Promise.withResolvers();
    wt2Link.once("open", opened.resolve);
    wt2Link.once("error", opened.reject);
    await opened.promise;
  }
  const wt2LinkAt = frames.length;
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
    "a link caller inside a variation is answered like any other",
    wt2LinkResult.isError === false && wt2LinkResult.text.startsWith("applied 1 op(s);"),
    wt2LinkResult.text.split("\n")[0],
  );
  const wt2LinkGraph = await waitFor("graph broadcast for the in-variation link call", () =>
    frames.slice(wt2LinkAt).find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "second-only")),
  );
  check(
    "where the caller runs is which canvas it writes: the second variation's",
    wt2LinkGraph.worktree === wt2 && !frames.slice(wt2LinkAt).some((f) => f.type === "graph" && f.worktree === wtA),
    wt2LinkGraph.worktree,
  );
  wt2Link.close();

  const auditRows = await waitFor("audit lines for both variations", () => {
    const rows = dbRows(
      "SELECT worktree, entry FROM audit WHERE tenant = ? AND key = ? ORDER BY seq ASC",
      "local",
      projectKeyOf(target),
    );
    return rows !== null && rows.some((r) => r.worktree === wt2) ? rows : null;
  });
  check(
    "every audit line says which variation it was steered through",
    auditRows.every((r) => typeof r.worktree === "string" && JSON.parse(r.entry).worktree === r.worktree) &&
      auditRows.some((r) => r.worktree === wtA) &&
      auditRows.some((r) => r.worktree === wt2 && JSON.parse(r.entry).text === "shape the second variation"),
    JSON.stringify(auditRows.map((r) => `${r.worktree === wtA ? "main" : "variation-2"}:${JSON.parse(r.entry).kind}`)),
  );

  const closeAt = frames.length;
  socket.send(JSON.stringify({ type: "close_worktree", worktree: wt2 }));
  const stopped = await waitFor("session_stopped for the closed variation", () =>
    frames.slice(closeAt).find((f) => f.type === "session_stopped" && f.worktree === wt2),
  );
  check("close_worktree stops that variation's harness and says why", typeof stopped.reason === "string" && stopped.reason.length > 0, stopped.reason);
  await waitFor("the second variation's harness process to go", () => gone(secondChild.pid));
  const afterClose = await waitFor("a session frame with only the first harness left", () =>
    frames.slice(closeAt).find((f) => f.type === "session" && f.session.sessions.length === 1),
  );
  check(
    "the variation stays on the view with its canvas; only its harness is gone",
    afterClose.session.sessions[0].worktree === wtA && afterClose.session.worktrees.some((w) => w.id === wt2),
    JSON.stringify(afterClose.session.sessions.map((s) => s.worktree)),
  );
  check(
    "info/exclude stayed idempotent across every startup",
    readFileSync(join(target, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l.trim() === ".shape/").length === 1,
  );

  // --- a canvas drawn before Shape kept state in a database ------------------
  // The files a pre-SQLite bridge wrote are taken over on the first attach: the
  // graph and its revisions move into the database, the leftovers are removed,
  // and the project's own config.json is left exactly where it is.
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
  socket.send(JSON.stringify({ type: "switch_project", path: legacyTarget }));
  const helloLegacy = await waitFor(
    "hello for the project whose canvas was left by an older Shape",
    () => frames.find((f) => f.type === "hello" && f.session.cwd === wtLegacy),
    30_000,
  );
  check(
    "a graph written by an older Shape opens as this project's canvas",
    helloLegacy.graphs[wtLegacy].nodes.some((n) => n.id === "old-canvas"),
    JSON.stringify(helloLegacy.graphs[wtLegacy].nodes.map((n) => n.id)),
  );
  check(
    "its revisions came over with their own timestamps, not the attach's",
    helloLegacy.revisions[wtLegacy].some((r) => r.rev === 1 && r.at === "2020-01-01T00:00:00.000Z"),
    JSON.stringify(helloLegacy.revisions[wtLegacy]),
  );
  check(
    "the imported canvas is a row of the database like any other project's",
    storedGraph(legacyTarget)?.nodes.some((n) => n.id === "old-canvas") === true,
    JSON.stringify(storedGraph(legacyTarget)?.nodes.map((n) => n.id) ?? null),
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

  // --- a canvas stored under the project key an older Shape derived ----------
  // The rows seeded before the bridge started sit under sha256(machine + the
  // directory); this build keys the same project off its repo's common dir. The
  // attach adopts them, so the canvas the user drew is the canvas they get back.
  socket.send(JSON.stringify({ type: "switch_project", path: oldKeyTarget }));
  const helloOldKey = await waitFor(
    "hello for the project whose canvas was stored under the old project key",
    () => frames.find((f) => f.type === "hello" && f.session.cwd === wtOldKey),
    30_000,
  );
  check(
    "a canvas stored under the previous project key opens as this project's",
    helloOldKey.graphs[wtOldKey].nodes.some((n) => n.id === "old-key-canvas") && helloOldKey.graphs[wtOldKey].rev >= 7,
    JSON.stringify({ nodes: helloOldKey.graphs[wtOldKey].nodes.map((n) => n.id), rev: helloOldKey.graphs[wtOldKey].rev }),
  );
  check(
    "its revisions came with it, timestamps and all",
    helloOldKey.revisions[wtOldKey].some((r) => r.rev === 7 && r.at === "2026-01-01T00:00:00.000Z"),
    JSON.stringify(helloOldKey.revisions[wtOldKey]),
  );
  check(
    "the row now lives under the key this build derives from the repo",
    storedGraph(oldKeyTarget)?.nodes.some((n) => n.id === "old-key-canvas") === true,
    JSON.stringify(storedGraph(oldKeyTarget)?.nodes.map((n) => n.id) ?? null),
  );
  check(
    "and nothing is left under the old one: one project, one canvas",
    (dbRows("SELECT worktree FROM graphs WHERE tenant = ? AND key = ?", "local", OLD_KEY) ?? []).length === 0 &&
      (dbRows("SELECT key FROM projects WHERE tenant = ? AND key = ?", "local", OLD_KEY) ?? []).length === 0,
    JSON.stringify({
      graphs: dbRows("SELECT worktree FROM graphs WHERE tenant = ? AND key = ?", "local", OLD_KEY),
      projects: dbRows("SELECT key FROM projects WHERE tenant = ? AND key = ?", "local", OLD_KEY),
    }),
  );
  const adoptedAudit = dbRows(
    "SELECT key, entry FROM audit WHERE tenant = ? AND worktree = ? ORDER BY seq ASC",
    "local",
    wtOldKey,
  );
  check(
    "what was steered before the upgrade is still on the record, under the new key",
    adoptedAudit.some((row) => row.key === projectKeyOf(oldKeyTarget) && JSON.parse(row.entry).id === "old-key-steer"),
    JSON.stringify(adoptedAudit.map((row) => `${row.key.slice(0, 6)}:${JSON.parse(row.entry).id}`)),
  );
  check(
    "the adoption is announced, naming the worktree it moved",
    stderr.includes(`adopted the canvas of ${wtOldKey} from its previous project key`),
  );

  // --- starting a new project from the canvas --------------------------------
  // SHAPE_GH points the agent at scripts/fake-gh.mjs, so the publish path is
  // exercised end to end without a real GitHub account.
  const ghLines = () =>
    existsSync(fakeGhLog)
      ? readFileSync(fakeGhLog, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
      : [];
  const gitIn = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  check("hello reports that this machine can publish to GitHub", hello.session.canPublish === true, JSON.stringify(hello.session.canPublish));

  const fresh = join(createRootReal, "demo-private");
  socket.send(JSON.stringify({ type: "create_project", path: fresh, github: { visibility: "private" } }));
  const helloNew = await waitFor(
    "hello after create_project",
    () => frames.find((f) => f.type === "hello" && f.session.cwd === fresh),
    30_000,
  );
  check("create_project re-hellos with the new project as the target", helloNew.session.cwd === fresh);
  check(
    "the new project is a folder under version control with an initial commit",
    existsSync(fresh) && existsSync(join(fresh, ".git")) && gitIn(fresh, ["rev-list", "--count", "HEAD"]) === "1",
    existsSync(fresh) ? gitIn(fresh, ["rev-list", "--count", "HEAD"]) : "missing",
  );
  check("an empty new project gets a README to commit", existsSync(join(fresh, "README.md")));
  const createdLine = await waitFor(
    "created transcript line",
    () => frames.find((f) => f.type === "transcript" && f.role === "tool" && f.text.startsWith("Started demo-private")),
    10_000,
  );
  check(
    "the transcript says what landed, in plain words, publishing included",
    createdLine.text === `Started demo-private at ${fresh} — new repository, published to https://github.com/fake/demo-private`,
    createdLine.text,
  );
  const ghCreate = ghLines().find((argv) => argv[0] === "repo" && argv[1] === "create");
  check(
    "gh was asked for a private repo and a push",
    ghCreate !== undefined && ghCreate.includes("--private") && ghCreate.includes("--push"),
    JSON.stringify(ghCreate ?? null),
  );
  check("gh auth was probed once, at agent startup", ghLines().filter((argv) => argv[0] === "auth").length === 1);

  // an existing but EMPTY folder is still a legitimate place to start
  const emptyDir = join(createRootReal, "empty-already");
  await mkdir(emptyDir, { recursive: true });
  socket.send(JSON.stringify({ type: "create_project", path: emptyDir, github: null }));
  const helloEmpty = await waitFor(
    "hello after starting in an existing empty folder",
    () => frames.find((f) => f.type === "hello" && f.session.cwd === emptyDir),
    30_000,
  );
  check("an existing empty folder can become a new project", helloEmpty.session.cwd === emptyDir);
  check(
    "the empty folder got its own repo, README and initial commit",
    existsSync(join(emptyDir, ".git")) &&
      existsSync(join(emptyDir, "README.md")) &&
      gitIn(emptyDir, ["rev-list", "--count", "HEAD"]) === "1",
    existsSync(join(emptyDir, ".git")) ? gitIn(emptyDir, ["rev-list", "--count", "HEAD"]) : "no repo",
  );

  // a folder with anything in it is somebody's work: refused before any git
  // command, so what is in there is left alone and nothing retargets
  const occupied = join(createRoot, "occupied");
  await mkdir(occupied, { recursive: true });
  await writeFile(join(occupied, "notes.txt"), "already here\n");
  const helloesBeforeOccupied = frames.filter((f) => f.type === "hello").length;
  socket.send(JSON.stringify({ type: "create_project", path: occupied, github: null }));
  const occupiedRefusal = await waitFor("create refused for a folder with files in it", () =>
    frames.find((f) => f.type === "error" && f.message.includes("already has files in it")),
  );
  check(
    "a folder that already has files in it is refused",
    occupiedRefusal.message.startsWith("create_project rejected:"),
    occupiedRefusal.message,
  );
  await sleep(300);
  check(
    "the refused folder is untouched: no repo, no new files, same contents",
    !existsSync(join(occupied, ".git")) &&
      readdirSync(occupied).join(",") === "notes.txt" &&
      readFileSync(join(occupied, "notes.txt"), "utf8") === "already here\n",
    readdirSync(occupied).join(","),
  );
  check(
    "no extra hello after the refused folder",
    frames.filter((f) => f.type === "hello").length === helloesBeforeOccupied,
  );

  // a path that is a file has nowhere to stand: refused, nothing retargets
  const helloesBefore = frames.filter((f) => f.type === "hello").length;
  const notADir = join(createRoot, "a-file.txt");
  await writeFile(notADir, "not a folder\n");
  socket.send(JSON.stringify({ type: "create_project", path: notADir, github: null }));
  const refused = await waitFor("create refused for a file path", () =>
    frames.find((f) => f.type === "error" && f.message.includes("exists and is not a directory")),
  );
  check(
    "a path that is a file is refused",
    refused.message.startsWith("create_project rejected:"),
    refused.message,
  );
  await sleep(300);
  check("no extra hello after the refused create", frames.filter((f) => f.type === "hello").length === helloesBefore);

  // inside an existing repo: adopted, never re-initialized — and, coming after
  // two refusals, this is also the proof that a refused create reopens the
  // guard instead of wedging it closed
  const nested = join(wtA, "sub-project");
  const nestedAt = frames.length;
  socket.send(JSON.stringify({ type: "create_project", path: nested, github: null }));
  const helloNested = await waitFor(
    "hello for the folder inside an existing repo",
    () => frames.slice(nestedAt).find((f) => f.type === "hello" && f.session.cwd === wtA),
    30_000,
  );
  check(
    "a folder inside a worktree is that repo's project, named by its main worktree",
    helloNested.projectId === projectKeyOf(target) && helloNested.session.cwd === wtA,
    `${helloNested.projectId} / ${helloNested.session.cwd}`,
  );
  const nestedLine = await waitFor(
    "created transcript line for the nested folder",
    () => frames.find((f) => f.type === "transcript" && f.role === "tool" && f.text.startsWith("Started sub-project")),
    10_000,
  );
  check(
    "a folder inside a repo joins that repo instead of starting its own",
    nestedLine.text === `Started sub-project at ${nested} — existing repository` && !existsSync(join(nested, ".git")),
    nestedLine.text,
  );

  // the link section below drives the second variation, so open a harness in
  // it: a switch onto a worktree of the project the agent is ALREADY on is not
  // a retarget at all, it is that variation being opened
  const openVariationAt = frames.length;
  socket.send(JSON.stringify({ type: "switch_project", path: worktree }));
  await waitFor(
    "a harness started in the variation, with no re-hello",
    () => frames.slice(openVariationAt).find((f) => f.type === "session_started" && f.worktree === wtVariation),
    30_000,
  );
  check(
    "switching onto a variation of the same project opens it instead of retargeting",
    frames.slice(openVariationAt).every((f) => f.type !== "hello"),
    JSON.stringify(frames.slice(openVariationAt).filter((f) => f.type === "hello").length),
  );

  // --- canvas calls light the bubbles they touch -----------------------------
  // The canvas is what the reader watches, so writing to it is also what says
  // where the agent is. A pulse socket stands in for the agent's own canvas
  // tool; it uses codeRefs no later section touches, so the bubbles it leaves
  // behind cannot change what the link and hook sections below observe.
  const pulseFrames = [];
  const pulseSocket = new WebSocket(`ws://127.0.0.1:${PORT}/link`);
  pulseSocket.on("message", (data) => pulseFrames.push(JSON.parse(data.toString())));
  {
    const opened = Promise.withResolvers();
    pulseSocket.once("open", opened.resolve);
    pulseSocket.once("error", opened.reject);
    await opened.promise;
  }

  // a first call, so the set the second one replaces is not the empty one
  pulseSocket.send(
    JSON.stringify({
      type: "canvas_call",
      cwd: wtVariation,
      id: "smoke-pulse-0",
      args: {
        ops: [
          {
            op: "upsert_node",
            node: {
              id: "pulse-c",
              parentId: null,
              label: "Pulse C",
              summary: "Stands for the part the file tool will touch.",
              phase: "component",
              codeRefs: ["packages/db"],
            },
          },
        ],
        note: "pulse seed",
      },
    }),
  );
  const seedActivity = await waitFor("activity from the seed canvas call", () =>
    frames.find((f) => f.type === "activity" && f.nodeIds.includes("pulse-c")),
  );
  check("a canvas call lights the bubble it wrote", seedActivity.nodeIds.join(",") === "pulse-c", seedActivity.nodeIds.join(","));

  const pulseAt = frames.length;
  pulseSocket.send(
    JSON.stringify({
      type: "canvas_call",
      cwd: wtVariation,
      id: "smoke-pulse-1",
      args: {
        ops: [
          {
            op: "upsert_node",
            node: { id: "pulse-a", parentId: null, label: "Pulse A", summary: "First bubble of the pair.", phase: "idea" },
          },
          {
            op: "upsert_node",
            node: { id: "pulse-b", parentId: null, label: "Pulse B", summary: "Second bubble of the pair.", phase: "idea" },
          },
        ],
        note: "two bubbles at once",
      },
    }),
  );
  const pulseGraph = await waitFor("graph for the pair", () =>
    frames.slice(pulseAt).find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "pulse-b")),
  );
  const pairAt = frames.indexOf(pulseGraph);
  const pairActivity = await waitFor("activity for the pair", () =>
    frames.slice(pairAt).find((f) => f.type === "activity"),
  );
  check(
    "the activity frame follows the graph frame and names exactly the pair",
    pairActivity.nodeIds.slice().sort().join(",") === "pulse-a,pulse-b",
    pairActivity.nodeIds.join(","),
  );

  // a file the agent opens still joins the set: the two answers to "where is it
  // working" are the same kind of answer, and neither cancels the other
  const unionAt = frames.length;
  pulseSocket.send(
    JSON.stringify({
      type: "agent_event",
      cwd: wtVariation,
      event: { kind: "tool_start", name: "Edit", paths: ["packages/db/src/index.ts"], summary: "packages/db/src/index.ts" },
    }),
  );
  const unionActivity = await waitFor("activity after the file tool_start", () =>
    frames.slice(unionAt).find((f) => f.type === "activity"),
  );
  check(
    "a file the agent touches joins the bubbles its canvas call lit",
    unionActivity.nodeIds.slice().sort().join(",") === "pulse-a,pulse-b,pulse-c",
    unionActivity.nodeIds.join(","),
  );

  const endAt = frames.length;
  pulseSocket.send(JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "turn_end" } }));
  await waitFor("activity cleared after the pulse turn", () =>
    frames.slice(endAt).find((f) => f.type === "activity" && f.nodeIds.length === 0),
  );
  check("the end of the turn puts every bubble back to rest", true);
  pulseSocket.close();

  // --- product-first greenfield turn ----------------------------------------
  // Two brand-new empty projects, so nothing above is disturbed: one taking the
  // default (the picture first), one asking to go straight to building. The
  // fake harness answers a "product-first probe" utterance with a build bubble
  // it is not allowed to make yet, then with the picture it was asked for.
  const pfTarget = join(createRootReal, "product-first");
  // the project's only worktree is its own directory: a fresh repo has one
  const wtPf = pfTarget;
  socket.send(JSON.stringify({ type: "create_project", path: pfTarget, github: null }));
  await waitFor(
    "hello for a brand-new project with an empty canvas",
    () => frames.find((f) => f.type === "hello" && f.session.cwd === pfTarget),
    30_000,
  );
  const pfLog = ompLogIn(pfTarget);
  const pfAt = frames.length;
  socket.send(
    JSON.stringify({
      type: "utterance",
      worktree: wtPf,
      referent: null,
      text: "product-first probe: an app that splits a dinner bill. It should handle tips too.",
    }),
  );

  const draftGraph = await waitFor("graph frame carrying the draft root", () =>
    frames.slice(pfAt).find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "product")),
  );
  const draft = draftGraph.graph.nodes.find((n) => n.id === "product");
  check(
    "the first words become a product bubble before the agent has done anything",
    draft.layer === "product" && draft.parentId === null && draft.label === "Your idea" && typeof draft.status === "string" && draft.status.length > 0,
    JSON.stringify(draft),
  );
  check(
    "the draft root's promise is the user's own first sentence",
    draft.summary === "product-first probe: an app that splits a dinner bill.",
    draft.summary,
  );
  const draftActivity = await waitFor("activity on the draft root", () =>
    frames.slice(pfAt).find((f) => f.type === "activity" && f.nodeIds.join(",") === "product"),
  );
  check("the draft root is where the canvas says the work is", draftActivity !== undefined);

  const pfPrompt = await waitFor("the product-first prompt", () =>
    ompFrames(pfLog).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("product-first probe")),
  );
  check(
    "the first prompt hands over the draft root, spends the turn on the picture and says to stop",
    pfPrompt.body.includes("id `product`") &&
      pfPrompt.body.includes("This turn is the product picture and nothing else:") &&
      pfPrompt.body.includes("Then stop and let the user look") &&
      pfPrompt.body.includes('say "build it"'),
    pfPrompt.body.slice(-400),
  );

  const tooEarly = await waitFor("the too-early build bubble refused", () =>
    ompFrames(pfLog).find((f) => f.type === "canvas_result" && f.text.includes("product/first")),
  );
  const tooEarlyText = tooEarly.text;
  check(
    "a build bubble in the product turn comes back with the reason to act on",
    tooEarlyText.startsWith("applied 0 op(s);") &&
      tooEarlyText.includes(
        "product picture first: this turn is the product layer only — name the product, give it 3 to 5 capabilities, then stop and let the user look",
      ),
    tooEarlyText.split("\n")[0],
  );

  const picture = await waitFor("the product picture applied", () =>
    ompFrames(pfLog).find((f) => f.type === "canvas_result" && f.text.startsWith("applied 2 op(s);")),
  );
  check(
    // the picture turn is the one turn that owes no links: the build layer the
    // links would point at is exactly what it may not draw yet
    "the product-first turn is never asked for the links it is not allowed to write",
    !picture.text.includes('"warnings"') && !picture.text.includes("link/") &&
      !ompFrames(pfLog).some((f) => f.type === "canvas_result" && f.text.includes("link/")),
    picture.text.split("\n")[0],
  );
  const named = await waitFor("graph carrying the named product", () =>
    frames
      .slice(pfAt)
      .find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "product" && n.label === "Bill Splitter")),
  );
  check(
    "renaming the draft root and hanging a capability under it is what the turn accepts",
    named.graph.nodes.filter((n) => n.layer === "product").length === 2,
    JSON.stringify(named.graph.nodes.map((n) => `${n.id}:${n.layer ?? "build"}`)),
  );

  await waitFor("activity cleared at the end of the product turn", () =>
    frames.slice(pfAt).find((f) => f.type === "activity" && f.nodeIds.length === 0),
  );
  socket.send(JSON.stringify({ type: "utterance", worktree: wtPf, referent: null, text: "build it" }));
  const afterPicture = await waitFor("build ops accepted after the product turn", () =>
    ompFrames(pfLog).find((f) => f.type === "canvas_result" && f.text.startsWith("applied 3 op(s);")),
  );
  check(
    "the turn after the picture may build",
    afterPicture.text.startsWith("applied 3 op(s);"),
    afterPicture.text.split("\n")[0],
  );

  // the same first utterance with the picture turned off: the bubble still
  // appears, the turn is not spent on it, and building starts at once
  const pfOff = join(createRootReal, "straight-to-building");
  const wtPfOff = pfOff;
  socket.send(JSON.stringify({ type: "create_project", path: pfOff, github: null }));
  await waitFor(
    "hello for the project that skips the product picture",
    () => frames.find((f) => f.type === "hello" && f.session.cwd === pfOff),
    30_000,
  );
  const pfOffLog = ompLogIn(pfOff);
  const pfOffAt = frames.length;
  socket.send(
    JSON.stringify({
      type: "utterance",
      worktree: wtPfOff,
      referent: null,
      text: "a tool that renames photos by the date they were taken",
      productFirst: false,
    }),
  );
  const offGraph = await waitFor("draft root even with the picture turned off", () =>
    frames.slice(pfOffAt).find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "product")),
  );
  check(
    "the first words become a bubble whichever way the first turn goes",
    offGraph.graph.nodes.find((n) => n.id === "product").summary ===
      "a tool that renames photos by the date they were taken",
    JSON.stringify(offGraph.graph.nodes.find((n) => n.id === "product")),
  );
  const offPrompt = await waitFor("the prompt with the picture turned off", () =>
    ompFrames(pfOffLog).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("renames photos by the date")),
  );
  check(
    "it still hands over the draft root, but nothing holds the turn to the product layer",
    offPrompt.body.includes("id `product`") &&
      !offPrompt.body.includes("This turn is the product picture") &&
      !offPrompt.body.includes("<canvas-steering>"),
    offPrompt.body.slice(-200),
  );
  const offBuild = await waitFor("build ops accepted in the very first turn", () =>
    ompFrames(pfOffLog).find((f) => f.type === "canvas_result" && f.text.startsWith("applied 3 op(s);")),
  );
  check(
    "with the picture turned off the first turn builds immediately",
    offBuild.text.startsWith("applied 3 op(s);"),
    offBuild.text.split("\n")[0],
  );

  // back on the variation: the link section below drives that canvas. Coming
  // from another repo this IS a retarget, and it opens the harness in exactly
  // the worktree it was given — the project is still named by its main one.
  const backOnVariationAt = frames.length;
  socket.send(JSON.stringify({ type: "switch_project", path: worktree }));
  const helloVariation = await waitFor(
    "hello back on the project, with the harness in the variation",
    () =>
      frames
        .slice(backOnVariationAt)
        .find((f) => f.type === "hello" && f.session.sessions.some((sess) => sess.worktree === wtVariation)),
    30_000,
  );
  check(
    "retargeting onto a variation names the project by its main worktree and runs the harness in the variation",
    helloVariation.session.cwd === wtA &&
      helloVariation.session.sessions.map((sess) => sess.worktree).join(",") === wtVariation,
    JSON.stringify({ cwd: helloVariation.session.cwd, sessions: helloVariation.session.sessions.map((sess) => sess.worktree) }),
  );

  // --- the link: canvas over MCP + external agent events --------------------
  // The worktree is the live target and its canvas is empty, so the link can
  // add bubbles here without disturbing anything asserted above. A second
  // socket stands in for an external process (MCP server, harness hook), which
  // reaches the agent runtime's own endpoint at /link, not the browser hub.
  const linkUrl = `ws://127.0.0.1:${PORT}/link`;
  const linkPkg = join(process.cwd(), "..", "link");
  const linkFrames = [];
  const linkSocket = new WebSocket(linkUrl);
  linkSocket.on("message", (data) => linkFrames.push(JSON.parse(data.toString())));
  {
    const opened = Promise.withResolvers();
    linkSocket.once("open", opened.resolve);
    linkSocket.once("error", opened.reject);
    await opened.promise;
  }

  linkSocket.send(
    JSON.stringify({
      type: "canvas_call",
      cwd: wtVariation,
      id: "smoke-link-1",
      args: {
        ops: [
          {
            op: "upsert_node",
            node: {
              id: "linked",
              parentId: null,
              label: "Linked",
              summary: "Reached the canvas through the link.",
              phase: "component",
              codeRefs: ["packages/auth"],
            },
          },
        ],
        note: "from the link",
      },
    }),
  );
  const linkResult = await waitFor("canvas_result on the caller's socket", () =>
    linkFrames.find((f) => f.type === "canvas_result" && f.id === "smoke-link-1"),
  );
  check(
    "canvas_call is answered on the calling socket, correlated by id",
    linkResult.text.startsWith("applied 1 op(s);") && linkResult.isError === false,
    JSON.stringify(linkResult),
  );
  await waitFor("graph broadcast for the link's node", () =>
    frames.find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "linked")),
  );
  check("what the link applies is broadcast to the browsers", true);
  check(
    "a canvas result never reaches a socket that did not ask for it",
    !frames.some((f) => f.type === "canvas_result"),
    JSON.stringify(frames.filter((f) => f.type === "canvas_result")),
  );

  // external events are indistinguishable from native ones: same activity
  // mapping, same transcript, same turn accounting
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
    frames.find((f) => f.type === "activity" && f.nodeIds.includes("linked")),
  );
  check(
    "an external tool_start maps its paths onto the codeRefs node",
    linkActivity.nodeIds.join(",") === "linked",
    linkActivity.nodeIds.join(","),
  );

  linkSocket.send(
    JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "text", text: "the link is speaking" } }),
  );
  await waitFor("transcript from an external text event", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant" && f.text === "the link is speaking"),
  );
  check("an external text event lands in the transcript", true);

  const activityAt = frames.indexOf(linkActivity);
  linkSocket.send(JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "turn_end" } }));
  await waitFor("activity cleared by an external turn_end", () =>
    frames.slice(activityAt + 1).find((f) => f.type === "activity" && f.nodeIds.length === 0),
  );
  check("an external turn_end ends the turn's activity", true);

  linkSocket.send(
    JSON.stringify({
      type: "agent_event",
      cwd: wtVariation,
      event: { kind: "session", sessionId: "link-session-1", model: { provider: "anthropic", id: "claude-x" } },
    }),
  );
  // a fresh BROWSER, not a link client: only the hub greets a socket with hello
  const sessionProbe = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const probeFrames = [];
  sessionProbe.on("message", (data) => probeFrames.push(JSON.parse(data.toString())));
  const probeHello = await waitFor("hello for the session probe", () =>
    probeFrames.find(
      (f) =>
        f.type === "hello" &&
        f.session.sessions.some((sess) => sess.worktree === wtVariation && sess.session.sessionId === "link-session-1"),
    ),
  );
  const probeSession = probeHello.session.sessions.find((sess) => sess.worktree === wtVariation);
  check(
    "a session reported by the link becomes the session of the variation it runs in",
    probeSession.session.model?.id === "claude-x",
    JSON.stringify({ worktree: probeSession.worktree, session: probeSession.session }),
  );
  sessionProbe.close();

  // the link is a boundary like the browser is: a frame the bridge cannot make
  // sense of is refused, not half-applied
  linkSocket.send(JSON.stringify({ type: "agent_event", cwd: wtVariation, event: { kind: "not-an-event" } }));
  const badEvent = await waitFor("unknown event kind refused", () =>
    linkFrames.find((f) => f.type === "error"),
  );
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
  await waitFor("mistyped link frames refused", () =>
    linkFrames.filter((f) => f.type === "error").length >= 3,
  );
  check("a mistyped event field and an id-less canvas_call are both refused", true);

  // --- the canvas tool as an MCP server, end to end -------------------------
  // Resolved from the link package, not this one: the sdk is its dependency.
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
    frames.slice(clearedAt).find((f) => f.type === "activity" && f.nodeIds.includes("linked")),
  );
  check(
    "a harness hook lights up the bubble whose code the tool touched",
    // the MCP call above wrote `mcp-linked` and no turn has ended since, so it
    // is still lit: a file joins what the canvas lit, it does not replace it
    hookActivity.nodeIds.slice().sort().join(",") === "linked,mcp-linked",
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
    frames.slice(promptAt).find((f) => f.type === "agent" && f.state === "streaming"),
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
    frames.slice(stopAt).find((f) => f.type === "activity" && f.nodeIds.length === 0),
  );
  await waitFor("idle from the Stop hook", () =>
    frames.slice(stopAt).find((f) => f.type === "agent" && f.state === "idle"),
  );
  check("the Stop hook clears activity and returns the session to idle", true);
  linkSocket.close();

  // --- the terminal drawer is the harness's own terminal --------------------
  // Shape launched this harness in a pty it owns, so the drawer is not a
  // rendering of anything: it is the terminal the TUI is running in. What the
  // harness prints comes out of it, and what the user types goes in.
  const paneAt = frames.length;
  socket.send(JSON.stringify({ type: "pty_open", worktree: wtVariation, cols: 80, rows: 24 }));
  const paneState = await waitFor("pty_state for the pane", () =>
    frames.slice(paneAt).find((f) => f.type === "pty_state"),
  );
  check(
    "the drawer opens on the harness's own terminal, not on a shell",
    paneState.shell === "agent" && paneState.open === true,
    JSON.stringify(paneState),
  );

  const typedAt = frames.length;
  const rendered = () =>
    frames
      .slice(typedAt)
      .filter((f) => f.type === "pty_data" && f.worktree === wtVariation)
      .map((f) => f.data)
      .join("");
  // Typed the way a person types at a TUI. Nothing is replayed into a drawer
  // that opens late — the scrollback belongs to the program — so what proves
  // the drawer is wired to the harness is that typing reaches it and what it
  // says next comes back out.
  socket.send(
    JSON.stringify({
      type: "pty_input",
      worktree: wtVariation,
      data: `${JSON.stringify({ type: "typed", text: "typed straight at the terminal" })}\r`,
    }),
  );
  const typedFrame = await waitFor("the harness read what was typed into the drawer", () =>
    ompFrames(ompLogIn(worktree)).find((f) => f.__dir === "stdin" && f.text?.includes("typed straight at the terminal")),
  );
  check("typing into the drawer reaches the harness itself", typedFrame.type === "typed", JSON.stringify(typedFrame));
  check(
    "and it is the harness's own turn: nothing the room delivered",
    !ompFrames(ompLogIn(worktree)).some((f) => f.type === "deliver" && f.body.includes("typed straight at the terminal")),
    JSON.stringify(ompFrames(ompLogIn(worktree)).filter((f) => f.type === "deliver").length),
  );
  await waitFor("what the harness said in its terminal", () => rendered().length > 0, 15_000);
  check("what happens in that terminal reaches the drawer", rendered().length > 0, JSON.stringify(rendered().slice(0, 80)));
  // that turn was the harness's own; the sections below steer it again, and a
  // delivery landing mid-turn would be a steer with no lifecycle of its own
  await waitFor(
    "the typed turn to end",
    () => frames.slice(typedAt).find((f) => f.type === "agent" && f.worktree === wtVariation && f.state === "idle"),
    20_000,
  );

  // --- next and autonomy ----------------------------------------------------
  // The end of a turn has to say what happens now, and the user has to be able
  // to hand the wheel over entirely. Both are per variation, both are server
  // side, and neither ever touches the canvas.
  const nextAt = frames.length;
  socket.send(
    JSON.stringify({ type: "utterance", worktree: wtVariation, referent: null, text: "next probe: end on a card" }),
  );
  const card = await waitFor("a next frame for the card the agent sent", () =>
    frames.slice(nextAt).find((f) => f.type === "next" && f.worktree === wtVariation && f.next !== null),
  );
  check(
    "a canvas call carrying `next` becomes that variation's card, word for word",
    card.next.summary === "The login part checks passwords, and nothing exports yet." &&
      card.next.choices.length === 2 &&
      card.next.choices[0].label === "Build the export" &&
      card.next.choices[0].say === "Build the export next and show me one." &&
      card.next.question === "One file per note, or one file for the whole trip?",
    JSON.stringify(card.next),
  );
  const cardGraph = frames.slice(nextAt).filter((f) => f.type === "graph" && f.worktree === wtVariation).at(-1);
  check(
    "the card is not part of the canvas: no bubble, no stored doc, no revision",
    cardGraph !== undefined &&
      !JSON.stringify(cardGraph.graph).includes("One file per note") &&
      !JSON.stringify(storedGraph(target, wtVariation)).includes("One file per note") &&
      !storedRevisions(target, wtVariation).some((s) => JSON.stringify(s).includes("One file per note")),
  );

  // the card's own turn must be over first: a delivery that lands mid-turn is
  // a steer, and a steer carries no canvas call to refuse
  await waitFor(
    "the card's turn to end",
    () => frames.slice(nextAt).find((f) => f.type === "agent" && f.worktree === wtVariation && f.state === "idle"),
    20_000,
  );
  const badAt = frames.length;
  socket.send(
    JSON.stringify({ type: "utterance", worktree: wtVariation, referent: null, text: "bad-next probe: five choices" }),
  );
  const badReceipt = await waitFor("the op/bad-next receipt reached the harness", () =>
    ompFrames(ompLogIn(worktree)).find(
      (f) => f.type === "canvas_result" && f.text.includes("op/bad-next"),
    ),
  );
  const cardText = badReceipt.text;
  const badNext = receipts(cardText).rejections.find((r) => r.code === "op/bad-next");
  check(
    "a malformed card is refused at /next with a repair receipt, and the ops still land",
    badNext !== undefined && badNext.index === -1 && badNext.subject.path === "/next" &&
      badNext.severity === "error" && badNext.supportedFixes.length >= 1 &&
      cardText.startsWith("applied 3 op(s);"),
    JSON.stringify({ first: cardText.split("\n")[0], receipt: badNext }),
  );
  check(
    "and nothing of that card is ever offered to the reader",
    !frames.slice(badAt).some((f) => f.type === "next" && f.next !== null && f.next.summary === "Where things stand."),
    JSON.stringify(frames.slice(badAt).filter((f) => f.type === "next").map((f) => f.next?.summary ?? null)),
  );

  // anything said spends the card, and the turn it starts ends on a new one —
  // this turn sends none, so the bridge makes the card out of its last sentence
  // and again: this section reads what one whole turn leaves behind, so it
  // must not open the next one inside it
  await waitFor(
    "the bad-next turn to end",
    () => frames.slice(badAt).find((f) => f.type === "agent" && f.worktree === wtVariation && f.state === "idle"),
    20_000,
  );
  const clearAt = frames.length;
  socket.send(JSON.stringify({ type: "utterance", worktree: wtVariation, referent: null, text: "plain probe" }));
  await waitFor("the card taken down by an utterance", () =>
    frames.slice(clearAt).find((f) => f.type === "next" && f.worktree === wtVariation && f.next === null),
  );
  check("saying anything to a variation clears its card first", true);
  const synth = await waitFor("the synthesized card at the end of a cardless turn", () =>
    frames.slice(clearAt).find((f) => f.type === "next" && f.worktree === wtVariation && f.next !== null),
  );
  check(
    "a turn that ends with no card gets one made from its own last sentence",
    synth.next.summary.startsWith("ack: plain probe") && synth.next.summary.endsWith("sketching the canvas.") &&
      synth.next.choices.map((c) => c.label).join(",") === "Keep going,What changed?" &&
      synth.next.choices[0].say === "Keep going with the plan." &&
      synth.next.question === null,
    JSON.stringify(synth.next),
  );

  // --- autonomous mode: the bridge answers the card itself ------------------
  const armAt = frames.length;
  socket.send(JSON.stringify({ type: "set_autonomous", worktree: wtVariation, on: true }));
  const armed = await waitFor("the autonomous frame", () =>
    frames.slice(armAt).find((f) => f.type === "autonomous" && f.worktree === wtVariation),
  );
  check("the toggle is answered per variation", armed.on === true, JSON.stringify(armed));

  const stretchAt = frames.length;
  socket.send(
    JSON.stringify({ type: "utterance", worktree: wtVariation, referent: null, text: "next probe: hand it the wheel" }),
  );
  const autoPrompt = await waitFor("the harness received the autonomous prompt", () =>
    ompFrames(ompLogIn(worktree)).find((f) => f.type === "deliver" && f.body.includes("Autonomous mode is on.")),
  );
  check(
    "a turn that ended on a question is answered by the bridge itself",
    autoPrompt.body.includes("take the option you would recommend") &&
      autoPrompt.body.includes("keep going until the work is finished") &&
      autoPrompt.body.includes("Do not stop to ask."),
    autoPrompt.body.slice(0, 48),
  );
  const autoLine = await waitFor("the panel line for the auto-continue", () =>
    frames
      .slice(stretchAt)
      .find((f) => f.type === "transcript" && f.worktree === wtVariation && f.role === "user" && f.text.startsWith("autonomous:")),
  );
  check(
    "what it decided is on the record as the user's own line, marked as its own",
    autoLine.text.includes("Autonomous mode is on."),
    autoLine.text.slice(0, 40),
  );
  const autoAudit = await waitFor("an audit line for the auto-continue", () => {
    const rows = dbRows(
      "SELECT worktree, entry FROM audit WHERE tenant = ? AND key = ? ORDER BY seq ASC",
      "local",
      projectKeyOf(target),
    );
    return rows?.find((r) => r.worktree === wtVariation && JSON.parse(r.entry).kind === "auto") ?? null;
  });
  check(
    "every turn it answered for the user is in the audit as `auto`",
    JSON.parse(autoAudit.entry).run === 1 && typeof JSON.parse(autoAudit.entry).id === "string",
    autoAudit.entry,
  );

  // every auto-continue ends on the same card, which still has a way on: the
  // stretch drives itself into the cap, which is exactly what the cap is for
  const paused = await waitFor(
    "autonomous mode paused at the cap",
    () =>
      frames
        .slice(stretchAt)
        .find((f) => f.type === "transcript" && f.text.startsWith("autonomous mode paused after 25 turns")),
    60_000,
  );
  const disarmed = frames
    .slice(stretchAt)
    .find((f) => f.type === "autonomous" && f.worktree === wtVariation && f.on === false);
  // mode is not the point here and is not even stable: an auto-continue that
  // lands before the harness has gone idle is delivered as a steer
  const autoPrompts = ompFrames(ompLogIn(worktree)).filter(
    (f) => f.type === "deliver" && f.body.includes("Autonomous mode is on."),
  ).length;
  check(
    "a stretch stops after 25 turns without a human, says so plainly, and turns itself off",
    autoPrompts === 25 && disarmed !== undefined && paused.role === "tool" &&
      paused.text.endsWith("say something to continue") &&
      !frames.slice(stretchAt).some((f) => f.type === "error" && f.message.includes("autonomous")),
    JSON.stringify({ autoPrompts, disarmed: disarmed?.on ?? null, line: paused.text }),
  );

  // A card with nothing on it is the agent saying the work is finished, and
  // that is the one turn end autonomous mode leaves alone. Checked on a
  // variation whose canvas is still empty, which is where the product-first
  // gate would otherwise fire: handing the wheel over takes that gate off.
  execFileSync("git", ["worktree", "add", "-b", "variation-3", worktree3], { cwd: target, stdio: "ignore" });
  const wt3 = realpathSync(worktree3);
  const refreshFrames = [];
  const refresh = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  refresh.on("message", (data) => refreshFrames.push(JSON.parse(data.toString())));
  {
    const opened = Promise.withResolvers();
    refresh.once("open", opened.resolve);
    refresh.once("error", opened.reject);
    await opened.promise;
  }
  // a fresh browser re-lists the repo's worktrees, and the agent needs that
  // listing before it will open a harness in one
  const helloThird = await waitFor("a hello that lists the third variation", () =>
    refreshFrames.find((f) => f.type === "hello" && f.session.worktrees.some((w) => w.id === wt3)),
  );
  check(
    "hello carries the card and the toggle of every variation",
    helloThird.nexts !== undefined && helloThird.autonomous !== undefined &&
      helloThird.nexts[wtVariation] !== undefined && helloThird.autonomous[wtVariation] === false &&
      helloThird.nexts[wt3] === null && helloThird.autonomous[wt3] === false,
    JSON.stringify({
      nexts: Object.keys(helloThird.nexts ?? {}).length,
      variation: helloThird.autonomous?.[wtVariation],
      third: helloThird.nexts?.[wt3],
    }),
  );
  refresh.close();

  const thirdAt = frames.length;
  socket.send(JSON.stringify({ type: "open_worktree", path: worktree3 }));
  await waitFor(
    "session_started for the third variation",
    () => frames.slice(thirdAt).find((f) => f.type === "session_started" && f.worktree === wt3),
    30_000,
  );
  socket.send(JSON.stringify({ type: "set_autonomous", worktree: wt3, on: true }));
  await waitFor("the third variation is running on its own", () =>
    frames.slice(thirdAt).find((f) => f.type === "autonomous" && f.worktree === wt3 && f.on === true),
  );
  socket.send(
    JSON.stringify({ type: "utterance", worktree: wt3, referent: null, text: "finished probe: build it and stop" }),
  );
  const thirdGraph = await waitFor("a build bubble on the third variation's canvas", () =>
    frames
      .slice(thirdAt)
      .find((f) => f.type === "graph" && f.worktree === wt3 && f.graph.nodes.some((n) => n.id === "auth-service")),
  );
  check(
    "the product-first gate is off while a variation runs on its own: a build bubble lands on the first turn",
    thirdGraph.graph.nodes.some((n) => n.id === "auth-service" && (n.layer ?? "build") === "build") &&
      !frames.slice(thirdAt).some((f) => f.type === "error" && f.message.includes("product/first")),
    JSON.stringify(thirdGraph.graph.nodes.map((n) => `${n.id}:${n.layer ?? "build"}`)),
  );
  const finishedCard = await waitFor("the finished card on the third variation", () =>
    frames.slice(thirdAt).find((f) => f.type === "next" && f.worktree === wt3 && f.next !== null),
  );
  check(
    "a card with no choices and no question is the agent saying it is finished",
    finishedCard.next.choices.length === 0 && finishedCard.next.question === null &&
      finishedCard.next.summary === "Everything that was asked for is built.",
    JSON.stringify(finishedCard.next),
  );
  await sleep(600);
  check(
    "and that is the one turn end autonomous mode leaves alone: no prompt, no loop",
    !ompFrames(ompLogIn(worktree3)).some((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("Autonomous mode is on.")),
    JSON.stringify(ompFrames(ompLogIn(worktree3)).filter((f) => f.type === "deliver").map((f) => f.body.slice(0, 24))),
  );

  const closeThirdAt = frames.length;
  socket.send(JSON.stringify({ type: "close_worktree", worktree: wt3 }));
  await waitFor("the third variation's harness stopped", () =>
    frames.slice(closeThirdAt).find((f) => f.type === "session_stopped" && f.worktree === wt3),
  );
  check(
    "a variation whose harness went away offers nothing and runs nothing",
    frames.slice(closeThirdAt).some((f) => f.type === "next" && f.worktree === wt3 && f.next === null) &&
      frames.slice(closeThirdAt).some((f) => f.type === "autonomous" && f.worktree === wt3 && f.on === false),
    JSON.stringify(frames.slice(closeThirdAt).filter((f) => f.type === "next" || f.type === "autonomous").map((f) => f.type)),
  );

  // --- the start card's choices, the terminal, and the live line ------------
  // A fourth variation, opened the way the "start a session" card opens one:
  // a named harness, autonomy chosen at launch, and the choice remembered for
  // the project. Then the two things the browser needs from a running session
  // that are not the canvas — a way to the terminal, and the sentence being
  // written right now.
  execFileSync("git", ["worktree", "add", "-b", "variation-4", worktree4], { cwd: target, stdio: "ignore" });
  const wt4 = realpathSync(worktree4);
  // a project config that already says something else: remembering a harness
  // must not throw the rest of it away
  await mkdir(join(worktree4, ".shape"), { recursive: true });
  await writeFile(join(worktree4, ".shape", "config.json"), JSON.stringify({ note: "kept" }));
  // a variation made after the last listing is not a variation the agent knows
  // yet: a hello re-detects them, so one throwaway socket is what a browser
  // opening a new tab would do anyway
  {
    const refresh4 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const seen = Promise.withResolvers();
    refresh4.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "hello") seen.resolve(true);
    });
    refresh4.once("error", seen.reject);
    await seen.promise;
    refresh4.close();
  }

  const cardAt = frames.length;
  socket.send(
    JSON.stringify({ type: "open_worktree", path: worktree4, backend: "omp", autonomous: true, remember: true }),
  );
  const startedFourth = await waitFor(
    "session_started for the variation opened from the card",
    () => frames.slice(cardAt).find((f) => f.type === "session_started" && f.worktree === wt4),
    30_000,
  );
  check(
    "the named harness is the one that was started",
    startedFourth.backend.id === "omp" && startedFourth.backend.capabilities.terminal === "pane",
    JSON.stringify(startedFourth.backend),
  );
  const fourthStart = await waitFor("the fourth variation's harness process", () =>
    ompFrames(ompLogIn(worktree4)).find((f) => f.type === "__start"),
  );
  check(
    "autonomy is chosen at launch: the harness is started with approval turned off",
    fourthStart.argv.join(" ").includes("--approval-mode yolo") && fourthStart.cwd === wt4,
    JSON.stringify(fourthStart.argv),
  );
  const remembered = JSON.parse(
    await waitFor("the remembered harness in the project's config", () => {
      const file = join(worktree4, ".shape", "config.json");
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      return text.includes('"backend"') ? text : null;
    }),
  );
  check(
    "remembering the choice writes the project's own config and keeps what was already in it",
    remembered.backend === "omp" && remembered.note === "kept",
    JSON.stringify(remembered),
  );

  const focusAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: wt4 }));
  const drawer = await waitFor("the terminal frame that opens the drawer", () =>
    frames.slice(focusAt).find((f) => f.type === "terminal" && f.worktree === wt4),
  );
  check("going to the terminal of a pty-launched harness asks the browser to open it", drawer.open === true, JSON.stringify(drawer));

  const nowAt = frames.length;
  socket.send(JSON.stringify({ type: "utterance", worktree: wt4, referent: null, text: "next probe: say something" }));
  await waitFor(
    "the live line while the harness is writing",
    () => frames.slice(nowAt).some((f) => f.type === "now" && f.worktree === wt4 && f.text !== null),
    20_000,
  );
  const live = frames.slice(nowAt).filter((f) => f.type === "now" && f.worktree === wt4);
  check(
    "the message being written arrives as a folded live line, tail only",
    live.every((f) => f.text === null || f.text.length <= 120),
    JSON.stringify(live.map((f) => (f.text === null ? null : f.text.length))),
  );
  await waitFor("the live line cleared at the end of the turn", () => {
    const last = frames.slice(nowAt).filter((f) => f.type === "now" && f.worktree === wt4).at(-1);
    return last !== undefined && last.text === null ? last : null;
  }, 20_000);
  check("a turn that ends leaves nothing being said", true);
  const spoken = frames.slice(nowAt).filter((f) => f.type === "transcript" && f.worktree === wt4 && f.role === "assistant");
  check(
    "a delta is never a transcript line: the whole message of record is, once",
    spoken.length === 1 && live.some((f) => f.text !== null && spoken[0].text.includes(f.text)),
    `${spoken.length} assistant line(s): ${JSON.stringify(spoken.map((f) => f.text.slice(0, 40)))}`,
  );

  const closeFourthAt = frames.length;
  socket.send(JSON.stringify({ type: "close_worktree", worktree: wt4 }));
  await waitFor("the fourth variation's harness stopped", () =>
    frames.slice(closeFourthAt).find((f) => f.type === "session_stopped" && f.worktree === wt4),
  );

  console.log(`\n--- addressed instruction as omp received it ---\n${addressed.body}\n---`);
} catch (err) {
  check("smoke run completed", false, String(err));
} finally {
  socket?.close();
  bridge?.kill("SIGKILL");
  await sleep(100);
  await rm(target, { recursive: true, force: true });
  await rm(targetB, { recursive: true, force: true });
  await rm(legacyTarget, { recursive: true, force: true });
  await rm(oldKeyTarget, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
  await rm(worktree2, { recursive: true, force: true });
  await rm(worktree3, { recursive: true, force: true });
  await rm(worktree4, { recursive: true, force: true });
  await rm(createRoot, { recursive: true, force: true });
}

// --- structure down to classes and functions -------------------------------
// Its own project, its own bridge, its own port: the run above tore its target
// down, and the parts of a file only mean anything against a project that has
// them. Four claims are checked end to end — that the parser reads every shape
// a top-level part is written in, that reality reads the parts out of a real
// file, that the survey prompt hands those parts to the model and refuses a
// part that is not there, and that touching the file lights the bubble anchored
// to one of its parts.
{
  const { composeSurveyPrompt, onboardingOpGate } = await import(new URL("../src/server/onboarding.ts", import.meta.url));
  const { gitFileIndexSync } = await import(new URL("../src/agent/reality.ts", import.meta.url));
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

  const symPort = PORT + 3;
  const symFrames = [];
  let symBridge = null;
  let symSocket = null;
  let symLink = null;
  try {
    symBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", symTarget, "--port", String(symPort), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...NO_AUTO_MAP, SHAPE_HOME: symHome, HOME: symHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let symErr = "";
    symBridge.stderr.setEncoding("utf8");
    symBridge.stderr.on("data", (d) => {
      symErr += d;
    });
    await waitFor("bridge listening for the parts project", () => symErr.includes("canvas at ws://"));

    symSocket = new WebSocket(`ws://127.0.0.1:${symPort}/ws`);
    symSocket.on("message", (data) => symFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      symSocket.once("open", opened.resolve);
      symSocket.once("error", opened.reject);
      await opened.promise;
    }
    const symWt = realpathSync(symTarget);
    const symHello = await waitFor("hello for the parts project", () =>
      symFrames.find((f) => f.type === "hello"),
    );

    const reality = symHello.graphs[symWt].reality;
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

    // the survey prompt: rule 10 works from an inventory, not from a hint
    const surveyDoc = { nodes: [], edges: [], reality };
    const survey = composeSurveyPrompt(surveyDoc, undefined);
    check(
      "the survey prompt carries the inventory of parts rule 10 works from",
      survey.includes("the inventory rule 10 works from") &&
        survey.includes(`- ${partsRel}: Ledger (class, exported, line 5)`),
      JSON.stringify(survey.split("\n").filter((l) => l.includes("inventory") || l.startsWith(`- ${partsRel}`))),
    );
    check(
      "rule 10 demands the depth instead of permitting it, and still names the refusal",
      survey.includes("Every leaf build bubble") && survey.includes("`onboarding/unknown-symbol`") &&
        !survey.includes("Nothing below lists those names"),
      JSON.stringify(survey.split("\n").filter((l) => l.startsWith("10.") || l.includes("unknown-symbol"))),
    );
    const bare = composeSurveyPrompt({ nodes: [], edges: [], reality: { ...reality, symbols: [] } }, undefined);
    check(
      "a project whose files declare no parts is told rule 10 stops at the files",
      bare.includes("Classes and functions found in the code: none — the parts are files, and rule 10 stops at them."),
      JSON.stringify(bare.split("\n").filter((l) => l.startsWith("Classes and functions"))),
    );

    // the survey gate, against the reality the bridge just extracted
    const symIndex = gitFileIndexSync(symTarget);
    const gate = onboardingOpGate(symIndex, { nodes: [], reality });
    const claim = (id, codeRefs, extra = {}) => ({
      op: "upsert_node",
      node: { id, parentId: null, label: id, summary: `${id} covers something.`, phase: "built", codeRefs, ...extra },
    });
    const bogus = gate(claim("the-parts", [`${partsRel}#Nope`]));
    check(
      "a survey claim on a part the file does not contain is refused",
      bogus?.code === "onboarding/unknown-symbol" && bogus.severity === "error" &&
        bogus.subject.path === "/node/codeRefs/0" && bogus.evidence.file === partsRel &&
        bogus.evidence.name === "Nope" && bogus.evidence.known.includes("Ledger") &&
        bogus.evidence.known.length <= 20 && bogus.supportedFixes.length >= 1,
      JSON.stringify(bogus),
    );
    check(
      "the refusal names the parts that file really has",
      bogus?.message.includes("Nope") && bogus.supportedFixes[0].includes("keepInternal"),
      JSON.stringify(bogus?.supportedFixes ?? null),
    );
    check(
      "a survey claim on a part that is really there is accepted",
      gate(claim("the-ledger", [`${partsRel}#Ledger`])) === null,
      JSON.stringify(gate(claim("the-ledger", [`${partsRel}#Ledger`]))),
    );
    check(
      "a part named against a file reality never read is accepted",
      gate(claim("the-manifest", ["package.json#Anything"])) === null,
      JSON.stringify(gate(claim("the-manifest", ["package.json#Anything"]))),
    );
    const bareInfra = gate(claim("the-database", undefined, { layer: "infra" }));
    check(
      "an infra bubble with nothing to point at is refused like a build bubble",
      bareInfra?.code === "onboarding/no-coderefs" && bareInfra.message.includes("configuration"),
      JSON.stringify(bareInfra),
    );
    check(
      // it names `the-ledger`, admitted as a build bubble earlier in this same
      // call: connection is the default, so pointing at real configuration is
      // half of what an infra bubble owes (user decision 2026-09-04)
      "an infra bubble that points at real configuration and names what runs on it is accepted",
      gate(claim("the-workspace", ["pnpm-workspace.yaml"], { layer: "infra", hosts: ["the-ledger"] })) === null,
      JSON.stringify(gate(claim("the-workspace", ["pnpm-workspace.yaml"], { layer: "infra", hosts: ["the-ledger"] }))),
    );
    check(
      "and one that points at configuration but names nothing is not",
      gate(claim("the-lonely-host", ["pnpm-workspace.yaml"], { layer: "infra" }))?.code ===
        "onboarding/unhosted-infra",
      JSON.stringify(gate(claim("the-lonely-host", ["pnpm-workspace.yaml"], { layer: "infra" }))),
    );

    // a bubble anchored to one part of a file lights up when that file is touched
    symLink = new WebSocket(`ws://127.0.0.1:${symPort}/link`);
    const symLinkFrames = [];
    symLink.on("message", (data) => symLinkFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      symLink.once("open", opened.resolve);
      symLink.once("error", opened.reject);
      await opened.promise;
    }
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
// needs a project that has some. Checked end to end — what the extractor reads
// out of the files, what the survey prompt then tells the agent about it, and
// that a survey may declare an infra bubble that names what runs on it.
{
  const { GraphStore } = await import(new URL("../src/server/store.ts", import.meta.url));
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  const { onboardingOpGate } = await import(new URL("../src/server/onboarding.ts", import.meta.url));
  const { gitFileIndexSync } = await import(new URL("../src/agent/reality.ts", import.meta.url));
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

  const infraPort = PORT + 4;
  const infraFrames = [];
  let infraBridge = null;
  let infraSocket = null;
  try {
    infraBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", infraTarget, "--port", String(infraPort), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...NO_AUTO_MAP, SHAPE_HOME: infraHome, HOME: infraHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let infraErr = "";
    infraBridge.stderr.setEncoding("utf8");
    infraBridge.stderr.on("data", (d) => {
      infraErr += d;
    });
    await waitFor("bridge listening for the configured project", () => infraErr.includes("canvas at ws://"));

    infraSocket = new WebSocket(`ws://127.0.0.1:${infraPort}/ws`);
    infraSocket.on("message", (data) => infraFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      infraSocket.once("open", opened.resolve);
      infraSocket.once("error", opened.reject);
      await opened.promise;
    }
    const infraWt = realpathSync(infraTarget);
    const infraHello = await waitFor("hello for the configured project", () =>
      infraFrames.find((f) => f.type === "hello"),
    );

    const found = infraHello.graphs[infraWt].reality.infra;
    const item = (id) => found.find((i) => i.id === id);
    check(
      // one line per kind, and inside a kind by label: the same order every run,
      // so the ghost strip and the survey listing never shuffle under the user
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

    // --- what the survey turn is told about it -------------------------------
    infraSocket.send(JSON.stringify({ type: "onboard", worktree: infraWt }));
    const infraSurvey = await waitFor("survey prompt for the configured project", () =>
      ompFrames(ompLogIn(infraTarget)).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("<onboarding-survey>")),
    );
    check(
      "the survey prompt lists the infrastructure with the files behind it",
      infraSurvey.body.includes("Infrastructure found in the code (6 item(s))") &&
        infraSurvey.body.includes(
          '- Postgres database (docker-compose.yml: db) — a Postgres database, read from the service "db" in docker-compose.yml (evidence: .env.example, docker-compose.yml, packages/api/package.json)',
        ) &&
        infraSurvey.body.includes("- Runs on Fly.io (fly.toml) —"),
      infraSurvey.body.slice(infraSurvey.body.indexOf("Infrastructure found in the code")).split("\n").slice(0, 2).join(" / "),
    );
    check(
      "the survey prompt states the infra pass: plain English, the config files, and what runs on it",
      infraSurvey.body.includes("11. Then the infra pass: where this thing runs and what it leans on.") &&
        infraSurvey.body.includes('`layer: "infra"`') &&
        /`codeRefs` = the configuration files\s+listed as that item's evidence, and `hosts` = the ids of the build bubbles that run on it/.test(infraSurvey.body) &&
        /Never invent infrastructure with no file behind it/.test(infraSurvey.body),
    );
    check(
      "the survey prompt requires the depth and hands over the inventory rule 10 works from",
      infraSurvey.body.includes("10. Go down to the parts inside the files.") &&
        infraSurvey.body.includes("Every leaf build bubble") &&
        infraSurvey.body.includes('`codeRefs: ["<file>#<Name>"]`') &&
        infraSurvey.body.includes("3-5 children per part") &&
        infraSurvey.body.includes("the inventory rule 10 works from") &&
        !infraSurvey.body.includes("Nothing below lists those names for you"),
    );
    check(
      "the preamble carries the four layers and what an infra bubble must point at",
      infraSurvey.body.includes("FOUR LAYERS — PRODUCT, BUILD, INFRA and CORRECTNESS.") &&
        /An infra bubble carries the configuration files that prove it in its `codeRefs`/.test(infraSurvey.body) &&
        infraSurvey.body.includes("`path/to/file.ts#TheName`"),
    );

    // --- the survey gate: an infra bubble that names what runs on it ---------
    const infraIndex = gitFileIndexSync(infraTarget);
    const infraStore = new GraphStore(
      openSqliteStorage(join(infraHome, "gate.db")),
      "local",
      "infra-layer",
    );
    infraStore.applyCanvasCall({
      ops: [
        {
          op: "upsert_node",
          node: {
            id: "the-api",
            parentId: null,
            label: "The way in",
            summary: "Answers the requests the outside world makes.",
            phase: "built",
            codeRefs: ["packages/api"],
          },
        },
      ],
    });
    const hosted = infraStore.applyCanvasCall(
      {
        ops: [
          {
            op: "upsert_node",
            node: {
              id: "the-database",
              parentId: null,
              label: "The main database",
              summary: "Keeps everything the app must not forget.",
              phase: "built",
              layer: "infra",
              kind: "database",
              codeRefs: ["docker-compose.yml", ".env.example"],
              hosts: ["the-api"],
            },
          },
        ],
      },
      onboardingOpGate(infraIndex, infraStore.doc),
    );
    check(
      "the survey accepts an infra bubble that points at its configuration and names what runs on it",
      hosted.text.startsWith("applied 1 op(s);") && infraStore.node("the-database")?.layer === "infra" &&
        infraStore.node("the-database")?.hosts?.join(",") === "the-api",
      hosted.text.split("\n")[0],
    );
    // connection is the default (user decision 2026-09-04): during a survey a
    // piece of infrastructure nothing runs on is a claim, exactly like a
    // capability nothing realizes
    const unhosted = onboardingOpGate(infraIndex, infraStore.doc)({
      op: "upsert_node",
      node: {
        id: "the-pipeline",
        parentId: null,
        label: "The build-and-test pipeline",
        summary: "Runs the checks on every change.",
        phase: "built",
        layer: "infra",
        kind: "ci",
        codeRefs: ["docker-compose.yml"],
      },
    });
    check(
      "the survey vetoes an infra bubble that names nothing in hosts",
      unhosted?.code === "onboarding/unhosted-infra" && unhosted.severity === "error" &&
        unhosted.subject.path === "/node/hosts" && unhosted.subject.id === "the-pipeline" &&
        Array.isArray(unhosted.evidence.hosts) && unhosted.evidence.hosts.length === 0 &&
        unhosted.supportedFixes.length >= 1 &&
        unhosted.message.includes("nothing on the build side runs on"),
      JSON.stringify(unhosted),
    );
    check(
      "the survey states the default it holds an infra bubble to",
      /And `hosts` is not optional: connection is the default/.test(infraSurvey.body) &&
        infraSurvey.body.includes("`onboarding/unhosted-infra`") &&
        infraSurvey.body.includes("every infra bubble names what runs on it"),
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
// the extractor reads, what the survey turn is then told about it, that a survey
// may declare a correctness bubble naming what it attests, and that a build
// reads as verified from the extraction alone.
{
  const { GraphStore } = await import(new URL("../src/server/store.ts", import.meta.url));
  const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
  const { onboardingOpGate } = await import(new URL("../src/server/onboarding.ts", import.meta.url));
  const { gitFileIndexSync } = await import(new URL("../src/agent/reality.ts", import.meta.url));
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

  const vPort = PORT + 5;
  const vFrames = [];
  let vBridge = null;
  let vSocket = null;
  try {
    vBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", vTarget, "--port", String(vPort), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...NO_AUTO_MAP, SHAPE_HOME: vHome, HOME: vHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let vErr = "";
    vBridge.stderr.setEncoding("utf8");
    vBridge.stderr.on("data", (d) => {
      vErr += d;
    });
    await waitFor("bridge listening for the verified project", () => vErr.includes("canvas at ws://"));

    vSocket = new WebSocket(`ws://127.0.0.1:${vPort}/ws`);
    vSocket.on("message", (data) => vFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      vSocket.once("open", opened.resolve);
      vSocket.once("error", opened.reject);
      await opened.promise;
    }
    const vWt = realpathSync(vTarget);
    const vHello = await waitFor("hello for the verified project", () => vFrames.find((f) => f.type === "hello"));

    const found = vHello.graphs[vWt].reality.verification;
    const item = (id) => found.find((v) => v.id === id);
    check(
      // one line per kind, and inside a kind by label: the same order every run,
      // so the ghost strip and the survey listing never shuffle under the user
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
      reality: vHello.graphs[vWt].reality,
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

    // --- what the survey turn is told about it -------------------------------
    vSocket.send(JSON.stringify({ type: "onboard", worktree: vWt }));
    const vSurvey = await waitFor("survey prompt for the verified project", () =>
      ompFrames(ompLogIn(vTarget)).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes("<onboarding-survey>")),
    );
    check(
      "the survey prompt lists the verification with its evidence and what it covers",
      vSurvey.body.includes("Verification found in the code (4 item(s))") &&
        vSurvey.body.includes(
          "- Tests in packages/api (1 file) — 1 test file under packages/api (evidence: packages/api/src/a.test.ts; covers: packages/api, packages/api/src/a.ts)",
        ) &&
        vSurvey.body.includes("- Checks run on every push (.github/workflows/ci.yml) —"),
      vSurvey.body.slice(vSurvey.body.indexOf("Verification found in the code")).split("\n").slice(0, 2).join(" / "),
    );
    // same reading as the greenfield preamble check: the survey text is
    // hard-wrapped, so the sentence is asserted, not the column it breaks at
    const vFlat = vSurvey.body.replace(/\s+/g, " ");
    check(
      "the survey prompt states the correctness pass: plain English, the files, and what it attests",
      vFlat.includes("12. Last, the correctness pass: what shows the parts are correct rather than merely written.") &&
        vFlat.includes('`layer: "correctness"`') &&
        vFlat.includes("`codeRefs` = the files listed as that item's evidence, and `verifies` = the ids of the build bubbles it attests") &&
        vFlat.includes("read them off that item's covers list") &&
        vFlat.includes("Never invent verification with no file behind it"),
    );
    check(
      "the preamble carries the four layers and that a built bubble nothing verifies is a claim",
      vFlat.includes("FOUR LAYERS — PRODUCT, BUILD, INFRA and CORRECTNESS.") &&
        vFlat.includes("A BUILT BUBBLE NOTHING VERIFIES IS A CLAIM.") &&
        vFlat.includes("add or extend what proves it works — a test, a smoke run, a check — and put that on the correctness layer with `verifies` naming the part") &&
        vFlat.includes("a correctness bubble carries the files that ARE the check"),
    );

    // --- the survey gate: a correctness bubble that names what it attests ---
    const vIndex = gitFileIndexSync(vTarget);
    const vStore = new GraphStore(openSqliteStorage(join(vHome, "gate.db")), "local", "correctness-layer");
    vStore.applyCanvasCall({
      ops: [
        {
          op: "upsert_node",
          node: {
            id: "the-api",
            parentId: null,
            label: "The way in",
            summary: "Answers the requests the outside world makes.",
            phase: "built",
            codeRefs: ["packages/api"],
          },
        },
      ],
    });
    const attested = vStore.applyCanvasCall(
      {
        ops: [
          {
            op: "upsert_node",
            node: {
              id: "the-api-checks",
              parentId: null,
              label: "The checks on the way in",
              summary: "Proves the way in still answers the way it promises.",
              phase: "built",
              layer: "correctness",
              kind: "test",
              codeRefs: ["packages/api/src/a.test.ts"],
              verifies: ["the-api"],
            },
          },
        ],
      },
      onboardingOpGate(vIndex, vStore.doc),
    );
    check(
      "the survey accepts a correctness bubble that points at its files and names what it attests",
      attested.text.startsWith("applied 1 op(s);") && vStore.node("the-api-checks")?.layer === "correctness" &&
        vStore.node("the-api-checks")?.verifies?.join(",") === "the-api",
      attested.text.split("\n")[0],
    );
    const bareCorrectness = onboardingOpGate(vIndex, vStore.doc)({
      op: "upsert_node",
      node: {
        id: "the-review",
        parentId: null,
        label: "Someone looks at it",
        summary: "Claims a person checks this.",
        phase: "built",
        layer: "correctness",
      },
    });
    check(
      "a correctness bubble with nothing to point at is refused like an infra bubble",
      bareCorrectness?.code === "onboarding/no-coderefs" && bareCorrectness.message.includes("the files that ARE it"),
      JSON.stringify(bareCorrectness),
    );
    // and the same default on this layer: a check that attests nothing is the
    // same empty claim (user decision 2026-09-04)
    const unattesting = onboardingOpGate(vIndex, vStore.doc)({
      op: "upsert_node",
      node: {
        id: "the-typecheck",
        parentId: null,
        label: "The type checks",
        summary: "Proves the parts still fit together.",
        phase: "built",
        layer: "correctness",
        kind: "check",
        codeRefs: ["packages/api/package.json"],
      },
    });
    check(
      "the survey vetoes a correctness bubble that names nothing in verifies",
      unattesting?.code === "onboarding/unattesting-correctness" && unattesting.severity === "error" &&
        unattesting.subject.path === "/node/verifies" && unattesting.subject.id === "the-typecheck" &&
        Array.isArray(unattesting.evidence.verifies) && unattesting.evidence.verifies.length === 0 &&
        unattesting.supportedFixes.length >= 1 &&
        unattesting.message.includes("attests nothing on the build side"),
      JSON.stringify(unattesting),
    );
    check(
      "the survey states the default it holds a check to, and closes on the whole picture",
      vFlat.includes("`verifies` is not optional either: a check that names no build bubble is rejected with `onboarding/unattesting-correctness`") &&
        vFlat.includes("every check names what it attests") &&
        vFlat.includes("A top-level group nothing names is a gap, and closing it is part of this survey"),
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
    // — otherwise a project surveyed by an older bridge would come back with its
    // checks scattered onto the build layer.
    const legacyHome = await mkdtemp(join(tmpdir(), "vh-smoke-legacy-layer-"));
    const legacyStorage = openSqliteStorage(join(legacyHome, "legacy.db"));
    await legacyStorage.saveGraph("local", "legacy-layer", "/tmp/legacy-layer", {
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
    const legacyStore = new GraphStore(legacyStorage, "local", "legacy-layer", "/tmp/legacy-layer");
    await legacyStore.load();
    check(
      'a stored row on the retired "verify" layer loads onto the correctness layer',
      legacyStore.node("the-api-checks")?.layer === "correctness" &&
        JSON.stringify(legacyStore.node("the-api-checks")?.verifies) === '["the-api"]',
      JSON.stringify(legacyStore.node("the-api-checks")),
    );
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

// --- a project with nothing to name its harness -----------------------------
// Its own project, its own bridge, its own port. Two harnesses on the machine,
// no `--backend`, no config file anywhere: nobody named one, so the resolution
// falls all the way through to omp — the harness Shape supports for now — and
// the project comes up WITH a session. Then the other half of the same rule:
// a variation whose session was closed is not refused when the user types into
// it. The sentence OPENS the session and is the first thing it hears.
{
  const noneTarget = await mkdtemp(join(tmpdir(), "vh-smoke-none-"));
  const noneHome = await mkdtemp(join(tmpdir(), "vh-smoke-none-home-"));
  await seedWorkspace(noneTarget, "none");
  const nonePort = PORT + 6;
  const noneFrames = [];
  let noneBridge = null;
  let noneSocket = null;
  try {
    noneBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", noneTarget, "--port", String(nonePort), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        // two detected harnesses and nothing choosing between them: the
        // resolution falls through to omp, which is what this block is about
        env: { ...process.env, ...NO_AUTO_MAP, SHAPE_FORCE_HARNESSES: "omp,claude", SHAPE_HOME: noneHome, HOME: noneHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let noneErr = "";
    noneBridge.stderr.setEncoding("utf8");
    noneBridge.stderr.on("data", (d) => {
      noneErr += d;
    });
    await waitFor("bridge listening for the unnamed-harness project", () => noneErr.includes("canvas at ws://"));

    noneSocket = new WebSocket(`ws://127.0.0.1:${nonePort}/ws`);
    noneSocket.on("message", (data) => noneFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      noneSocket.once("open", opened.resolve);
      noneSocket.once("error", opened.reject);
      await opened.promise;
    }
    const noneWt = realpathSync(noneTarget);
    const noneHello = await waitFor("hello for the unnamed-harness project", () => noneFrames.find((f) => f.type === "hello"));
    check(
      "a project nobody named a harness for still comes up with a session, on omp",
      noneHello.session.sessions.length === 1 &&
        noneHello.session.sessions[0].worktree === noneWt &&
        noneHello.session.sessions[0].backend.id === "omp" &&
        noneHello.agents[noneWt] === "idle" &&
        noneHello.graphs[noneWt] !== undefined,
      JSON.stringify({
        sessions: noneHello.session.sessions.map((s) => `${s.worktree}:${s.backend.id}`),
        agents: noneHello.agents,
      }),
    );
    check(
      "and it still reports every harness it found, omp being only the fallback",
      noneHello.tools.launcher === "pty" && noneHello.tools.harnesses.map((t) => t.id).sort().join(",") === "claude,omp",
      JSON.stringify(noneHello.tools),
    );
    const firstStart = await waitFor("the harness the fallback started", () =>
      ompFrames(ompLogIn(noneTarget)).find((f) => f.type === "__start"),
    );
    check(
      "the fallback harness ran in that variation and approves nothing by itself",
      firstStart.cwd === noneWt && !firstStart.argv.join(" ").includes("--approval-mode"),
      JSON.stringify(firstStart.argv),
    );

    // close it, so the variation is on the view with a canvas and no session:
    // the state typing used to be refused in
    const closeAt = noneFrames.length;
    noneSocket.send(JSON.stringify({ type: "close_worktree", worktree: noneWt }));
    const noneStopped = await waitFor("session_stopped for the closed variation", () =>
      noneFrames.slice(closeAt).find((f) => f.type === "session_stopped" && f.worktree === noneWt),
    );
    check("close_worktree leaves that variation with no session", typeof noneStopped.reason === "string" && noneStopped.reason.length > 0, noneStopped.reason);
    await waitFor("the closed harness process to go", () => gone(firstStart.pid));

    const typedAt = noneFrames.length;
    const typed = "type into a variation with nothing running";
    noneSocket.send(JSON.stringify({ type: "utterance", worktree: noneWt, referent: null, text: typed, productFirst: false }));
    const reopened = await waitFor(
      "the session the typing opened",
      () => noneFrames.slice(typedAt).find((f) => f.type === "session_started" && f.worktree === noneWt),
      30_000,
    );
    check(
      "typing into a variation with no session opens one instead of refusing it",
      reopened.backend.id === "omp" && !noneFrames.slice(typedAt).some((f) => f.type === "error"),
      JSON.stringify(noneFrames.slice(typedAt).filter((f) => f.type === "error").map((f) => f.message)),
    );
    const answered = await waitFor(
      "the reopened session answering what was typed",
      () =>
        noneFrames
          .slice(typedAt)
          .find((f) => f.type === "graph" && f.worktree === noneWt && f.graph.nodes.some((n) => n.id === "auth-service")),
      30_000,
    );
    check(
      "the session is announced BEFORE the sentence lands in it",
      noneFrames.indexOf(reopened) < noneFrames.indexOf(answered),
      `session_started@${noneFrames.indexOf(reopened)} answer@${noneFrames.indexOf(answered)}`,
    );
    const noneStarts = ompFrames(ompLogIn(noneTarget)).filter((f) => f.type === "__start");
    check(
      "what it opened is a second harness process in that same variation",
      noneStarts.length === 2 &&
        noneStarts[1].pid !== firstStart.pid &&
        noneStarts[1].cwd === noneWt &&
        !noneStarts[1].argv.join(" ").includes("--approval-mode"),
      JSON.stringify(noneStarts.map((f) => `${f.pid}:${f.cwd}`)),
    );
    const heard = ompFrames(ompLogIn(noneTarget)).filter((f) => f.type === "deliver" || f.type === "delivered");
    check(
      "the typed sentence is the first thing the new session hears, and it is receipted",
      heard[0]?.type === "deliver" &&
        heard[0].body.includes(typed) &&
        heard.some((f) => f.type === "delivered" && f.id === heard[0].id),
      JSON.stringify(heard.map((f) => f.type)),
    );
  } catch (err) {
    check("the unnamed-harness run completed", false, String(err));
  } finally {
    noneSocket?.close();
    noneBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(noneTarget, { recursive: true, force: true });
    await rm(noneHome, { recursive: true, force: true });
  }
}

// --- the native folder chooser ----------------------------------------------
// "Open another" with an empty box asks the machine the project's agent runs
// on for a folder, because no browser API hands a page an absolute path. The
// dialog itself is stood in for by SHAPE_PICK_FOLDER, the way SHAPE_GH stands
// in for the GitHub CLI — one command per process, so each case needs a bridge
// of its own: a person choosing a folder, a person closing the dialog, and a
// machine with no chooser to run at all.
{
  const pickHome = await mkdtemp(join(tmpdir(), "vh-smoke-pick-home-"));
  const chosen = await mkdtemp(join(tmpdir(), "vh-smoke-chosen-"));
  const running = [];

  /** a bridge whose chooser is `command`, with a browser watching its project */
  const chooserBridge = async (label, command, port) => {
    const target = await mkdtemp(join(tmpdir(), "vh-smoke-pick-"));
    const frames = [];
    const bridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", target, "--port", String(port), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        // the fake gh, for the same reason the main bridge gets it: startup
        // probes for a GitHub login, and a smoke must not wait on a network
        env: {
          ...process.env,
          ...NO_AUTO_MAP,
          SHAPE_PICK_FOLDER: command,
          SHAPE_GH: fakeGh,
          SHAPE_HOME: pickHome,
          HOME: pickHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // registered before anything is awaited: a bridge that never comes up is
    // still a process this block has to take down
    let err = "";
    const live = { target, frames, bridge, socket: null, stderr: () => err };
    running.push(live);
    bridge.stderr.setEncoding("utf8");
    bridge.stderr.on("data", (d) => {
      err += d;
    });
    await waitFor(`bridge listening for ${label}`, () => err.includes("canvas at ws://"), 30_000);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    live.socket = socket;
    {
      const opened = Promise.withResolvers();
      socket.once("open", opened.resolve);
      socket.once("error", opened.reject);
      await opened.promise;
    }
    await waitFor(`hello for ${label}`, () => frames.find((f) => f.type === "hello"));
    return live;
  };

  try {
    // node, not printf: its startup is what keeps the "dialog" standing open
    // long enough for the second ask below to find one already there
    const answers = await chooserBridge(
      "the chooser that answers with a folder",
      `${process.execPath} -e process.stdout.write(${JSON.stringify(chosen)})`,
      PORT + 7,
    );
    // a second browser on the same project: it opened no dialog, so the answer
    // is none of its business
    const otherFrames = [];
    const other = new WebSocket(`ws://127.0.0.1:${PORT + 7}/ws`);
    other.on("message", (data) => otherFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      other.once("open", opened.resolve);
      other.once("error", opened.reject);
      await opened.promise;
    }
    await waitFor("hello for the second browser on the project", () => otherFrames.find((f) => f.type === "hello"));

    const pickAt = answers.frames.length;
    answers.socket.send(JSON.stringify({ type: "pick_folder" }));
    answers.socket.send(JSON.stringify({ type: "pick_folder" }));
    const answer = await waitFor("folder_picked on the socket that asked", () =>
      answers.frames.slice(pickAt).find((f) => f.type === "folder_picked"),
    );
    check("the folder the chooser named is what comes back", answer.path === chosen, JSON.stringify(answer));
    const second = await waitFor("the second chooser refused", () =>
      answers.frames.slice(pickAt).find((f) => f.type === "error" && f.message.startsWith("pick_folder")),
    );
    check(
      "a second chooser while one is open is refused, not queued behind it",
      second.message === "pick_folder rejected: a folder chooser is already open",
      second.message,
    );
    check(
      "the answer reached the browser that asked and nobody else",
      !otherFrames.some((f) => f.type === "folder_picked") &&
        !otherFrames.some((f) => f.type === "error" && f.message.startsWith("pick_folder")),
      JSON.stringify(otherFrames.filter((f) => f.type === "folder_picked" || f.type === "error")),
    );
    other.close();

    // closing the dialog is an answer about nothing: exit 1, no path
    const cancels = await chooserBridge("the chooser the user closes", "false", PORT + 8);
    const cancelAt = cancels.frames.length;
    cancels.socket.send(JSON.stringify({ type: "pick_folder" }));
    const cancelled = await waitFor("folder_picked for the closed chooser", () =>
      cancels.frames.slice(cancelAt).find((f) => f.type === "folder_picked"),
    );
    check("closing the chooser answers with no folder at all", cancelled.path === null, JSON.stringify(cancelled));

    // and a machine whose chooser cannot be run says so, twice: the second ask
    // proves the failure released the room's slot instead of wedging it
    const missing = await chooserBridge("a machine with no chooser", "/nonexistent/binary", PORT + 9);
    const missingAt = missing.frames.length;
    missing.socket.send(JSON.stringify({ type: "pick_folder" }));
    const failure = await waitFor("the failure the browser hears", () =>
      missing.frames.slice(missingAt).find((f) => f.type === "error" && f.message.startsWith("pick_folder")),
    );
    check(
      "a chooser that cannot be run is a failure, not a cancel",
      failure.message.startsWith("pick_folder failed:") &&
        !missing.frames.slice(missingAt).some((f) => f.type === "folder_picked"),
      failure.message,
    );
    const retryAt = missing.frames.length;
    missing.socket.send(JSON.stringify({ type: "pick_folder" }));
    const retry = await waitFor("the second ask after a failure", () =>
      missing.frames.slice(retryAt).find((f) => f.type === "error" && f.message.startsWith("pick_folder")),
    );
    check(
      "a failed chooser leaves the next one free to try",
      retry.message.startsWith("pick_folder failed:"),
      retry.message,
    );
  } catch (failure) {
    // what a bridge that never came up printed is the only thing that explains it
    const said = running.map((live) => live.stderr().trim().split("\n").at(-1) ?? "").join(" | ");
    check("the folder chooser run completed", false, `${String(failure)} — ${said}`);
  } finally {
    for (const live of running) {
      live.socket?.close();
      live.bridge?.kill("SIGKILL");
    }
    await sleep(100);
    for (const live of running) await rm(live.target, { recursive: true, force: true });
    await rm(chosen, { recursive: true, force: true });
    await rm(pickHome, { recursive: true, force: true });
  }
}

// --- the map nobody asked for -----------------------------------------------
// The two states a project lands in by itself, and the room's answer to each:
// NEVER MAPPED (code on disk, no bubbles) is surveyed the moment a session
// starts in it, and FELL BEHIND (bubbles, and the code moved out from under
// them) is caught up the same way. Every other bridge in this file runs with
// SHAPE_AUTO_MAP=0 because it drives onboarding by hand; these two are the
// blocks it is unset in, so what they see is the room deciding for itself.
//
// Nothing here ever sends an `onboard` frame. That is the point.
{
  const autoTarget = await mkdtemp(join(tmpdir(), "vh-smoke-auto-"));
  const autoHome = await mkdtemp(join(tmpdir(), "vh-smoke-auto-home-"));
  await seedWorkspace(autoTarget, "au");
  // a second variation of the same repo, canvas empty and nothing running in
  // it: the room's decision about THIS one happens while a browser is watching,
  // because the browser is the one that opens it
  const autoVar = join(tmpdir(), `vh-smoke-auto-wt-${process.pid}`);
  execFileSync("git", ["worktree", "add", "-b", "auto-variation", autoVar], { cwd: autoTarget, stdio: "ignore" });
  const autoWt = realpathSync(autoTarget);
  const autoVarWt = realpathSync(autoVar);
  const autoPort = PORT + 10;
  const autoLog = ompLogIn(autoTarget);
  const autoVarLog = ompLogIn(autoVar);
  const autoFrames = [];
  let autoBridge = null;
  let autoSocket = null;
  try {
    autoBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", autoTarget, "--port", String(autoPort), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        // deliberately WITHOUT NO_AUTO_MAP: the automatic map is the subject
        env: { ...process.env, SHAPE_HOME: autoHome, HOME: autoHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let autoErr = "";
    autoBridge.stderr.setEncoding("utf8");
    autoBridge.stderr.on("data", (d) => {
      autoErr += d;
    });
    await waitFor("bridge listening for the unmapped project", () => autoErr.includes("canvas at ws://"), 30_000);

    autoSocket = new WebSocket(`ws://127.0.0.1:${autoPort}/ws`);
    autoSocket.on("message", (data) => autoFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      autoSocket.once("open", opened.resolve);
      autoSocket.once("error", opened.reject);
      await opened.promise;
    }
    const autoHello = await waitFor("hello for the unmapped project", () => autoFrames.find((f) => f.type === "hello"), 30_000);
    check("the project the bridge came up in has code", autoHello.session.targetHasCode === true);

    // the startup session was already mapping by the time this browser could
    // connect — which is the point — so the proof of it is what the harness
    // received and what the canvas carries, not a frame nobody was there for
    const startupSurvey = await waitFor(
      "the survey the room delivered by itself",
      () => ompFrames(autoLog).find((f) => f.type === "deliver" && f.body.includes("<onboarding-survey>")),
      30_000,
    );
    check(
      "a session in a project with code and no map surveys it without being asked",
      startupSurvey.mode === "prompt" &&
        startupSurvey.body.includes("Mechanical skeleton") &&
        !startupSurvey.body.includes("User focus"),
      `${startupSurvey.mode} ${String(startupSurvey.body.length)}`,
    );
    const autoMark = await waitFor(
      "the mark the automatic survey left on the canvas",
      () => {
        const frame = autoFrames.find((f) => f.type === "graph" && f.worktree === autoWt && f.graph.surveyed !== undefined);
        if (frame !== undefined) return frame.graph;
        const greeting = autoFrames.find((f) => f.type === "hello");
        const graph = greeting?.graphs?.[autoWt];
        return graph?.surveyed === undefined ? null : graph;
      },
      30_000,
    );
    check(
      "delivering it marked the canvas as mapped at the HEAD it was mapped against",
      autoMark.surveyed.head === autoMark.reality.head &&
        typeof autoMark.surveyed.head === "string" &&
        typeof autoMark.surveyed.at === "string",
      JSON.stringify(autoMark.surveyed),
    );

    // and now the same decision, watched: the other variation's canvas is
    // empty and nothing runs in it, so opening it is a session start this
    // browser sees every frame of
    const varAt = autoFrames.length;
    autoSocket.send(JSON.stringify({ type: "open_worktree", path: autoVar }));
    await waitFor(
      "the session opened in the unmapped variation",
      () => autoFrames.slice(varAt).find((f) => f.type === "session_started" && f.worktree === autoVarWt),
      30_000,
    );
    const line = await waitFor(
      "the transcript line of a map nobody asked for",
      () =>
        autoFrames
          .slice(varAt)
          .find(
            (f) =>
              f.type === "transcript" &&
              f.worktree === autoVarWt &&
              f.role === "user" &&
              f.text.startsWith("Map this project"),
          ),
      30_000,
    );
    check(
      "the room says why it is mapping a project nobody asked it to map",
      line.text === "Map this project — this project has code and no map yet",
      line.text,
    );
    const varSurvey = await waitFor(
      "the survey delivered to the variation",
      () => ompFrames(autoVarLog).find((f) => f.type === "deliver" && f.body.includes("<onboarding-survey>")),
      30_000,
    );
    check(
      "every session start on an unmapped canvas gets the survey, not just the first of the project",
      varSurvey.mode === "prompt" && !varSurvey.body.includes("<catch-up>"),
      varSurvey.mode,
    );
    const varMark = await waitFor(
      "the mark on the variation's canvas",
      () =>
        autoFrames
          .slice(varAt)
          .find((f) => f.type === "graph" && f.worktree === autoVarWt && f.graph.surveyed !== undefined),
      30_000,
    );
    check(
      "the variation's canvas carries its own mark, at its own HEAD",
      varMark.graph.surveyed.head === varMark.graph.reality.head && typeof varMark.graph.surveyed.head === "string",
      JSON.stringify(varMark.graph.surveyed),
    );

    // and the anti-loop half: that variation, closed and reopened. Its canvas
    // has bubbles now and it was mapped at this HEAD, so the second session
    // start finds nothing behind and delivers nothing — a room that surveyed
    // again here would remap the project on every reconnect forever.
    const reopenAt = autoFrames.length;
    autoSocket.send(JSON.stringify({ type: "close_worktree", worktree: autoVarWt }));
    await waitFor(
      "session_stopped for the reopened variation",
      () => autoFrames.slice(reopenAt).find((f) => f.type === "session_stopped" && f.worktree === autoVarWt),
      30_000,
    );
    autoSocket.send(JSON.stringify({ type: "open_worktree", path: autoVar }));
    await waitFor(
      "the second session in the same variation",
      () => autoFrames.slice(reopenAt).find((f) => f.type === "session_started" && f.worktree === autoVarWt),
      30_000,
    );
    await waitFor(
      "the second harness process in that variation",
      () => ompFrames(autoVarLog).filter((f) => f.type === "__start").length === 2,
      30_000,
    );
    // the room decides as the session starts, so a beat after the second start
    // is a beat after the decision
    await sleep(1500);
    const mapped = ompFrames(autoVarLog).filter(
      (f) => f.type === "deliver" && (f.body.includes("<onboarding-survey>") || f.body.includes("<catch-up>")),
    );
    check(
      "a second session on a canvas that is not behind is mapped again by nobody",
      mapped.length === 1,
      JSON.stringify(mapped.map((f) => f.id)),
    );
  } catch (err) {
    check("the automatic survey run completed", false, String(err));
  } finally {
    autoSocket?.close();
    autoBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(autoVar, { recursive: true, force: true });
    await rm(autoTarget, { recursive: true, force: true });
    await rm(autoHome, { recursive: true, force: true });
  }
}

// --- the map that fell behind -----------------------------------------------
// A canvas with bubbles, seeded into the database before the bridge starts, and
// a repo with a package none of those bubbles points at: the map is behind the
// code, so the session that starts in it gets the catch-up turn — the same
// validation as a survey, a prompt made of the gap, and exactly once per HEAD.
{
  const cuTarget = await mkdtemp(join(tmpdir(), "vh-smoke-catchup-"));
  const cuHome = await mkdtemp(join(tmpdir(), "vh-smoke-catchup-home-"));
  await seedWorkspace(cuTarget, "cu");
  const cuWt = realpathSync(cuTarget);
  const cuPort = PORT + 11;
  const cuLog = ompLogIn(cuTarget);
  const cuFrames = [];
  let cuBridge = null;
  let cuSocket = null;
  let cuErr = "";
  try {
    // the canvas as somebody left it: one bubble, over one of the two packages.
    // Written under the key the agent will derive, so the first attach finds it
    // exactly where it looks for its own canvas.
    const { openSqliteStorage } = await import(new URL("../src/server/sqlite.ts", import.meta.url));
    const cuDb = join(cuHome, ".shape", "shape.db");
    const seeded = openSqliteStorage(cuDb);
    await seeded.saveGraph("local", projectKeyOf(cuTarget), cuWt, {
      rev: 5,
      nodes: [
        {
          id: "the-front-door",
          parentId: null,
          label: "The front door",
          summary: "Lets a person in and hands the rest of the app a session.",
          phase: "built",
          codeRefs: ["packages/auth"],
        },
      ],
      edges: [],
    });

    cuBridge = spawn(
      process.execPath,
      ["src/index.ts", "--cwd", cuTarget, "--port", String(cuPort), "--omp", "node scripts/fake-omp-tui.mjs"],
      {
        cwd: process.cwd(),
        // WITHOUT NO_AUTO_MAP, like the block above: the room decides here
        env: { ...process.env, SHAPE_HOME: cuHome, HOME: cuHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cuBridge.stderr.setEncoding("utf8");
    cuBridge.stderr.on("data", (d) => {
      cuErr += d;
    });
    await waitFor("bridge listening for the stale map", () => cuErr.includes("canvas at ws://"), 30_000);

    cuSocket = new WebSocket(`ws://127.0.0.1:${cuPort}/ws`);
    cuSocket.on("message", (data) => cuFrames.push(JSON.parse(data.toString())));
    {
      const opened = Promise.withResolvers();
      cuSocket.once("open", opened.resolve);
      cuSocket.once("error", opened.reject);
      await opened.promise;
    }
    const cuHello = await waitFor("hello for the stale map", () => cuFrames.find((f) => f.type === "hello"), 30_000);
    check(
      // the startup session was already being caught up by the time this
      // browser could connect — on Linux the catch-up's file index is two git
      // spawns that finish before the socket is even open — so what is asserted
      // is that the seeded bubble is the canvas this room opened on, never that
      // nothing has happened since; the proof of the turn is what the harness
      // received and what the room wrote down, not a frame nobody was there for
      "the canvas the bridge came up on is the one that was left behind",
      cuHello.graphs[cuWt]?.nodes.some((n) => n.id === "the-front-door") === true &&
        !cuHello.graphs[cuWt]?.nodes.some((n) => n.id === "cu-auth"),
      JSON.stringify(cuHello.graphs[cuWt]?.nodes.map((n) => n.id) ?? null),
    );

    const catchUp = await waitFor(
      "the catch-up prompt",
      () => ompFrames(cuLog).find((f) => f.type === "deliver" && f.body.includes("<catch-up>")),
      30_000,
    );
    const cuAudit = await waitFor("the room's own record of the catch-up", () => {
      let db = null;
      try {
        db = new DatabaseSync(cuDb);
        const rows = db
          .prepare("SELECT entry FROM audit WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY seq ASC")
          .all("local", projectKeyOf(cuTarget), cuWt);
        return rows.map((r) => JSON.parse(r.entry)).find((e) => e.kind === "onboard") ?? null;
      } catch {
        return null;
      } finally {
        db?.close();
      }
    });
    check(
      "a canvas the code moved under is caught up, not remapped",
      cuAudit.catchUp === true &&
        cuAudit.focus === null &&
        !ompFrames(cuLog).some((f) => f.type === "deliver" && f.body.includes("<onboarding-survey>")),
      JSON.stringify(cuAudit),
    );
    check(
      "the catch-up prompt names the package no bubble covers, and the file with the parts inside it",
      catchUp.body.includes("- r:@cu/db — packages/db") &&
        catchUp.body.includes("- packages/db/src/backup.mjs: backupUsers (function, exported, line 1)") &&
        catchUp.body.includes("Notes on the map"),
      JSON.stringify(catchUp.body.split("\n").filter((l) => l.startsWith("- r:") || l.startsWith("- packages/"))),
    );
    check(
      "and it carries the survey's own rules: plain English, the boundary test, the altitude bound, depth, and the armed validation",
      catchUp.body.includes("PLAIN ENGLISH, NO JARGON") &&
        catchUp.body.includes(
          "can you state what it promises to the rest of the system in one sentence, and would deleting it break a named set of importers?",
        ) &&
        catchUp.body.includes("Altitude: 3-5 top-level bubbles") &&
        catchUp.body.includes("Depth, rule 10:") &&
        catchUp.body.includes("Validation is armed for this turn") &&
        // no skeleton is synthesized for a canvas that already has bubbles
        !catchUp.body.includes("Mechanical skeleton"),
      JSON.stringify(catchUp.body.slice(0, 120)),
    );
    {
      // the canvas as this browser has seen it: the hello it opened on, plus
      // every revision since — a browser that connected after the turn was
      // delivered still holds the canvas the turn left behind
      const cuSeen = [cuHello.graphs[cuWt], ...cuFrames.filter((f) => f.type === "graph" && f.worktree === cuWt).map((f) => f.graph)];
      check(
        "no mechanical skeleton was seeded over the map somebody already grouped",
        cuSeen.every((g) => g !== undefined && !g.nodes.some((n) => n.id === "cu-auth" || n.id === "cu-db")),
        JSON.stringify(cuSeen.at(-1)?.nodes.map((n) => n.id) ?? null),
      );
    }

    // the same validation a survey turn runs under: the fake answers this
    // prompt with one legal claim and one bubble pointing at a path that does
    // not exist, and the gate refuses the second
    const cuResult = await waitFor(
      "the catch-up turn's canvas receipt",
      () => ompFrames(cuLog).find((f) => f.type === "canvas_result" && f.text.includes("onboarding/unknown-coderef")),
      30_000,
    );
    check(
      "codeRefs validation is armed for a catch-up turn exactly as it is for a survey",
      receipts(cuResult.text).rejections.some(
        (r) => r.code === "onboarding/unknown-coderef" && r.evidence.ref === "packages/nope",
      ),
      cuResult.text.split("\n")[0],
    );
    const cuMark = await waitFor(
      "the mark the catch-up left on the canvas",
      () => {
        const frame = cuFrames.find((f) => f.type === "graph" && f.worktree === cuWt && f.graph.surveyed !== undefined);
        if (frame !== undefined) return frame.graph;
        // delivered before this browser connected: the hello carries the mark
        const graph = cuHello.graphs[cuWt];
        return graph?.surveyed === undefined ? null : graph;
      },
      30_000,
    );
    check(
      "the catch-up marks the canvas as caught up at this HEAD",
      cuMark.surveyed.head === cuMark.reality.head && typeof cuMark.surveyed.head === "string",
      JSON.stringify(cuMark.surveyed),
    );

    // and once at that HEAD: the variation closed and reopened is a second
    // session start on a canvas that was caught up a moment ago, and the room
    // leaves it alone until the code moves again
    const cuReopenAt = cuFrames.length;
    cuSocket.send(JSON.stringify({ type: "close_worktree", worktree: cuWt }));
    await waitFor(
      "session_stopped for the caught-up variation",
      () => cuFrames.slice(cuReopenAt).find((f) => f.type === "session_stopped" && f.worktree === cuWt),
      30_000,
    );
    cuSocket.send(JSON.stringify({ type: "open_worktree", path: cuTarget }));
    await waitFor(
      "the second session in the caught-up variation",
      () => cuFrames.slice(cuReopenAt).find((f) => f.type === "session_started" && f.worktree === cuWt),
      30_000,
    );
    await waitFor(
      "the second harness process in the caught-up variation",
      () => ompFrames(cuLog).filter((f) => f.type === "__start").length === 2,
      30_000,
    );
    await sleep(1500);
    const cuMapped = ompFrames(cuLog).filter(
      (f) => f.type === "deliver" && (f.body.includes("<catch-up>") || f.body.includes("<onboarding-survey>")),
    );
    check(
      "a reconnect at the same HEAD is not caught up a second time",
      cuMapped.length === 1,
      JSON.stringify(cuMapped.map((f) => f.id)),
    );
  } catch (err) {
    check("the automatic catch-up run completed", false, `${String(err)}\n--- bridge stderr ---\n${cuErr}`);
  } finally {
    cuSocket?.close();
    cuBridge?.kill("SIGKILL");
    await sleep(100);
    await rm(cuTarget, { recursive: true, force: true });
    await rm(cuHome, { recursive: true, force: true });
  }
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
