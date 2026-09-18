#!/usr/bin/env node
/**
 * On-prem auth smoke test. Runs the real binaries — `src/server-cli.ts`,
 * `src/agent-cli.ts` and `src/login-cli.ts` — as separate processes against one
 * token file, and drives them from two browser sockets that hold two different
 * tenants' tokens:
 *
 *   bind guard          — a non-loopback --host without --token-file refuses to start
 *   token file          — a token shorter than 16 chars fails startup by name
 *   browser upgrade      — no `?token=` is a 401 at the upgrade, not a frame
 *   agent upgrade        — a tokenless agent exits 1 with the 401 message, no retry
 *   tenancy             — each browser sees only its own tenant's rooms, and
 *                         neither select_project nor set_project_status can
 *                         name another tenant's project
 *   shape login         — servers.json (0600) alone authenticates an agent
 *   mapping             — authenticated explicit map commits persist tenant-isolated graphs
 *   control-only restore  — an authenticated inactive-only tenant gets its
 *                           project list before any room exists, then can
 *                           reactivate the stored room with no agent or source
 *   storage             — one graph row per (tenant, project, branch) in <data-dir>/shape.db
 *
 * The sessions are scripts/fake-omp-tui.mjs processes this smoke starts itself,
 * dialing each agent's loopback link from inside its target: Shape starts no
 * sessions, so a project has one only because something reported in from it.
 *
 * Usage (from packages/bridge): node scripts/smoke-auth.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { requestControl as sendControlRequest } from "../../../scripts/lib/client.mjs";

/** the harness stub, by absolute path: a session runs with its worktree as cwd */
const FAKE_OMP_TUI = join(dirname(fileURLToPath(import.meta.url)), "fake-omp-tui.mjs");

const PORT = Number(process.env.SMOKE_AUTH_PORT ?? 4422);
/** each agent owns a loopback link port of its own: the agents share nothing but the server */
const LINK_PORT_A = PORT + 1;
const LINK_PORT_B = PORT + 2;
const LINK_PORT_C = PORT + 3;
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
/** the origin `shape login` keys servers.json by — the smoke asserts it verbatim */
const ORIGIN = `ws://127.0.0.1:${PORT}`;

/** one token per tenant; ≥ 16 chars, which is what the loader enforces */
const TOKEN_A = "aaaaaaaaaaaaaaaa-A";
const TOKEN_B = "bbbbbbbbbbbbbbbb-B";
const TOKEN_CONTROL = "cccccccccccccccc-C";
const TENANT_A = "acme";
const TENANT_B = "globex";
const TENANT_CONTROL = "control-only";

// Every bridge/agent below inherits this environment: a smoke must not depend
// on what is installed on the machine running it. `none` keeps the agents away
// from the developer's own herdr, and detection reports exactly one harness.
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

/** parse a file the server writes under us; a half-written read is just "not yet" */
function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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
 * so reality extraction succeeds and the targets are distinguishable on the
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

/** three agent-backed targets plus one project that exists only through /control */
const targetA = await mkdtemp(join(tmpdir(), "vh-auth-a-"));
const targetB = await mkdtemp(join(tmpdir(), "vh-auth-b-"));
const targetC = await mkdtemp(join(tmpdir(), "vh-auth-c-"));
const targetControl = await mkdtemp(join(tmpdir(), "vh-auth-control-"));
/** SHAPE_HOME for everything that must NOT find a saved token; a local database and a project's directive land here too */
const fakeHome = await mkdtemp(join(tmpdir(), "vh-auth-home-"));
/** a second SHAPE_HOME, written by `shape login` and read by exactly one agent */
const loginHome = await mkdtemp(join(tmpdir(), "vh-auth-login-"));
/** holds `shape.db`: every tenant's graphs, revisions and registry rows */
const dataDir = await mkdtemp(join(tmpdir(), "vh-auth-data-"));
const tokenDir = await mkdtemp(join(tmpdir(), "vh-auth-tokens-"));
const tokenFile = join(tokenDir, "tokens.json");
const shortTokenFile = join(tokenDir, "short.json");
await writeFile(
  tokenFile,
  JSON.stringify(
    [
      { token: TOKEN_A, tenant: TENANT_A },
      { token: TOKEN_B, tenant: TENANT_B },
      { token: TOKEN_CONTROL, tenant: TENANT_CONTROL },
    ],
    null,
    2,
  ),
);
await writeFile(shortTokenFile, JSON.stringify([{ token: "short", tenant: "x" }]));
await seedWorkspace(targetA, "aa");
await seedWorkspace(targetB, "bb");
await seedWorkspace(targetC, "cc");
await seedWorkspace(targetControl, "ctl");

