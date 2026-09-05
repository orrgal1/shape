#!/usr/bin/env node
/**
 * Manager-attach smoke test. Unlike every other smoke in here there is no fake
 * to hide behind: the manager lives in the USER's herdr, and finding it is a
 * conversation with the real server on this machine. So this one talks to that
 * herdr — but only ever about a repo it made itself in `/tmp`, in a workspace
 * of that repo's own, and it closes both on the way out. A run must leave the
 * user's terminal exactly as it found it.
 *
 * Shape OPENS nothing (#28). `attachManager` is find-only: the manager is a tab
 * the user (or their manager skill) started, and a project without one simply
 * has no manager. That is what this drives, and the whole point is what does
 * NOT happen:
 *   no workspace   — a project whose repo no workspace of the user's belongs
 *                    to attaches to nothing, says "none" in the log, and does
 *                    not bring a workspace into existence by asking
 *   no manager tab — with the workspace there but no tab called "manager" in
 *                    it, the same: null, "none", and the workspace still holds
 *                    the tabs it held. Shape does not open the tab it wanted
 *   found          — a tab labelled "manager" whose agent runs in the project
 *                    IS the manager: `origin: "found"`, the pane, tab and
 *                    workspace herdr reports, and not shape-aware, because
 *                    that session never dialled this bridge's link
 *   again          — a second attach finds the same one and creates nothing
 *   mgr config     — the harness the manager hands to future builders is
 *                    Shape's: `--extension <omp-extension.ts>`, the link in
 *                    `SHAPE_LINK`, the project's directive as brief-extra —
 *                    written ONCE, because `mgr config add` appends blindly
 *                    and reconciling is Shape's job, so two attaches must
 *                    leave one of each and not two
 *   no complaints  — `attachManager` swallows its own failures into stderr and
 *                    returns null anyway, so the bridge's log is read: one
 *                    outcome line per attach and nothing else
 *   nothing left   — the tab and the workspace are gone at the end, because
 *                    they were made for a repo in /tmp that is about to be
 *                    deleted, and this herdr is the user's
 *
 * The manager tab is put there by this smoke, playing the user: the workspace,
 * the tab and the agent in it all come from the herdr socket directly, because
 * `workspaceOf` and `attachManager` are find-only and will create none of them.
 * The agent is a REPORTED one — `pane.report_agent`, which is how herdr's own
 * integrations tell it what is running in a pane — so herdr lists a live agent
 * in that pane, with the tab's cwd, and no harness process is started for a
 * repo that exists for two seconds. `agent.start` would have to launch a real
 * omp and wait for herdr to detect it; nothing here is about the launching.
 *
 * The link URL points at nothing on purpose (port 1): a manager Shape cannot
 * talk to is still a manager, and this smoke is about the attach, not the
 * loopback.
 *
 * Requires a real herdr on PATH (the launcher autospawns the server and uses
 * its default socket — do not set HERDR_SOCKET_PATH for this one).
 *
 * Usage (from packages/bridge): node scripts/smoke-manager.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { attachManager } from "../src/agent/manager.ts";
import { HerdrLauncher, herdrSocketPath } from "../src/agent/launcher/herdr.ts";

/** the extension every Shape-launched omp gets, as the manager module names it */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OMP_EXTENSION = join(REPO_ROOT, "packages", "link", "src", "omp-extension.ts");

/** a link nothing listens on: see the header */
const LINK_URL = "ws://127.0.0.1:1/link";

/** what this run calls its agent; unique, because herdr refuses a name twice */
const AGENT_NAME = `manager-smoke-${String(process.pid)}`;

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
    const hit = await predicate();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

const SOCKET = herdrSocketPath();

/**
 * One call to the user's herdr, framed the way `HerdrLauncher.#call` frames
 * one: a connection carrying a single request, whose first response line is
 * that request's answer, and then herdr hangs up. This smoke plays the user
 * here — everything Shape is not allowed to create, it creates.
 */
function herdrCall(method, params = {}) {
  const { promise, resolve: settle, reject } = Promise.withResolvers();
  const socket = connect(SOCKET);
  let buf = "";
  socket.setEncoding("utf8");
  socket.on("connect", () => socket.write(`${JSON.stringify({ id: `smoke-${String(Date.now())}`, method, params })}\n`));
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl === -1) return;
    const answer = JSON.parse(buf.slice(0, nl));
    socket.end();
    if (answer.error !== undefined && answer.error !== null) reject(new Error(`${answer.error.code}: ${answer.error.message}`));
    else settle(answer.result ?? {});
  });
  socket.on("error", reject);
  return promise;
}

