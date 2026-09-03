#!/usr/bin/env node
/**
 * Remote-mode smoke test. Runs the two real binaries — `src/server-cli.ts` and
 * `src/agent-cli.ts` — as separate processes joined only by the `/agent`
 * WebSocket, and drives them from a browser socket on `/ws`:
 *
 *   browser before any agent  — joins ungreeted, no hello until an agent attaches
 *   attach                    — hello with agentConnected, one project, the agent's cwd
 *   utterance                 — reaches the remote harness, canvas call comes back
 *   agent SIGTERM             — session/projects flip to disconnected, utterance refused
 *   agent restart             — the room outlives the agent and re-greets it
 *   a second agent            — two projects, select_project joins the other one
 *   remote storage            — a graph per project and a registry under --data-dir
 *   server restart            — the rooms come back; live agents re-bind them
 *   agentless restore         — restored rooms are read-only, and still diffable
 *
 * The harness on both agents is scripts/fake-omp.mjs, so nothing real is
 * spawned; each target project gets its own log, which is what proves which
 * process served a turn.
 *
 * Usage (from packages/bridge): node scripts/smoke-remote.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_REMOTE_PORT ?? 4412);
/** each agent owns a loopback link port of its own: the agents share nothing but the server */
const LINK_PORT_A = PORT + 1;
const LINK_PORT_B = PORT + 2;
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
/** an agent's reconnect backoff tops out at 8 s: a restart must be re-bound inside this */
const RECONNECT_MS = 10_000;

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
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

/** parse a file the server writes under us; a half-written read is just "not yet" */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** the fake child logs to <its cwd>/fake-omp.log; each agent's target gets its own */
const ompLogIn = (dir) => join(dir, "fake-omp.log");

/**
 * A committed pnpm workspace: gives the agent a real git HEAD and two packages,
 * so reality extraction succeeds and the two targets are distinguishable on the
 * wire (@<scope>/auth, @<scope>/db).
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

const targetA = await mkdtemp(join(tmpdir(), "vh-remote-a-"));
const targetB = await mkdtemp(join(tmpdir(), "vh-remote-b-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-remote-home-"));
/** where a remote server keeps graphs, revisions and its project registry */
const dataDir = await mkdtemp(join(tmpdir(), "vh-remote-data-"));
await seedWorkspace(targetA, "ra");
await seedWorkspace(targetB, "rb");

const frames = [];
/** every process this smoke started, so the finally block can kill all of them */
const spawned = [];
let socket = null;

/**
 * Starts one of the binaries with SHAPE_HOME pointed at a throwaway dir (recents
 * must not touch the real home) and the fake harness log pinned to its target.
 * Returns a handle whose `log` accumulates the child's stderr — the banners the
 * steps wait on. cwd stays packages/bridge: relative `--omp` tokens are resolved
 * against the agent process's cwd, not the target's.
 */
function launch(label, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SHAPE_HOME: fakeHome, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = { label, child, log: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    handle.log += d;
    process.stderr.write(`[${label}] ${d}`);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => process.stderr.write(`[${label}:out] ${d}`));
  spawned.push(handle);
  return handle;
}

/** SIGTERM, then SIGKILL if it is still up — an agent's exit must close its link */
async function stopChild(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill("SIGTERM");
  const deadline = Date.now() + 5000;
  while (handle.child.exitCode === null && handle.child.signalCode === null && Date.now() < deadline) {
    await sleep(25);
  }
  handle.child.kill("SIGKILL");
}

const agentArgs = (target, linkPort) => [
  "src/agent-cli.ts",
  "--server",
  SERVER_URL,
  "--cwd",
  target,
  "--link-port",
  String(linkPort),
  "--omp",
  "node scripts/fake-omp.mjs",
];

/**
 * The server binary, pointed at this run's data dir. It is started three times
 * (fresh, restarted under live agents, restarted alone), so each start waits on
 * its own banners — the restore line first when rows are expected, since a step
 * that raced past it would be talking to a server without its rooms.
 */