/**
 * Each target is a single physical worktree on the `smoke` branch. Agent-link
 * routing and the worktree inventory keep those paths; public session, graph,
 * and stored canvas identities use the full branch ref.
 */
const mainA = realpathSync(targetA);
const mainB = realpathSync(targetB);
const mainC = realpathSync(targetC);
const mainControl = realpathSync(targetControl);
const BRANCH_ID = "refs/heads/smoke";
const headOf = (dir) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

/** every process this smoke started, so the finally block can kill all of them */
const spawned = [];
/** every browser socket, closed in teardown whatever a step above did */
const browsers = [];

/**
 * Starts one of the binaries with SHAPE_HOME pointed at a throwaway dir (a
 * saved token, a local database and a project's directive must not touch the
 * real home). `SHAPE_TOKEN` is stripped unless a step passes one: the
 * operator's own env must not authenticate the child this smoke expects to be
 * refused. cwd stays packages/bridge, so the binaries resolve against this
 * package. `log` accumulates both streams — the banners and refusals the steps
 * wait on are on stderr, but `shape login` reports where it saved on stdout.
 */
function launch(label, args, extraEnv = {}) {
  const env = { ...process.env, SHAPE_HOME: fakeHome };
  delete env.SHAPE_TOKEN;
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handle = { label, child, log: "" };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    handle.log += d;
    process.stderr.write(`[${label}] ${d}`);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    handle.log += d;
    process.stderr.write(`[${label}:out] ${d}`);
  });
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

/** a binary this smoke expects to die on its own: waits for the exit, not a signal */
async function waitForExit(handle, timeoutMs) {
  await waitFor(`${handle.label} to exit`, () => (handle.child.exitCode === null ? null : true), timeoutMs);
  return handle.child.exitCode;
}

const agentArgs = (target, linkPort, extra = []) => [
  "src/agent-cli.ts",
  "--server",
  SERVER_URL,
  "--cwd",
  target,
  "--link-port",
  String(linkPort),
  ...extra,
];

/** the agent announces its loopback link in the line that says it attached */
function linkUrlOf(agent) {
  const found = /link at (ws:\/\/[^\s)]+)/.exec(agent.log);
  if (found === null) throw new Error(`${agent.label} never announced its loopback link`);
  return found[1];
}

/**
 * A harness process running in a tenant's physical worktree dials that agent's
 * loopback link. Shape starts nothing; the public branch session exists only
 * because this process reports in.
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

/**
 * One browser socket, tagged with the token it presents and keeping its own
 * ordered frame log: the whole point of this smoke is that two tenants on one
 * server see different frames, which a single shared log would hide.
 */
