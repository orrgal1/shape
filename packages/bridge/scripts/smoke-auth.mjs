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
 *                         select_project across tenants is an unknown project
 *   shape login         — servers.json (0600) alone authenticates an agent
 *   audit               — the mechanical skeleton the room draws by itself is
 *                         the ONE thing it files, under the caller's tenant
 *   storage             — one graph row per (tenant, project, variation) in <data-dir>/shape.db
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
const TENANT_A = "acme";
const TENANT_B = "globex";

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

/** every audit entry filed against one variation of one tenant's project, oldest first */
function auditEntries(tenant, key, worktree) {
  const rows = dbRows(
    "SELECT entry FROM audit WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY seq ASC",
    tenant,
    key,
    worktree,
  );
  return rows === null ? [] : rows.map((row) => JSON.parse(row.entry));
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

/** one target per agent: tenant acme's project, tenant globex's, and the login-authenticated one */
const targetA = await mkdtemp(join(tmpdir(), "vh-auth-a-"));
const targetB = await mkdtemp(join(tmpdir(), "vh-auth-b-"));
const targetC = await mkdtemp(join(tmpdir(), "vh-auth-c-"));
/** SHAPE_HOME for everything that must NOT find a saved token (recents only) */
const fakeHome = await mkdtemp(join(tmpdir(), "vh-auth-home-"));
/** a second SHAPE_HOME, written by `shape login` and read by exactly one agent */
const loginHome = await mkdtemp(join(tmpdir(), "vh-auth-login-"));
/** holds `shape.db`: every tenant's graphs, revisions, registry rows and audit entries */
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
    ],
    null,
    2,
  ),
);
await writeFile(shortTokenFile, JSON.stringify([{ token: "short", tenant: "x" }]));
await seedWorkspace(targetA, "aa");
await seedWorkspace(targetB, "bb");
await seedWorkspace(targetC, "cc");

/**
 * The one variation each target has. A fresh repo nobody ran `git worktree add`
 * in is a single worktree, and its id — what every worktree-scoped frame and
 * every stored row is keyed by — is the realpath of its directory. It is also
 * what the server reports as the project's cwd, which is not the spelling
 * mkdtemp handed out on a machine whose temp dir is a symlink.
 */
const mainA = realpathSync(targetA);
const mainB = realpathSync(targetB);
const mainC = realpathSync(targetC);

/** every process this smoke started, so the finally block can kill all of them */
const spawned = [];
/** every browser socket, closed in teardown whatever a step above did */
const browsers = [];

