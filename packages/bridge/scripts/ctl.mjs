#!/usr/bin/env node
/**
 * Bridge control CLI — drives a *running* Shape bridge over its WebSocket, for
 * scripts and skills that need to read what the bridge sees, or mark one of its
 * projects active or inactive, without the web UI. Shape is a read-only
 * picture: nothing here starts a session, prompts one or stops one.
 *
 *   node packages/bridge/scripts/ctl.mjs status
 *   node packages/bridge/scripts/ctl.mjs set-project-status <projectId> <active|inactive>
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
let worktree;
/** the command's own positional arguments, in the order they were given */
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--port") port = Number(argv[++i]);
  else if (a === "--worktree") worktree = argv[++i];
  else if (command === null) command = a;
  else if (rest.length < 2) rest.push(a);
  else out(1, { ok: false, error: `unexpected argument: ${a}` });
}
if (!["status", "set-project-status", "focus-terminal"].includes(command ?? "")) {
  out(1, {
    ok: false,
    error:
      "usage: ctl.mjs [--port <n>] status | set-project-status <projectId> <active|inactive> | focus-terminal [--worktree <id>]",
  });
}
if (!Number.isInteger(port) || port <= 0) out(1, { ok: false, error: "invalid --port" });
const [projectId, wanted] = rest;
if (command === "set-project-status") {
  if (projectId === undefined) out(1, { ok: false, error: "set-project-status needs a project id (`status` lists them)" });
  // the only two states a project has: anything else is a caller inventing one
  if (wanted !== "active" && wanted !== "inactive") {
    out(1, { ok: false, error: "set-project-status needs a status: active or inactive" });
  }
}

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

// Every command starts from the bridge's hello for this connection — except
// `set-project-status`, which must work on a bridge that has nothing to greet
// with: a bridge whose every project is inactive holds no room, and marking one
// active again is exactly the request that fixes that. The socket is open by
// here, so an ungreeted connection is a bridge with no active project, not a
// missing one.
const hello = frames.find((f) => f.type === "hello") ?? (await nextFrame((f) => f.type === "hello", CONNECT_TIMEOUT_MS));
if (!hello && command !== "set-project-status") {
  out(1, { ok: false, error: "the bridge holds no active project to report on" });
}

/**
 * One row of the switcher, as a caller of this CLI needs it: the `projectId`
 * `set-project-status` takes, and what that project is doing.
 */
const summarize = (project) => ({
  projectId: project.projectId,
  label: project.label,
  status: project.status,
  liveSessions: project.liveSessions,
  manager: project.manager,
  caughtUp: project.caughtUp,
});

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
    // the project this connection is watching, and every project the bridge
    // holds for it: their ids are what `set-project-status` is given, and a
    // caller has no other way to learn them
    projectId: hello.projectId,
    projects: hello.projects.map((project) => ({ ...summarize(project), cwd: project.cwd })),
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

if (command === "set-project-status") {
  // The same status again is nothing at all on the wire — the server sends a
  // list only when something moved — so a caller asking for what is already
  // true is answered from the list this connection was greeted with, instead
  // of waiting for a frame nobody is going to send. An ungreeted connection
  // has no list to check it against, and asks.
  const listed = hello ? hello.projects : null;
  const known = listed?.find((project) => project.projectId === projectId) ?? null;
  if (known?.status === wanted) out(0, { ok: true, projects: listed.map(summarize) });
  socket.send(JSON.stringify({ type: "set_project_status", projectId, status: wanted }));
  // Marking a project inactive closes its room and marking it active reopens
  // it from the registry, so the answer is a fresh list — broadcast to every
  // browser of the tenant, this one included. The only refusal there is, an id
  // no project of this tenant has, comes back to this socket alone.
  const result = await nextFrame((f) => f.type === "projects" || f.type === "error", 10_000);
  if (!result) out(1, { ok: false, error: "timed out waiting for the bridge" });
  if (result.type === "error") out(1, { ok: false, error: result.message });
  out(0, { ok: true, projects: result.projects.map(summarize) });
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
