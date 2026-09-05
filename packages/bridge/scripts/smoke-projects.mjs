#!/usr/bin/env node
/**
 * Project-registry smoke test, against the REAL bridge and the REAL herdr on
 * this machine (#28). Nothing here is faked, because the thing under test is
 * exactly the join between the two: a repo is a project because a session is
 * running in it, and the browser's only say over a project is whether it is
 * active.
 *
 * Two throwaway repos in /tmp. A gets a workspace in the user's herdr with a
 * tab running in it; B gets nothing at all. Then a bridge with NO `--cwd`, so
 * the registry and the scan are the whole source of what it knows:
 *   discovered   — A is an ACTIVE project with one live session, and B is not
 *                  a project at all: nobody is working in it, and Shape does
 *                  not go looking for repos on disk
 *   stored       — that project is a row in the database, marked active
 *   inactive     — `set_project_status inactive` empties the switcher's active
 *                  half of it, closes its room (the runtime is told why and
 *                  goes away), refuses a `select_project` for it, and writes
 *                  the status down
 *   active again — flipping it back reopens the room from the row, and
 *                  `select_project` answers with a hello whose worktrees are
 *                  A's: no data was lost by parking it
 *   untouched    — the herdr tab is exactly as it was. Shape reads the user's
 *                  terminal and writes nothing to it, in either direction
 *
 * The agent in A's tab is a REPORTED one — `pane.report_agent`, herdr's own
 * way for an integration to say what is running in a pane, then `agent.rename`
 * to give it the name a manager-launched builder would have. herdr lists it as
 * a live agent with the tab's cwd, which is all the bridge's scan looks at, and
 * no harness process is launched for a repo that exists for a few seconds.
 *
 * This machine's herdr belongs to the USER: it is already hosting their own
 * sessions, in their own repos, and the bridge will discover every one of those
 * as a project of its own in this smoke's throwaway database. That is correct
 * behaviour and merely slow. So nothing here asserts on the LENGTH of the
 * project list, only on A and on B, and the first hello is given room to
 * arrive.
 *
 * Requires a real herdr on PATH. Local-only, never CI (the user's terminal is
 * an input). Usage (from packages/bridge): node scripts/smoke-projects.mjs
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";

import { herdrSocketPath } from "../src/agent/launcher/herdr.ts";

const PORT = 4431;

/** the name a builder in the user's herdr carries; see the teardown for the clash */
const AGENT_NAME = "issue-1";

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
    await sleep(50);
  }
}

const SOCKET = herdrSocketPath();
let callSeq = 0;

/**
 * One call to the user's herdr, framed the way the launcher frames one: a
 * connection carrying a single request, whose first response line is that
 * request's answer, and then herdr hangs up. This smoke plays the user here —
 * it opens the workspace and the tab, because Shape never does.
 */
function herdrCall(method, params = {}) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const socket = connect(SOCKET);
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(`${JSON.stringify({ id: `smoke-${String(++callSeq)}`, method, params })}\n`));
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const answer = JSON.parse(buf.slice(0, nl));
    socket.end();
    if (answer.error !== undefined && answer.error !== null) reject(new Error(`${answer.error.code}: ${answer.error.message}`));
    else resolve(answer.result ?? {});
  });
  socket.on("error", reject);
  return promise;
}

/** a committed repo on a branch of its own: this machine's hook refuses `main` */
async function seedRepo(dir, branch) {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: basename(dir), private: true }, null, 2));
  await writeFile(join(dir, "src", "index.ts"), "export const one = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", branch);
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** the registry row for one project key, straight out of the bridge's database */
function projectRow(file, key) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT status, live_sessions FROM projects WHERE key = ?").get(key) ?? null;
  } finally {
    db.close();
  }
}

/** every project a frame carries, or null when it carries none */
const projectsOf = (frame) => (frame.type === "hello" || frame.type === "projects" ? frame.projects : null);

const repoA = await mkdtemp(join(tmpdir(), "vh-projects-a-"));
const repoB = await mkdtemp(join(tmpdir(), "vh-projects-b-"));
const home = await mkdtemp(join(tmpdir(), "vh-projects-home-"));
const dbFile = join(home, "shape.db");
await seedRepo(repoA, "worked-in");
await seedRepo(repoB, "left-alone");

