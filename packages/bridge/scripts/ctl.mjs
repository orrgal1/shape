#!/usr/bin/env node
/**
 * Bridge control CLI — drives a *running* Shape bridge over its WebSocket, for
 * scripts and skills that need to read what the bridge sees, or point it at
 * another project, without the web UI. Shape is a read-only picture: nothing
 * here starts a session, prompts one or stops one.
 *
 *   node packages/bridge/scripts/ctl.mjs status
 *   node packages/bridge/scripts/ctl.mjs switch-project <abs-path>
 *   node packages/bridge/scripts/ctl.mjs focus-terminal [--worktree <id>]
 *   node packages/bridge/scripts/ctl.mjs discover
 *   node packages/bridge/scripts/ctl.mjs adopt <pid>
 *
 * A repo's variations each have their own canvas, so a command that acts on one
 * takes `--worktree <id>` (an id `status` lists); without it the main worktree —
 * the one the project's path names — is the target.
 *
 * Global: --port <n> (default 4400). One JSON line on stdout.
 * Exit codes: 0 ok; 1 bridge rejected the request; 2 no bridge listening.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
let worktree;
let targetPath;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--worktree") worktree = argv[++i];
  else if (command === null) command = a;
  else if (targetPath === undefined) targetPath = a;
  else out(1, { ok: false, error: `unexpected argument: ${a}` });
}
if (!["status", "switch-project", "focus-terminal", "discover", "adopt"].includes(command ?? "")) {
  out(1, {
    ok: false,
    error:
      "usage: ctl.mjs [--port <n>] status | switch-project <abs-path> | focus-terminal [--worktree <id>] | discover | adopt <pid>",
  });
}
if (!Number.isInteger(port) || port <= 0) out(1, { ok: false, error: "invalid --port" });
if (command === "switch-project" && !targetPath) out(1, { ok: false, error: "switch-project needs a path" });
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

/** the bridge lists worktrees by realpath; a path only compares to them resolved the same way */
const realpath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

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
    // whether Shape can take the user to a session's own terminal here, and
    // which harnesses are installed where the agent runs
    launcher: hello.tools?.launcher ?? "none",
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

if (command === "switch-project") {
  // A path inside the project the bridge is already on is a VARIATION, not a
  // retarget: nothing is dropped and nothing is opened, the agent only
  // refreshes its worktree list, and the room reports that as a fresh
  // `session`. Another repo is the real switch, and it re-hellos — so which
  // frame settles this command depends on which of the two was asked for.
  const asked = realpath(resolve(targetPath));
  const variation = hello.session.worktrees.some((w) => asked === w.path || asked.startsWith(`${w.path}/`));
  socket.send(JSON.stringify({ type: "switch_project", path: targetPath }));
  // a retarget forgets every observed session, opens the new project and
  // re-extracts its reality before it re-attaches — allow time
  const result = await nextFrame(
    (f) => f.type === "hello" || (variation && f.type === "session") || (f.type === "error" && /^switch_project/.test(f.message)),
    60_000,
  );
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  out(0, { ok: true, cwd: result.session.cwd });
}

if (command === "focus-terminal") {
  const target = targetWorktree(hello.session);
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: target }));
  // Shape owns no terminal to answer with: under herdr the session's own tab
  // is switched to and the terminal app raised, which is silence on this
  // wire. The only thing worth waiting for is a refusal.
  const rejection = await nextFrame(
    (f) =>
      f.type === "error" &&
      /^(nothing is reporting in from|there is no terminal to go to|could not bring the terminal forward|.* is not a variation of this project)/.test(
        f.message,
      ),
    2000,
  );
  if (rejection) out(1, { ok: false, error: rejection.message });
  const running = hello.session.sessions.find((s) => s.worktree === target) ?? null;
  out(0, { ok: true, worktree: target, terminal: running?.backend.capabilities.terminal ?? null });
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
  // adopt is a project switch onto the directory that session runs in, and
  // nothing else: the same budget as switch-project. A session already inside
  // this repo ends in a refreshed `session` frame rather than a new hello.
  const result = await nextFrame(
    (f) =>
      f.type === "hello" ||
      f.type === "session" ||
      (f.type === "error" && /^(adopt rejected|switch_project)/.test(f.message)),
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
