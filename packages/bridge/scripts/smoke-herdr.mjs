#!/usr/bin/env node
/**
 * Herdr smoke test. herdr is not how Shape starts sessions — Shape starts
 * none — it is how Shape SEES the user's machine: every session in a herdr tab
 * is a project Shape can list and a terminal it can bring forward, and a
 * session running anywhere else is neither. This drives that, with
 * `scripts/fake-herdr.mjs` in place of the user's herdr server and
 * `scripts/fake-omp-tui.mjs` as the session inside a tab:
 *
 *   probe           — the bridge finds herdr on HERDR_SOCKET_PATH and says so
 *   the seed        — `--cwd` is a repo treated as seen: one ACTIVE project,
 *                     with the manager tab the user already has in their herdr
 *                     FOUND in it (`origin: "found"`), and not one tab, pane or
 *                     prompt created by Shape to get it — the fake's call log
 *                     is read to prove that
 *   a builder tab   — a tab created in a worktree with a harness started in it
 *                     (what a manager-launched builder looks like) reports in
 *                     over the loopback link as a session with terminal
 *                     "external": its terminal is the user's, not a drawer
 *   focus_terminal  — becomes `agent.list` then `agent.focus` for THAT pane,
 *                     each on a connection of its own (herdr hangs up per
 *                     answer), and raises the hosting application
 *                     (`SHAPE_TERMINAL_APP` names it, `SHAPE_OPEN` raises
 *                     nothing real, and the probe of this machine's process
 *                     table is checked separately)
 *   no session      — focus_terminal for a variation nothing reports in from is
 *                     refused with the reason
 *   tab.close       — the harness dies with its tab and the session is gone
 *   discovery       — a herdr agent in a repo Shape was never told about is a
 *                     new ACTIVE project with one live session, found by the
 *                     scan the first browser to connect triggers. Switching to
 *                     it answers a hello with NO manager, because no workspace
 *                     of the user's belongs to that repo
 *   gone quiet      — that agent's tab closes and nobody says so: the next
 *                     scan sees the whole machine, so the project it no longer
 *                     mentions drops to no live sessions and stays active
 *
 * Shape OPENS nothing in herdr any more (#28): the manager is a tab the user
 * (or a previous Shape) started, so the fake here hosts one BEFORE the bridge
 * comes up, in a workspace named after the project, with an agent in the
 * project's main checkout and no link of its own — the user's own session, seen
 * in herdr and nowhere else. `smoke-manager.mjs` drives the same pass against
 * the real herdr on this machine.
 *
 * Not in CI (it models a terminal): run it locally, against the fake by
 * default. Usage (from packages/bridge): node scripts/smoke-herdr.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import WebSocket from "ws";

import { parsePsRows, terminalAppOf } from "../src/agent/launcher/herdr.ts";

const PORT = Number(process.env.SMOKE_HERDR_PORT ?? 4415);

// herdr is the terminal under test, and the one harness on this machine is the
// fake omp. An explicit socket is also what tells the launcher not to go
// autospawning a herdr server: someone else already owns this one.
process.env.SHAPE_LAUNCHER = "herdr";
process.env.SHAPE_FORCE_HARNESSES = "omp";

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

/** one JSON object per line: every call, event and lifecycle marker of a fake */
function jsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** the calls herdr was asked for, in order, with the connection each came on */
const calls = (method) => jsonl(herdrLog).filter((f) => f.type === "__call" && f.method === method);

/**
 * The same, minus this smoke's own calls. The smoke plays the user's terminal
 * here — it creates the workspaces, tabs and agents that a manager or a person
 * would — and its request ids all start with `smoke-`, so what is left is
 * exactly what the BRIDGE asked herdr for. Shape opens nothing, and this is
 * how a run says so.
 */
const bridgeCalls = (method) => calls(method).filter((f) => !String(f.id).startsWith("smoke-"));

let callSeq = 0;

/**
 * One call to the fake herdr, the way the real protocol works: a connection
 * carrying a single request, whose first response line is that request's
 * answer. This smoke is a herdr CLIENT here — it plays the manager launching a
 * builder into a tab, which is what Shape then observes.
 */
function herdrCall(method, params = {}) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const socket = connect(socketPath);
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(`${JSON.stringify({ id: `smoke-${String(++callSeq)}`, method, params })}\n`));
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const answer = JSON.parse(buf.slice(0, nl));
    socket.end();
    if (answer.error !== undefined) reject(new Error(`${answer.error.code}: ${answer.error.message}`));
    else resolve(answer.result ?? {});
  });
  socket.on("error", reject);
  return promise;
}

