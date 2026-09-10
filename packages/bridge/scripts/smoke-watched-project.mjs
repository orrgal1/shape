#!/usr/bin/env node
/**
 * Focused #33 smoke: a browser on a standalone server asks its remote root
 * agent for a directory and gets a separately linked observation-only project.
 * The chooser, herdr launcher and manager executable are hostile fakes;
 * repositories, split server/agent processes, WebSockets and SQLite are real.
 *
 * Usage (from packages/bridge): node scripts/smoke-watched-project.mjs
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const results = [];
let failed = 0;

function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function seedRepo(dir, branch) {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: basename(dir), private: true }, null, 2)}\n`);
  await writeFile(join(dir, "src", "index.ts"), "export const watched = true;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", branch);
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "seed");
}

async function fingerprint(root) {
  const rows = [];
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (entry.isDirectory()) {
        rows.push(`d ${rel} ${info.mode.toString(8)}`);
        await walk(path, rel);
      } else if (entry.isSymbolicLink()) {
        rows.push(`l ${rel} ${await readlink(path)}`);
      } else {
        const digest = createHash("sha256").update(await readFile(path)).digest("hex");
        rows.push(`f ${rel} ${info.mode.toString(8)} ${digest}`);
      }
    }
  }
  await walk(root, "");
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

function registry(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT key, project, worktrees, sessions, status FROM projects ORDER BY key").all().map((row) => ({
      key: String(row.key),
      project: JSON.parse(String(row.project)),
      worktrees: JSON.parse(String(row.worktrees)),
      sessions: JSON.parse(String(row.sessions)),
      status: String(row.status),
    }));
  } finally {
    db.close();
  }
}

async function connectSocket(port, frames) {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

let herdrSeq = 0;
function herdrCall(socketPath, method, params = {}) {
  const socket = createConnection(socketPath);
  const { promise, resolve, reject } = Promise.withResolvers();
  let buffer = "";
  socket.setEncoding("utf8");
  socket.once("connect", () => {
    socket.write(`${JSON.stringify({ id: `smoke-${++herdrSeq}`, method, params })}\n`);
  });
  socket.on("data", (chunk) => {
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    const frame = JSON.parse(buffer.slice(0, nl));
    socket.destroy();
    if (frame.error) reject(new Error(frame.error.message));
    else resolve(frame.result);
  });
  socket.once("error", reject);
  return promise;
}

async function jsonl(file) {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const root = await mkdtemp(join(tmpdir(), "shape-watched-project-"));
const repoA = join(root, "current");
const repoB = join(root, "picked project ");
const nonRepo = join(root, "not-git");
const home = join(root, "home");
const dataDir = join(root, "server-data");
const dbFile = join(dataDir, "shape.db");
const pickerState = join(root, "picker.json");
const pickerLog = join(root, "picker.log");
const herdrSocket = join(root, "herdr.sock");
const herdrLog = join(root, "herdr.log");
const mgrLog = join(root, "mgr.log");
const fakeMgr = join(root, "mgr");
await mkdir(repoA);
await mkdir(repoB);
await mkdir(nonRepo);
await mkdir(home);
await mkdir(dataDir);
await seedRepo(repoA, "current-smoke");
await seedRepo(repoB, "picked-smoke");
await writeFile(join(nonRepo, "plain.txt"), "not a repository\n");
await writeFile(
  fakeMgr,
  `#!${process.execPath}\nconst { appendFileSync } = require("node:fs");\nappendFileSync(process.env.FAKE_MGR_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");\nprocess.exit(23);\n`,
);
await chmod(fakeMgr, 0o755);

const pathA = await realpath(repoA);
const pathB = await realpath(repoB);
const pathNonRepo = await realpath(nonRepo);
const before = {
  a: await fingerprint(pathA),
  b: await fingerprint(pathB),
  nonRepo: await fingerprint(pathNonRepo),
};
await writeFile(
  pickerState,
  JSON.stringify([{ hang: pickerLog }, null, pathB, pathB, pathB, join(root, "missing"), pathNonRepo]),
);

const picker = fileURLToPath(new URL("./fake-directory-picker.mjs", import.meta.url));
const serverPort = await freePort();
const linkPort = await freePort();
const frames = [];
const observerFrames = [];
let server = null;
let agent = null;
let herdr = null;
let socket = null;
let observer = null;
let canceller = null;
let linkedSession = null;
let stderr = "";

function launchAgent() {
  const child = spawn(
    process.execPath,
    ["src/agent-cli.ts", "--server", `ws://127.0.0.1:${String(serverPort)}`, "--cwd", pathA, "--link-port", String(linkPort)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        SHAPE_HOME: home,
        SHAPE_AUTO_MAP: "0",
        SHAPE_FORCE_HARNESSES: "omp",
        SHAPE_FORCE_LAUNCHERS: "herdr",
        SHAPE_LAUNCHER: "herdr",
        HERDR_SOCKET_PATH: herdrSocket,
        FAKE_MGR_LOG: mgrLog,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        SHAPE_PICK_FOLDER: `${process.execPath} ${picker} ${pickerState}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.output = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    child.output += chunk;
    stderr += chunk;
  });
  return child;
}
try {
  herdr = spawn(process.execPath, ["scripts/fake-herdr.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HERDR_SOCKET_PATH: herdrSocket,
      FAKE_HERDR_LOG: herdrLog,
      FAKE_HERDR_REFUSE_SHAPE_MUTATIONS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let herdrReady = "";
  herdr.stdout.setEncoding("utf8");
  herdr.stdout.on("data", (chunk) => {
    herdrReady += chunk;
  });
  await waitFor("fake launcher listening", () => herdrReady.includes('"type":"ready"'));
  const rootWorkspace = await herdrCall(herdrSocket, "workspace.create", {
    label: basename(pathA),
    cwd: pathA,
    focus: false,
  });
  await herdrCall(herdrSocket, "tab.rename", {
    tab_id: rootWorkspace.tab.tab_id,
    label: "manager",
  });
  await herdrCall(herdrSocket, "agent.start", {
    pane_id: rootWorkspace.root_pane.pane_id,
    name: "manager",
    kind: "omp",
    args: [],
  });

  server = spawn(process.execPath, ["src/server-cli.ts", "--port", String(serverPort), "--data-dir", dataDir], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, SHAPE_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await waitFor("server listening", () => stderr.includes("server at ws://"));

  agent = launchAgent();
  await waitFor("remote agent attached", () => agent.output.includes("agent attached to"));
  const launcherReadsBeforeWatched = (await jsonl(herdrLog)).filter(
    (frame) =>
      frame.type === "__call" &&
      !String(frame.id).startsWith("smoke-") &&
      ["workspace.list", "tab.list", "agent.list"].includes(frame.method),
  ).length;

  socket = await connectSocket(serverPort, frames);
  const initial = await waitFor("capable current project hello", () =>
    frames.find((frame) =>
      frame.type === "hello" && frame.session.cwd === pathA && frame.session.agentConnected && frame.tools.directoryPicker === true,
    ),
  );
  const keyA = initial.projectId;
  observer = await connectSocket(serverPort, observerFrames);
  await waitFor("second browser on current project", () => observerFrames.some((frame) => frame.type === "hello" && frame.projectId === keyA));

  const abandonedFrames = [];
  const rowsBeforeAbandon = registry(dbFile);
  canceller = await connectSocket(serverPort, abandonedFrames);
  canceller.send(JSON.stringify({ type: "add_watched_project" }));
  await waitFor("hanging chooser started", async () => {
    try {
      return (await readFile(pickerLog, "utf8")).includes("started");
    } catch {
      return false;
    }
  });
  canceller.close();
  await waitFor("abandoned chooser terminated", async () => {
    try {
      return (await readFile(pickerLog, "utf8")).includes("terminated");
    } catch {
      return false;
    }
  });
  check(
    "closing the requesting browser cancels and kills its chooser without registry mutation",
    JSON.stringify(registry(dbFile)) === JSON.stringify(rowsBeforeAbandon),
    JSON.stringify(registry(dbFile)),
  );

  const cancelledAt = frames.length;
  const rowsBeforeCancel = registry(dbFile);
  socket.send(JSON.stringify({ type: "add_watched_project" }));
  await waitFor("picker cancellation", () => frames.slice(cancelledAt).find((frame) => frame.type === "watched_project_add_cancelled"));
  await sleep(100);
  const afterCancel = frames.slice(cancelledAt);
  const rowsAfterCancel = registry(dbFile);
  check(
    "cancel answers only with watched_project_add_cancelled",
    afterCancel.filter((frame) => frame.type === "watched_project_add_cancelled").length === 1 &&
      !afterCancel.some((frame) => frame.type === "hello" || frame.type === "projects" || frame.type === "error"),
    JSON.stringify(afterCancel.map((frame) => frame.type)),
  );
  check(
    "cancel is a true registry no-op",
    JSON.stringify(rowsAfterCancel) === JSON.stringify(rowsBeforeCancel) && !rowsAfterCancel.some((row) => row.project.cwd === pathB),
    JSON.stringify(rowsAfterCancel),
  );

  const addedAt = frames.length;
  const observerAt = observerFrames.length;
  socket.send(JSON.stringify({ type: "add_watched_project" }));
  const pickedHello = await waitFor("picked project hello", () =>
    frames.slice(addedAt).find((frame) => frame.type === "hello" && frame.session.cwd === pathB),
  );
  const keyB = pickedHello.projectId;
  const addedProjects = await waitFor("picked project broadcast", () =>
    frames.slice(addedAt).find((frame) => frame.type === "projects" && frame.projects.some((project) => project.projectId === keyB)),
  );
  const pickedRow = registry(dbFile).find((row) => row.key === keyB);
  check(
    "success registers the whitespace-preserving canonical path with read-only provenance",
    pickedRow?.status === "active" &&
      pickedRow.project.cwd === pathB &&
      pickedRow.project.label === basename(pathB) &&
      pickedRow.project.observationOnly === true &&
      pickedRow.project.watcherKey === keyA &&
      pickedRow.sessions.length === 0 &&
      pickedRow.worktrees.length === 1 &&
      pickedRow.worktrees[0].id === pathB,
    JSON.stringify(pickedRow),
  );
  check(
    "success selects only the requesting browser with a fresh hello",
    pickedHello.session.sessions.length === 0 &&
      !observerFrames.slice(observerAt).some((frame) => frame.type === "hello" && frame.projectId === keyB),
    JSON.stringify(observerFrames.slice(observerAt).map((frame) => `${frame.type}:${frame.projectId ?? ""}`)),
  );
  check(
    "success broadcasts the new project list",
    addedProjects.projects.some((project) => project.projectId === keyA) &&
      addedProjects.projects.some((project) => project.projectId === keyB && project.status === "active"),
    JSON.stringify(addedProjects.projects),
  );
  const activePicked = await waitFor("picked project observation active", () =>
    frames.slice(addedAt).find((frame) =>
      frame.type === "hello" &&
      frame.projectId === keyB &&
      frame.session.agentConnected &&
      frame.tools.directoryPicker === true &&
      frame.tools.launcher === null &&
      frame.session.manager === null &&
      frame.session.sessions.length === 0,
    ),
  );
  const launcherCallsAfterFirstWatch = (await jsonl(herdrLog)).filter(
    (frame) => frame.type === "__call" && !String(frame.id).startsWith("smoke-"),
  );
  const managerCallsAfterFirstWatch = await jsonl(mgrLog);
  check(
    "the split server waits for a separate observation-only runtime without inspecting its manager",
    activePicked.session.agentConnected &&
      activePicked.tools.launcher === null &&
      launcherCallsAfterFirstWatch.filter((frame) =>
        ["workspace.list", "tab.list", "agent.list"].includes(frame.method),
      ).length === launcherReadsBeforeWatched &&
      managerCallsAfterFirstWatch.some((call) => call.cwd === pathA) &&
      managerCallsAfterFirstWatch.every((call) => call.cwd !== pathB),
    JSON.stringify({ activePicked, launcherCallsAfterFirstWatch, managerCallsAfterFirstWatch }),
  );

  const repeatedAt = frames.length;
  socket.send(JSON.stringify({ type: "add_watched_project" }));
  await waitFor("idempotent re-add hello", () =>
    frames.slice(repeatedAt).find((frame) => frame.type === "hello" && frame.projectId === keyB),
  );
  await waitFor("idempotent re-add project broadcast", () =>
    frames.slice(repeatedAt).find((frame) =>
      frame.type === "projects" && frame.projects.some((project) => project.projectId === keyB),
    ),
  );
  const repeatedRows = registry(dbFile);
  const repeated = repeatedRows.find((row) => row.key === keyB);
  check(
    "re-adding an active project is idempotent without creating a watcher cycle",
    repeatedRows.filter((row) => row.key === keyB).length === 1 &&
      repeated.project.watcherKey === keyA &&
      repeated.worktrees.length === new Set(repeated.worktrees.map((worktree) => worktree.id)).size,
    JSON.stringify(repeated),
  );

  const workspace = await herdrCall(herdrSocket, "workspace.create", {
    label: basename(pathB),
    cwd: pathB,
    focus: false,
  });
  await herdrCall(herdrSocket, "tab.rename", {
    tab_id: workspace.tab.tab_id,
    label: "manager",
  });
  await herdrCall(herdrSocket, "agent.start", {
    pane_id: workspace.root_pane.pane_id,
    name: "manager",
    kind: "omp",
    args: [],
  });
  const launcherReadsBeforeReactivation = (await jsonl(herdrLog)).filter(
    (frame) =>
      frame.type === "__call" &&
      !String(frame.id).startsWith("smoke-") &&
      ["workspace.list", "tab.list", "agent.list"].includes(frame.method),
  ).length;

  const parkedAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: keyB, status: "inactive" }));
  await waitFor("picked project parked", () =>
    frames.slice(parkedAt).find((frame) =>
      frame.type === "projects" && frame.projects.some((project) => project.projectId === keyB && project.status === "inactive"),
    ),
  );
  await waitFor("requester returned to current project", () =>
    frames.slice(parkedAt).find((frame) => frame.type === "hello" && frame.projectId === keyA),
  );

  const reactivatedAt = frames.length;
  socket.send(JSON.stringify({ type: "add_watched_project" }));
  await waitFor("reactivated project hello", () =>
    frames.slice(reactivatedAt).find((frame) => frame.type === "hello" && frame.projectId === keyB),
  );
  await waitFor("reactivated project broadcast", () =>
    frames.slice(reactivatedAt).find((frame) =>
      frame.type === "projects" && frame.projects.some((project) => project.projectId === keyB && project.status === "active"),
    ),
  );
  const reactivatedRows = registry(dbFile);
  check(
    "re-adding an inactive project reactivates its one existing row",
    reactivatedRows.filter((row) => row.key === keyB).length === 1 &&
      reactivatedRows.find((row) => row.key === keyB)?.status === "active",
    JSON.stringify(reactivatedRows),
  );
  await waitFor("reactivated project observation active", () =>
    frames.slice(reactivatedAt).find((frame) =>
      frame.type === "hello" &&
      frame.projectId === keyB &&
      frame.session.agentConnected &&
      frame.tools.directoryPicker === true,
    ),
  );

  const launcherLogAfterReactivation = await jsonl(herdrLog);
  const bridgeLauncherCalls = launcherLogAfterReactivation.filter(
    (frame) => frame.type === "__call" && !String(frame.id).startsWith("smoke-"),
  );
  const managerCallsAfterReactivation = await jsonl(mgrLog);
  check(
    "reactivation keeps provenance and never inspects or configures the present manager",
    registry(dbFile).find((row) => row.key === keyB)?.project.observationOnly === true &&
      bridgeLauncherCalls.filter((frame) =>
        ["workspace.list", "tab.list", "agent.list"].includes(frame.method),
      ).length === launcherReadsBeforeReactivation &&
      managerCallsAfterReactivation.some((call) => call.cwd === pathA) &&
      managerCallsAfterReactivation.every((call) => call.cwd !== pathB),
    JSON.stringify({ bridgeLauncherCalls, managerCallsAfterReactivation }),
  );

  linkedSession = new WebSocket(`ws://127.0.0.1:${String(linkPort)}/link`);
  await new Promise((resolve, reject) => {
    linkedSession.once("open", resolve);
    linkedSession.once("error", reject);
  });
  linkedSession.send(
    JSON.stringify({
      type: "hello",
      cwd: pathB,
      harness: "omp",
      sessionId: "watched-session",
      sessionFile: null,
      model: null,
      capabilities: { steer: true, tool: true },
    }),
  );
  const watchedSession = await waitFor("watched session reported without a terminal", () =>
    frames.find(
      (frame) =>
        frame.type === "session_started" &&
        frame.worktree === pathB &&
        frame.backend.capabilities.terminal === "none",
    ),
  );
  const focusAt = frames.length;
  socket.send(JSON.stringify({ type: "focus_terminal", worktree: pathB }));
  await waitFor("observation-only focus refusal", () =>
    frames.slice(focusAt).find((frame) => frame.type === "error" && frame.message.includes("no terminal")),
  );
  const finalLauncherCalls = (await jsonl(herdrLog)).filter(
    (frame) => frame.type === "__call" && !String(frame.id).startsWith("smoke-"),
  );
  check(
    "a watched session exposes no focusable terminal and causes no prompt, launch, or focus",
    watchedSession.backend.capabilities.terminal === "none" &&
      !finalLauncherCalls.some((frame) =>
        ["agent.prompt", "agent.start", "agent.focus", "tab.focus"].includes(frame.method),
      ),
    JSON.stringify(finalLauncherCalls),
  );

  linkedSession.close();
  linkedSession = null;
  const restartedAt = frames.length;
  agent.kill("SIGTERM");
  if (agent.exitCode === null) await new Promise((resolve) => agent.once("exit", resolve));
  agent = launchAgent();
  await waitFor("root agent reattached after restart", () => agent.output.includes("agent attached to"));
  const restoredHello = await waitFor("watched runtime restored through its originating agent", () =>
    frames.slice(restartedAt).find(
      (frame) =>
        frame.type === "hello" &&
        frame.projectId === keyB &&
        frame.session.agentConnected &&
        frame.tools.launcher === null,
    ),
  );
  const restartLauncherCalls = await jsonl(herdrLog);
  const managerCallsAfterRestart = await jsonl(mgrLog);
  check(
    "agent restart recreates the separate read-only watched runtime from persisted provenance",
    registry(dbFile).find((row) => row.key === keyB)?.project.observationOnly === true &&
      restoredHello.session.manager === null &&
      managerCallsAfterRestart.some((call) => call.cwd === pathA) &&
      managerCallsAfterRestart.every((call) => call.cwd !== pathB) &&
      !restartLauncherCalls.some(
        (frame) =>
          frame.type === "__call" &&
          !String(frame.id).startsWith("smoke-") &&
          ["agent.prompt", "agent.start", "agent.focus", "tab.focus"].includes(frame.method),
      ),
    JSON.stringify({
      row: registry(dbFile).find((row) => row.key === keyB),
      restoredHello,
      managerCallsAfterRestart,
    }),
  );

  async function rejectSelection(label, message) {
    const rejectedAt = frames.length;
    const beforeRejected = JSON.stringify(registry(dbFile));
    socket.send(JSON.stringify({ type: "add_watched_project" }));
    const rejected = await waitFor(`${label} picker error`, () =>
      frames.slice(rejectedAt).find((frame) => frame.type === "error" && frame.message.includes(message)),
    );
    await sleep(100);
    check(
      `${label} returns the existing structured error frame`,
      rejected.type === "error" && rejected.message.startsWith("pick_directory failed:"),
      JSON.stringify(rejected),
    );
    check(
      `${label} does not mutate or broadcast the registry`,
      JSON.stringify(registry(dbFile)) === beforeRejected &&
        !frames.slice(rejectedAt).some((frame) => frame.type === "hello" || frame.type === "projects"),
      JSON.stringify(frames.slice(rejectedAt).map((frame) => frame.type)),
    );
  }

  await rejectSelection("a missing path", "not readable");
  await rejectSelection("a non-project directory", "not a Git project");
  const after = {
    a: await fingerprint(pathA),
    b: await fingerprint(pathB),
    nonRepo: await fingerprint(pathNonRepo),
  };
  check(
    "watching, re-adding and rejecting projects does not mutate any selected repository",
    JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify({ before, after }),
  );
} catch (err) {
  check("watched-project smoke completed", false, err instanceof Error ? `${err.message}\n${err.stack ?? ""}\n${stderr}` : String(err));
} finally {
  linkedSession?.close();
  canceller?.close();
  socket?.close();
  observer?.close();
  for (const child of [agent, server, herdr]) {
    child?.kill("SIGTERM");
    if (child !== null && child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  await rm(root, { recursive: true, force: true });
}

for (const result of results) console.log(result);
console.log(`\n${String(results.length - failed)} passed, ${String(failed)} failed`);
if (failed > 0) process.exitCode = 1;
