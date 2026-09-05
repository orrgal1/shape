#!/usr/bin/env node
/**
 * Remote-mode smoke test. Runs the two real binaries — `src/server-cli.ts` and
 * `src/agent-cli.ts` — as separate processes joined only by the `/agent`
 * WebSocket, and drives them from a browser socket on `/ws`:
 *
 *   browser before any agent  — joins ungreeted, no hello until an agent attaches
 *   attach                    — hello with agentConnected, one project, the agent's cwd
 *   a session reports in      — a harness dialing the agent's loopback link from
 *                               inside a worktree IS the session appearing
 *   a turn in that session    — its canvas call comes back to the browser as a graph
 *   agent SIGTERM             — session_stopped, session/projects flip to
 *                               disconnected, and nothing else is drawn
 *   agent restart             — the room outlives the agent and re-greets it
 *   a second agent            — two projects, select_project joins the other one
 *   remote storage            — a graph row per variation and a registry in <data-dir>/shape.db
 *   server restart            — the rooms come back; live agents re-bind them
 *   agentless restore         — restored rooms are read-only, and still diffable
 *
 * The sessions are scripts/fake-omp-tui.mjs processes this smoke starts itself,
 * pointed at each agent's own link: Shape launches nothing, so a session only
 * exists because something reported in from a worktree. Each target keeps its
 * own harness log, which is what proves which process served a turn.
 *
 * Usage (from packages/bridge): node scripts/smoke-remote.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

/** the harness stub, by absolute path: a session runs with its worktree as cwd */
const FAKE_OMP_TUI = join(dirname(fileURLToPath(import.meta.url)), "fake-omp-tui.mjs");

const PORT = Number(process.env.SMOKE_REMOTE_PORT ?? 4412);
/** each agent owns a loopback link port of its own: the agents share nothing but the server */
const LINK_PORT_A = PORT + 1;
const LINK_PORT_B = PORT + 2;
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
/** an agent's reconnect backoff tops out at 8 s: a restart must be re-bound inside this */
const RECONNECT_MS = 10_000;

// Every bridge/agent below inherits this environment: a smoke must not depend
// on what is installed on the machine running it. `none` keeps the agents away
// from the developer's own herdr — no session here runs in a terminal Shape can
// reach — and detection reports exactly one harness, `omp`.
process.env.SHAPE_LAUNCHER = "none";
process.env.SHAPE_FORCE_HARNESSES = "omp";

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

