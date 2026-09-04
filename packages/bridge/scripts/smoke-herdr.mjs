#!/usr/bin/env node
/**
 * Herdr-launcher smoke test. The same bridge as every other smoke, but the
 * harness does not run in a pty Shape owns: it runs in a terminal tab that
 * belongs to the user, opened over herdr's socket API. `scripts/fake-herdr.mjs`
 * stands in for that server, and the harness inside the tab is the usual
 * `scripts/fake-omp-tui.mjs` — so the loopback link, the canvas and the
 * steering are real, and only the terminal is somebody else's.
 *
 * What it asserts, end to end:
 *   workspace.create — a project gets ONE workspace of its own, named after
 *                     it: the workspace the user already had open ("scratch",
 *                     which the fake starts with) is left alone
 *   the root tab    — the first session takes the tab that CAME WITH that
 *                     workspace, relabelled for the variation, and asks for
 *                     no tab of its own; it carries the harness's link and
 *                     worktree in its environment
 *   tab.create      — the second variation is a second TAB in the SAME
 *                     workspace (`workspace_id`), in its own directory
 *   agent.start     — the harness started in that tab's root pane, by kind
 *   hello           — a session in that variation, terminal "external": there
 *                     is nothing for the browser to draw a drawer over
 *   utterance       — reaches the harness over the loopback link as `deliver`
 *   focus_terminal  — becomes an `agent.focus` call and NO `terminal` frame:
 *                     the terminal is the user's, and it is brought forward
 *                     where it lives — the tab inside herdr, and the
 *                     application hosting it (`SHAPE_TERMINAL_APP` names it
 *                     and `SHAPE_OPEN` raises nothing real, so the probe of
 *                     this machine's process table is checked separately)
 *   one call, one    — herdr answers a request and HANGS UP, so the launcher
 *   connection         opens a connection per call and keeps working after
 *                      the first answer closed the first one
 *   status           — subscribed for the launched PANE (herdr has no global
 *                      form of it) and delivered on that pane's connection
 *   pane.exited     — a harness that dies in its tab becomes `session_stopped`
 *   close_worktree  — becomes `tab.close`, and the session is gone
 *
 * Usage (from packages/bridge): node scripts/smoke-herdr.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import WebSocket from "ws";

import { parsePsRows, terminalAppOf } from "../src/agent/launcher/herdr.ts";

const PORT = Number(process.env.SMOKE_HERDR_PORT ?? 4415);

// herdr is the launcher under test, and the one harness on this machine is the
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

const calls = (method) => jsonl(herdrLog).filter((f) => f.type === "__call" && f.method === method);
/** what herdr answered, for the ids it invented: workspaces, tabs, panes */
const answers = (method) => jsonl(herdrLog).filter((f) => f.type === "__answer" && f.method === method);

