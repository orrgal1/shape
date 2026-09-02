#!/usr/bin/env node
/**
 * Bridge dev smoke test. Runs the real bridge against scripts/fake-omp.mjs in a
 * throwaway target dir, drives it over WebSocket, and asserts the wire contract.
 *
 * Usage (from packages/bridge): node scripts/smoke.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? 4409);
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
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** the fake child logs to <its cwd>/fake-omp.log */
const ompLogIn = (dir) => join(dir, "fake-omp.log");

const target = await mkdtemp(join(tmpdir(), "vh-smoke-a-"));
const targetB = await mkdtemp(join(tmpdir(), "vh-smoke-b-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-smoke-home-"));
await seedWorkspace(target, "t");
await seedWorkspace(targetB, "b");
// HOME is pointed at fakeHome for the bridge child, so "~/proj" is this dir
const homeProj = join(fakeHome, "proj");
await mkdir(homeProj, { recursive: true });
await seedWorkspace(homeProj, "h");

// a second worktree of target A's repo, on its own branch — the toggle target
const worktree = join(tmpdir(), `vh-smoke-wt-${process.pid}`);
execFileSync("git", ["worktree", "add", "-b", "variation", worktree], { cwd: target, stdio: "ignore" });
const ompLog = ompLogIn(target);
const frames = [];
let bridge = null;
let socket = null;

// --- store.applyCanvasCall: gate vetoes interleaved with shared rejections ---
// In-process (node strips types, same as the bridge child): the index
// interleaving lives entirely in GraphStore, no wire round-trip needed.
{
  const { GraphStore } = await import(new URL("../src/store.ts", import.meta.url));
  const store = new GraphStore(join(tmpdir(), `vh-smoke-store-${process.pid}`));
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
  const mixed = JSON.parse(outcome.text.slice(outcome.text.indexOf("\n") + 1)).rejections;
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
}

// --- backend seam: config precedence + unknown-id startup error ------------
// Two extra bridge processes: one whose harness command comes only from
// ~/.shape/config.json (no --omp flag), one whose project config names a
// backend that does not exist.
{
  const cfgTarget = await mkdtemp(join(tmpdir(), "vh-smoke-cfg-"));
  const cfgHome = await mkdtemp(join(tmpdir(), "vh-smoke-cfghome-"));
  const fakeOmp = join(process.cwd(), "scripts", "fake-omp.mjs");
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
      env: { ...process.env, SHAPE_HOME: cfgHome, HOME: cfgHome },
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
      started !== undefined && started.cwd === realpathSync(cfgTarget) && cfgErr.includes("registered host tool: canvas"),
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
      env: { ...process.env, SHAPE_HOME: cfgHome, HOME: cfgHome },
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
    "a project config naming an unknown backend fails startup and lists the known ids",
    badExit !== 0 && badExit !== "timeout" && /unknown backend "nope"/.test(badErr) && /known ids: omp/.test(badErr),
    `exit=${badExit} stderr=${badErr.trim().split("\n").pop() ?? ""}`,
  );
  bad.kill("SIGKILL");

  await rm(projectConfig, { force: true });
  check("the offending project config is gone again", !existsSync(projectConfig));
  await rm(cfgTarget, { recursive: true, force: true });
  await rm(cfgHome, { recursive: true, force: true });
}