/**
 * Starts one of the binaries with SHAPE_HOME pointed at a throwaway dir (recents
 * and saved tokens must not touch the real home). `SHAPE_TOKEN` is stripped
 * unless a step passes one: the operator's own env must not authenticate the
 * child this smoke expects to be refused. cwd stays packages/bridge, so the
 * binaries resolve against this package. `log` accumulates both streams — the
 * banners and refusals the steps wait on are on stderr, but `shape login`
 * reports where it saved on stdout.
 *
 * The automatic map is deliberately LEFT ON: the skeleton the room draws for a
 * project whose canvas nobody has drawn is the only write the server makes by
 * itself, and it is the audit line the sections below are about.
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
 * A session in one of a tenant's worktrees: the harness stub dialing that
 * agent's loopback link from inside the directory. It is how a session appears
 * at all — nothing is launched — and here it is also what makes the room draw
 * the project's skeleton, which is the record the audit sections read.
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

  // --- 6. the one thing the room writes by itself, and who it is filed under -

  // A session reporting in from a project whose canvas is empty is what makes
  // the room draw the mechanical skeleton (`server/room.ts` §autoMap). That
  // write — and nothing else on this server — becomes an audit line
  // (`server/storage.ts`: `AuditBody` has one kind, `onboard`), stamped with the
  // tenant, project and variation it happened in and stored as JSON in the
  // `audit` table (`server/sqlite.ts`).
  const sessionAAt = mark(wireA);
  const sessionA = await startSession("omp-a", agentA, mainA);
  await frameAfter(
    wireA,
    sessionAAt,
    (f) => f.type === "session_started" && f.worktree === mainA,
    "session_started in the first tenant's project",
  );
  const onboard = await waitFor(
    "the onboarding entry in the first tenant's audit log",
    () => auditEntries(TENANT_A, projectAId, mainA).find((e) => e.kind === "onboard") ?? null,
    20_000,
  );
  check(
    "the skeleton the room drew by itself is audited under the caller's tenant, project and variation",
    onboard.tenant === TENANT_A &&
      onboard.projectId === projectAId &&
      onboard.worktree === mainA &&
      typeof onboard.at === "string",
    JSON.stringify(onboard),
  );
  check(
    "and the line says how much it drew: one bubble per workspace package, plus their dependency",
    onboard.ops === 3,
    `ops=${String(onboard.ops)}`,
  );

  // What a HARNESS draws is not the room's record: the canvas call below lands
  // on the canvas and in the revisions, and files no audit line of its own —
  // whatever the room seeded before it, every line in the trail is `onboard`.
  const drawnAt = mark(wireA);
  type(sessionA, "build me an auth service");
  await frameAfter(
    wireA,
    drawnAt,
    (f) => f.type === "graph" && f.worktree === mainA && f.graph.nodes.some((n) => n.id === "auth-service"),
    "the graph the session drew",
  );
  await sleep(300);
  const entriesAfter = auditEntries(TENANT_A, projectAId, mainA);
  check(
    "a canvas call from a session is not audited: the trail is what the SERVER wrote, not the harness",
    entriesAfter.length > 0 && entriesAfter.every((e) => e.kind === "onboard"),
    JSON.stringify(entriesAfter.map((e) => e.kind)),
  );

  // --- 7. what the tenants keep in the database, side by side ---------------

  const sessionBAt = mark(wireB);
  await startSession("omp-b", agentB, mainB);
  await frameAfter(
    wireB,
    sessionBAt,
    (f) => f.type === "session_started" && f.worktree === mainB,
    "session_started in the second tenant's project",
  );

  const graphRow = (tenant, key, worktree) => {
    const rows = dbRows("SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?", tenant, key, worktree);
    return rows === null || rows.length === 0 ? null : JSON.parse(rows[0].doc);
  };
  // each project's skeleton is drawn from ITS OWN packages, so the rows are
  // told apart by the bubbles in them rather than by the key they were read on
  const mappedRow = (tenant, key, worktree, scope) => {
    const row = graphRow(tenant, key, worktree);
    return row !== null && row.nodes.some((n) => n.id.startsWith(`${scope}-`)) ? row : null;
  };
  const graphA = await waitFor("the first tenant's graph row", () => mappedRow(TENANT_A, projectAId, mainA, "aa"), 20_000);
  const graphB = await waitFor("the second tenant's graph row", () => mappedRow(TENANT_B, projectBId, mainB, "bb"), 20_000);
  check(
    "each tenant's graph is a row of its own, keyed by tenant, project and variation",
    graphA.nodes.some((n) => n.id === "aa-auth") && graphB.nodes.some((n) => n.id === "bb-auth"),
    `${JSON.stringify(graphA.nodes.map((n) => n.id))} / ${JSON.stringify(graphB.nodes.map((n) => n.id))}`,
  );
  check(
    "and holds that project's own packages, never the other tenant's",
    graphA.nodes.every((n) => !n.id.startsWith("bb-")) && graphB.nodes.every((n) => !n.id.startsWith("aa-")),
    `${JSON.stringify(graphA.nodes.map((n) => n.id))} / ${JSON.stringify(graphB.nodes.map((n) => n.id))}`,
  );
  check(
    "the tenant is part of a graph's key, not a filter: one tenant's project key finds nothing under the other",
    graphRow(TENANT_B, projectAId, mainA) === null && graphRow(TENANT_A, projectBId, mainB) === null,
  );
  const audits = await waitFor(
    "an audit entry for each mapped project",
    () => {
      const rows = dbRows("SELECT tenant, key, entry FROM audit");
      return rows !== null && rows.some((row) => row.key === projectAId) && rows.some((row) => row.key === projectBId)
        ? rows
        : null;
    },
    20_000,
  );
  check(
    "every audit entry is filed under the tenant that owns the project it is about",
    audits.some((row) => row.key === projectAId && row.tenant === TENANT_A) &&
      audits.every((row) => (row.key === projectAId ? row.tenant === TENANT_A : row.tenant !== TENANT_A)),
    JSON.stringify(audits.map((row) => `${row.tenant}:${row.key.slice(0, 8)}`)),
  );
  check(
    "and every one of them is the room's own onboarding write: nothing else audits",
    audits.every((row) => JSON.parse(row.entry).kind === "onboard"),
    JSON.stringify(audits.map((row) => JSON.parse(row.entry).kind)),
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
  for (const dir of [targetA, targetB, targetC, fakeHome, loginHome, dataDir, tokenDir]) {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("");
for (const line of results) console.log(line);
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
