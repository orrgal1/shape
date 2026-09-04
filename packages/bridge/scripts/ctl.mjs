#!/usr/bin/env node
/**
 * Bridge control CLI — drives a *running* Shape bridge over its
 * WebSocket, for scripts/skills that need to retarget the bridge or trigger
 * onboarding without the web UI.
 *
 *   node packages/bridge/scripts/ctl.mjs status
 *   node packages/bridge/scripts/ctl.mjs switch-project <abs-path>
 *   node packages/bridge/scripts/ctl.mjs create-project <abs-path> [--public|--private]
 *   node packages/bridge/scripts/ctl.mjs onboard [--focus "<text>"] [--worktree <id>]
 *   node packages/bridge/scripts/ctl.mjs open-worktree <abs-path> [--backend <id>] [--autonomous] [--remember]
 *   node packages/bridge/scripts/ctl.mjs focus-terminal [--worktree <id>]
 *
 * A repo's variations each have their own canvas, so a command that acts on one
 * takes `--worktree <id>` (an id `status` lists); without it the main worktree —
 * the one the project's path names — is the target.
 *
 * Global: --port <n> (default 4400). One JSON line on stdout.
 * Exit codes: 0 ok; 1 bridge rejected the request; 2 no bridge listening.
 */

import WebSocket from "ws";

// defaults mirror BRIDGE_PORT / BRIDGE_WS_PATH in packages/shared/src/index.ts
const DEFAULT_PORT = 4400;
const WS_PATH = "/ws";
const CONNECT_TIMEOUT_MS = 3000;

function out(code, obj) {
  console.log(JSON.stringify(obj));
  process.exit(code);
}

// --- argv ------------------------------------------------------------------
const argv = process.argv.slice(2);
let command = null;
let port = DEFAULT_PORT;
let focus;
let worktree;
let targetPath;
let visibility = null;
/** `--backend <id>`: which harness `open-worktree` starts, beating every configured default */
let backend;
/** `--autonomous`: start it deciding for itself (launch-time only, like the card) */
let autonomous = false;
/** `--remember`: write the chosen harness to the worktree's `.shape/config.json` */
let remember = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--focus") focus = argv[++i];
  else if (a === "--worktree") worktree = argv[++i];
  else if (a === "--public" || a === "--private") visibility = a.slice(2);
  else if (a === "--backend") backend = argv[++i];
  else if (a === "--autonomous") autonomous = true;
  else if (a === "--remember") remember = true;
  else if (command === null) command = a;
  else if (targetPath === undefined) targetPath = a;
  else out(1, { ok: false, error: `unexpected argument: ${a}` });
}
if (
  !["status", "switch-project", "create-project", "onboard", "open-worktree", "focus-terminal", "discover", "adopt"].includes(
    command ?? "",
  )
) {
  out(1, {
    ok: false,
    error:
      "usage: ctl.mjs [--port <n>] status | switch-project <abs-path> | create-project <abs-path> [--public|--private] | onboard [--focus <text>] [--worktree <id>] | open-worktree <abs-path> [--backend <id>] [--autonomous] [--remember] | focus-terminal [--worktree <id>] | discover | adopt <pid>",
  });
}
if (!Number.isInteger(port) || port <= 0) out(1, { ok: false, error: "invalid --port" });
if (command === "switch-project" && !targetPath) out(1, { ok: false, error: "switch-project needs a path" });
if (command === "create-project" && !targetPath) out(1, { ok: false, error: "create-project needs a path" });
if (command === "open-worktree" && !targetPath) out(1, { ok: false, error: "open-worktree needs a path" });
if (command === "adopt" && !/^\d+$/.test(targetPath ?? "")) out(1, { ok: false, error: "adopt needs a pid" });

// --- connection ------------------------------------------------------------
const frames = [];
const waiters = []; // { predicate, resolve }
const socket = new WebSocket(`ws://localhost:${port}${WS_PATH}`, { handshakeTimeout: CONNECT_TIMEOUT_MS });

