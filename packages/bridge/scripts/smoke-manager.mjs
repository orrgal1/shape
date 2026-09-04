#!/usr/bin/env node
/**
 * Manager-attach smoke test. Unlike every other smoke in here there is no fake
 * to hide behind: the manager lives in the USER's herdr, and finding it, or
 * opening it, is a conversation with the real server on this machine. So this
 * one talks to that herdr — but only ever about a repo it made itself in
 * `/tmp`, in a workspace of that repo's own, and it closes both on the way out.
 * A run must leave the user's terminal exactly as it found it.
 *
 * What it asserts, end to end:
 *   opened          — a project with no manager gets one: a tab labelled
 *                     "manager" in the project's workspace, running omp with
 *                     Shape's extension, told to read the skill and take the
 *                     job. Its agent name is herdr-legal and says what it is
 *   shape-aware     — a manager Shape itself opened carries this bridge's
 *                     link, so the canvas can talk to it without waiting for
 *                     the extension to dial home
 *   one tab         — the workspace holds exactly ONE tab called "manager",
 *                     and the pane herdr reports for it sits in the project
 *   found           — attaching a second time finds THAT manager instead of
 *                     opening a second one: same pane, same tab, same
 *                     workspace, and still one tab
 *   mgr config      — the harness the manager hands to future builders is
 *                     Shape's: `--extension <omp-extension.ts>`, the link in
 *                     `SHAPE_LINK`, the project's directive as brief-extra —
 *                     written ONCE, because `mgr config add` appends blindly
 *                     and reconciling is Shape's job, so two attaches must
 *                     leave one of each and not two
 *   no complaints   — `attachManager` swallows its own failures into stderr
 *                     and hands back the handle anyway, so the bridge's log
 *                     is read: one outcome line per attach and nothing else.
 *                     A manager that was opened but never PROMPTED shows up
 *                     here and nowhere else
 *   nothing left    — the tab and the workspace are gone at the end, because
 *                     they were made for a repo in /tmp that is about to be
 *                     deleted, and this herdr is the user's
 *
 * The link URL points at nothing on purpose (port 1): a manager whose
 * extension cannot dial home is still a manager, and this smoke is about the
 * attach, not the loopback.
 *
 * Requires a real herdr on PATH (the launcher autospawns the server and uses
 * its default socket — do not set HERDR_SOCKET_PATH for this one).
 *
 * Usage (from packages/bridge): node scripts/smoke-manager.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { attachManager } from "../src/agent/manager.ts";
import { HerdrLauncher } from "../src/agent/launcher/herdr.ts";

/** the extension every Shape-launched omp gets, as the manager module names it */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OMP_EXTENSION = join(REPO_ROOT, "packages", "link", "src", "omp-extension.ts");

/** a link nothing listens on: see the header */
const LINK_URL = "ws://127.0.0.1:1/link";

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
 * The workspaces the user already had. Nothing in this smoke may close one of
 * them: the workspace it tears down has to be one that was not here before.
 */