/** a committed repo: not `main`, because this machine's hook refuses commits there */
function commitAll(dir) {
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "smoke");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** a committed one-package workspace: enough for reality extraction to succeed */
async function seedTarget(dir) {
  await mkdir(join(dir, "packages", "solo", "src"), { recursive: true });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "herdr-smoke", private: true }, null, 2));
  await writeFile(join(dir, "packages", "solo", "package.json"), JSON.stringify({ name: "@herdr/solo", version: "0.0.1" }, null, 2));
  await writeFile(join(dir, "packages", "solo", "src", "index.ts"), "export const solo = 1;\n");
  commitAll(dir);
}

const target = await mkdtemp(join(tmpdir(), "vh-herdr-target-"));
/**
 * A repo Shape is never told about: only a herdr agent running in it puts it
 * on the picture, which is the whole of how a project comes into being.
 */
const stranger = await mkdtemp(join(tmpdir(), "vh-herdr-stranger-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-herdr-home-"));
const socketPath = join(fakeHome, "herdr.sock");
const herdrLog = join(fakeHome, "fake-herdr.log");
await seedTarget(target);
await writeFile(join(stranger, "README.md"), "# a repo nobody told Shape about\n");
commitAll(stranger);
/** the variation a builder works in: its own worktree, as the manager makes one */
const worktree = join(tmpdir(), `vh-herdr-wt-${process.pid}`);
execFileSync("git", ["worktree", "add", "-q", "-b", "variation", worktree], { cwd: target, stdio: "ignore" });

const wtMain = realpathSync(target);
const wtVariation = realpathSync(worktree);
const wtStranger = realpathSync(stranger);

const frames = [];
let herdr = null;
let bridge = null;
let socket = null;

/**
 * A browser watching the canvas. The scan runs only while one is connected, so
 * cycling this socket is also the only way a smoke gets a fresh scan out of
 * the bridge: the standing timer is 30 s, which is longer than this whole run.
 */
async function openBrowser() {
  const ws = new WebSocket(`ws://127.0.0.1:${String(PORT)}/ws`);
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const opened = Promise.withResolvers();
  ws.once("open", opened.resolve);
  ws.once("error", opened.reject);
  await opened.promise;
  return ws;
}

/**
 * Ask the bridge to look at the machine again, and say where the frames that
 * answer begin. A scan happens when the browser count goes from none to one,
 * so cycling the socket is the whole trick — with the close given time to
 * land, or the count never reaches zero and nothing is triggered.
 */
async function rescan() {
  socket.close();
  socket = null;
  await sleep(300);
  const from = frames.length;
  socket = await openBrowser();
  return from;
}

