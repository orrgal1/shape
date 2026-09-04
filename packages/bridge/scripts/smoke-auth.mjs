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
 *   terminal gating     — no --allow-terminal ⇒ terminal "none" and pty_* dropped
 *   shape login         — servers.json (0600) alone authenticates an agent
 *   audit               — deliver/delivered entries under the caller's tenant
 *   storage             — one graph row per (tenant, project, variation) in <data-dir>/shape.db
 *
 * The harness on every agent is scripts/fake-omp-tui.mjs, so nothing real is
 * spawned; each target gets its own log, which is what proves which process
 * served a turn.
 *
 * Usage (from packages/bridge): node scripts/smoke-auth.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

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
// on what is installed on the machine running it. The launcher is Shape's own
// pty (never a herdr tab in the developer's terminal), and detection reports
// exactly one harness — `omp`, which `--omp` points at the fake.
process.env.SHAPE_LAUNCHER = "pty";
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
  git("init", "-q");
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
 * child this smoke expects to be refused. cwd stays packages/bridge, so a
 * relative `--omp` token resolves against the agent process, not its target.
 * `log` accumulates both streams — the banners and refusals the steps wait on
 * are on stderr, but `shape login` reports where it saved on stdout.
 */
function launch(label, args, extraEnv = {}) {
  // SHAPE_AUTO_MAP=0 reaches the server through here: its targets have code and
  // empty canvases, and an automatic map would deliver turns no step asked for
  const env = { ...process.env, SHAPE_AUTO_MAP: "0", SHAPE_HOME: fakeHome };
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
  "--omp",
  "node scripts/fake-omp-tui.mjs",
  ...extra,
];

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

  // --- 3. the first tenant's agent: 401 without a token, terminal off with one

  const tokenless = launch("agent-no-token", agentArgs(targetA, LINK_PORT_A), { FAKE_OMP_LOG: ompLogIn(targetA) });
  const tokenlessCode = await waitForExit(tokenless, 5_000);
  check(
    "an agent with no token is refused by name and does not retry",
    tokenless.log.includes("Shape server refused the token (401)") && tokenlessCode === 1,
    `exit ${String(tokenlessCode)}: ${tokenless.log.trim().split("\n").at(-1) ?? "(no output)"}`,
  );

  const helloAAt = mark(wireA);
  const agentA = launch("agent-a", agentArgs(targetA, LINK_PORT_A, ["--token", TOKEN_A]), {
    FAKE_OMP_LOG: ompLogIn(targetA),
  });
  await waitFor("agent A attached", () => agentA.log.includes("agent attached to"));
  const helloA = await frameAfter(wireA, helloAAt, (f) => f.type === "hello", "hello after the first tenant's attach");
  const projectAId = helloA.projectId;
  check(
    "an agent authenticated by --token greets its own tenant's browser with its one project",
    helloA.projects.length === 1 && helloA.projects[0].cwd === mainA && helloA.session.cwd === mainA,
    JSON.stringify(helloA.projects.map((p) => p.cwd)),
  );
  // the harness runs in a variation, so what it can do is reported against that
  // variation: the browser is told which session it drives and where it runs
  const runningA = helloA.session.sessions.find((s) => s.worktree === mainA);
  check(
    "an agent started without --allow-terminal advertises terminal none on the variation it runs in",
    runningA !== undefined && runningA.backend.capabilities.terminal === "none",
    `${String(runningA?.worktree)}: ${JSON.stringify(runningA?.backend.capabilities ?? null)}`,
  );

  const ptyAt = mark(wireA);
  send(wireA, { type: "pty_open", worktree: mainA, cols: 80, rows: 24 });
  await sleep(500);
  check(
    "a pty_open against a terminal-less agent produces no pty_state",
    !wireA.frames.slice(ptyAt).some((f) => f.type === "pty_state" || f.type === "pty_data"),
    JSON.stringify(wireA.frames.slice(ptyAt).map((f) => f.type)),
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
  const agentB = launch("agent-b", agentArgs(targetB, LINK_PORT_B, ["--allow-terminal"]), {
    FAKE_OMP_LOG: ompLogIn(targetB),
    SHAPE_TOKEN: TOKEN_B,
  });
  await waitFor("agent B attached", () => agentB.log.includes("agent attached to"));
  const helloB = await frameAfter(wireB, helloBAt, (f) => f.type === "hello", "hello after the second tenant's attach");
  const projectBId = helloB.projectId;
  check(
    "an agent authenticated by SHAPE_TOKEN attaches for its own tenant only",
    helloB.projects.length === 1 && helloB.projects[0].cwd === mainB,
    JSON.stringify(helloB.projects.map((p) => p.cwd)),
  );
  const runningB = helloB.session.sessions.find((s) => s.worktree === mainB);
  check(
    "an agent started with --allow-terminal advertises the backend's real terminal on the variation it runs in",
    runningB !== undefined && runningB.backend.capabilities.terminal === "pane",
    `${String(runningB?.worktree)}: ${JSON.stringify(runningB?.backend.capabilities ?? null)}`,
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
  const agentC = launch("agent-c", agentArgs(targetC, LINK_PORT_C), {
    FAKE_OMP_LOG: ompLogIn(targetC),
    SHAPE_HOME: loginHome,
  });
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

  // --- 6. the audit log of a steering delivery ------------------------------

  // what these two sections are about is the database, not the first turn's
  // shape, so both tenants ask to go straight to building: the harness stub's
  // build bubbles are what tells the two rows apart below
  const utterance = "audit this steering: build me an auth service";
  send(wireA, { type: "utterance", worktree: mainA, referent: null, text: utterance, productFirst: false });
  await waitFor("the steered prompt in the first tenant's harness log", () =>
    ompFrames(ompLogIn(targetA)).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes(utterance)),
  );
  const delivery = await waitFor(
    "a deliver entry in the first tenant's audit log",
    () => auditEntries(TENANT_A, projectAId, mainA).find((e) => e.kind === "deliver" && e.text === utterance) ?? null,
    10_000,
  );
  check(
    "a steering delivery is audited under the caller's tenant, project and variation",
    delivery.tenant === TENANT_A &&
      delivery.projectId === projectAId &&
      delivery.worktree === mainA &&
      typeof delivery.at === "string",
    JSON.stringify(delivery),
  );
  const receipt = await waitFor(
    "the delivered receipt for the audited utterance",
    () => auditEntries(TENANT_A, projectAId, mainA).find((e) => e.kind === "delivered" && e.id === delivery.id) ?? null,
    10_000,
  );
  check(
    "the delivery receipt is audited against the same utterance id",
    receipt.tenant === TENANT_A && typeof receipt.mode === "string",
    JSON.stringify(receipt),
  );

  // --- 7. what the tenants keep in the database, side by side ---------------

  const utteranceB = "globex wants its own auth service";
  send(wireB, { type: "utterance", worktree: mainB, referent: null, text: utteranceB, productFirst: false });
  await waitFor("the second tenant's prompt in its harness log", () =>
    ompFrames(ompLogIn(targetB)).find((f) => f.type === "deliver" && f.mode === "prompt" && f.body.includes(utteranceB)),
  );

  const graphRow = (tenant, key, worktree) => {
    const rows = dbRows("SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?", tenant, key, worktree);
    return rows === null || rows.length === 0 ? null : JSON.parse(rows[0].doc);
  };
  // the row appears as soon as the first words are sketched onto the canvas, so
  // what is waited for is the turn's own bubbles, not merely a row
  const builtRow = (tenant, key, worktree) => {
    const row = graphRow(tenant, key, worktree);
    return row !== null && row.nodes.some((n) => n.id === "auth-service") ? row : null;
  };
  const graphA = await waitFor("the first tenant's graph row", () => builtRow(TENANT_A, projectAId, mainA), 10_000);
  const graphB = await waitFor("the second tenant's graph row", () => builtRow(TENANT_B, projectBId, mainB), 10_000);
  check(
    "each tenant's graph is a row of its own, keyed by tenant, project and variation",
    graphA.nodes.some((n) => n.id === "auth-service") && graphB.nodes.some((n) => n.id === "auth-service"),
    `${JSON.stringify(graphA.nodes.map((n) => n.id))} / ${JSON.stringify(graphB.nodes.map((n) => n.id))}`,
  );
  check(
    "each row's first sketch holds the words that tenant said, not the other's",
    graphA.nodes.find((n) => n.id === "product")?.summary === utterance &&
      graphB.nodes.find((n) => n.id === "product")?.summary === utteranceB,
    `${graphA.nodes.find((n) => n.id === "product")?.summary} / ${graphB.nodes.find((n) => n.id === "product")?.summary}`,
  );
  check(
    "the tenant is part of a graph's key, not a filter: one tenant's project key finds nothing under the other",
    graphRow(TENANT_B, projectAId, mainA) === null && graphRow(TENANT_A, projectBId, mainB) === null,
  );
  const audits = dbRows("SELECT tenant, key FROM audit");
  check(
    "every audit entry is filed under the tenant that owns the project it is about",
    audits !== null &&
      audits.some((row) => row.key === projectAId) &&
      audits.every((row) => (row.key === projectAId ? row.tenant === TENANT_A : row.tenant !== TENANT_A)),
    JSON.stringify(audits?.map((row) => `${row.tenant}:${row.key.slice(0, 8)}`) ?? null),
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
