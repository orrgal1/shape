#!/usr/bin/env node
/**
 * Bridge control CLI — drives a *running* Shape bridge over its
 * WebSocket, for scripts/skills that need to retarget the bridge or trigger
 * onboarding without the web UI.
 *
 *   node packages/bridge/scripts/ctl.mjs status
 *   node packages/bridge/scripts/ctl.mjs switch-project <abs-path>
 *   node packages/bridge/scripts/ctl.mjs onboard [--focus "<text>"]
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
let targetPath;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--focus") focus = argv[++i];
  else if (command === null) command = a;
  else if (targetPath === undefined) targetPath = a;
  else out(1, { ok: false, error: `unexpected argument: ${a}` });
}
if (!["status", "switch-project", "onboard"].includes(command ?? "")) {
  out(1, { ok: false, error: "usage: ctl.mjs [--port <n>] status | switch-project <abs-path> | onboard [--focus <text>]" });
}
if (!Number.isInteger(port) || port <= 0) out(1, { ok: false, error: "invalid --port" });
if (command === "switch-project" && !targetPath) out(1, { ok: false, error: "switch-project needs a path" });

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

if (command === "status") {
  const { cwd, sessionName, worktrees, backend } = hello.session;
  out(0, {
    ok: true,
    cwd,
    sessionName,
    backend: backend?.id ?? null,
    capabilities: backend?.capabilities ?? null,
    nodes: hello.graph.nodes.length,
    worktrees,
  });
}

if (command === "switch-project") {
  socket.send(JSON.stringify({ type: "switch_project", path: targetPath }));
  // retarget = dispose omp, re-extract reality, fresh omp, then re-hello — allow time
  const result = await nextFrame((f) => f.type === "hello" || isRejection("switch_project rejected")(f), 60_000);
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge to re-hello" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  out(0, { ok: true, cwd: result.session.cwd });
}

if (command === "onboard") {
  socket.send(JSON.stringify({ type: "onboard", ...(focus !== undefined ? { focus } : {}) }));
  // accepted = no prompt rejection; don't wait for the survey turn itself
  const rejection = await nextFrame(isRejection("onboard rejected"), 1500);
  if (rejection) out(1, { ok: false, error: rejection.message });
  out(0, { ok: true });
}