try {
  // --- the herdr server the bridge talks to ---------------------------------
  herdr = spawn(process.execPath, ["scripts/fake-herdr.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath, FAKE_HERDR_LOG: herdrLog },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let herdrOut = "";
  herdr.stdout.setEncoding("utf8");
  herdr.stdout.on("data", (d) => {
    herdrOut += d;
  });
  herdr.stderr.setEncoding("utf8");
  herdr.stderr.on("data", (d) => process.stderr.write(`[herdr] ${d}`));
  await waitFor("the fake herdr server listening", () => herdrOut.includes('"ready"'));

  // --- the manager the user already has, before Shape is even up -----------
  // A workspace of the project's own with a `manager` tab in it, whose agent
  // runs in the project's main checkout and has no link: exactly what a
  // manager the user (or a previous Shape) started looks like from outside.
  // Shape must recognize THIS rather than open one of its own.
  const managerWorkspace = await herdrCall("workspace.create", { label: basename(wtMain), cwd: wtMain, focus: false });
  const managerWorkspaceId = String(managerWorkspace.workspace.workspace_id);
  const managerTab = await herdrCall("tab.create", { workspace_id: managerWorkspaceId, cwd: wtMain, label: "manager" });
  await herdrCall("agent.start", {
    name: "manager-herdr-smoke",
    kind: "omp",
    pane_id: String(managerTab.root_pane.pane_id),
    args: [],
    timeout_ms: 10_000,
  });

  // --- the bridge, with that herdr as the machine's terminal ----------------
  bridge = spawn(process.execPath, ["src/index.ts", "--cwd", target, "--port", String(PORT)], {
    cwd: process.cwd(),
    // SHAPE_TERMINAL_APP names the app whose window "go to terminal" raises, so
    // this bridge advertises an external terminal without probing the machine
    // it runs on; SHAPE_OPEN replaces `open` with `true`, so nothing real is
    // ever brought forward under a smoke. SHAPE_AUTO_MAP=0 keeps the room from
    // mapping this seeded project by itself — the terminal is what this file is
    // about. The manager pass is left ON: it is find-only now, so what it does
    // to a fake herdr is read a workspace's tabs.
    env: {
      ...process.env,
      SHAPE_AUTO_MAP: "0",
      HERDR_SOCKET_PATH: socketPath,
      SHAPE_HOME: fakeHome,
      HOME: fakeHome,
      SHAPE_TERMINAL_APP: "/tmp/FakeTerminal.app",
      SHAPE_OPEN: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(`[bridge] ${d}`);
  });
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (d) => process.stderr.write(`[bridge:out] ${d}`));
  await waitFor("bridge listening", () => stderr.includes("canvas at ws://"));

  check(
    "the bridge finds the herdr on HERDR_SOCKET_PATH and reports an external terminal",
    stderr.includes("hosts this machine's sessions") && stderr.includes("terminal: herdr"),
    stderr.split("\n").find((line) => line.includes("herdr")) ?? "(herdr never mentioned)",
  );

  socket = await openBrowser();
  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check("hello names herdr as the project's launcher", hello.tools?.launcher === "herdr", JSON.stringify(hello.tools ?? null));
  check(
    "a project nobody is working in yet is attached with no session in it",
    hello.session.sessions.length === 0,
    JSON.stringify(hello.session.sessions),
  );

  // --- the seed is a project, and its manager was already there -------------
  // `--cwd` is a repo treated as seen: one ACTIVE project, and the herdr agent
  // in the manager tab is a live session in its main checkout — the scan is
  // the only thing that knows about that one, because it never spoke on the
  // link.
  check(
    "the --cwd seed is the one project, and it is active",
    hello.projects.length === 1 && hello.projects[0]?.status === "active" && hello.projects[0]?.projectId === hello.projectId,
    JSON.stringify(hello.projects.map((p) => ({ id: p.projectId, status: p.status }))),
  );
  check(
    "with the session herdr is hosting counted as live in it",
    hello.projects[0]?.liveSessions === 1,
    String(hello.projects[0]?.liveSessions),
  );
  check(
    "the manager tab the user already had is FOUND, in the pane and workspace herdr says",
    hello.session.manager?.origin === "found" &&
      hello.session.manager.tabId === String(managerTab.tab.tab_id) &&
      hello.session.manager.workspaceId === managerWorkspaceId,
    JSON.stringify(hello.session.manager),
  );
  check(
    "it is not shape-aware: a session that never dialled the link cannot reach the canvas",
    hello.session.manager?.shapeAware === false,
    String(hello.session.manager?.shapeAware),
  );
  check("and the project says it has one", hello.projects[0]?.manager === true, String(hello.projects[0]?.manager));
  check(
    "nothing was opened to get it: Shape created no tab, started no agent and typed nothing",
    bridgeCalls("tab.create").length === 0 && bridgeCalls("agent.start").length === 0 && bridgeCalls("agent.prompt").length === 0,
    `${bridgeCalls("tab.create").length} tab.create, ${bridgeCalls("agent.start").length} agent.start, ${bridgeCalls("agent.prompt").length} agent.prompt`,
  );

  // --- a builder in a tab of its own, the way the manager launches one -------
  // The tab and the harness inside it are somebody else's doing: Shape only
  // ever learns about this session because it dials the loopback link from a
  // directory Shape knows.
  const startedAt = frames.length;
  const created = await herdrCall("tab.create", {
    workspace_id: managerWorkspaceId,
    cwd: wtVariation,
    label: "variation",
    env: {
      SHAPE_LINK: `ws://127.0.0.1:${String(PORT)}/link`,
      SHAPE_WORKTREE: wtVariation,
      FAKE_OMP_LOG: join(fakeHome, "fake-omp.log"),
    },
  });
  const paneId = String(created.root_pane.pane_id);
  const tabId = String(created.tab.tab_id);
  await herdrCall("agent.start", { name: "builder", kind: "omp", pane_id: paneId, args: [], timeout_ms: 30_000 });

  // A session appears twice over: first because something spoke from a
  // directory Shape knows — all it can say then is that work is happening
  // there — and again the moment the harness greets, which is what names it.
  const appeared = await waitFor(
    "session_started for the builder's variation",
    () => frames.slice(startedAt).find((f) => f.type === "session_started" && f.worktree === wtVariation),
  );
  check(
    "a directory of this repo speaking on the link IS a session appearing, before anything is known about it",
    appeared.backend.id === "unknown" && appeared.backend.capabilities.events === "hooks",
    JSON.stringify({ backend: appeared.backend.id, capabilities: appeared.backend.capabilities }),
  );
  const named = await waitFor(
    "the greeted session in the builder's variation",
    () =>
      frames
        .slice(startedAt)
        .find((f) => f.type === "session_started" && f.worktree === wtVariation && f.backend.id === "omp"),
  );
  check(
    "and the harness's own hello names it: its session, its model and the canvas tool it registered",
    named.session.sessionId !== null &&
      named.backend.capabilities.events === "native" &&
      named.backend.capabilities.hostTool === true,
    JSON.stringify({ session: named.session, capabilities: named.backend.capabilities }),
  );
  check(
    "either way its terminal is the user's own, which Shape can reach but does not host",
    appeared.backend.capabilities.terminal === "external" && named.backend.capabilities.terminal === "external",
    JSON.stringify(named.backend.capabilities),
  );

  // --- going to that session's terminal -------------------------------------
  const focusAt = frames.length;
  const listedBefore = calls("agent.list").length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: wtVariation }));
  const focused = await waitFor("an agent.focus call", () => calls("agent.focus")[0]);
  check(
    "focus_terminal brings that session's own pane forward, found by the directory it runs in",
    focused.params.target === paneId,
    `${String(focused.params.target)} vs ${paneId}`,
  );
  check(
    "and it is found by asking herdr what is live, not from a pane id Shape kept",
    calls("agent.list").length > listedBefore,
    `${String(calls("agent.list").length - listedBefore)} agent.list call(s)`,
  );
  // the real server answers ONE request per connection and then hangs up, so a
  // launcher holding one socket open would work exactly once
  const rounds = jsonl(herdrLog).filter((f) => f.type === "__call" && f.conn !== undefined);
  check(
    "every call went out on a connection of its own, the way the protocol demands",
    new Set(rounds.map((f) => f.conn)).size === rounds.length,
    `${rounds.length} call(s) on ${new Set(rounds.map((f) => f.conn)).size} connection(s)`,
  );
  await sleep(300);
  check(
    "and the browser is asked for nothing: there is no terminal for Shape to draw",
    !frames.slice(focusAt).some((f) => f.type === "error"),
    JSON.stringify(frames.slice(focusAt).filter((f) => f.type === "error").map((f) => f.message)),
  );

  // Unset, the launcher walks the REAL process table to decide which
  // application to raise: the one input a smoke cannot synthesize. It must come
  // back with an app bundle or nothing, and never throw on whatever this
  // machine happens to be running.
  let probed = "threw";
  try {
    probed = terminalAppOf(parsePsRows(execFileSync("ps", ["-axo", "pid,ppid,command"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })));
  } catch (err) {
    probed = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  check(
    "the launcher's own probe survives the real process table: an .app bundle, or nothing",
    probed === null || (typeof probed === "string" && probed.startsWith("/") && probed.endsWith(".app")),
    String(probed),
  );

  // --- a variation nothing is running in ------------------------------------
  const refusedAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: wtMain }));
  const refused = await waitFor("the refusal for a variation with no session", () =>
    frames.slice(refusedAt).find((f) => f.type === "error"),
  );
  check(
    "focus_terminal for a variation nothing reports in from is refused with the reason",
    refused.message.includes("reporting in"),
    refused.message,
  );

  // --- the user closes the tab ----------------------------------------------
  const closeAt = frames.length;
  await herdrCall("tab.close", { tab_id: tabId });
  const stopped = await waitFor("session_stopped for the closed tab", () =>
    frames.slice(closeAt).find((f) => f.type === "session_stopped" && f.worktree === wtVariation),
  );
  check("a harness that dies with its tab ends that variation's session, and says why", stopped.reason.length > 0, stopped.reason);
  const after = await waitFor("a session frame with nothing running", () =>
    frames.slice(closeAt).find((f) => f.type === "session" && f.session.sessions.every((s) => s.worktree !== wtVariation)),
  );
  check(
    "and the variation stays on the picture, with no session in it",
    after.session.worktrees.some((w) => w.id === wtVariation),
    JSON.stringify(after.session.worktrees.map((w) => w.id)),
  );

  // --- a repo Shape was never told about ------------------------------------
  // Nobody opens a project. A herdr agent running in a repo IS the project
  // appearing, and the scan that notices it runs when a browser connects —
  // never with nobody watching, which is why the socket is cycled here rather
  // than waiting out the 30 s tick.
  const strangerTab = await herdrCall("tab.create", {
    workspace_id: managerWorkspaceId,
    cwd: wtStranger,
    label: "a stranger's work",
  });
  await herdrCall("agent.start", {
    name: "issue-1",
    kind: "omp",
    pane_id: String(strangerTab.root_pane.pane_id),
    args: [],
    timeout_ms: 10_000,
  });
  const rescanned = await rescan();
  const listed = await waitFor("a projects broadcast naming the stranger's repo", () =>
    frames
      .slice(rescanned)
      .find((f) => f.type === "projects" && f.projects.some((p) => p.cwd === wtStranger)),
  );
  const strangerProject = listed.projects.find((p) => p.cwd === wtStranger);
  check(
    "a herdr agent in a repo nobody named is a new ACTIVE project, with that session live in it",
    strangerProject.status === "active" && strangerProject.liveSessions === 1,
    JSON.stringify(strangerProject),
  );
  check(
    "and it has no manager: no workspace of the user's belongs to that repo",
    strangerProject.manager === false,
    String(strangerProject.manager),
  );
  check(
    "the project it was discovered alongside is still there, still active",
    listed.projects.some((p) => p.cwd === wtMain && p.status === "active"),
    JSON.stringify(listed.projects.map((p) => `${p.label}:${p.status}`)),
  );
  check(
    "and discovering it opened nothing in the user's terminal either",
    bridgeCalls("tab.create").length === 0 && bridgeCalls("agent.start").length === 0 && bridgeCalls("agent.prompt").length === 0,
    `${bridgeCalls("tab.create").length} tab.create, ${bridgeCalls("agent.start").length} agent.start, ${bridgeCalls("agent.prompt").length} agent.prompt`,
  );

  // A project no workspace of the user's belongs to has no manager, and the
  // canvas is told exactly that instead of being handed one: opening the tab
  // is the user's business, and Shape only ever reports what it found.
  const switched = frames.length;
  socket.send(JSON.stringify({ type: "select_project", projectId: strangerProject.projectId }));
  const strangerHello = await waitFor("a hello for the stranger's project", () =>
    frames.slice(switched).find((f) => f.type === "hello" && f.projectId === strangerProject.projectId),
  );
  check(
    "switching to a project with no manager tab in it answers a hello carrying no manager",
    strangerHello.session.manager === null,
    JSON.stringify(strangerHello.session.manager),
  );

  // --- the stranger's session ends ------------------------------------------
  // The tab closes, so herdr stops listing that agent — and nothing tells the
  // bridge. A scan sees the WHOLE machine, so a repo it stays silent about has
  // nothing live in it: the count has to fall by itself, and the project stays
  // in the registry with everything it knows.
  await herdrCall("tab.close", { tab_id: String(strangerTab.tab.tab_id) });
  const emptied = await rescan();
  const quiet = await waitFor("a projects broadcast with nothing live in the stranger's repo", () =>
    frames
      .slice(emptied)
      .find((f) => f.type === "projects" && f.projects.some((p) => p.cwd === wtStranger && p.liveSessions === 0)),
  );
  check(
    "the last session leaving a repo leaves the project itself active, with nothing live in it",
    quiet.projects.find((p) => p.cwd === wtStranger)?.status === "active",
    JSON.stringify(quiet.projects.find((p) => p.cwd === wtStranger)),
  );
  check(
    "and the project whose session is still running still counts it",
    quiet.projects.find((p) => p.cwd === wtMain)?.liveSessions === 1,
    JSON.stringify(quiet.projects.find((p) => p.cwd === wtMain)),
  );
} catch (err) {
  check("the herdr smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  socket?.close();
  bridge?.kill("SIGKILL");
  herdr?.kill("SIGKILL");
  await sleep(150);
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: target, stdio: "ignore" });
  } catch {
    // the repo is about to be deleted anyway
  }
  await rm(worktree, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
  await rm(stranger, { recursive: true, force: true });
  await rm(fakeHome, { recursive: true, force: true });
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? `HERDR SMOKE OK (${results.length} checks)` : `HERDR SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