const pathA = realpathSync(repoA);
const pathB = realpathSync(repoB);

const frames = [];
let bridge = null;
let socket = null;
let workspaceId = null;
let tabId = null;
let agentName = AGENT_NAME;

try {
  // --- the user's terminal, before Shape is up ------------------------------
  try {
    await herdrCall("session.snapshot", {});
  } catch (err) {
    throw new Error(
      `this smoke drives the real herdr on ${SOCKET} and it did not answer (${err instanceof Error ? err.message : String(err)}) — start herdr and run it again`,
    );
  }
  const workspace = await herdrCall("workspace.create", { label: basename(pathA), cwd: pathA, focus: false });
  workspaceId = String(workspace.workspace.workspace_id);
  const tab = await herdrCall("tab.create", { workspace_id: workspaceId, cwd: pathA, label: AGENT_NAME });
  tabId = String(tab.tab.tab_id);
  const paneId = String(tab.root_pane.pane_id);
  await herdrCall("pane.report_agent", { pane_id: paneId, source: "shape-smoke", agent: "omp", state: "idle" });
  try {
    await herdrCall("agent.rename", { target: paneId, name: agentName });
  } catch {
    // agent names are unique across the whole server, and this is the user's:
    // a builder of theirs may already be called this
    agentName = `${AGENT_NAME}-${String(process.pid)}`;
    await herdrCall("agent.rename", { target: paneId, name: agentName });
  }

  // --- the bridge, told nothing -------------------------------------------
  // No `--cwd`: what it knows comes from its registry (empty, the database is
  // new) and from what it can see running. SHAPE_MANAGER=0 because the manager
  // pass has its own smoke and this one must not write to A's git config.
  bridge = spawn(process.execPath, ["src/index.ts", "--port", String(PORT), "--db", dbFile], {
    cwd: process.cwd(),
    env: { ...process.env, SHAPE_HOME: home, HOME: home, SHAPE_MANAGER: "0" },
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
  // the startup scan opens a runtime for every repo the user has a session in,
  // and those are real repos with real worktrees: this is the slow part
  await waitFor("bridge listening", () => stderr.includes("canvas at ws://"), 180_000);
  check(
    "the bridge found the user's own herdr and is watching the machine through it",
    stderr.includes("terminal: herdr"),
    stderr.split("\n").find((line) => line.includes("terminal:")) ?? "(never said)",
  );

  socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/ws`);
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  {
    const opened = Promise.withResolvers();
    socket.once("open", opened.resolve);
    socket.once("error", opened.reject);
    await opened.promise;
  }

  // --- a repo somebody is working in is a project --------------------------
  const listed = await waitFor(
    "a project list naming the repo with a session in it",
    () => frames.find((f) => projectsOf(f)?.some((p) => p.cwd === pathA)),
    60_000,
  );
  const projects = projectsOf(listed);
  const projectA = projects.find((p) => p.cwd === pathA);
  check(
    "the repo a herdr agent is running in is an ACTIVE project, with that session live in it",
    projectA.status === "active" && projectA.liveSessions === 1,
    JSON.stringify(projectA),
  );
  check(
    "and the repo nobody is working in is no project at all",
    !projects.some((p) => p.cwd === pathB),
    `${pathB} ${projects.some((p) => p.cwd === pathB) ? "is listed" : "is not listed"}`,
  );
  const keyA = projectA.projectId;
  check("it was written down as active", projectRow(dbFile, keyA)?.status === "active", JSON.stringify(projectRow(dbFile, keyA)));

  // --- parking it -----------------------------------------------------------
  // The one thing a browser may say about a project. Everything the project
  // has is kept; what goes away is the room and the runtime feeding it.
  const parkedAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: keyA, status: "inactive" }));
  const parked = await waitFor("a projects broadcast marking it inactive", () =>
    frames.slice(parkedAt).find((f) => f.type === "projects" && f.projects.some((p) => p.projectId === keyA && p.status === "inactive")),
  );
  check(
    "marking a project inactive takes it out of the active half of the switcher, and keeps it in the list",
    parked.projects.find((p) => p.projectId === keyA)?.status === "inactive",
    JSON.stringify(parked.projects.find((p) => p.projectId === keyA)),
  );
  check("and the status is written down", projectRow(dbFile, keyA)?.status === "inactive", JSON.stringify(projectRow(dbFile, keyA)));

  const refusedAt = frames.length;
  socket.send(JSON.stringify({ type: "select_project", projectId: keyA }));
  const refused = await waitFor("the refusal for an inactive project", () =>
    frames.slice(refusedAt).find((f) => f.type === "error"),
  );
  check("switching to an inactive project is refused with the reason", refused.message.includes("is inactive"), refused.message);

  const labelA = basename(pathA);
  await waitFor(
    "the runtime of the parked project to go away",
    () => stderr.includes(`project ${labelA}: runtime gone`),
    20_000,
  );
  check(
    "its room closed and the runtime feeding it was told why",
    stderr.split("\n").some((line) => line.includes(`project ${labelA}: runtime gone`) && line.includes("inactive")),
    stderr.split("\n").find((line) => line.includes(`project ${labelA}: runtime gone`)) ?? "(never said)",
  );

  // --- and bringing it back -------------------------------------------------
  const revivedAt = frames.length;
  socket.send(JSON.stringify({ type: "set_project_status", projectId: keyA, status: "active" }));
  await waitFor("a projects broadcast marking it active again", () =>
    frames.slice(revivedAt).find((f) => f.type === "projects" && f.projects.some((p) => p.projectId === keyA && p.status === "active")),
  );
  check("marking it active again puts it back", projectRow(dbFile, keyA)?.status === "active", JSON.stringify(projectRow(dbFile, keyA)));

  const selectedAt = frames.length;
  socket.send(JSON.stringify({ type: "select_project", projectId: keyA }));
  const hello = await waitFor(
    "a hello for the revived project",
    () => frames.slice(selectedAt).find((f) => f.type === "hello" && f.projectId === keyA),
    30_000,
  );
  check(
    "and its room is open again, with the repo's own worktrees on it",
    hello.session.worktrees.some((w) => w.id === pathA),
    JSON.stringify(hello.session.worktrees.map((w) => w.id)),
  );

  // --- the user's terminal, after all that ---------------------------------
  // Shape reads herdr and writes nothing to it: no tab of the user's is
  // created, renamed, focused or closed by any of the above.
  const stillThere = (await herdrCall("agent.list", {})).agents.filter((row) => String(row.workspace_id) === workspaceId);
  check(
    "the tab Shape found all this through is still running, untouched",
    stillThere.length === 1 && String(stillThere[0].pane_id) === paneId && stillThere[0].name === agentName,
    JSON.stringify(stillThere.map((row) => ({ pane: row.pane_id, name: row.name, cwd: row.cwd }))),
  );
  const tabs = (await herdrCall("tab.list", { workspace_id: workspaceId })).tabs;
  check(
    "in the tab the user made, still called what they called it",
    tabs.some((row) => String(row.tab_id) === tabId && row.label === AGENT_NAME),
    tabs.map((row) => `${String(row.tab_id)}:${String(row.label)}`).join(", "),
  );
} catch (err) {
  check("the projects smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  socket?.close();
  bridge?.kill("SIGKILL");
  // The workspace and its tab were made for repos in /tmp that are about to
  // stop existing, and this herdr is the user's: closing the workspace takes
  // the tab and the reported agent with it.
  if (workspaceId !== null) {
    try {
      await herdrCall("workspace.close", { workspace_id: workspaceId });
      check("the user's herdr kept nothing of this smoke", true, workspaceId);
    } catch (err) {
      check("the user's herdr kept nothing of this smoke", false, err instanceof Error ? err.message : String(err));
    }
  }
  await sleep(150);
  await rm(repoA, { recursive: true, force: true });
  await rm(repoB, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? `PROJECTS SMOKE OK (${results.length} checks)` : `PROJECTS SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