function workspaceIds() {
  const out = execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" });
  const listed = JSON.parse(out.split("\n").find((line) => line.trim().startsWith("{")));
  return new Set((listed.result?.workspaces ?? []).map((workspace) => String(workspace.workspace_id)));
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
let handle = null;
/** only true for a workspace this run brought into existence */
let ownsWorkspace = false;

/**
 * What the bridge said while attaching. `attachManager` survives everything —
 * a failure on the way is one `console.error` and the handle still comes back
 * — so listening is the only way to catch a manager that was opened and then
 * never told to take the job.
 */
const said = [];
const wasError = console.error;
console.error = (...args) => {
  said.push(args.map((arg) => String(arg)).join(" "));
  wasError(...args);
};

try {
  const before = workspaceIds();

  launcher = await HerdrLauncher.probe();
  if (launcher === null) throw new Error("a real herdr is required for this smoke, and none answered");
  check("a real herdr answered", true, `protocol handshake ok, ${launcher.version}`);

  // --- nothing there yet: Shape opens the manager ---------------------------
  handle = await attachManager(project, launcher, env);
  check("a manager was attached", handle !== null);
  if (handle === null) throw new Error("attachManager returned null on a fresh project");
  ownsWorkspace = !before.has(handle.workspaceId);
  check("in a workspace this smoke created", ownsWorkspace, handle.workspaceId);
  check("and Shape is the one who opened it", handle.origin === "opened", handle.origin);
  check("the pane carries this bridge's link", handle.shapeAware === true, String(handle.shapeAware));
  check(
    "under a herdr-legal name that says what it is",
    handle.agentName === "manager" || handle.agentName.startsWith("manager-"),
    handle.agentName,
  );

  const opened = await launcher.tabs(handle.workspaceId);
  const managerTabs = opened.filter((tab) => tab.label === "manager");
  check("the workspace holds exactly one manager tab", managerTabs.length === 1, `${managerTabs.length} of ${opened.length} tabs`);
  check("and it is the tab the handle names", managerTabs[0]?.tabId === handle.tabId, `${managerTabs[0]?.tabId} vs ${handle.tabId}`);

  const row = await waitFor("herdr to report an agent in the manager's pane", async () =>
    (await launcher.agents()).find((agent) => agent.paneId === handle.paneId),
  );
  check("an agent is running in that pane", row !== undefined, `${row.name ?? "unnamed"} in ${row.paneId}`);
  const rowCwd = row.cwd === null ? null : realpathSync(row.cwd);
  check("and it is running in the project", rowCwd === projectPath, `${String(rowCwd)} vs ${projectPath}`);

  // --- attaching again finds it, and does not open a second -----------------
  const again = await attachManager(project, launcher, env);
  check("a second attach found a manager", again !== null);
  check("and says it found rather than opened", again?.origin === "found", String(again?.origin));
  check(
    "in the same pane, tab and workspace",
    again?.paneId === handle.paneId && again?.tabId === handle.tabId && again?.workspaceId === handle.workspaceId,
    `${String(again?.paneId)}/${String(again?.tabId)}/${String(again?.workspaceId)}`,
  );
  const after = (await launcher.tabs(handle.workspaceId)).filter((tab) => tab.label === "manager");
  check("with still exactly one manager tab", after.length === 1, `${after.length}`);

  // --- the harness the manager will hand to its builders -------------------
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
  // bridge prints is a step that did not happen — the prompt above all.
  const outcomes = said.filter((line) => line.startsWith("[bridge] manager:"));
  const complaints = outcomes.filter((line) => !/^\[bridge] manager: (found|opened|none) /.test(line));
  check("the attach complained about nothing", complaints.length === 0, complaints.join(" / "));
  check("and said what it did, once per attach", outcomes.length === 2, outcomes.length === 2 ? "" : outcomes.join(" / "));
} catch (err) {
  check("the manager smoke ran to completion", false, err instanceof Error ? err.message : String(err));
} finally {
  console.error = wasError;
  // The tab first, then the workspace it was the only tenant of. Both belong
  // to a repo in /tmp that is about to stop existing, and a manager left
  // pointed at it would sit in the user's terminal forever.
  if (launcher !== null && handle !== null) {
    try {
      await launcher.closeTab(handle.tabId);
    } catch (err) {
      check("the manager tab closed", false, err instanceof Error ? err.message : String(err));
    }
    if (ownsWorkspace) {
      try {
        await launcher.closeWorkspace(handle.workspaceId);
      } catch (err) {
        // closing a workspace's last tab takes the workspace with it, so herdr
        // having forgotten it already is the outcome this asked for
        const gone = err instanceof Error && err.message.includes("workspace_not_found");
        if (!gone) check("the smoke's workspace closed", false, err instanceof Error ? err.message : String(err));
      }
    }
  }
  launcher?.dispose();
  // The point of the whole teardown: the user's herdr must not be carrying a
  // workspace for a repo that no longer exists.
  if (handle !== null && ownsWorkspace) {
    try {
      check("the user's herdr kept nothing of this smoke", !workspaceIds().has(handle.workspaceId), handle.workspaceId);
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
