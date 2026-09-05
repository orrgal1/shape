/**
 * The project's MANAGER: the one session in the user's herdr that turns what
 * they ask for into issues and dispatches a builder per issue, each in its own
 * tab and worktree. Shape does not manage anything itself — the
 * `@orrgal1/manager-skill` does, in an omp of its own — so this file is only
 * about making sure that session exists, is Shape-aware, and hands Shape's
 * integration down to every builder it launches.
 *
 * Three steps, in this order, on every project open and every switch:
 *
 *   FIND. A `manager` tab in this project's herdr workspace whose live agent
 *   runs in the project's main checkout IS the manager, whoever started it —
 *   the user may have opened it by hand, or a previous Shape did and outlived
 *   this process. Recognition is by tab label plus agent cwd, because a pane
 *   id does not survive a Shape restart and an agent name does not survive a
 *   herdr restart. A `manager` tab with NO live agent is a dead shell from a
 *   session that ended; it is closed, so the workspace never accumulates two
 *   tabs by that name. A `manager` tab whose agent lives somewhere else
 *   belongs to another project sharing the workspace: left alone, and not
 *   counted as found.
 *
 *   OPEN. Nothing found means `mgr paths` (for the skill file to point the
 *   session at) and then one omp with Shape's extension loaded, in a tab
 *   labelled `manager`, prompted to read the skill and take the job.
 *
 *   CONFIG. `mgr config` is what the manager applies to the builders it
 *   launches LATER, so both origins get it: Shape's extension in `omp-arg` and
 *   its link URL in `env` mean every builder comes up on the canvas, and
 *   `brief-extra` points them at the project's directive. `mgr config add`
 *   appends without deduping, so reconciliation is Shape's job: the desired
 *   list is computed, and only a difference costs an `unset` + re-add.
 *
 * Every failure here degrades to `null` and one line on stderr, never an
 * exception, because this runs INSIDE opening a project: a herdr that refused,
 * a `mgr` that is not installed or a workspace the user closed are all reasons
 * to have no manager, and none of them is a reason to have no canvas.
 */

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagerHandle } from "../../../shared/src/index.ts";
import type { HerdrLauncher } from "./launcher/herdr.ts";

/** what the manager's tab is called, and how it is recognized again */
export const MANAGER_LABEL = "manager";

/**
 * Two paths, both derived from this file's own location:
 * `<repo>/packages/bridge/src/agent/manager.ts` -> the bridge package root.
 *
 * `MGR` is the `mgr` CLI the manager skill ships, a dependency of THIS
 * package. `OMP_EXTENSION` is the omp extension's PATH rather than its import,
 * because the bridge must run against a checkout where packages/link is
 * present but not built or importable from here, and omp loads a `.ts` file
 * directly. That extension is Shape's whole integration with an omp: the
 * manager is launched with it, and `mgr config` hands the same path down to
 * every builder the manager launches. One path, one truth.
 */
const BRIDGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MGR = join(BRIDGE_ROOT, "node_modules", ".bin", "mgr");
export const OMP_EXTENSION = resolve(BRIDGE_ROOT, "..", "link", "src", "omp-extension.ts");

/**
 * How long a `mgr` call gets. It reads `git config` and writes it back, so it
 * is bounded work; past this something is wedged and the project must open
 * without a manager rather than wait on it.
 */
const MGR_TIMEOUT_MS = 30_000;

/** herdr agent names: `[a-z][a-z0-9_-]{0,31}` */
const MAX_AGENT_NAME = 32;

/** how Shape's own `omp-arg` pair is recognized in a config it did not write */
const EXTENSION_SUFFIX = "/omp-extension.ts";

/** every builder inherits this from the manager: the canvas it reports to */
const LINK_ENV = "SHAPE_LINK";

/**
 * What the manager needs from the runtime that the runtime alone knows: where
 * this bridge listens, which directive file it just wrote, and which sessions
 * are on the link right now.
 */
