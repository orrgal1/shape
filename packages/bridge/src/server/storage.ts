/**
 * Where a room's files live, and — remotely — which projects to reopen after a
 * restart. Local mode keeps today's layout inside the project itself
 * (`<cwd>/.shape/`) and needs no registry: the agent that owns the repo is what
 * brings the project back. A remote server owns one data dir for every project
 * it has ever hosted, so it must remember them itself; a row is everything a
 * room needs to come back agentless.
 *
 * Nothing here knows about rooms: a `Storage` answers where and what, the
 * server decides when.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProject, AgentSession, WorktreeInfo } from "../../../shared/src/index.ts";
import { parseProject, parseSession, parseWorktrees } from "../linkframes.ts";

/** what a room needs to come back without its agent */
export interface StoredProject {
  /** the project as its agent last attached it */
  project: AgentProject;
  /** the harness session as last known; the agent replaces it when it returns */
  session: AgentSession;
  worktrees: WorktreeInfo[];
  /** ISO time of the last attach or detach */
  lastSeen: string;
}

export interface Storage {
  /** directory holding <dir>/graph.json and <dir>/revisions/ for this project */
  dirFor(project: AgentProject): string;
  /** projects to reopen agentless at startup; [] when this storage keeps no registry */
  listProjects(): Promise<StoredProject[]>;
  /** upsert one registry row; a no-op for storages without a registry */
  saveProject(row: StoredProject): Promise<void>;
}

/**
 * Boundary validator: the registry was written by an older server, and a row
 * whose project or session no longer parses would open a room with holes in it.
 * Rows are the same shapes off the same producer as the attach frame, so they
 * are checked against the same validators.
 */
function parseRow(value: unknown): StoredProject | null {
  if (value === null || typeof value !== "object") return null;
  // an object from JSON.parse, checked immediately above
  const row = value as Record<string, unknown>;
  const project = parseProject(row.project);
  const session = parseSession(row.session);
  const worktrees = parseWorktrees(row.worktrees);
  if (project === null || session === null || worktrees === null) return null;
  if (typeof row.lastSeen !== "string" || row.lastSeen.length === 0) return null;
  return { project, session, worktrees, lastSeen: row.lastSeen };
}

/** local mode: the project's own `.shape/`, exactly as every earlier version wrote it */
export function projectDirStorage(): Storage {
  return {
    dirFor: (project) => join(project.cwd, ".shape"),
    listProjects: () => Promise.resolve([]),
    saveProject: () => Promise.resolve(),
  };
}

/**
 * Remote mode: `<root>/projects/<key>/` per project, registry at
 * `<root>/projects.json`. The registry is held in memory as well as on disk
 * because a save rewrites the whole array: re-reading the file per save would
 * race every other save. Writes are serialized and atomic (tmp + rename) like
 * `GraphStore.persist`, and a failed write is the caller's to report — it must
 * not poison the writes queued behind it.
 */
export function dataDirStorage(root: string): Storage {
  const file = join(root, "projects.json");
  const tmp = `${file}.tmp`;
  const rows = new Map<string, StoredProject>();
  let loaded = false;
  let writing: Promise<void> = Promise.resolve();

  const load = async (): Promise<StoredProject[]> => {
    loaded = true;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      // no registry yet: a server's first run, not a fault
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error(`[bridge] ignoring unparseable ${file}`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.error(`[bridge] ignoring unparseable ${file}`);
      return [];
    }
    const out: StoredProject[] = [];
    for (const raw of parsed as unknown[]) {
      const row = parseRow(raw);
      // one unreadable row costs its own project, not the whole registry
      if (row === null) {
        console.error(`[bridge] ignoring unparseable ${file}`);
        continue;
      }
      rows.set(row.project.key, row);
      out.push(row);
    }
    return out;
  };

  return {
    dirFor: (project) => join(root, "projects", project.key),
    listProjects: load,
    saveProject: async (row) => {
      // a save before any list would drop every project this server did not
      // itself attach: what is on disk is the base the upsert lands on
      if (!loaded) await load();
      rows.set(row.project.key, row);
      const text = `${JSON.stringify([...rows.values()], null, 2)}\n`;
      const done = writing.then(async () => {
        await mkdir(root, { recursive: true });
        await writeFile(tmp, text, "utf8");
        await rename(tmp, file);
      });
      writing = done.catch(() => undefined);
      return done;
    },
  };
}
