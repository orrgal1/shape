#!/usr/bin/env node
/**
 * Herdr smoke test. herdr is not how Shape starts sessions — Shape starts
 * none — it is how Shape can SEE the user's own terminal: a session running in
 * a herdr tab has a terminal that can be brought forward, and one running
 * anywhere else does not. This drives that, with `scripts/fake-herdr.mjs` in
 * place of the user's herdr server and `scripts/fake-omp-tui.mjs` as the
 * session inside the tab:
 *
 *   probe           — the bridge finds herdr on HERDR_SOCKET_PATH and says so
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
 *
 * The project's manager tab is the one thing Shape still OPENS in herdr; that
 * pass has its own smoke (`smoke-manager.mjs`) and is switched off here with
 * SHAPE_MANAGER=0, so what this file drives is only the observing side.
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

/** a committed one-package workspace: enough for reality extraction to succeed */
async function seedTarget(dir) {
  await mkdir(join(dir, "packages", "solo", "src"), { recursive: true });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "herdr-smoke", private: true }, null, 2));
  await writeFile(join(dir, "packages", "solo", "package.json"), JSON.stringify({ name: "@herdr/solo", version: "0.0.1" }, null, 2));
  await writeFile(join(dir, "packages", "solo", "src", "index.ts"), "export const solo = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  // not `main`: this machine's global pre-commit hook refuses commits there,
  // and a throwaway repo in /tmp is nobody's trunk
  git("init", "-q", "-b", "smoke");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

const target = await mkdtemp(join(tmpdir(), "vh-herdr-target-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-herdr-home-"));
const socketPath = join(fakeHome, "herdr.sock");
const herdrLog = join(fakeHome, "fake-herdr.log");
await seedTarget(target);
/** the variation a builder works in: its own worktree, as the manager makes one */
const worktree = join(tmpdir(), `vh-herdr-wt-${process.pid}`);
execFileSync("git", ["worktree", "add", "-q", "-b", "variation", worktree], { cwd: target, stdio: "ignore" });

const wtMain = realpathSync(target);
const wtVariation = realpathSync(worktree);

const frames = [];
let herdr = null;
let bridge = null;
let socket = null;

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

  // --- the bridge, with that herdr as the machine's terminal ----------------
  bridge = spawn(process.execPath, ["src/index.ts", "--cwd", target, "--port", String(PORT)], {
    cwd: process.cwd(),
    // SHAPE_TERMINAL_APP names the app whose window "go to terminal" raises, so
    // this bridge advertises an external terminal without probing the machine
    // it runs on; SHAPE_OPEN replaces `open` with `true`, so nothing real is
    // ever brought forward under a smoke. SHAPE_AUTO_MAP=0 keeps the room from
    // mapping this seeded project by itself — the terminal is what this file is
    // about. SHAPE_MANAGER=0: the manager pass has its own smoke.
    env: {
      ...process.env,
      SHAPE_AUTO_MAP: "0",
      SHAPE_MANAGER: "0",
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

  socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  {
    const opened = Promise.withResolvers();
    socket.once("open", opened.resolve);
    socket.once("error", opened.reject);
    await opened.promise;
  }
  const hello = await waitFor("hello", () => frames.find((f) => f.type === "hello"));
  check("hello names herdr as the project's launcher", hello.tools?.launcher === "herdr", JSON.stringify(hello.tools ?? null));
  check(
    "a project nobody is working in yet is attached with no session in it",
    hello.session.sessions.length === 0,
    JSON.stringify(hello.session.sessions),
  );

  // --- a builder in a tab of its own, the way the manager launches one -------
  // The workspace, the tab and the harness inside it are all somebody else's
  // doing: Shape only ever learns about this session because it dials the
  // loopback link from a directory Shape knows.
  const startedAt = frames.length;
  const workspace = await herdrCall("workspace.create", { label: basename(wtMain), cwd: wtMain, focus: false });
  const workspaceId = String(workspace.workspace.workspace_id);
  const created = await herdrCall("tab.create", {
    workspace_id: workspaceId,
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
  await rm(fakeHome, { recursive: true, force: true });
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? `HERDR SMOKE OK (${results.length} checks)` : `HERDR SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