const noBridge = () => out(2, { ok: false, error: "no bridge" });
socket.on("error", noBridge);
socket.on("close", noBridge);
const connectDeadline = setTimeout(noBridge, CONNECT_TIMEOUT_MS);

socket.on("message", (data) => {
  const frame = JSON.parse(data.toString());
  frames.push(frame);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].predicate(frame)) waiters.splice(i, 1)[0].resolve(frame);
  }
});

/** next frame (from now on) matching predicate, or null on timeout */
function nextFrame(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const waiter = { predicate, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) {
        waiters.splice(i, 1);
        resolve(null);
      }
    }, timeoutMs).unref();
  });
}

await new Promise((resolve) => socket.once("open", resolve));
clearTimeout(connectDeadline);

// every command starts from the bridge's hello for this connection
const hello = frames.find((f) => f.type === "hello") ?? (await nextFrame((f) => f.type === "hello", CONNECT_TIMEOUT_MS));
if (!hello) out(2, { ok: false, error: "no bridge" });

const isRejection = (prefix) => (f) => f.type === "error" && f.message.startsWith(prefix);

/**
 * The variation a scoped command acts on: `--worktree` (an id, a path or a
 * branch name), else the main worktree — the one the project's path names.
 */
function targetWorktree(session) {
  const listed = session.worktrees;
  if (worktree !== undefined) {
    const named = listed.find((w) => w.id === worktree || w.path === worktree || w.branch === worktree);
    if (!named) out(1, { ok: false, error: `unknown variation ${worktree}` });
    return named.id;
  }
  const main = listed.find((w) => w.path === session.cwd) ?? listed[0];
  if (!main) out(1, { ok: false, error: "the bridge lists no variations for this project" });
  return main.id;
}

if (command === "status") {
  const { cwd, worktrees, sessions, agentConnected } = hello.session;
  const main = worktrees.find((w) => w.path === cwd) ?? worktrees[0] ?? null;
  out(0, {
    ok: true,
    cwd,
    agentConnected,
    // how this project starts a harness, and what it has to start: a script
    // that means to open a variation needs to know what it may ask for
    launcher: hello.tools?.launcher ?? null,
    harnesses: (hello.tools?.harnesses ?? []).map((t) => t.id),
    // what "is this repo mapped yet" means: the main variation's canvas
    nodes: main === null ? 0 : (hello.graphs[main.id]?.nodes.length ?? 0),
    worktrees: worktrees.map((w) => {
      const running = sessions.find((s) => s.worktree === w.id) ?? null;
      return {
        id: w.id,
        path: w.path,
        branch: w.branch,
        main: main !== null && w.id === main.id,
        nodes: hello.graphs[w.id]?.nodes.length ?? 0,
        running: running !== null,
        sessionId: running?.session.sessionId ?? null,
        sessionName: running?.session.sessionName ?? null,
        backend: running?.backend.id ?? null,
        capabilities: running?.backend.capabilities ?? null,
        agent: hello.agents[w.id] ?? null,
      };
    }),
  });
}

/**
 * A retarget re-hellos. But a path that turns out to be a variation of the
 * project the bridge is already on is no retarget at all: the agent opens a
 * harness there and announces it. Both settle the command.
 */
const retargeted = (rejects) => (f) =>
  f.type === "hello" || f.type === "session_started" || (f.type === "error" && rejects.test(f.message));

/** what a settled retarget is reported as; a variation names itself too */
const landedOn = (result) =>
  result.type === "hello"
    ? { ok: true, cwd: result.session.cwd }
    : { ok: true, cwd: hello.session.cwd, worktree: result.worktree };

if (command === "switch-project") {
  socket.send(JSON.stringify({ type: "switch_project", path: targetPath }));
  // retarget = dispose every harness, re-extract reality, fresh harness, then
  // re-hello — allow time
  const result = await nextFrame(retargeted(/^(switch_project rejected|open_worktree)/), 60_000);
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  out(0, landedOn(result));
}