/** a committed repo: `mgr config` needs a git dir to write the harness into */
async function seedTarget(dir) {
  await writeFile(join(dir, "README.md"), "# manager smoke target\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  // not `main`: this machine's global pre-commit hook refuses commits there,
  // and a throwaway repo in /tmp is nobody's trunk
  git("init", "-q", "-b", "smoke");
  git("add", "-A");
  git("-c", "user.email=smoke@example.com", "-c", "user.name=smoke", "commit", "-q", "-m", "init");
}

/** every value of a multi-valued git key, or none: a missing key exits 1 */
function gitConfig(dir, key) {
  try {
    return execFileSync("git", ["-C", dir, "config", "--local", "--get-all", key], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * The workspaces herdr is holding. Nothing in this smoke may close one it did
 * not create, and "Shape created nothing" is read off this too.
 */
async function workspaceIds() {
  const listed = await herdrCall("workspace.list", {});
  return new Set((listed.workspaces ?? []).map((workspace) => String(workspace.workspace_id)));
}

const target = await mkdtemp(join(tmpdir(), "vh-manager-target-"));
const scratch = await mkdtemp(join(tmpdir(), "vh-manager-home-"));
await seedTarget(target);

const projectPath = realpathSync(target);
const project = { path: projectPath, label: basename(projectPath) };

/** the project's directive (issue #4), which the manager passes to builders */
const directivePath = join(scratch, "shape-directive.md");
await writeFile(directivePath, "# directive\n\nKeep the smoke honest.\n");

const env = { linkUrl: LINK_URL, directivePath, isLinked: () => false };

let launcher = null;
/** the workspace and tab this run made, and must take away again */
let workspaceId = null;
let tabId = null;

/**
 * What the bridge said while attaching. `attachManager` survives everything —
 * a failure on the way is one `console.error` and it returns null — so
 * listening is the only way to see WHICH of the two nothings happened.
 */
const said = [];
const wasError = console.error;
console.error = (...args) => {
  said.push(args.map((arg) => String(arg)).join(" "));
  wasError(...args);
};

try {
  launcher = await HerdrLauncher.probe();
  if (launcher === null) throw new Error("a real herdr is required for this smoke, and none answered");
  check("a real herdr answered", true, `protocol handshake ok, ${launcher.version}`);

  // --- no workspace for this repo at all ------------------------------------
  // Find-only starts here: a project the user has not opened a workspace for
  // has no manager, and asking must not make one.
  const before = await workspaceIds();
  const nowhere = await attachManager(project, launcher, env);
  check("a project with no workspace of its own attaches to no manager", nowhere === null, JSON.stringify(nowhere));
  check(
    "and says so: nothing found, nothing opened",
    said.at(-1)?.startsWith("[bridge] manager: none ") === true,
    said.at(-1) ?? "(said nothing)",
  );
  const untouched = await workspaceIds();
  check(
    "asking did not bring a workspace into existence",
    untouched.size === before.size && [...untouched].every((id) => before.has(id)),
    `${before.size} workspaces before, ${untouched.size} after`,
  );

  // --- the workspace, put there by the user ---------------------------------
  // `workspace.create` answers with a workspace that already has its first tab
  // and pane, which is exactly the shell the user would be looking at.
  const created = await herdrCall("workspace.create", { label: project.label, cwd: projectPath, focus: false });
  workspaceId = String(created.workspace.workspace_id);
  const rootTabId = String(created.tab.tab_id);

  const empty = await attachManager(project, launcher, env);
  check("a workspace with no manager tab in it still attaches to no manager", empty === null, JSON.stringify(empty));
  check(
    "and says none rather than opening the tab it wanted",
    said.at(-1)?.startsWith("[bridge] manager: none ") === true,
    said.at(-1) ?? "(said nothing)",
  );
  const tabsAfterMiss = await launcher.tabs(workspaceId);
  check(
    "the workspace holds the one tab it came with, and nothing labelled manager",
    tabsAfterMiss.length === 1 && tabsAfterMiss[0]?.tabId === rootTabId && !tabsAfterMiss.some((tab) => tab.label === "manager"),
    tabsAfterMiss.map((tab) => `${tab.tabId}:${tab.label}`).join(", "),
  );

  // --- the manager the user starts ------------------------------------------
  // A tab called "manager", running in the project, with an agent in its pane.
  // The agent is reported rather than launched (see the header): herdr lists it
  // as live, in the tab's cwd, which is everything the attach looks at.
  const managerTab = await herdrCall("tab.create", { workspace_id: workspaceId, cwd: projectPath, label: "manager" });
  tabId = String(managerTab.tab.tab_id);
  const paneId = String(managerTab.root_pane.pane_id);
  await herdrCall("pane.report_agent", { pane_id: paneId, source: "shape-smoke", agent: "omp", state: "idle" });
  await herdrCall("agent.rename", { target: paneId, name: AGENT_NAME });
  const row = await waitFor("herdr to report an agent in the manager's pane", async () =>
    (await launcher.agents()).find((agent) => agent.paneId === paneId),
  );
  const rowCwd = row.cwd === null ? null : realpathSync(row.cwd);
  check("herdr hosts an agent in the manager tab, running in the project", rowCwd === projectPath, `${String(rowCwd)} vs ${projectPath}`);

  const handle = await attachManager(project, launcher, env);
  check("that manager is found", handle !== null);
  if (handle === null) throw new Error("attachManager found no manager where herdr says one is running");
  check("and found is all it can ever be: Shape opens no manager", handle.origin === "found", handle.origin);
  check(
    "in the pane, tab and workspace herdr reports",
    handle.paneId === paneId && handle.tabId === tabId && handle.workspaceId === workspaceId,
    `${handle.paneId}/${handle.tabId}/${handle.workspaceId}`,
  );
  check("under the name herdr knows it by", handle.agentName === AGENT_NAME, handle.agentName);
  check(
    "and not shape-aware: that session never dialled this bridge's link",
    handle.shapeAware === false,
    String(handle.shapeAware),
  );

  // --- attaching again finds the same one -----------------------------------
  const again = await attachManager(project, launcher, env);
  check("a second attach found a manager", again !== null);
  check(
    "the same pane, tab and workspace, and no second tab",
    again?.paneId === handle.paneId && again?.tabId === handle.tabId && again?.workspaceId === handle.workspaceId,
    `${String(again?.paneId)}/${String(again?.tabId)}/${String(again?.workspaceId)}`,
  );
  const after = (await launcher.tabs(workspaceId)).filter((tab) => tab.label === "manager");
  check("with still exactly one manager tab", after.length === 1, `${after.length}`);

  // --- the harness the manager will hand to its builders --------------------
  // Two attaches, one of each value: `mgr config add` appends without
  // deduping, so anything else means Shape is not reconciling.
  const ompArgs = gitConfig(target, "mgr.omp-arg");
  check("mgr.omp-arg is exactly the extension pair", ompArgs.length === 2 && ompArgs[0] === "--extension", ompArgs.join(" | "));
  check("naming Shape's own extension", ompArgs[1] === OMP_EXTENSION, String(ompArgs[1]));
  check("which is a file that exists", ompArgs[1] !== undefined && existsSync(ompArgs[1]));
  const mgrEnv = gitConfig(target, "mgr.env");
  check("mgr.env carries one SHAPE_LINK and nothing else", mgrEnv.length === 1 && mgrEnv[0] === `SHAPE_LINK=${LINK_URL}`, mgrEnv.join(" | "));
  const briefExtra = gitConfig(target, "mgr.brief-extra");
  check("mgr.brief-extra is the project's directive", briefExtra.length === 1 && briefExtra[0] === directivePath, briefExtra.join(" | "));

  // One line per attach and nothing else: every other `manager:` line the
  // bridge prints is a step that did not happen.
  const outcomes = said.filter((line) => line.startsWith("[bridge] manager:"));
  const complaints = outcomes.filter((line) => !/^\[bridge] manager: (found|none) /.test(line));
  check("the attaches complained about nothing", complaints.length === 0, complaints.join(" / "));
  check("and said what each did, once per attach", outcomes.length === 4, outcomes.length === 4 ? "" : outcomes.join(" / "));
} catch (err) {
  check("the manager smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  console.error = wasError;
  // The tab first, then the workspace. Both were made for a repo in /tmp that
  // is about to stop existing, and a manager tab left pointed at it would sit
  // in the user's terminal forever.
  if (launcher !== null && tabId !== null) {
    try {
      await launcher.closeTab(tabId);
    } catch (err) {
      check("the manager tab closed", false, err instanceof Error ? err.message : String(err));
    }
  }
  if (launcher !== null && workspaceId !== null) {
    try {
      await launcher.closeWorkspace(workspaceId);
    } catch (err) {
      // closing a workspace's last tab takes the workspace with it, so herdr
      // having forgotten it already is the outcome this asked for
      const gone = err instanceof Error && err.message.includes("workspace_not_found");
      if (!gone) check("the smoke's workspace closed", false, err instanceof Error ? err.message : String(err));
    }
    // The point of the whole teardown: the user's herdr must not be carrying a
    // workspace for a repo that no longer exists.
    try {
      check("the user's herdr kept nothing of this smoke", !(await workspaceIds()).has(workspaceId), workspaceId);
    } catch (err) {
      check("the user's herdr kept nothing of this smoke", false, err instanceof Error ? err.message : String(err));
    }
  }
  await sleep(150);
  await rm(target, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}

console.log(`\n${results.join("\n")}\n`);
console.log(failed === 0 ? `MANAGER SMOKE OK (${results.length} checks)` : `MANAGER SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
