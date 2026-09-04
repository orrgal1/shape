/**
 * One-shot import of the layout Shape used before it kept state in SQLite:
 * `<project>/.shape/graph.json` plus `<project>/.shape/revisions/<rev>.json`
 * locally, and `<data-dir>/tenants/<tenant>/projects/<key>/` with a
 * `projects.json` registry remotely.
 *
 * A user upgrading must not lose the canvas they drew, so the files are read
 * once, written into the database, and — locally — moved aside, so the next
 * attach has nothing to import and the repo is left with only its `config.json`.
 * Everything here is tolerant: a file that no longer parses is skipped with a
 * line on stderr, because a broken leftover must never stop a project opening.
 */

import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProject, GraphDoc, GraphSnapshot } from "../../../shared/src/index.ts";
import { mainWorktreeOf, parseRow, type Storage } from "./storage.ts";

const REV_FILE_RE = /^(\d+)\.json$/;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Tolerant read: a missing file and an unparseable one are both "nothing here". */
async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[bridge] skipping unparseable ${file}`);
    return null;
  }
}

/**
 * Move one project's `<dir>/graph.json` and `<dir>/revisions/` into the
 * database, as the canvas of `worktree`. Returns false when there is nothing
 * to import, so the caller can stay quiet about projects that never had files.
 * Revisions go in oldest first, so a project with more than the retention
 * limit keeps its newest ones.
 */
async function importShapeDir(
  storage: Storage,
  tenant: string,
  key: string,
  worktree: string,
  dir: string,
): Promise<boolean> {
  const stored = await readJson(join(dir, "graph.json"));
  if (stored === null || typeof stored !== "object") return false;
  await storage.saveGraph(tenant, key, worktree, stored as GraphDoc);

  const revDir = join(dir, "revisions");
  let names: string[];
  try {
    names = await readdir(revDir);
  } catch {
    names = [];
  }
  const revs = names
    .map((name) => REV_FILE_RE.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  for (const rev of revs) {
    const raw = await readJson(join(revDir, `${rev}.json`));
    if (raw === null || typeof raw !== "object") continue;
    if (!("nodes" in raw) || !Array.isArray(raw.nodes)) continue;
    if (!("edges" in raw) || !Array.isArray(raw.edges)) continue;
    const at = "at" in raw && typeof raw.at === "string" ? raw.at : new Date(0).toISOString();
    const snapshot: GraphSnapshot = {
      rev,
      at,
      nodes: raw.nodes as GraphSnapshot["nodes"],
      edges: raw.edges as GraphSnapshot["edges"],
    };
    await storage.saveRevision(tenant, key, worktree, snapshot);
  }
  return true;
}

/**
 * Local mode: the project's own `.shape/` is where its canvas used to live.
 * Only ever runs for a project the database has no graph for — a project
 * already in the database has been imported (or was born there), and its files
 * are out of the way. `config.json` and the directory itself stay: that is the
 * user's backend choice, not canvas state.
 *
 * The canvas lands on the MAIN worktree (`project.cwd`): it was drawn when a
 * project had exactly one directory, and that is the one it was drawn from.
 *
 * The files are moved aside, never deleted: a bridge pointed at a throwaway
 * database (`--db`, a smoke's `SHAPE_HOME`) imports just the same, and the
 * only copy of a canvas must survive that. A second import lands beside the
 * first under a timestamped name rather than over it.
 */
export async function importLegacyProject(storage: Storage, tenant: string, project: AgentProject): Promise<void> {
  const worktree = mainWorktreeOf(project.cwd);
  if ((await storage.loadGraph(tenant, project.key, worktree)) !== null) return;
  const dir = join(project.cwd, ".shape");
  let imported: boolean;
  try {
    imported = await importShapeDir(storage, tenant, project.key, worktree, dir);
  } catch (err) {
    // an unreadable leftover costs the user their old canvas, never the project
    console.error(`[bridge] could not import ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!imported) return;
  let aside = join(dir, "imported");
  if (await exists(aside)) aside = `${aside}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await mkdir(aside, { recursive: true });
  await rename(join(dir, "graph.json"), join(aside, "graph.json")).catch(() => undefined);
  await rename(join(dir, "revisions"), join(aside, "revisions")).catch(() => undefined);
  console.error(`[bridge] imported ${dir} into ${storage.file} (files kept under ${aside})`);
}

/**
 * Remote mode: one pass over `<root>/projects.json` at startup, before any room
 * opens. The per-project directories are left where they are — inert once their
 * contents are in the database — and the registry is renamed rather than
 * deleted, both so an operator can still see what the old layout held and so a
 * second startup does not import twice.
 *
 * As locally, an old canvas is the main worktree's: `project.cwd` is the only
 * directory the row knows about.
 */
export async function importLegacyDataDir(storage: Storage, root: string): Promise<void> {
  const file = join(root, "projects.json");
  const parsed = await readJson(file);
  if (!Array.isArray(parsed)) return;
  let count = 0;
  for (const raw of parsed as unknown[]) {
    const row = parseRow(raw);
    if (row === null) {
      console.error(`[bridge] skipping unparseable row in ${file}`);
      continue;
    }
    const dir = join(root, "tenants", row.tenant, "projects", row.project.key);
    const worktree = mainWorktreeOf(row.project.cwd);
    try {
      if ((await storage.loadGraph(row.tenant, row.project.key, worktree)) === null) {
        await importShapeDir(storage, row.tenant, row.project.key, worktree, dir);
      }
      await storage.saveProject(row);
      count++;
    } catch (err) {
      console.error(`[bridge] could not import ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await rename(file, `${file}.imported`).catch(() => undefined);
  console.error(`[bridge] imported ${count} project(s) from ${file} into ${storage.file}`);
}