/** a committed one-package workspace: enough for reality extraction to succeed */
async function seedTarget(dir) {
  await mkdir(join(dir, "packages", "solo", "src"), { recursive: true });
  await writeFile(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "herdr-smoke", private: true }, null, 2));
  await writeFile(join(dir, "packages", "solo", "package.json"), JSON.stringify({ name: "@herdr/solo", version: "0.0.1" }, null, 2));
  await writeFile(join(dir, "packages", "solo", "src", "index.ts"), "export const solo = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

const target = await mkdtemp(join(tmpdir(), "vh-herdr-target-"));
const fakeHome = await mkdtemp(join(tmpdir(), "vh-herdr-home-"));
const socketPath = join(fakeHome, "herdr.sock");
const herdrLog = join(fakeHome, "fake-herdr.log");
await seedTarget(target);
/** a second variation of the same repo: a second tab, which is what dies below */
const worktree = join(tmpdir(), `vh-herdr-wt-${process.pid}`);
execFileSync("git", ["worktree", "add", "-b", "variation", worktree], { cwd: target, stdio: "ignore" });

const wtMain = realpathSync(target);
const wtVariation = realpathSync(worktree);
/** each variation's harness logs into its own directory, as everywhere else */
const ompLogIn = (dir) => join(dir, "fake-omp.log");

const frames = [];
let herdr = null;
let bridge = null;
let socket = null;

try {
  // --- the herdr server the launcher talks to -------------------------------
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

  // --- the bridge, launching through it -------------------------------------
  bridge = spawn(
    process.execPath,
    ["src/index.ts", "--cwd", target, "--port", String(PORT), "--omp", "node scripts/fake-omp-tui.mjs"],
    {
      cwd: process.cwd(),
      // SHAPE_TERMINAL_APP names the app whose window "go to terminal" raises,
      // so this bridge advertises an external terminal without probing the
      // machine it runs on; SHAPE_OPEN replaces `open` with `true`, so nothing
      // real is ever brought forward under a smoke. SHAPE_AUTO_MAP=0 keeps the
      // room from mapping this seeded project by itself: the launcher is what
      // this file is about, and a survey turn would talk over it.
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

  // --- the project's workspace and the harness in its root tab -------------
  // One workspace per project, one tab per variation. A brand-new workspace
  // arrives WITH its first tab and root pane, so the project's first session
  // takes that tab and no `tab.create` happens for it at all.
  const created = await waitFor("a workspace created for the project", () => calls("workspace.create")[0]);
  const answer = await waitFor("the workspace herdr handed back", () => answers("workspace.create")[0]);
  const workspaceId = String(answer.result.workspace.workspace_id);
  const rootTab = String(answer.result.tab.tab_id);
  const rootPane = String(answer.result.root_pane.pane_id);
  const listed = await waitFor("the workspaces the launcher looked at first", () => answers("workspace.list")[0]);
  const scratchId = String((listed.result.workspaces ?? []).find((w) => w.label === "scratch")?.workspace_id ?? "");
  check(
    "a project gets a herdr workspace of its own, named after it and rooted in its worktree",
    created.params.label === basename(wtMain) && created.params.cwd === wtMain && workspaceId.length > 0,
    JSON.stringify(created.params),
  );
  check(
    "and it is Shape's own: the workspace the user already had open is not taken over",
    scratchId.length > 0 && scratchId !== workspaceId,
    `scratch ${scratchId}, project ${workspaceId}`,
  );
  check(
    "the tab it runs in carries the harness's loopback link and the variation it is for",
    String(created.params.env?.SHAPE_LINK ?? "").startsWith("ws://") &&
      String(created.params.env?.SHAPE_LINK ?? "").endsWith("/link") &&
      created.params.env?.SHAPE_WORKTREE === wtMain,
    JSON.stringify(created.params.env ?? null),
  );
  const renamed = await waitFor("the root tab relabelled for the variation", () =>
    calls("tab.rename").find((f) => f.params.tab_id === rootTab),
  );
  check(
    "the first session takes the tab that came with the workspace, relabelled, and asks for none of its own",
    typeof renamed.params.label === "string" &&
      renamed.params.label.length > 0 &&
      !calls("tab.create").some((f) => f.params.cwd === wtMain),
    `${JSON.stringify(renamed.params)}; ${String(calls("tab.create").length)} tab.create calls so far`,
  );

  const startCall = await waitFor("the agent started in that tab", () => calls("agent.start")[0]);
  check(
    "the harness is started in the tab's root pane, by kind",
    startCall.params.kind === "omp" && typeof startCall.params.pane_id === "string" && startCall.params.pane_id.length > 0,
    JSON.stringify(startCall.params),
  );
  check(
    "and it is started with the canvas extension, not driven over a pipe",
    Array.isArray(startCall.params.args) && startCall.params.args.includes("--extension"),
    JSON.stringify(startCall.params.args ?? null),
  );
  check(
    "and that pane is the root pane of the project's own workspace",
    startCall.params.pane_id === rootPane && rootPane.startsWith(`${workspaceId}:`),
    `${String(startCall.params.pane_id)} vs ${rootPane}`,
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
  check("hello says the project is launched through herdr", hello.tools?.launcher === "herdr", JSON.stringify(hello.tools ?? null));
  const running = hello.session.sessions.find((s) => s.worktree === wtMain);
  check(
    "the session that came up in the tab is reported against that variation",
    running !== undefined && running.backend.id === "omp",
    JSON.stringify(hello.session.sessions),
  );
  check(
    "a harness in the user's own terminal advertises an external terminal: there is no drawer to open",
    running?.backend.capabilities.terminal === "external",
    JSON.stringify(running?.backend.capabilities ?? null),
  );

  // --- steering goes over the link, not through the terminal ----------------
  // productFirst off: the first turn on an empty canvas would otherwise be
  // spent on the product picture, and what this asserts is the wire into the
  // harness, not that gate (§Product-first turn covers it)
  socket.send(
    JSON.stringify({
      type: "utterance",
      worktree: wtMain,
      referent: null,
      text: "build me an auth service",
      productFirst: false,
    }),
  );
  const delivered = await waitFor("the utterance in the harness's own log", () =>
    jsonl(ompLogIn(target)).find((f) => f.type === "deliver" && f.body.includes("build me an auth service")),
  );
  check(
    "an utterance reaches a herdr-launched harness over the loopback link",
    delivered.mode === "prompt" || delivered.mode === "steer",
    `${delivered.mode}: ${delivered.body.slice(-40)}`,
  );
  await waitFor("the canvas the harness drew", () =>
    frames.find((f) => f.type === "graph" && f.worktree === wtMain && f.graph.nodes.some((n) => n.id === "auth-service")),
  );
  check("the canvas is written from inside the user's terminal like anywhere else", true);

  // --- going to the terminal ------------------------------------------------
  const focusAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: wtMain }));
  const focused = await waitFor("an agent.focus call", () => calls("agent.focus")[0] ?? calls("tab.focus")[0]);
  check(
    "going to the terminal of a herdr-launched harness brings its own tab forward",
    typeof (focused.params.target ?? focused.params.tab_id) === "string",
    JSON.stringify(focused.params),
  );
  await sleep(400);
  check(
    "and it asks the browser for nothing: there is no drawer to open over the canvas",
    !frames.slice(focusAt).some((f) => f.type === "terminal"),
    JSON.stringify(frames.slice(focusAt).filter((f) => f.type === "terminal")),
  );
  check(
    "the focus was not refused",
    !frames.slice(focusAt).some((f) => f.type === "error"),
    JSON.stringify(frames.slice(focusAt).filter((f) => f.type === "error").map((f) => f.message)),
  );

  // --- and the same, without being told which app to raise ------------------
  // The bridge above was handed SHAPE_TERMINAL_APP, so it never looked at this
  // machine. Unset, the launcher walks the REAL process table, which is the one
  // input a smoke cannot synthesize: it must come back with an app bundle or
  // nothing, and never throw on whatever this machine happens to be running.
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

  // --- herdr hangs up after every answer ------------------------------------
  // The real server answers ONE request per connection and then closes it, so
  // a launcher that keeps one socket for its calls works exactly once. Four
  // more round trips in a row are what that regression would fail.
  const roundTripsAt = calls("agent.focus").length + calls("tab.focus").length;
  const errorsAt = frames.filter((f) => f.type === "error").length;
  for (let i = 0; i < 4; i++) {
    socket.send(JSON.stringify({ type: "focus_terminal", worktree: wtMain }));
    await sleep(100);
  }
  await waitFor(
    "four more calls answered after herdr hung up on the first",
    () => calls("agent.focus").length + calls("tab.focus").length >= roundTripsAt + 4,
  );
  check(
    "the launcher keeps calling a herdr that closes the connection on every answer",
    frames.filter((f) => f.type === "error").length === errorsAt,
    JSON.stringify(frames.filter((f) => f.type === "error").map((f) => f.message)),
  );
  const plainCalls = jsonl(herdrLog).filter((f) => f.type === "__call" && f.method !== "events.subscribe");
  const usedConnections = new Set(plainCalls.map((f) => f.conn));
  check(
    "and every call went out on a connection of its own, the way the protocol demands",
    plainCalls.length >= 6 && usedConnections.size === plainCalls.length,
    `${plainCalls.length} calls on ${usedConnections.size} connections`,
  );

  // --- status comes off the pane's own subscription --------------------------
  const mainPane = String(startCall.params.pane_id);
  const subscribes = calls("events.subscribe");
  const paneSub = subscribes.find((f) =>
    (f.params.subscriptions ?? []).some((s) => s.type === "pane.agent_status_changed" && s.pane_id === mainPane),
  );
  check(
    "the launched pane's status is subscribed for THAT pane: herdr has no global form of it",
    paneSub !== undefined,
    JSON.stringify(subscribes.map((f) => f.params.subscriptions)),
  );
  check(
    "and the lifecycle events are subscribed once, globally",
    subscribes.some((f) => {
      const asked = f.params.subscriptions ?? [];
      return asked.every((s) => s.pane_id === undefined) && asked.some((s) => s.type === "pane.exited");
    }),
    JSON.stringify(subscribes.map((f) => f.params.subscriptions)),
  );
  const statusEvent = await waitFor("a status event delivered to that pane's subscription", () =>
    jsonl(herdrLog).find(
      (f) =>
        f.type === "__event" &&
        f.event === "pane.agent_status_changed" &&
        f.data.pane_id === mainPane &&
        (f.to ?? []).includes(paneSub?.conn ?? -1),
    ),
  );
  check(
    "status for the launched pane reaches the launcher on that pane's connection",
    typeof statusEvent.data.agent_status === "string",
    `${statusEvent.data.agent_status} on connection ${String(paneSub?.conn)}`,
  );

  // --- a harness that dies in its tab ---------------------------------------
  const openAt = frames.length;
  socket.send(JSON.stringify({ type: "open_worktree", path: worktree }));
  await waitFor(
    "a session in the second variation",
    () => frames.slice(openAt).find((f) => f.type === "session_started" && f.worktree === wtVariation),
    30_000,
  );
  const secondTab = await waitFor("a second tab, in the second variation", () =>
    calls("tab.create").find((f) => f.params.cwd === wtVariation),
  );
  check(
    "each variation gets its own tab, in its own directory",
    secondTab.params.env?.SHAPE_WORKTREE === wtVariation,
    JSON.stringify(secondTab.params.cwd),
  );
  check(
    "and that tab is asked for IN the project's workspace: one workspace, one tab per variation",
    secondTab.params.workspace_id === workspaceId,
    `${JSON.stringify(secondTab.params.workspace_id ?? null)} vs ${workspaceId}`,
  );

  const child = await waitFor("the second variation's harness process", () =>
    jsonl(ompLogIn(worktree)).find((f) => f.type === "__start"),
  );
  const diedAt = frames.length;
  // SIGKILL: no goodbye on the link, no `tab.close` from Shape — the harness
  // simply is not there any more, which is what a user quitting a TUI in their
  // own terminal looks like
  process.kill(child.pid, "SIGKILL");
  const exited = await waitFor("the pane exit event", () =>
    jsonl(herdrLog).find((f) => f.type === "__event" && f.event === "pane.exited"),
  );
  const stoppedByExit = await waitFor("session_stopped for the pane that exited", () =>
    frames.slice(diedAt).find((f) => f.type === "session_stopped" && f.worktree === wtVariation),
  );
  check(
    "a harness that dies in its own tab ends that variation's session, and the pane exit says so too",
    typeof stoppedByExit.reason === "string" &&
      stoppedByExit.reason.length > 0 &&
      typeof exited.data?.pane_id === "string",
    `${JSON.stringify(exited.data?.pane_id ?? null)} -> ${stoppedByExit.reason}`,
  );
  check(
    "and that variation is offered again rather than left running",
    frames.slice(diedAt).some((f) => f.type === "session" && f.session.sessions.every((s) => s.worktree !== wtVariation)),
    JSON.stringify(frames.slice(diedAt).filter((f) => f.type === "session").map((f) => f.session.sessions.map((s) => s.worktree))),
  );

  // --- one workspace for the project, whatever it opened --------------------
  check(
    "every session Shape started is in the project's workspace, none in the user's own",
    calls("agent.start").length >= 2 &&
      calls("agent.start").every((f) => String(f.params.pane_id).startsWith(`${workspaceId}:`)) &&
      calls("tab.create").every((f) => f.params.workspace_id === workspaceId),
    calls("agent.start")
      .map((f) => String(f.params.pane_id))
      .join(", "),
  );
  check(
    "and it asked for exactly one workspace, however many variations it opened",
    calls("workspace.create").length === 1,
    `${String(calls("workspace.create").length)} workspace.create calls`,
  );

  // --- closing a variation closes its tab -----------------------------------
  const closeAt = frames.length;
  socket.send(JSON.stringify({ type: "close_worktree", worktree: wtMain }));
  const stopped = await waitFor("session_stopped for the closed variation", () =>
    frames.slice(closeAt).find((f) => f.type === "session_stopped" && f.worktree === wtMain),
  );
  check("closing a variation stops its harness and says why", stopped.reason.length > 0, stopped.reason);
  // the tab the main session runs in: the root tab that came with the
  // project's workspace, named by herdr rather than guessed at
  const tabOfMain = rootTab;
  const closedTab = await waitFor("the tab.close call for that variation's tab", () =>
    calls("tab.close").find((f) => f.params.tab_id === tabOfMain),
  );
  check(
    "closing a variation closes the terminal tab its harness was opened in",
    closedTab !== undefined,
    `${JSON.stringify(closedTab.params)} for tab ${tabOfMain}`,
  );
  await waitFor("the closed variation's harness process exited", () =>
    jsonl(ompLogIn(target)).some((f) => f.type === "__exit"),
  );
  check("and the harness inside that tab is gone", true);
  const afterClose = await waitFor("a session frame with nothing running", () =>
    frames.slice(closeAt).find((f) => f.type === "session" && f.session.sessions.every((s) => s.worktree !== wtMain)),
  );
  check("and the variation is on the view with no session in it", afterClose.session.worktrees.some((w) => w.id === wtMain));
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