export interface ManagerEnvironment {
  /** this bridge's loopback link URL (what `SHAPE_LINK` carries) */
  linkUrl: string;
  /** the project's `shape-directive.md`; null leaves `brief-extra` alone this pass */
  directivePath: string | null;
  /** is a loopback-link client greeted from this cwd right now */
  isLinked(cwd: string): boolean;
  /** the `mgr` binary, for a smoke that ships its own */
  mgr?: string;
}

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `mgr` without a shell; a non-zero exit is data, not an exception. A
 * binary that is not there at all says nothing on stderr, so the spawn error
 * stands in for it — "mgr ENOENT" is the only useful thing to report then.
 */
function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  const { promise, resolve: settle } = Promise.withResolvers<Ran>();
  execFile(file, args, { cwd, env, timeout: MGR_TIMEOUT_MS }, (err, stdout, stderr) => {
    const failed = err === null ? "" : err.message;
    const said = stderr.trim();
    settle({ ok: err === null, stdout, stderr: said.length === 0 ? failed : said });
  });
  return promise;
}

/** Failures arrive as Errors whose message is already the whole story. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `mgr`'s one-line JSON, or null. Malformed output is a failed call: this is a
 * contract between two programs, and half-understood output is worse than
 * none.
 */
function parseJson(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim();
  if (line.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** one multi-valued `mgr config` key, with anything of the wrong shape dropped */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * A directory as the filesystem sees it. A path that cannot be resolved (the
 * worktree was removed under a still-running agent) is judged by its
 * spelling — comparing two unresolvable paths is still worth more than
 * treating them as different.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** a project label as a herdr agent name may spell it (`[a-z][a-z0-9_-]{0,31}`) */
function slug(label: string): string {
  return label.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The `omp-arg` list the manager should hand its builders, or null when it
 * already says that. Shape owns exactly one pair in there — `--extension
 * <…/omp-extension.ts>` — so its own pair is stripped wherever it sits
 * (including a stray value left by a half-written config) and re-appended
 * once. Everything else the user or the skill put there keeps its place and
 * its order: this is their config, and Shape is one line of it.
 */
export function planOmpArgs(existing: readonly string[], extension: string): string[] | null {
  const kept: string[] = [];
  for (let i = 0; i < existing.length; i++) {
    const entry = existing[i] as string;
    if (entry === "--extension" && (existing[i + 1] ?? "").endsWith(EXTENSION_SUFFIX)) {
      i++;
      continue;
    }
    if (entry.endsWith(EXTENSION_SUFFIX)) continue;
    kept.push(entry);
  }
  const desired = [...kept, "--extension", extension];
  const same = desired.length === existing.length && desired.every((entry, i) => entry === existing[i]);
  return same ? null : desired;
}

/**
 * The `env` list the builders should inherit, or null when it already says
 * that. A stale `SHAPE_LINK` is worse than none — it points a builder at a
 * port this machine gave to something else — so every spelling of it is
 * replaced by this bridge's.
 */
export function planEnv(existing: readonly string[], linkUrl: string): string[] | null {
  const desired = [...existing.filter((entry) => !entry.startsWith(`${LINK_ENV}=`)), `${LINK_ENV}=${linkUrl}`];
  const same = desired.length === existing.length && desired.every((entry, i) => entry === existing[i]);
  return same ? null : desired;
}

/**
 * Find or open this project's manager, and make sure it passes Shape on to the
 * builders it launches. `null` is a normal answer: no herdr, no `mgr`, or a
 * herdr that would not cooperate — the canvas then simply shows no manager.
 */
export async function attachManager(
  project: { path: string; label: string },
  launcher: HerdrLauncher | null,
  env: ManagerEnvironment,
): Promise<ManagerHandle | null> {
  // the manager lives in the USER's terminal or nowhere: it has to be a tab in
  // a strip they can walk over to, and it has to outlive this process
  if (launcher === null) return null;
  if (process.env.SHAPE_MANAGER === "0") {
    console.error("[bridge] manager: disabled by SHAPE_MANAGER=0");
    return null;
  }
  const mgr = env.mgr ?? MGR;

  try {
    const handle = await attach(project, launcher, env, mgr);
    if (handle === null) return null;
    await configure(project, handle, env, mgr);
    return handle;
  } catch (err) {
    // every herdr call in there can be refused (a workspace the user closed
    // mid-flight, a socket that dropped) and none of it is worth a project
    console.error(`[bridge] manager: none (${errText(err)})`);
    return null;
  }
}

/** FIND then OPEN; whichever answers, the caller configures it. */
async function attach(
  project: { path: string; label: string },
  launcher: HerdrLauncher,
  env: ManagerEnvironment,
  mgr: string,
): Promise<ManagerHandle | null> {
  const workspaceId = await launcher.workspaceOf(project);
  if (workspaceId !== null) {
    const found = await findManager(project, launcher, workspaceId, env);
    if (found !== null) {
      console.error(
        `[bridge] manager: found ${found.agentName} in pane ${found.paneId} of workspace ${found.workspaceId} (shape-aware: ${found.shapeAware ? "yes" : "no"})`,
      );
      return found;
    }
  }
  return await openManager(project, launcher, workspaceId, env, mgr);
}

/**
 * The manager already in the user's terminal, if it is there. Tabs are taken
 * in id order so that two candidates (which only a race or a user's own second
 * tab can produce) resolve the same way on every pass.
 */
async function findManager(
  project: { path: string; label: string },
  launcher: HerdrLauncher,
  workspaceId: string,
  env: ManagerEnvironment,
): Promise<ManagerHandle | null> {
  const tabs = (await launcher.tabs(workspaceId))
    .filter((tab) => tab.label === MANAGER_LABEL)
    .sort((a, b) => a.tabId.localeCompare(b.tabId));
  if (tabs.length === 0) return null;
  // `agent.list` is global by protocol; only this workspace's rows can be ours
  const agents = (await launcher.agents()).filter((agent) => agent.workspaceId === workspaceId);
  const wanted = await canonical(project.path);

  for (const tab of tabs) {
    const agent = agents.find((entry) => entry.tabId === tab.tabId);
    if (agent === undefined) {
      // a tab named `manager` with nothing running in it is what a manager
      // that exited leaves behind; leaving it would make the next open the
      // second tab by that name in the user's strip
      console.error(`[bridge] manager: closing tab ${tab.tabId} — labelled ${MANAGER_LABEL} with no live agent in it`);
      try {
        await launcher.closeTab(tab.tabId);
      } catch (err) {
        console.error(`[bridge] manager: tab ${tab.tabId} would not close: ${errText(err)}`);
      }
      continue;
    }
    const cwd = agent.cwd;
    if (cwd === null || (await canonical(cwd)) !== wanted) {
      console.error(
        `[bridge] manager: leaving tab ${tab.tabId} alone — ${agent.name ?? "its agent"} runs in ${cwd ?? "a directory herdr will not name"}, not ${project.path}`,
      );
      continue;
    }
    return {
      paneId: agent.paneId,
      tabId: tab.tabId,
      workspaceId,
      agentName: agent.name ?? MANAGER_LABEL,
      origin: "found",
      // a manager whose omp never dialled the link cannot reach the canvas;
      // the canvas says so rather than pretending the integration is there
      shapeAware: env.isLinked(cwd),
    };
  }
  return null;
}

/** No manager yet: one omp with Shape's extension, told to read the skill. */
async function openManager(
  project: { path: string; label: string },
  launcher: HerdrLauncher,
  workspaceId: string | null,
  env: ManagerEnvironment,
  mgr: string,
): Promise<ManagerHandle | null> {
  const paths = await run(mgr, ["paths"], project.path, mgrEnv(workspaceId));
  const skill = paths.ok ? parseJson(paths.stdout) : null;
  const skillMd = typeof skill?.skill_md === "string" ? skill.skill_md : null;
  if (skillMd === null) {
    // an omp with no skill to read is not a manager, it is a stray session in
    // the user's terminal: better to open nothing at all
    console.error(`[bridge] manager: none (mgr paths: ${paths.ok ? "unreadable output" : paths.stderr})`);
    return null;
  }

  const named = `${MANAGER_LABEL}-${slug(project.label)}`.slice(0, MAX_AGENT_NAME);
  const opened = await launcher.open(
    {
      // the manager works in the main checkout: it writes issues and launches
      // builders, and never edits the tree itself
      cwd: project.path,
      kind: "omp",
      argv: ["omp", "--extension", OMP_EXTENSION],
      env: { [LINK_ENV]: env.linkUrl },
      project,
      label: MANAGER_LABEL,
    },
    [MANAGER_LABEL, named],
  );
  try {
    await launcher.prompt(opened.paneId, `Read ${skillMd} and act as the manager for this project.`);
  } catch (err) {
    // an omp that was never told the job is not a manager, and the next pass
    // would FIND it (a `manager` tab with a live agent in the right tree) and
    // never prompt it either — so it goes, and opening is retried from scratch
    console.error(`[bridge] manager: none (${opened.agentName} would not take the prompt: ${errText(err)})`);
    try {
      await launcher.closeTab(opened.tabId);
    } catch (nested) {
      console.error(`[bridge] manager: tab ${opened.tabId} would not close: ${errText(nested)}`);
    }
    return null;
  }
  console.error(
    `[bridge] manager: opened ${opened.agentName} in pane ${opened.paneId} of workspace ${opened.workspaceId} (shape-aware: yes)`,
  );
  return { ...opened, origin: "opened", shapeAware: true };
}

/** `mgr` reads the workspace out of the environment when herdr placed us in one */
function mgrEnv(workspaceId: string | null): NodeJS.ProcessEnv {
  return workspaceId === null ? process.env : { ...process.env, HERDR_WORKSPACE_ID: workspaceId };
}

/**
 * Hand Shape down to the builders this manager will launch. Nothing in here
 * throws: a manager Shape can see but not configure is still a manager worth
 * showing, and the reason is on stderr for whoever wonders why a builder came
 * up off the canvas.
 */
async function configure(
  project: { path: string; label: string },
  handle: ManagerHandle,
  env: ManagerEnvironment,
  mgr: string,
): Promise<void> {
  const environment = { ...process.env, HERDR_WORKSPACE_ID: handle.workspaceId };
  const listed = await run(mgr, ["config", "list"], project.path, environment);
  const config = listed.ok ? parseJson(listed.stdout) : null;
  if (config === null) {
    console.error(`[bridge] manager: mgr config list failed (${listed.ok ? "unreadable output" : listed.stderr})`);
    return;
  }

  const args = planOmpArgs(strings(config["omp-arg"]), OMP_EXTENSION);
  if (args !== null && !(await rewrite(mgr, project.path, environment, "omp-arg", args))) return;
  const inherited = planEnv(strings(config.env), env.linkUrl);
  if (inherited !== null && !(await rewrite(mgr, project.path, environment, "env", inherited))) return;

  const brief = typeof config["brief-extra"] === "string" ? config["brief-extra"] : null;
  if (env.directivePath === null || brief === env.directivePath) return;
  const set = await run(mgr, ["config", "set", "brief-extra", env.directivePath], project.path, environment);
  if (!set.ok) console.error(`[bridge] manager: mgr config set brief-extra failed (${set.stderr})`);
}

/**
 * Replace one multi-valued key: `unset` then `add` in order, because `add`
 * appends without deduping and there is no way to edit an entry in place. A
 * failure half-way through leaves the key short, which the next pass sees as a
 * difference and rewrites — the reason to report it and stop rather than pile
 * more writes onto a `mgr` that is refusing.
 */
async function rewrite(
  mgr: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  key: string,
  values: readonly string[],
): Promise<boolean> {
  const cleared = await run(mgr, ["config", "unset", key], cwd, environment);
  if (!cleared.ok) {
    console.error(`[bridge] manager: mgr config unset ${key} failed (${cleared.stderr})`);
    return false;
  }
  for (const value of values) {
    const added = await run(mgr, ["config", "add", key, value], cwd, environment);
    if (!added.ok) {
      console.error(`[bridge] manager: mgr config add ${key} ${value} failed (${added.stderr})`);
      return false;
    }
  }
  return true;
}