if (command === "create-project") {
  socket.send(
    JSON.stringify({
      type: "create_project",
      path: targetPath,
      github: visibility === null ? null : { visibility },
    }),
  );
  // create = mkdir + git + (optionally) gh, then the same retarget as a switch
  const result = await nextFrame(retargeted(/^(create_project|open_worktree)/), 90_000);
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  out(0, landedOn(result));
}

if (command === "onboard") {
  socket.send(
    JSON.stringify({ type: "onboard", worktree: targetWorktree(hello.session), ...(focus !== undefined ? { focus } : {}) }),
  );
  // accepted = no rejection; don't wait for the survey turn itself. A variation
  // with no harness in it refuses in its own words, not with an "onboard
  // rejected" prefix — both are this command failing.
  const rejection = await nextFrame(
    (f) => f.type === "error" && (f.message.startsWith("onboard rejected") || f.message.startsWith("no session is running on")),
    1500,
  );
  if (rejection) out(1, { ok: false, error: rejection.message });
  out(0, { ok: true });
}

if (command === "open-worktree") {
  socket.send(
    JSON.stringify({
      type: "open_worktree",
      path: targetPath,
      // absent means "let the agent resolve it" — the config files, its flag,
      // or the single harness it detected; naming one here beats all of them
      ...(backend !== undefined ? { backend } : {}),
      ...(autonomous ? { autonomous: true } : {}),
      ...(remember ? { remember: true } : {}),
    }),
  );
  // starting a harness is a real launch (a terminal, a TUI, a first prompt):
  // the same budget the room gives an open before it stops serializing them
  const result = await nextFrame(
    (f) => f.type === "session_started" || (f.type === "error" && /^(open_worktree|no harness|there is nothing)/.test(f.message)),
    60_000,
  );
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  out(0, {
    ok: true,
    worktree: result.worktree,
    backend: result.backend.id,
    terminal: result.backend.capabilities.terminal,
    sessionId: result.session.sessionId,
  });
}

if (command === "focus-terminal") {
  const target = targetWorktree(hello.session);
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: target }));
  // Two honest outcomes: Shape owns the pty and answers with the frame that
  // opens the drawer, or the harness lives in the user's own terminal and was
  // focused there, which is silence on this wire. A refusal is neither.
  const result = await nextFrame(
    (f) =>
      (f.type === "terminal" && f.worktree === target) ||
      (f.type === "error" &&
        /^(no session is running on|there is no terminal to go to|could not bring the terminal forward)/.test(f.message)),
    3000,
  );
  if (result?.type === "error") out(1, { ok: false, error: result.message });
  const running = hello.session.sessions.find((s) => s.worktree === target) ?? null;
  out(0, {
    ok: true,
    worktree: target,
    terminal: running?.backend.capabilities.terminal ?? null,
    // the drawer was asked for; a harness in its own terminal never asks
    opened: result !== null && result.open === true,
  });
}

if (command === "discover") {
  socket.send(JSON.stringify({ type: "discover" }));
  // a scan is `ps` + a walk of every harness's session store
  const result = await nextFrame((f) => f.type === "sessions", 10_000);
  if (!result) out(1, { ok: false, error: "timed out waiting for a sessions frame" });
  out(0, {
    ok: true,
    count: result.sessions.length,
    sessions: result.sessions.map((s) => ({
      harness: s.harness,
      pid: s.pid,
      cwd: s.cwd,
      sessionId: s.sessionId,
      startedAt: s.startedAt,
      attach: s.attach,
    })),
  });
}

if (command === "adopt") {
  socket.send(JSON.stringify({ type: "adopt", pid: Number(targetPath) }));
  // adopt = a project switch with a backend override: same budget as switch-project
  const result = await nextFrame(
    (f) => f.type === "hello" || (f.type === "error" && /^(adopt rejected|no Shape adapter|switch_project)/.test(f.message)),
    60_000,
  );
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge to re-hello" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  const running = result.session.sessions[0] ?? null;
  out(0, {
    ok: true,
    cwd: result.session.cwd,
    backend: running?.backend.id ?? null,
    sessionId: running?.session.sessionId ?? null,
  });
}