async function openBrowser(label, token) {
  const wire = { label, frames: [], socket: null };
  const next = new WebSocket(`${SERVER_URL}/ws?token=${encodeURIComponent(token)}`);
  next.on("message", (data) => wire.frames.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  next.once("open", opened.resolve);
  // both stay registered: a killed server errors this socket long after it opened
  next.on("error", opened.reject);
  next.on("unexpected-response", (_req, res) => opened.reject(new Error(`upgrade refused with ${res.statusCode}`)));
  await opened.promise;
  wire.socket = next;
  browsers.push(wire);
  return wire;
}

let controlSequence = 0;

/** Use the production client for one authenticated, request-correlated exchange. */
function requestControl(label, token, request) {
  return sendControlRequest(
    { ...request, requestId: `${label}-${++controlSequence}` },
    { server: SERVER_URL, token },
  );
}

const mapOps = (scope) => [
  {
    op: "upsert_node",
    node: {
      id: `${scope}-auth`,
      parentId: null,
      label: `@${scope}/auth`,
      summary: `Authenticates ${scope} users`,
      phase: "built",
      kind: "service",
      codeRefs: ["packages/auth"],
    },
  },
  {
    op: "upsert_node",
    node: {
      id: `${scope}-db`,
      parentId: null,
      label: `@${scope}/db`,
      summary: `Stores ${scope} users`,
      phase: "built",
      kind: "database",
      codeRefs: ["packages/db"],
    },
  },
  {
    op: "upsert_edge",
    edge: {
      id: `${scope}-auth--${scope}-db`,
      source: `${scope}-auth`,
      target: `${scope}-db`,
      kind: "depends",
    },
  },
];

const mapReality = (scope, head) => ({
  nodes: [
    { id: `r:@${scope}/auth`, label: `@${scope}/auth`, dir: "packages/auth" },
    { id: `r:@${scope}/db`, label: `@${scope}/db`, dir: "packages/db" },
  ],
  edges: [
    {
      id: `r:@${scope}/auth--r:@${scope}/db`,
      source: `r:@${scope}/auth`,
      target: `r:@${scope}/db`,
    },
  ],
  symbols: [],
  infra: [],
  verification: [],
  extractedAt: new Date().toISOString(),
  head,
});

async function commitMap(label, token, projectId, projectLabel, path, scope) {
  const repository = { id: projectId, label: projectLabel, path };
  const state = await requestControl(`${label}-read`, token, {
    type: "map_read",
    repository,
    branch: BRANCH_ID,
  });
  if (state.type !== "map_state") throw new Error(`${label}: expected map_state, got ${state.type}`);
  const head = headOf(path);
  const committed = await requestControl(`${label}-commit`, token, {
    type: "map_commit",
    repository,
    branch: BRANCH_ID,
    expectedRevision: state.revision,
    expectedMappedCommit: state.mappedCommit,
    commit: head,
    mode: "initial",
    ops: mapOps(scope),
    reality: mapReality(scope, head),
    note: "auth smoke explicit tenant map",
  });
  if (committed.type !== "map_committed") {
    throw new Error(`${label}: expected map_committed, got ${committed.type}`);
  }
  return committed;
}

/**
 * Tries an upgrade that should not be granted. A 401 reaches the ws client as
 * `unexpected-response`; a server that destroys the socket instead surfaces the
 * same refusal as `error`. Either one is a refusal — a browser never learns
 * more than that — so the check accepts both and reports which arrived.
 */
async function browserRefused(url) {
  const socket = new WebSocket(url);
  const frames = [];
  const settled = Promise.withResolvers();
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  socket.once("open", () => settled.resolve({ refused: false, how: "upgrade accepted" }));
  socket.once("error", (err) => settled.resolve({ refused: true, how: `error: ${err.message}` }));
  socket.once("unexpected-response", (_req, res) => settled.resolve({ refused: true, how: `unexpected-response ${res.statusCode}` }));
  const outcome = await settled.promise;
  // a refused socket that somehow still speaks would deliver here
  await sleep(300);
  socket.close();
  return { ...outcome, frames };
}

const send = (wire, msg) => wire.socket.send(JSON.stringify(msg));
const mark = (wire) => wire.frames.length;
const frameAfter = (wire, from, predicate, label, timeoutMs = 30_000) =>
  waitFor(`${wire.label}: ${label}`, () => wire.frames.slice(from).find(predicate), timeoutMs);

try {
  // --- 1. a server that refuses to start -------------------------------------

  const openBind = launch("server-open-bind", ["src/server-cli.ts", "--port", String(PORT), "--host", "0.0.0.0"]);
  const openBindCode = await waitForExit(openBind, 15_000);
  check(
    "a non-loopback --host without --token-file is refused by name",
    openBind.log.includes("refusing to listen on 0.0.0.0 without --token-file"),
    openBind.log.trim().split("\n").at(-1) ?? "(no output)",
  );
  check("the refused bind exits 1 instead of listening", openBindCode === 1, `exit ${String(openBindCode)}`);

  const badTokens = launch("server-bad-tokens", [
    "src/server-cli.ts",
    "--port",
    String(PORT),
    "--data-dir",
    dataDir,
    "--token-file",
    shortTokenFile,
  ]);
  const badTokensCode = await waitForExit(badTokens, 15_000);
  check(
    "a token shorter than 16 chars fails startup, naming the token file",
    badTokens.log.includes(`token file ${shortTokenFile}`) && badTokensCode === 1,
    `exit ${String(badTokensCode)}: ${badTokens.log.trim().split("\n").at(-1) ?? "(no output)"}`,
  );

  // --- 2. the authenticated server, and the upgrade it grants or refuses -----

  const server = launch("server", [
    "src/server-cli.ts",
    "--port",
    String(PORT),
    "--host",
    "127.0.0.1",
    "--data-dir",
    dataDir,
    "--token-file",
    tokenFile,
  ]);
  await waitFor("the authenticated server listening", () => server.log.includes("server at ws://"));

  const anonymous = await browserRefused(`${SERVER_URL}/ws`);
  check(
    "a browser with no token is refused at the upgrade, ungreeted",
    anonymous.refused && anonymous.frames.length === 0,
    `${anonymous.how}; ${anonymous.frames.length} frame(s)`,
  );

  const wireA = await openBrowser("browser-a", TOKEN_A);
  await sleep(300);
  check(
    "a browser presenting a known token connects and waits ungreeted while its tenant has no rooms",
    wireA.socket.readyState === WebSocket.OPEN && !wireA.frames.some((f) => f.type === "hello"),
    `${wireA.frames.length} frame(s): ${JSON.stringify(wireA.frames.map((f) => f.type))}`,
  );

  // --- 3. the first tenant's agent: 401 without a token, its project with one

  const tokenless = launch("agent-no-token", agentArgs(targetA, LINK_PORT_A));
  const tokenlessCode = await waitForExit(tokenless, 5_000);
  check(
    "an agent with no token is refused by name and does not retry",
    tokenless.log.includes("Shape server refused the token (401)") && tokenlessCode === 1,
    `exit ${String(tokenlessCode)}: ${tokenless.log.trim().split("\n").at(-1) ?? "(no output)"}`,
  );

  const helloAAt = mark(wireA);
  const agentA = launch("agent-a", agentArgs(targetA, LINK_PORT_A, ["--token", TOKEN_A]));
  await waitFor("agent A attached", () => agentA.log.includes("agent attached to"));
  const helloA = await frameAfter(wireA, helloAAt, (f) => f.type === "hello", "hello after the first tenant's attach");
  const projectAId = helloA.projectId;
  check(
    "an agent authenticated by --token greets its own tenant's browser with its one project",
    helloA.projects.length === 1 && helloA.projects[0].cwd === mainA && helloA.session.cwd === mainA,
    JSON.stringify(helloA.projects.map((p) => p.cwd)),
  );
  check(
    "an agent that starts nothing attaches its project with no session in it",
    helloA.session.sessions.length === 0,
    JSON.stringify(helloA.session.sessions),
  );

  // --- 4. a second tenant on the same server --------------------------------

  const wireB = await openBrowser("browser-b", TOKEN_B);
  await sleep(300);
  check(
    "a second tenant's browser sees none of the first tenant's rooms",
    !wireB.frames.some((f) => f.type === "hello"),
    `${wireB.frames.length} frame(s): ${JSON.stringify(wireB.frames.map((f) => f.type))}`,
  );

  const crossAt = mark(wireB);
  send(wireB, { type: "select_project", projectId: projectAId });
  const crossError = await frameAfter(wireB, crossAt, (f) => f.type === "error", "error for the other tenant's project id");
  check(
    "select_project on another tenant's project is refused as an unknown project",
    crossError.message.includes("unknown project"),
    crossError.message,
  );

  // The other input a browser has is the status of a project, and it is scoped
  // exactly like the one above: an id this tenant has no row for is unknown,
  // whoever else holds it. A refusal here is the whole answer — the list that
  // says the project was left alone is the first tenant's own, below.
  const crossFlipAt = mark(wireB);
  send(wireB, { type: "set_project_status", projectId: projectAId, status: "inactive" });
  const crossFlip = await frameAfter(
    wireB,
    crossFlipAt,
    (f) => f.type === "error",
    "error for parking the other tenant's project",
  );
  check(
    "set_project_status on another tenant's project is refused as an unknown project",
    crossFlip.message === `unknown project ${projectAId}`,
    crossFlip.message,
  );

  const leakAt = mark(wireA);
  const helloBAt = mark(wireB);
  const agentB = launch("agent-b", agentArgs(targetB, LINK_PORT_B), { SHAPE_TOKEN: TOKEN_B });
  await waitFor("agent B attached", () => agentB.log.includes("agent attached to"));
  const helloB = await frameAfter(wireB, helloBAt, (f) => f.type === "hello", "hello after the second tenant's attach");
  const projectBId = helloB.projectId;
  check(
    "an agent authenticated by SHAPE_TOKEN attaches for its own tenant only",
    helloB.projects.length === 1 && helloB.projects[0].cwd === mainB,
    JSON.stringify(helloB.projects.map((p) => p.cwd)),
  );

  await sleep(300);
  const rejoinAt = mark(wireA);
  send(wireA, { type: "select_project", projectId: projectAId });
  const rejoinA = await frameAfter(wireA, rejoinAt, (f) => f.type === "hello", "hello re-joining the first tenant's room");
  const leaked = wireA.frames.slice(leakAt).filter((f) => Array.isArray(f.projects) && f.projects.length !== 1);
  check(
    "the first tenant's project list is untouched by the second tenant's agent",
    rejoinA.projects.length === 1 && rejoinA.projects[0].cwd === mainA && leaked.length === 0,
    `${JSON.stringify(rejoinA.projects.map((p) => p.cwd))}; ${leaked.length} leaked frame(s)`,
  );

  // --- 5. shape login: a saved token is credentials enough ------------------

  const login = launch("login", ["src/login-cli.ts", SERVER_URL, TOKEN_A], { SHAPE_HOME: loginHome });
  const loginCode = await waitForExit(login, 15_000);
  const savedLine = login.log.split("\n").find((line) => line.includes("saved token for")) ?? "";
  check(
    "shape login names the origin it saved a token for",
    loginCode === 0 && savedLine.includes(`saved token for ${ORIGIN} in `),
    `exit ${String(loginCode)}: ${savedLine.trim() || "(no output)"}`,
  );
  const savedPath = savedLine.slice(savedLine.indexOf(" in ") + 4).trim();
  const savedMode = savedPath !== "" && existsSync(savedPath) ? statSync(savedPath).mode & 0o777 : -1;
  check(
    "the saved token file is owner-only (0600) and keyed by origin",
    savedMode === 0o600 && readJson(savedPath)?.[ORIGIN]?.token === TOKEN_A,
    `${savedPath || "(no path)"} mode ${savedMode === -1 ? "missing" : savedMode.toString(8)}: ${JSON.stringify(readJson(savedPath))}`,
  );

  const loginAgentAt = mark(wireA);
  const agentC = launch("agent-c", agentArgs(targetC, LINK_PORT_C), { SHAPE_HOME: loginHome });
  await waitFor("agent C attached", () => agentC.log.includes("agent attached to"));
  const bothA = await frameAfter(
    wireA,
    loginAgentAt,
    (f) => Array.isArray(f.projects) && f.projects.length === 2,
    "the first tenant's list growing to two projects",
  );
  check(
    "an agent with neither --token nor SHAPE_TOKEN authenticates out of servers.json",
    bothA.projects.some((p) => p.cwd === mainC) && bothA.projects.some((p) => p.cwd === mainA),
    JSON.stringify(bothA.projects.map((p) => p.cwd)),
  );

  // --- 6. explicit branch mapping and tenant-isolated storage ----------------

  const sessionAAt = mark(wireA);
  await startSession("omp-a", agentA, mainA);
  await frameAfter(
    wireA,
    sessionAAt,
    (f) => f.type === "session_started" && f.worktree === BRANCH_ID,
    "session_started on the first tenant's public branch",
  );

  const graphAAt = mark(wireA);
  const committedA = await commitMap(
    "tenant-a",
    TOKEN_A,
    projectAId,
    helloA.projects[0].label,
    mainA,
    "aa",
  );
  check(
    "the first tenant explicitly maps its public branch",
    committedA.projectId === projectAId &&
      committedA.branch === BRANCH_ID &&
      committedA.mappedCommit === headOf(mainA),
    JSON.stringify(committedA),
  );
  await frameAfter(
    wireA,
    graphAAt,
    (f) => f.type === "graph" && f.worktree === BRANCH_ID && f.graph.nodes.some((n) => n.id === "aa-auth"),
    "the explicitly committed first-tenant graph",
  );

  const sessionBAt = mark(wireB);
  await startSession("omp-b", agentB, mainB);
  await frameAfter(
    wireB,
    sessionBAt,
    (f) => f.type === "session_started" && f.worktree === BRANCH_ID,
    "session_started on the second tenant's public branch",
  );
  const graphBAt = mark(wireB);
  const committedB = await commitMap(
    "tenant-b",
    TOKEN_B,
    projectBId,
    helloB.projects[0].label,
    mainB,
    "bb",
  );
  check(
    "the second tenant explicitly maps its public branch",
    committedB.projectId === projectBId &&
      committedB.branch === BRANCH_ID &&
      committedB.mappedCommit === headOf(mainB),
    JSON.stringify(committedB),
  );
  await frameAfter(
    wireB,
    graphBAt,
    (f) => f.type === "graph" && f.worktree === BRANCH_ID && f.graph.nodes.some((n) => n.id === "bb-auth"),
    "the explicitly committed second-tenant graph",
  );

  const graphRow = (tenant, key, branch) => {
    const rows = dbRows("SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?", tenant, key, branch);
    return rows === null || rows.length === 0 ? null : JSON.parse(rows[0].doc);
  };
  const graphA = await waitFor("the first tenant's graph row", () => graphRow(TENANT_A, projectAId, BRANCH_ID), 20_000);
  const graphB = await waitFor("the second tenant's graph row", () => graphRow(TENANT_B, projectBId, BRANCH_ID), 20_000);
  check(
    "each tenant's graph is a row of its own, keyed by tenant, project and public branch",
    graphA.nodes.some((n) => n.id === "aa-auth") && graphB.nodes.some((n) => n.id === "bb-auth"),
    `${JSON.stringify(graphA.nodes.map((n) => n.id))} / ${JSON.stringify(graphB.nodes.map((n) => n.id))}`,
  );
  check(
    "each graph holds only its tenant's explicitly committed nodes",
    graphA.nodes.every((n) => !n.id.startsWith("bb-")) && graphB.nodes.every((n) => !n.id.startsWith("aa-")),
    `${JSON.stringify(graphA.nodes.map((n) => n.id))} / ${JSON.stringify(graphB.nodes.map((n) => n.id))}`,
  );
  check(
    "the tenant is part of a graph's key, not a filter",
    graphRow(TENANT_B, projectAId, BRANCH_ID) === null && graphRow(TENANT_A, projectBId, BRANCH_ID) === null,
  );

  const registry = await waitFor(
    "all three projects in the server's registry",
    () => {
      const rows = dbRows("SELECT tenant, project FROM projects");
      return rows !== null && rows.length === 3 ? rows.map((row) => ({ tenant: row.tenant, project: JSON.parse(row.project) })) : null;
    },
    10_000,
  );
  const tenantOf = (cwd) => registry.find((row) => row.project?.cwd === cwd)?.tenant;
  check(
    "every registry row carries the tenant that owns the project",
    tenantOf(mainA) === TENANT_A && tenantOf(mainC) === TENANT_A && tenantOf(mainB) === TENANT_B,
    JSON.stringify(registry.map((row) => `${row.project?.cwd ?? "?"}:${String(row.tenant)}`)),
  );

  // --- 7. an inactive control-only tenant survives a cold start ------------

  const controlProjectId = "control-only-project";
  const controlWire = await openBrowser("browser-control", TOKEN_CONTROL);
  const controlListedAt = mark(controlWire);
  const committedControl = await commitMap(
    "control-only",
    TOKEN_CONTROL,
    controlProjectId,
    "control-only",
    mainControl,
    "ctl",
  );
  const controlListed = await frameAfter(
    controlWire,
    controlListedAt,
    (frame) => frame.type === "projects" && frame.projects.some((project) => project.projectId === controlProjectId),
    "control-only project listed after map_commit",
  );
  check(
    "map_commit persists a project that no agent ever attached",
    committedControl.projectId === controlProjectId &&
      controlListed.projects.length === 1 &&
      controlListed.projects[0].status === "active",
    JSON.stringify({ committedControl, projects: controlListed.projects }),
  );

  const controlParkedAt = mark(controlWire);
  send(controlWire, { type: "set_project_status", projectId: controlProjectId, status: "inactive" });
  const controlParked = await frameAfter(
    controlWire,
    controlParkedAt,
    (frame) =>
      frame.type === "projects" &&
      frame.projects.some((project) => project.projectId === controlProjectId && project.status === "inactive"),
    "control-only project parked",
  );
  check(
    "the control-only tenant has one stored project and it is inactive",
    controlParked.projects.length === 1 && controlParked.projects[0].liveSessions === 0,
    JSON.stringify(controlParked.projects),
  );

  // Nothing behind the stored row remains available: no agent process and no
  // repository path. A restart must recover the tenant's project list from the
  // registry alone, before there is any active room able to send a hello.
  for (const handle of spawned.filter((candidate) => candidate !== server)) await stopChild(handle);
  await rm(targetControl, { recursive: true, force: true });
  await stopChild(server);

  const coldServer = launch("server-control-cold", [
    "src/server-cli.ts",
    "--port",
    String(PORT),
    "--host",
    "127.0.0.1",
    "--data-dir",
    dataDir,
    "--token-file",
    tokenFile,
  ]);
  await waitFor("the cold authenticated server listening", () => coldServer.log.includes("server at ws://"));

  const coldWire = await openBrowser("browser-control-cold", TOKEN_CONTROL);
  const coldProjects = await frameAfter(
    coldWire,
    0,
    (frame) =>
      frame.type === "projects" &&
      frame.projects.length === 1 &&
      frame.projects[0].projectId === controlProjectId &&
      frame.projects[0].status === "inactive",
    "inactive-only project list on cold start",
    3_000,
  );
  check(
    "a fresh authenticated browser immediately receives its inactive-only project list without a room hello",
    !coldWire.frames.some((frame) => frame.type === "hello") &&
      coldProjects.projects[0].cwd === mainControl &&
      !existsSync(mainControl),
    JSON.stringify({ frames: coldWire.frames.map((frame) => frame.type), projects: coldProjects.projects }),
  );

  const activateControlAt = mark(coldWire);
  send(coldWire, { type: "set_project_status", projectId: controlProjectId, status: "active" });
  const controlHello = await frameAfter(
    coldWire,
    activateControlAt,
    (frame) => frame.type === "hello" && frame.projectId === controlProjectId,
    "hello after activating the control-only project",
    3_000,
  );
  check(
    "activating the stored row opens its room without an agent or repository path",
    controlHello.session.agentConnected === false &&
      controlHello.graphs[BRANCH_ID].nodes.some((node) => node.id === "ctl-auth") &&
      !existsSync(mainControl),
    JSON.stringify({
      agentConnected: controlHello.session.agentConnected,
      cwd: controlHello.session.cwd,
      nodes: controlHello.graphs[BRANCH_ID]?.nodes.map((node) => node.id),
    }),
  );
} catch (err) {
  check("the auth smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  // --- 8. teardown: every socket and child dies, even when a step above threw
  for (const wire of browsers) wire.socket?.close();
  for (const handle of spawned.slice().reverse()) {
    try {
      await stopChild(handle);
    } catch (err) {
      process.stderr.write(`[smoke] could not stop ${handle.label}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  for (const dir of [targetA, targetB, targetC, targetControl, fakeHome, loginHome, dataDir, tokenDir]) {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("");
for (const line of results) console.log(line);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