/** frames the fake omp sent and received, in order */
function ompFrames(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Read rows out of the server's own database while it runs. A database that is
 * not there yet — or busy mid-write — is just "not yet", so the callers can
 * poll it exactly as they polled the files it replaced.
 */
function dbRows(sql, ...params) {
  const file = join(dataDir, "shape.db");
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
  // not `main`: this machine's global pre-commit hook refuses commits there,
  // and a throwaway repo in /tmp is nobody's trunk
  git("init", "-q", "-b", "smoke");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

const targetA = await mkdtemp(join(tmpdir(), "vh-remote-a-"));
const targetB = await mkdtemp(join(tmpdir(), "vh-remote-b-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-remote-home-"));
/** holds `shape.db`: every project's graph, its revisions and the project registry */
const dataDir = await mkdtemp(join(tmpdir(), "vh-remote-data-"));
await seedWorkspace(targetA, "ra");
await seedWorkspace(targetB, "rb");

/**
 * The one variation each target has. A fresh repo nobody ran `git worktree add`
 * in is a single worktree, and its id — what every worktree-scoped frame and
 * every stored row is keyed by — is the realpath of its directory. It is also
 * what the server reports as the project's cwd, which is not the spelling
 * mkdtemp handed out on a machine whose temp dir is a symlink.
 */
const mainA = realpathSync(targetA);
const mainB = realpathSync(targetB);

const frames = [];
/** every process this smoke started, so the finally block can kill all of them */
const spawned = [];
let socket = null;

/**
 * Starts one of the binaries with SHAPE_HOME pointed at a throwaway dir (recents
 * must not touch the real home). Returns a handle whose `log` accumulates the
 * child's stderr — the banners the steps wait on, including the loopback link
 * URL a session dials. cwd stays packages/bridge: the binaries are named
 * relative to it.
 *
 * SHAPE_AUTO_MAP=0 goes to every child: the server is the one that reads it, and
 * the targets below are seeded WITH code and an empty canvas — a room that maps
 * them by itself would write bubbles none of these steps asked for.
 */
function launch(label, args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, SHAPE_AUTO_MAP: "0", SHAPE_HOME: fakeHome, ...extraEnv },
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

/** the agent announces its loopback link in the line that says it attached */
function linkUrlOf(agent) {
  const found = /link at (ws:\/\/[^\s)]+)/.exec(agent.log);
  if (found === null) throw new Error(`${agent.label} never announced its loopback link`);
  return found[1];
}

/**
 * A session in one of the repo's worktrees. Shape starts no sessions any more:
 * a harness process that dials the agent's loopback link from inside a worktree
 * IS the session appearing, so a smoke that wants one starts it itself —
 * exactly the way a session the user opened in their own terminal reports in.
 * The harness log lives in the worktree, so two sessions in the same directory
 * append to one file and their `__start` pids say which process served a turn.
 */
async function startSession(label, agent, worktree) {
  const child = spawn(process.execPath, [FAKE_OMP_TUI], {
    cwd: worktree,
    env: {
      ...process.env,
      SHAPE_LINK: linkUrlOf(agent),
      SHAPE_WORKTREE: worktree,
      FAKE_OMP_LOG: ompLogIn(worktree),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handle = { label, child, log: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    handle.log += d;
    process.stderr.write(`[${label}:out] ${d}`);
  });
  spawned.push(handle);
  // the fake says `ready` on stdout once its link is open and it has greeted
  await waitFor(`${label} on the link`, () => handle.log.includes('"ready"'));
  return handle;
}

/** a sentence typed into that session's pane: one turn, exactly like a TUI */
function type(session, text) {
  session.child.stdin.write(`${JSON.stringify({ type: "typed", text })}\n`);
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
  let agentA = launch("agent-a", agentArgs(targetA, LINK_PORT_A));
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
    Array.isArray(hello.projects) && hello.projects.length === 1 && hello.projects[0].cwd === mainA,
    JSON.stringify(hello.projects ?? null),
  );
  check(
    "hello names the project this socket is joined to",
    typeof hello.projectId === "string" && hello.projectId === hello.projects[0]?.projectId,
    `${String(hello.projectId)} vs ${String(hello.projects?.[0]?.projectId)}`,
  );
  check(
    "hello serves the remote agent's target as the session cwd and its first variation",
    hello.session.cwd === mainA && hello.session.worktrees[0]?.path === mainA,
    `${hello.session.cwd} / ${JSON.stringify(hello.session.worktrees)}`,
  );
  check(
    "an agent that started nothing attaches a project with no session in it",
    Array.isArray(hello.session.sessions) && hello.session.sessions.length === 0,
    JSON.stringify(hello.session.sessions),
  );
  check(
    "hello carries the reality layer extracted from the target workspace",
    hello.graphs[mainA].reality.nodes.map((n) => n.id).sort().join(",") === "r:@ra/auth,r:@ra/db",
    JSON.stringify(hello.graphs[mainA].reality.nodes.map((n) => n.id)),
  );

  // --- 3. a session reports in from the target, over the agent's own link ----

  const sessionAt = mark();
  let sessionA = await startSession("omp-a", agentA, mainA);
  const started = await frameAfter(
    sessionAt,
    (f) => f.type === "session_started" && f.worktree === mainA && f.backend.id === "omp",
    "session_started for the harness that reported in",
  );
  check(
    "a harness dialing the remote agent's link appears as a session in its variation",
    started.session.sessionId !== null && started.backend.capabilities.hostTool === true,
    JSON.stringify({ session: started.session, capabilities: started.backend.capabilities }),
  );
  check(
    "a session Shape neither started nor hosts is steerless, resumeless and has no terminal here",
    started.backend.capabilities.steerMidTurn === false &&
      started.backend.capabilities.resume === false &&
      started.backend.capabilities.terminal === "none",
    JSON.stringify(started.backend.capabilities),
  );

  // --- 4. a turn in that session, all the way back to the browser -----------

  const turnAt = mark();
  type(sessionA, "build me an auth service");
  const said = await frameAfter(
    turnAt,
    (f) => f.type === "transcript" && f.worktree === mainA && f.role === "assistant" && f.text.includes("auth service"),
    "assistant transcript line from the remote session",
  );
  check("what the remote session says reaches the browser as a transcript line", said.text.length > 0, said.text);

  const graph = await frameAfter(
    turnAt,
    (f) => f.type === "graph" && f.worktree === mainA && f.graph.nodes.some((n) => n.id === "auth-service"),
    "graph frame carrying the canvas call",
  );
  check(
    "the session's canvas call crosses the loopback link, the agent socket and the room to the browser",
    graph.graph.nodes.some((n) => n.id === "user-db") && graph.graph.edges.some((e) => e.id === "auth-service--user-db"),
    JSON.stringify(graph.graph.nodes.map((n) => n.id)),
  );
  const toolResult = await waitFor("canvas result in the harness log", () =>
    ompFrames(ompLogIn(mainA)).find((f) => f.type === "canvas_result" && f.text.startsWith("applied 3 op(s);")),
  );
  check(
    "the canvas result is returned across the link to the harness",
    toolResult.isError !== true,
    toolResult.text.split("\n")[0],
  );

  // --- 5. the agent goes away: the room stays, read-only ---------------------

  const goneAt = mark();
  await stopChild(agentA);
  const sessionLost = await frameAfter(
    goneAt,
    (f) => f.type === "session_stopped" && f.worktree === mainA,
    "session_stopped after the agent left",
  );
  check(
    "an agent that leaves takes the sessions it was watching with it, and says why",
    sessionLost.reason.length > 0,
    sessionLost.reason,
  );
  const disconnected = await frameAfter(
    goneAt,
    (f) => f.type === "session" && f.session.agentConnected === false,
    "session frame after the agent left",
  );
  check(
    "killing the agent tells the browser the session lost its agent",
    disconnected.session.cwd === mainA && disconnected.session.sessions.length === 0,
    `${disconnected.session.cwd}: ${JSON.stringify(disconnected.session.sessions)}`,
  );
  const offline = await frameAfter(
    goneAt,
    (f) => f.type === "projects" && f.projects.some((p) => p.cwd === mainA),
    "projects frame after the agent left",
  );
  check(
    "a departed agent leaves its project listed as offline",
    offline.projects.find((p) => p.cwd === mainA)?.agentConnected === false,
    JSON.stringify(offline.projects),
  );

  // the harness died with the link it was dialing, so nothing can be drawn on
  // that canvas any more: a room with no agent is a picture, not a session
  const quietAt = mark();
  await sleep(500);
  check(
    "nothing is drawn on a canvas whose agent is gone",
    !frames.slice(quietAt).some((f) => f.type === "graph" || f.type === "transcript"),
    JSON.stringify(frames.slice(quietAt).map((f) => f.type)),
  );

  // --- 6. the agent comes back: same room, a new session in it ---------------

  const rejoinAt = mark();
  agentA = launch("agent-a2", agentArgs(targetA, LINK_PORT_A));
  await waitFor("agent A re-attached", () => agentA.log.includes("agent attached to"));
  const rehello = await frameAfter(
    rejoinAt,
    (f) => f.type === "hello" && f.session.agentConnected === true,
    "hello after the re-attach",
  );
  check("restarting the agent re-attaches to the room it left behind", rehello.session.cwd === mainA, rehello.session.cwd);

  const secondTurnAt = mark();
  sessionA = await startSession("omp-a2", agentA, mainA);
  type(sessionA, "second life auth service");
  await frameAfter(
    secondTurnAt,
    (f) => f.type === "graph" && f.worktree === mainA && f.graph.nodes.some((n) => n.id === "auth-service"),
    "graph frame from the second session",
  );
  const starts = ompFrames(ompLogIn(mainA)).filter((f) => f.type === "__start");
  check(
    "a turn after the re-attach is served by a second harness process, in the room the first one left",
    starts.length >= 2 && starts.at(-1).pid !== starts[0].pid,
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
  agentA = launch("agent-a3", agentArgs(targetA, LINK_PORT_A));
  await waitFor("agent A attached a third time", () => agentA.log.includes("agent attached to"));
  const thirdHello = await frameAfter(
    thirdAt,
    (f) => f.type === "hello" && f.session.agentConnected === true,
    "hello after the third attach",
  );
  check(
    "the room outlives its agent across a second restart",
    thirdHello.session.cwd === mainA && thirdHello.projects.some((p) => p.cwd === mainA && p.agentConnected === true),
    JSON.stringify(thirdHello.projects),
  );

  const twoAt = mark();
  const agentB = launch("agent-b", agentArgs(targetB, LINK_PORT_B));
  await waitFor("agent B attached", () => agentB.log.includes("agent attached to"));
  const both = await frameAfter(
    twoAt,
    (f) => f.type === "projects" && f.projects.length === 2,
    "projects frame listing both projects",
  );
  check(
    "a second agent on the same server adds its project to the list",
    both.projects.some((p) => p.cwd === mainA) && both.projects.some((p) => p.cwd === mainB),
    JSON.stringify(both.projects.map((p) => p.cwd)),
  );

  const selectAt = mark();
  const projectB = both.projects.find((p) => p.cwd === mainB);
  send({ type: "select_project", projectId: projectB.projectId });
  const helloB = await frameAfter(selectAt, (f) => f.type === "hello", "hello for the selected project");
  check(
    "select_project moves this socket to the other project's room",
    helloB.session.cwd === mainB && helloB.projectId === projectB.projectId,
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

  // --- 8. what a remote server keeps in its database ------------------------

  const projectAId = hello.projectId;
  // an unauthenticated server files everything under the implicit `local` tenant
  const graphRow = await waitFor(
    "the first project's graph row in the server's database",
    () =>
      dbRows("SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?", "local", projectAId, mainA)?.[0] ??
      null,
    10_000,
  );
  const storedGraph = JSON.parse(graphRow.doc);
  check(
    "a remote server keeps each variation's graph in <data-dir>/shape.db, keyed by tenant, project and variation",
    storedGraph.nodes.some((n) => n.id === "auth-service") &&
      storedGraph.edges.some((e) => e.id === "auth-service--user-db"),
    JSON.stringify(storedGraph.nodes.map((n) => n.id)),
  );

  const registry = await waitFor(
    "both projects in the server's registry",
    () => {
      const rows = dbRows("SELECT tenant, key, project, sessions, worktrees, last_seen FROM projects");
      return rows !== null && rows.length === 2
        ? rows.map((row) => ({ ...row, project: JSON.parse(row.project), sessions: JSON.parse(row.sessions) }))
        : null;
    },
    10_000,
  );
  check(
    "the registry names both attached projects by cwd",
    [mainA, mainB].every((cwd) => registry.some((row) => row.project?.cwd === cwd)),
    JSON.stringify(registry.map((row) => row.project?.cwd ?? null)),
  );
  check(
    "registry rows are stored projects, not browser summaries",
    registry.every(
      (row) =>
        !("agentConnected" in row.project) &&
        Array.isArray(row.sessions) &&
        row.sessions.every((s) => typeof s.worktree === "string" && !("agentConnected" in s)) &&
        typeof row.last_seen === "string",
    ),
    JSON.stringify(registry.map((row) => Object.keys(row.project))),
  );

  // --- 9. the server restarts while both agents are still up ----------------

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
    reattached.some((p) => p.cwd === mainA) && reattached.some((p) => p.cwd === mainB),
    JSON.stringify(reattached.map((p) => `${p.cwd}:${String(p.agentConnected)}`)),
  );

  const restoredA = reattached.find((p) => p.cwd === mainA);
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
      helloRestored.graphs[mainA].nodes.some((n) => n.id === "auth-service") &&
      helloRestored.session.agentConnected === true,
    `${restoredA.projectId} vs ${projectAId}; ${JSON.stringify(helloRestored.graphs[mainA]?.nodes.map((n) => n.id))}`,
  );

  // --- 10. the same rooms with no agent anywhere ----------------------------

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
      [mainA, mainB].every((cwd) => aloneHello.projects.some((p) => p.cwd === cwd)),
    JSON.stringify(aloneHello.projects.map((p) => `${p.cwd}:${String(p.agentConnected)}`)),
  );

  const agentlessIdA = aloneHello.projects.find((p) => p.cwd === mainA)?.projectId;
  const joinAt = mark();
  send({ type: "select_project", projectId: agentlessIdA });
  const agentlessA = await frameAfter(
    joinAt,
    (f) => f.type === "hello" && f.projectId === agentlessIdA,
    "hello for the restored first project",
  );
  check(
    "a restored room comes back with no session in it: the harnesses died with the server",
    agentlessA.session.sessions.length === 0,
    JSON.stringify(agentlessA.session.sessions),
  );

  // everything that needs the machine — a re-scan for sessions to adopt — is
  // refused by name in a room nothing is attached to
  const refusedAloneAt = mark();
  send({ type: "discover" });
  const refusedAlone = await frameAfter(
    refusedAloneAt,
    (f) => f.type === "error",
    "error for the discover in a restored room",
  );
  check(
    "a request that needs the machine is refused by name in a restored room with no agent",
    refusedAlone.message.includes("no agent is attached"),
    refusedAlone.message,
  );

  // the snapshots are the variation's, not the agent's: two of them must still diff
  const revs = (agentlessA.revisions[mainA] ?? []).map((r) => r.rev).sort((a, b) => a - b);
  const diffAt = mark();
  if (revs.length >= 2) send({ type: "diff", worktree: mainA, revA: revs[0], revB: revs[1] });
  const delta =
    revs.length < 2
      ? null
      : await frameAfter(
          diffAt,
          (f) => f.type === "delta" && f.worktree === mainA && f.delta.revA === revs[0] && f.delta.revB === revs[1],
          "delta over the restored revisions",
          5_000,
        ).catch(() => null);
  check(
    "diff over a restored room's two oldest revisions is answered from the stored snapshots",
    delta !== null,
    `revisions=${revs.join(",")}`,
  );
} catch (err) {
  check("the remote smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  // --- 11. teardown: every child dies, even when a step above threw ----------
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