try {
  bridge = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", target, "--port", String(PORT), "--omp", "node scripts/fake-omp.mjs"],
    {
      cwd: process.cwd(),
      // held turns keep the session streaming long enough to test the steer branch;
      // SHAPE_HOME/HOME keep recents.json and "~" out of the real home dir
      env: { ...process.env, FAKE_OMP_TURN_HOLD_MS: "1200", SHAPE_HOME: fakeHome, HOME: fakeHome },
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
  check("bridge registered the canvas host tool", stderr.includes("registered host tool: canvas"));

  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  socket.once("open", opened.resolve);
  socket.once("error", opened.reject);
  await opened.promise;

  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check(
    "hello carries graph + session + agent state",
    hello.graph !== undefined && hello.session?.cwd === target && hello.agent === "idle",
    `session=${JSON.stringify(hello.session)}`,
  );
  check("hello reports an empty intent layer", hello.graph.nodes.length === 0 && hello.graph.edges.length === 0);
  const backend = hello.session.backend;
  check(
    "hello names the backend it is driving",
    backend?.id === "omp" && backend.label === "omp",
    JSON.stringify(backend ?? null),
  );
  check(
    "hello carries the backend's capability object",
    backend?.capabilities !== undefined &&
      backend.capabilities.steerMidTurn === true &&
      backend.capabilities.hostTool === true &&
      backend.capabilities.events === "native" &&
      backend.capabilities.resume === true &&
      backend.capabilities.terminal === "shell",
    JSON.stringify(backend?.capabilities ?? null),
  );

  // --- startup reality extraction -------------------------------------------
  if (existsSync("src/reality.ts")) {
    const pkgs = hello.graph.reality.nodes.map((n) => n.id).sort();
    check("reality extracted before the first hello", pkgs.length === 2, pkgs.join(","));
    check("reality layer records git HEAD", typeof hello.graph.reality.head === "string", String(hello.graph.reality.head).slice(0, 8));
    check("targetHasCode from workspace packages", hello.session.targetHasCode === true);
  } else {
    check("targetHasCode from the source-file fallback", hello.session.targetHasCode === true);
  }

  // --- worktree detection ---------------------------------------------------
  const wtPath = realpathSync(worktree);
  const mainPath = realpathSync(target);
  const wtList = hello.session.worktrees;
  const mainEntry = wtList.find((w) => w.path === mainPath);
  const variation = wtList.find((w) => w.path === wtPath);
  check("hello lists every worktree of the target's repo", wtList.length === 2, JSON.stringify(wtList.map((w) => `${w.path}@${w.branch}`)));
  check(
    "the targeted worktree is the current one",
    mainEntry?.current === true && variation?.current === false,
    JSON.stringify(wtList.map((w) => `${w.branch}:${w.current}`)),
  );
  check(
    "worktree branch and head are reported",
    variation?.branch === "variation" && typeof variation.head === "string" && variation.head.length === 40 &&
      typeof mainEntry?.branch === "string" && mainEntry.branch.length > 0,
    JSON.stringify({ branch: variation?.branch, head: variation?.head?.slice(0, 8), main: mainEntry?.branch }),
  );
  check(
    "`.shape/` was added to the repo's shared info/exclude",
    readFileSync(join(target, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l.trim() === ".shape/").length === 1,
  );

  // --- onboarding stage 1: mechanical skeleton ------------------------------
  socket.send(JSON.stringify({ type: "onboard", focus: "the auth path" }));

  const skeleton = await waitFor("skeleton graph", () =>
    frames.find((f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "t-auth")),
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
    ompFrames(ompLog).find((f) => f.type === "prompt" && f.message.includes("<onboarding-survey>")),
  );
  check("survey prompt carried the preamble (first delivery of the process)", survey.message.includes("<canvas-harness>"));
  check(
    "survey prompt states the anti-diary rule and the boundary test verbatim",
    survey.message.includes("NOT from README or doc prose") &&
      survey.message.includes("can you state what it promises to the rest of the system in one sentence, and would deleting it break a named set of importers?"),
  );
  check("survey prompt states the altitude bound", survey.message.includes("5-15 top-level bubbles"));
  check("survey prompt lists the mechanical skeleton", /- t-auth "auth" — "Workspace package at packages\/auth/.test(survey.message));
  check("survey prompt carries the user focus", survey.message.includes('User focus for this survey: "the auth path"'));

  // --- plain-English register (CONTRACTS.md §Graph document) ----------------
  check(
    "preamble carries the register rule with a contrasting example",
    survey.message.includes("Register — PLAIN ENGLISH, NO JARGON.") &&
      survey.message.includes('BAD:  "Minimal JSONL RPC client, protocol v1, id-correlated request()"') &&
      survey.message.includes('GOOD: "Talks to the coding agent: sends it instructions and listens to everything it does"') &&
      survey.message.includes("`codeRefs` are the one exception"),
  );
  check(
    "survey prompt repeats the register rule for the summaries it asks for",
    survey.message.includes("2. PLAIN ENGLISH, NO JARGON.") &&
      survey.message.includes("outcomes, not mechanisms") &&
      survey.message.includes("replace every one of them with a plain-English promise"),
  );
  const registration = ompFrames(ompLog).find((f) => f.type === "set_host_tools");
  check(
    "canvas tool description states the register rule",
    registration.tools[0].description.includes("PLAIN ENGLISH, NO JARGON:") &&
      registration.tools[0].description.includes("Only codeRefs stay technical."),
    registration.tools[0].name,
  );

  // --- onboarding validation mode -------------------------------------------
  const surveyResult = await waitFor("survey canvas result", () =>
    ompFrames(ompLog).find((f) => f.type === "host_tool_result" && f.result.content[0].text.includes("onboarding/unknown-coderef")),
  );
  const resultText = surveyResult.result.content[0].text;
  check("valid enrich applied, unpointable node rejected", resultText.startsWith("applied 1 op(s);"), JSON.stringify(resultText));
  const surveyReceipts = JSON.parse(resultText.slice(resultText.indexOf("\n") + 1)).rejections;
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

  const persistedSurvey = JSON.parse(await readFile(join(target, ".shape", "graph.json"), "utf8"));
  check(
    "status persisted to graph.json",
    persistedSurvey.nodes.find((n) => n.id === "t-auth")?.status === "reading how the other parts use it",
  );

  await waitFor("agent:idle after the survey", () => frames.find((f) => f.type === "agent" && f.state === "idle"));
  check("survey turn ended", true);

  socket.send(JSON.stringify({ type: "onboard" }));
  const reonboard = await waitFor("second onboard refused", () =>
    frames.find((f) => f.type === "error" && f.message.startsWith("onboard rejected")),
  );
  check("onboard refused once the canvas has bubbles", reonboard.message.includes("already has bubbles"), reonboard.message);

  // --- turn 1: normal utterance (validation mode must be off again) ---------
  socket.send(JSON.stringify({ type: "utterance", referent: null, text: "build me an auth service" }));

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
    ompFrames(ompLog).find((f) => f.type === "host_tool_result" && f.result.content[0].text.startsWith("applied 3 op(s);")),
  );
  check(
    "validation mode reset: codeRefs-less node accepted after agent_end",
    !normalResult.result.content[0].text.includes("rejected") &&
      graph.graph.nodes.find((n) => n.id === "user-db")?.codeRefs === undefined,
    normalResult.result.content[0].text,
  );

  const toolLine = frames.find((f) => f.type === "transcript" && f.role === "tool" && f.text === "canvas: initial decomposition");
  check("canvas tool transcript line", toolLine !== undefined);

  const activity = await waitFor("activity", () =>
    frames.find((f) => f.type === "activity" && f.nodeIds.includes("auth-service")),
  );
  check("activity mapped tool path -> codeRefs node", activity.nodeIds.sort().join(",") === "auth-service,t-auth", activity.nodeIds.join(","));

  await waitFor("activity cleared", () => frames.find((f) => f.type === "activity" && f.nodeIds.length === 0));
  check("activity cleared on turn_end", true);

  // --- structured repair receipts: malformed batch against the live bridge --
  await waitFor("agent:idle before the bad-op probe", () =>
    frames.filter((f) => f.type === "agent" && f.state === "idle").length >= 2 ? true : null,
  );
  socket.send(JSON.stringify({ type: "utterance", referent: null, text: "bad-op probe" }));
  const badResult = await waitFor("bad-op canvas result", () =>
    ompFrames(ompLog).find((f) => f.type === "host_tool_result" && f.result.content[0].text.includes("op/unknown-parent")),
  );
  const badText = badResult.result.content[0].text;
  check("receipts keep the one-line human summary first", badText.startsWith("applied 0 op(s);"), badText.split("\n")[0]);
  check("all-rejected batch is an error result", badResult.isError === true);
  const badReceipts = JSON.parse(badText.slice(badText.indexOf("\n") + 1)).rejections;
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
      referent: { kind: "node", id: "auth-service" },
      text: "this should also handle token refresh",
    }),
  );

  const addressed = await waitFor("omp received the addressed instruction", () =>
    ompFrames(ompLog).find((f) => (f.type === "prompt" || f.type === "steer") && f.message.includes("token refresh")),
  );

  check("delivered as prompt or steer", addressed.type === "prompt" || addressed.type === "steer", addressed.type);
  check("message contains <canvas-steering>", addressed.message.includes("<canvas-steering>"));
  check("message contains the node label", addressed.message.includes("Auth Service"));
  check("message contains the utterance", addressed.message.includes("this should also handle token refresh"));
  check(
    "message contains the neighbor line",
    /Neighbors: user-db \[dataflow "credentials"\]/.test(addressed.message),
    addressed.message.split("\n")[2],
  );
  check("later deliveries did not repeat the preamble", !addressed.message.includes("<canvas-harness>"));

  // --- turn 3: utterance with an EDGE referent while the turn is streaming ---
  await waitFor("turn 2 streaming", () =>
    frames.filter((f) => f.type === "transcript" && f.role === "assistant" && f.text.startsWith("ack: ")).length >= 2,
  );
  socket.send(
    JSON.stringify({
      type: "utterance",
      referent: { kind: "edge", id: "auth-service--user-db" },
      text: "make this async with a queue in between",
    }),
  );

  const steered = await waitFor("mid-stream delivery", () =>
    ompFrames(ompLog).find((f) => (f.type === "prompt" || f.type === "steer") && f.message.includes("make this async")),
  );
  check("mid-stream utterance delivered as steer", steered.type === "steer", steered.type);
  check(
    "edge referent resolved with endpoints",
    steered.message.includes("<canvas-steering>") &&
      /Referent: edge "credentials" \(id: auth-service--user-db\) — dataflow from auth-service to user-db/.test(steered.message) &&
      steered.message.includes('auth-service "Auth Service"'),
    steered.message.split("\n")[1],
  );
  await waitFor("steer echoed back to the panel", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant" && f.text.startsWith("steered:")),
  );
  check("steer acknowledgement reached the transcript", true);

  // --- persistence ----------------------------------------------------------
  const persisted = JSON.parse(await readFile(join(target, ".shape", "graph.json"), "utf8"));
  check(
    "graph.json persisted in the target dir",
    persisted.rev >= 1 && persisted.nodes.length === 4 && persisted.edges.length === 2,
    `rev=${persisted.rev} nodes=${persisted.nodes.length} edges=${persisted.edges.length}`,
  );

  // --- revision snapshots + diff --------------------------------------------
  const revDir = join(target, ".shape", "revisions");
  const revsOnDisk = () => {
    if (!existsSync(revDir)) return [];
    return readdirSync(revDir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.slice(0, -".json".length)))
      .sort((a, b) => a - b);
  };
  const snapshotAt = (rev) => JSON.parse(readFileSync(join(revDir, `${rev}.json`), "utf8"));

  const revs = await waitFor("revision snapshots on disk", () => {
    const found = revsOnDisk();
    return found.length >= 2 ? found : null;
  });
  check(
    "one snapshot file per revision under .shape/revisions",
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
    "hello carries the revision list",
    Array.isArray(hello.revisions) &&
      hello.revisions.every((r) => typeof r.rev === "number" && typeof r.at === "string"),
    JSON.stringify(hello.revisions),
  );
  const revList = await waitFor("revisions broadcast after a snapshot", () =>
    frames.find((f) => f.type === "revisions" && f.revisions.length >= 2),
  );
  check(
    "a new snapshot broadcasts an ascending revision list",
    revList.revisions.every((r, i, all) => i === 0 || all[i - 1].rev < r.rev),
    JSON.stringify(revList.revisions.map((r) => r.rev)),
  );

  const finalNodeIds = persisted.nodes.map((n) => n.id).sort().join(",");
  const finalEdgeIds = persisted.edges.map((e) => e.id).sort().join(",");
  socket.send(JSON.stringify({ type: "diff", revA: first, revB: last }));
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
  socket.send(JSON.stringify({ type: "diff", revA: skeletonRev, revB: surveyRev }));
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

  socket.send(JSON.stringify({ type: "diff", revA: last, revB: first }));
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

  socket.send(JSON.stringify({ type: "diff", revA: first, revB: 9999 }));
  const badDiff = await waitFor("bogus diff refused", () =>
    frames.find((f) => f.type === "error" && f.message.startsWith("unknown revision")),
  );
  check("diff against a nonexistent revision is refused", badDiff.message === "unknown revision 9999", badDiff.message);

  // --- abort ----------------------------------------------------------------
  socket.send(JSON.stringify({ type: "abort" }));
  await waitFor("abort forwarded", () => ompFrames(ompLog).some((f) => f.type === "abort"), 3000);
  check("abort forwarded to omp", true);

  // --- recents + project switching ------------------------------------------
  check("hello carries recentProjects", Array.isArray(hello.recentProjects) && hello.recentProjects[0] === target, JSON.stringify(hello.recentProjects));
  const childA = ompFrames(ompLog).find((f) => f.type === "__start");

  socket.send(JSON.stringify({ type: "switch_project", path: targetB }));
  const helloB = await waitFor("hello after switch", () =>
    frames.find((f) => f.type === "hello" && f.session.cwd === targetB),
  );
  check("switch_project re-hellos with the new target", helloB.session.cwd === targetB);
  check(
    "the re-created backend is reported for the new target",
    helloB.session.backend?.id === "omp" && helloB.session.backend.capabilities.events === "native",
    JSON.stringify(helloB.session.backend ?? null),
  );
  check("new target starts from its own (empty) graph", helloB.graph.nodes.length === 0 && helloB.graph.rev !== persisted.rev, `rev=${helloB.graph.rev} nodes=${helloB.graph.nodes.length}`);
  check(
    "new target's reality layer was extracted before the hello",
    helloB.graph.reality.nodes.map((n) => n.id).sort().join(",") === "r:@b/auth,r:@b/db",
    helloB.graph.reality.nodes.map((n) => n.id).join(","),
  );
  check("recents are most-recent-first and deduped", helloB.recentProjects.join(" | ") === `${targetB} | ${target}`, helloB.recentProjects.join(" | "));
  check(
    "recents.json written under SHAPE_HOME",
    JSON.parse(await readFile(join(fakeHome, ".shape", "recents.json"), "utf8"))[0] === targetB,
  );

  const persistedA = JSON.parse(await readFile(join(target, ".shape", "graph.json"), "utf8"));
  check("the old project's graph was persisted before switching away", persistedA.nodes.length === 4 && persistedA.edges.length === 2, `nodes=${persistedA.nodes.length}`);

  await waitFor("old child exited", () => ompFrames(ompLog).some((f) => f.type === "__exit"));
  let oldAlive = true;
  try {
    process.kill(childA.pid, 0);
  } catch {
    oldAlive = false;
  }
  check("old omp child is gone and the bridge survived it", !oldAlive && bridge.exitCode === null, `pid=${childA.pid} bridgeExit=${bridge.exitCode}`);

  socket.send(JSON.stringify({ type: "switch_project", path: join(targetB, "does-not-exist") }));
  const badSwitch = await waitFor("bad switch refused", () =>
    frames.find((f) => f.type === "error" && f.message.startsWith("switch_project rejected")),
  );
  check("non-directory path refused", badSwitch.message.includes("is not an existing directory"), badSwitch.message);
  check("no extra hello after the refused switch", frames.filter((f) => f.type === "hello").length === 2);

  socket.send(JSON.stringify({ type: "utterance", referent: null, text: "start the b project" }));
  const bPrompt = await waitFor("utterance reached the new child", () =>
    ompFrames(ompLogIn(targetB)).find((f) => f.type === "prompt" && f.message.includes("start the b project")),
  );
  check("post-switch utterance served by the new child", bPrompt !== undefined);
  check("new session earns the preamble again", bPrompt.message.includes("<canvas-harness>"));
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
    frames.find((f) => f.type === "hello" && f.session.cwd === homeProj),
  );
  check('"~" expanded against the home dir', helloHome.session.cwd === homeProj, helloHome.session.cwd);
  check(
    "home-relative project brought its own reality layer",
    helloHome.graph.reality.nodes.map((n) => n.id).sort().join(",") === "r:@h/auth,r:@h/db",
    helloHome.graph.reality.nodes.map((n) => n.id).join(","),
  );
  check("recents now lead with the home-relative project", helloHome.recentProjects[0] === homeProj, helloHome.recentProjects.length.toString());

  // --- toggling a worktree is just switch_project ---------------------------
  socket.send(JSON.stringify({ type: "switch_project", path: worktree }));
  const helloWt = await waitFor("hello for the worktree", () =>
    frames.find((f) => f.type === "hello" && f.session.cwd === worktree),
  );
  const toggled = helloWt.session.worktrees;
  check(
    "current flipped to the worktree we switched into",
    toggled.find((w) => w.path === wtPath)?.current === true &&
      toggled.find((w) => w.path === mainPath)?.current === false,
    JSON.stringify(toggled.map((w) => `${w.branch}:${w.current}`)),
  );
  const wtPersisted = JSON.parse(await readFile(join(worktree, ".shape", "graph.json"), "utf8"));
  check(
    "the worktree carries its own canvas state, empty and separate from the original's",
    helloWt.graph.nodes.length === 0 && wtPersisted.nodes.length === 0 && wtPersisted.reality.nodes.length === 2,
    `nodes=${wtPersisted.nodes.length} realityPkgs=${wtPersisted.reality.nodes.length}`,
  );
  check(
    "info/exclude stayed idempotent across both startups",
    readFileSync(join(target, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l.trim() === ".shape/").length === 1,
  );

  // --- the link: canvas over MCP + external agent events --------------------
  // The worktree is the live target and its canvas is empty, so the link can
  // add bubbles here without disturbing anything asserted above. A second
  // socket stands in for an external process (MCP server, harness hook).
  const linkUrl = `ws://127.0.0.1:${PORT}/ws`;
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
    JSON.stringify({ type: "agent_event", event: { kind: "text", text: "the link is speaking" } }),
  );
  await waitFor("transcript from an external text event", () =>
    frames.find((f) => f.type === "transcript" && f.role === "assistant" && f.text === "the link is speaking"),
  );
  check("an external text event lands in the transcript", true);

  const activityAt = frames.indexOf(linkActivity);
  linkSocket.send(JSON.stringify({ type: "agent_event", event: { kind: "turn_end" } }));
  await waitFor("activity cleared by an external turn_end", () =>
    frames.slice(activityAt + 1).find((f) => f.type === "activity" && f.nodeIds.length === 0),
  );
  check("an external turn_end ends the turn's activity", true);

  linkSocket.send(
    JSON.stringify({
      type: "agent_event",
      event: { kind: "session", sessionId: "link-session-1", model: { provider: "anthropic", id: "claude-x" } },
    }),
  );
  const sessionProbe = new WebSocket(linkUrl);
  const probeFrames = [];
  sessionProbe.on("message", (data) => probeFrames.push(JSON.parse(data.toString())));
  const probeHello = await waitFor("hello for the session probe", () =>
    probeFrames.find((f) => f.type === "hello" && f.session.sessionId === "link-session-1"),
  );
  check(
    "a session reported by the link becomes the bridge's session",
    probeHello.session.model?.id === "claude-x",
    JSON.stringify({ id: probeHello.session.sessionId, model: probeHello.session.model }),
  );
  sessionProbe.close();

  // the link is a boundary like the browser is: a frame the bridge cannot make
  // sense of is refused, not half-applied
  linkSocket.send(JSON.stringify({ type: "agent_event", event: { kind: "not-an-event" } }));
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
      event: { kind: "tool_start", name: "Edit", paths: "packages/auth", summary: "" },
    }),
  );
  linkSocket.send(JSON.stringify({ type: "canvas_call", args: { ops: [] } }));
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
    hookActivity.nodeIds.join(",") === "linked",
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

  console.log(`\n--- addressed instruction as omp received it ---\n${addressed.message}\n---`);
} catch (err) {
  check("smoke run completed", false, String(err));
} finally {
  socket?.close();
  bridge?.kill("SIGKILL");
  await sleep(100);
  await rm(target, { recursive: true, force: true });
  await rm(targetB, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
  await rm(worktree, { recursive: true, force: true });
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