async function startServer(label, restoredProjects = 0) {
  const handle = launch(label, ["src/server-cli.ts", "--port", String(PORT), "--data-dir", dataDir]);
  if (restoredProjects > 0) {
    const banner = `restored ${restoredProjects} project(s)`;
    await waitFor(`${label} ${banner}`, () => handle.log.includes(banner));
  }
  await waitFor(`${label} listening`, () => handle.log.includes("server at ws://"));
  return handle;
}

const send = (msg) => socket.send(JSON.stringify(msg));
const mark = () => frames.length;
const frameAfter = (from, predicate, label, timeoutMs = 30_000) =>
  waitFor(label, () => frames.slice(from).find(predicate), timeoutMs);

/**
 * A fresh browser socket on /ws, replacing any earlier one (a server restart
 * drops it anyway). Frames from every socket land in the one ordered log, so
 * `mark()` is what separates a step's frames from the steps before it.
 */
async function openBrowser() {
  socket?.close();
  const next = new WebSocket(`${SERVER_URL}/ws`);
  next.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  next.once("open", opened.resolve);
  // stays registered: a killed server errors this socket long after it opened
  next.on("error", opened.reject);
  await opened.promise;
  socket = next;
}

try {
  // --- 1. the server alone, and a browser that arrives before any agent ------

  const server = await startServer("server");
  await openBrowser();

  await sleep(300);
  check(
    "a browser that connects before any agent waits ungreeted",
    !frames.some((f) => f.type === "hello"),
    `${frames.length} frame(s): ${JSON.stringify(frames.map((f) => f.type))}`,
  );

  // --- 2. the first agent attaches over /agent -------------------------------

  const helloAt = mark();
  let agentA = launch("agent-a", agentArgs(targetA, LINK_PORT_A), { FAKE_OMP_LOG: ompLogIn(targetA) });
  await waitFor("agent A attached", () => agentA.log.includes("agent attached to"));

  const hello = await frameAfter(helloAt, (f) => f.type === "hello", "hello after the first attach");
  check("the first agent attach greets the browser that was already waiting", hello.type === "hello");
  check(
    "hello reports the attached agent as connected",
    hello.session.agentConnected === true,
    JSON.stringify(hello.session.agentConnected),
  );
  check(
    "hello lists exactly the one project the agent attached",
    Array.isArray(hello.projects) && hello.projects.length === 1 && hello.projects[0].cwd === targetA,
    JSON.stringify(hello.projects ?? null),
  );
  check(
    "hello names the project this socket is joined to",
    typeof hello.projectId === "string" && hello.projectId === hello.projects[0]?.projectId,
    `${String(hello.projectId)} vs ${String(hello.projects?.[0]?.projectId)}`,
  );
  check("hello serves the remote agent's target as the session cwd", hello.session.cwd === targetA, hello.session.cwd);
  check(
    "hello carries the reality layer extracted from the target workspace",
    hello.graph.reality.nodes.map((n) => n.id).sort().join(",") === "r:@ra/auth,r:@ra/db",
    JSON.stringify(hello.graph.reality.nodes.map((n) => n.id)),
  );

  // --- 3. an utterance travels browser -> server -> agent -> harness ---------

  const utteranceAt = mark();
  send({ type: "utterance", referent: null, text: "build me an auth service" });
  const prompt = await waitFor("prompt in the remote harness log", () =>
    ompFrames(ompLogIn(targetA)).find((f) => f.type === "prompt" && f.message.includes("build me an auth service")),
  );
  check("an utterance crosses the server-agent socket into the harness as a prompt", prompt.type === "prompt");
  check(
    "the first delivery to a fresh harness process carries the canvas preamble",
    prompt.message.includes("<canvas-harness>"),
    prompt.message.slice(0, 60),
  );
  const userLine = await frameAfter(
    utteranceAt,
    (f) => f.type === "transcript" && f.role === "user" && f.text === "build me an auth service",
    "user transcript line",
  );
  check("the utterance is echoed back to the browser as a user transcript line", userLine !== undefined);

  // --- 4. the harness's canvas host tool, all the way back to the browser ----

  const graph = await frameAfter(
    utteranceAt,
    (f) => f.type === "graph" && f.graph.nodes.some((n) => n.id === "auth-service"),
    "graph frame carrying the canvas call",
  );
  check(
    "the harness's canvas call reaches the browser as a graph frame",
    graph.graph.nodes.some((n) => n.id === "user-db") && graph.graph.edges.some((e) => e.id === "auth-service--user-db"),
    JSON.stringify(graph.graph.nodes.map((n) => n.id)),
  );
  const toolResult = await waitFor("canvas result in the harness log", () =>
    ompFrames(ompLogIn(targetA)).find(
      (f) => f.type === "host_tool_result" && f.result.content[0].text.startsWith("applied 3 op(s);"),
    ),
  );
  check(
    "the canvas result is returned across the link to the harness",
    toolResult.result.isError !== true,
    toolResult.result.content[0].text.split("\n")[0],
  );

  // --- 5. the agent goes away: the room stays, read-only ---------------------

  const goneAt = mark();
  await stopChild(agentA);
  const disconnected = await frameAfter(
    goneAt,
    (f) => f.type === "session" && f.session.agentConnected === false,
    "session frame after the agent left",
  );
  check(
    "killing the agent tells the browser the session lost its agent",
    disconnected.session.cwd === targetA,
    disconnected.session.cwd,
  );
  const offline = await frameAfter(
    goneAt,
    (f) => f.type === "projects" && f.projects.some((p) => p.cwd === targetA),
    "projects frame after the agent left",
  );
  check(
    "a departed agent leaves its project listed as offline",
    offline.projects.find((p) => p.cwd === targetA)?.agentConnected === false,
    JSON.stringify(offline.projects),
  );

  const refusedAt = mark();
  send({ type: "utterance", referent: null, text: "anyone home?" });
  const refused = await frameAfter(refusedAt, (f) => f.type === "error", "error for the agentless utterance");
  check(
    "an utterance with no agent attached is refused by name",
    refused.message.includes("no agent is attached"),
    refused.message,
  );

  // --- 6. the agent comes back: same room, new harness process ---------------

  const rejoinAt = mark();
  agentA = launch("agent-a2", agentArgs(targetA, LINK_PORT_A), { FAKE_OMP_LOG: ompLogIn(targetA) });
  await waitFor("agent A re-attached", () => agentA.log.includes("agent attached to"));
  const rehello = await frameAfter(
    rejoinAt,
    (f) => f.type === "hello" && f.session.agentConnected === true,
    "hello after the re-attach",
  );
  check("restarting the agent re-attaches to the room it left behind", rehello.session.cwd === targetA, rehello.session.cwd);

  send({ type: "utterance", referent: null, text: "second life auth service" });
  const rePrompt = await waitFor("prompt in the restarted harness log", () => {
    const log = ompFrames(ompLogIn(targetA));
    const lastStart = log.map((f) => f.type).lastIndexOf("__start");
    const at = log.findIndex((f, i) => i > lastStart && f.type === "prompt" && f.message.includes("second life"));
    return at === -1 ? null : { log, lastStart, prompt: log[at] };
  });
  const starts = rePrompt.log.filter((f) => f.type === "__start");
  check(
    "an utterance after re-attach is served by the new harness process",
    starts.length >= 2 && starts.at(-1).pid !== starts[0].pid && rePrompt.lastStart > 0,
    `${starts.length} start(s): ${JSON.stringify(starts.map((s) => s.pid))}`,
  );

  // --- 7. the room outlives its agent, and a second project joins the server --

  const secondGoneAt = mark();
  await stopChild(agentA);
  const secondGone = await frameAfter(
    secondGoneAt,
    (f) => f.type === "session" && f.session.agentConnected === false,
    "session frame after the second stop",
  );
  check(
    "a second SIGTERM disconnects the re-attached agent again",
    secondGone.session.agentConnected === false,
    JSON.stringify(secondGone.session.agentConnected),
  );

  const thirdAt = mark();
  agentA = launch("agent-a3", agentArgs(targetA, LINK_PORT_A), { FAKE_OMP_LOG: ompLogIn(targetA) });
  await waitFor("agent A attached a third time", () => agentA.log.includes("agent attached to"));
  const thirdHello = await frameAfter(
    thirdAt,
    (f) => f.type === "hello" && f.session.agentConnected === true,
    "hello after the third attach",
  );
  check(
    "the room outlives its agent across a second restart",
    thirdHello.session.cwd === targetA && thirdHello.projects.some((p) => p.cwd === targetA && p.agentConnected === true),
    JSON.stringify(thirdHello.projects),
  );

  const twoAt = mark();
  const agentB = launch("agent-b", agentArgs(targetB, LINK_PORT_B), { FAKE_OMP_LOG: ompLogIn(targetB) });
  await waitFor("agent B attached", () => agentB.log.includes("agent attached to"));
  const both = await frameAfter(
    twoAt,
    (f) => f.type === "projects" && f.projects.length === 2,
    "projects frame listing both projects",
  );
  check(
    "a second agent on the same server adds its project to the list",
    both.projects.some((p) => p.cwd === targetA) && both.projects.some((p) => p.cwd === targetB),
    JSON.stringify(both.projects.map((p) => p.cwd)),
  );

  const selectAt = mark();
  const projectB = both.projects.find((p) => p.cwd === targetB);
  send({ type: "select_project", projectId: projectB.projectId });
  const helloB = await frameAfter(selectAt, (f) => f.type === "hello", "hello for the selected project");
  check(
    "select_project moves this socket to the other project's room",
    helloB.session.cwd === targetB && helloB.projectId === projectB.projectId,
    `${helloB.session.cwd} / ${String(helloB.projectId)}`,
  );

  const unknownAt = mark();
  send({ type: "select_project", projectId: "no-such-project" });
  const unknown = await frameAfter(unknownAt, (f) => f.type === "error", "error for the unknown project id");
  check(
    "select_project on an unknown id is refused by name",
    unknown.message.includes("unknown project"),
    unknown.message,
  );

  // --- 9. what a remote server keeps on disk --------------------------------

  const projectAId = hello.projectId;
  // an unauthenticated server files everything under the implicit `local` tenant
  const graphPath = join(dataDir, "tenants", "local", "projects", projectAId, "graph.json");
  const storedGraph = await waitFor("the first project's graph under the data dir", () => readJson(graphPath), 10_000);
  check(
    "a remote server keeps each project's graph at <data-dir>/tenants/local/projects/<projectId>/graph.json",
    storedGraph.nodes.some((n) => n.id === "auth-service") &&
      storedGraph.edges.some((e) => e.id === "auth-service--user-db"),
    JSON.stringify(storedGraph.nodes.map((n) => n.id)),
  );

  const registry = await waitFor(
    "both projects in the server's registry",
    () => {
      const rows = readJson(join(dataDir, "projects.json"));
      return Array.isArray(rows) && rows.length === 2 ? rows : null;
    },
    10_000,
  );
  check(
    "the registry names both attached projects by cwd",
    [targetA, targetB].every((cwd) => registry.some((row) => row.project?.cwd === cwd)),
    JSON.stringify(registry.map((row) => row.project?.cwd ?? null)),
  );
  check(
    "registry rows are stored projects, not browser summaries",
    registry.every(
      (row) =>
        !("agentConnected" in row) && !("agentConnected" in (row.session ?? {})) && typeof row.lastSeen === "string",
    ),
    JSON.stringify(registry.map((row) => Object.keys(row))),
  );

  // --- 10. the server restarts while both agents are still up ---------------

  await stopChild(server);
  const restartAt = mark();
  const server2 = await startServer("server-2", 2);
  await openBrowser();
  const restartHello = await frameAfter(restartAt, (f) => f.type === "hello", "hello from the restarted server", 3_000);
  check(
    "a restarted server greets a browser at once, out of its registry alone",
    restartHello.projects.length === 2,
    JSON.stringify(restartHello.projects.map((p) => `${p.cwd}:${String(p.agentConnected)}`)),
  );

  const reattached = await waitFor(
    "both restored rooms reporting their agent back",
    () =>
      frames
        .slice(restartAt)
        .filter((f) => f.type === "projects" || f.type === "hello")
        .map((f) => f.projects)
        .find((projects) => projects.length === 2 && projects.every((p) => p.agentConnected === true)) ?? null,
    RECONNECT_MS,
  );
  check(
    "the live agents reconnect and re-bind the rooms the restart restored",
    reattached.some((p) => p.cwd === targetA) && reattached.some((p) => p.cwd === targetB),
    JSON.stringify(reattached.map((p) => `${p.cwd}:${String(p.agentConnected)}`)),
  );

  const restoredA = reattached.find((p) => p.cwd === targetA);
  const restoredAt = mark();
  send({ type: "select_project", projectId: restoredA.projectId });
  const helloRestored = await frameAfter(
    restoredAt,
    (f) => f.type === "hello" && f.projectId === restoredA.projectId,
    "hello for the first project after the restart",
  );
  check(
    "a restored room keeps its project key and serves the graph the old server persisted",
    restoredA.projectId === projectAId &&
      helloRestored.graph.nodes.some((n) => n.id === "auth-service") &&
      helloRestored.session.agentConnected === true,
    `${restoredA.projectId} vs ${projectAId}; ${JSON.stringify(helloRestored.graph.nodes.map((n) => n.id))}`,
  );

  // --- 11. the same rooms with no agent anywhere ----------------------------

  await stopChild(agentA);
  await stopChild(agentB);
  await stopChild(server2);
  const aloneAt = mark();
  await startServer("server-3", 2);
  await openBrowser();
  const aloneHello = await frameAfter(aloneAt, (f) => f.type === "hello", "hello from the agentless server", 3_000);
  check(
    "a server restarted with no agent at all still greets a browser, read-only",
    aloneHello.session.agentConnected === false,
    JSON.stringify(aloneHello.session.agentConnected),
  );
  check(
    "both projects come back agentless after a restart with no agents",
    aloneHello.projects.length === 2 &&
      aloneHello.projects.every((p) => p.agentConnected === false) &&
      [targetA, targetB].every((cwd) => aloneHello.projects.some((p) => p.cwd === cwd)),
    JSON.stringify(aloneHello.projects.map((p) => `${p.cwd}:${String(p.agentConnected)}`)),
  );

  const agentlessIdA = aloneHello.projects.find((p) => p.cwd === targetA)?.projectId;
  const joinAt = mark();
  send({ type: "select_project", projectId: agentlessIdA });
  const agentlessA = await frameAfter(
    joinAt,
    (f) => f.type === "hello" && f.projectId === agentlessIdA,
    "hello for the restored first project",
  );

  const refusedAloneAt = mark();
  send({ type: "utterance", referent: null, text: "anyone survived the restart?" });
  const refusedAlone = await frameAfter(
    refusedAloneAt,
    (f) => f.type === "error",
    "error for the utterance in a restored room",
  );
  check(
    "an utterance in a restored room with no agent is refused by name",
    refusedAlone.message.includes("no agent is attached"),
    refusedAlone.message,
  );

  // the snapshots are the room's, not the agent's: two of them must still diff
  const revs = (agentlessA.revisions ?? []).map((r) => r.rev).sort((a, b) => a - b);
  const diffAt = mark();
  if (revs.length >= 2) send({ type: "diff", revA: revs[0], revB: revs[1] });
  const delta =
    revs.length < 2
      ? null
      : await frameAfter(
          diffAt,
          (f) => f.type === "delta" && f.delta.revA === revs[0] && f.delta.revB === revs[1],
          "delta over the restored revisions",
          5_000,
        ).catch(() => null);
  check(
    "diff over a restored room's two oldest revisions is answered from the snapshots on disk",
    delta !== null,
    `revisions=${revs.join(",")}`,
  );
} catch (err) {
  check("the remote smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  // --- 12. teardown: every child dies, even when a step above threw ----------
  socket?.close();
  for (const handle of spawned.slice().reverse()) {
    try {
      await stopChild(handle);
    } catch (err) {
      process.stderr.write(`[smoke] could not stop ${handle.label}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  await rm(targetA, { recursive: true, force: true });
  await rm(targetB, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
}

console.log("");
for (const line of results) console.log(line);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
