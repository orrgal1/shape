/**
 * Where a room's files live, and — remotely — which projects to reopen after a
 * restart. Local mode keeps today's layout inside the project itself
 * (`<cwd>/.shape/`) and needs no registry: the agent that owns the repo is what
 * brings the project back. A remote server owns one data dir for every project
 * it has ever hosted, so it must remember them itself; a row is everything a
 * room needs to come back agentless.
 *
 * Remotely everything is under the tenant that owns it: two tenants may hold
 * the very same project key (the same repo path on two machines) and neither
 * may read the other's graph, so the tenant is a path segment, not a filter.
 *
 * Nothing here knows about rooms: a `Storage` answers where and what, the
 * server decides when.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProject, AgentSession, Referent, WorktreeInfo } from "../../../shared/src/index.ts";
import { parseProject, parseSession, parseWorktrees } from "../linkframes.ts";
import { LOCAL_TENANT } from "./auth.ts";

/** what a room needs to come back without its agent */
export interface StoredProject {
  /** the project as its agent last attached it */
  project: AgentProject;
  /** the tenant whose room this is; `local` on an unauthenticated server */
  tenant: string;
  /** the harness session as last known; the agent replaces it when it returns */
  session: AgentSession;
  worktrees: WorktreeInfo[];
  /** ISO time of the last attach or detach */
  lastSeen: string;
}

/**
 * What was said to a harness through this server, and how it went out. On-prem
 * operators need that record for steering they did not type themselves; the
 * room stamps `at`/`tenant`/`projectId` onto one of these bodies.
 */
export type AuditBody =
  /** an utterance composed from the canvas and sent to the agent */
  | { kind: "deliver"; id: string; referent: Referent | null; text: string }
  /** the agent's receipt for a `deliver`: `steer` mid-turn or `prompt`, queued or not */
  | { kind: "delivered"; id: string; mode: "prompt" | "steer"; queued: boolean }
  /** the onboarding survey turn, whose text the server wrote */
  | { kind: "onboard"; id: string; focus: string | null };

export type AuditEntry = AuditBody & {
  at: string;
  tenant: string;
  projectId: string;
};

export interface Storage {
  /** directory holding <dir>/graph.json and <dir>/revisions/ for this project */
  dirFor(project: AgentProject, tenant: string): string;
  /** projects to reopen agentless at startup; [] when this storage keeps no registry */
  listProjects(): Promise<StoredProject[]>;
  /** upsert one registry row; a no-op for storages without a registry */
  saveProject(row: StoredProject): Promise<void>;
  /**
   * Append one audit line. Never rejects: a steer must not fail because a disk
   * did. A storage that keeps no audit (local mode) drops it.
   */
  appendAudit(project: AgentProject, tenant: string, entry: AuditEntry): Promise<void>;
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
  // a row from a server that predates tenants was written unauthenticated, so
  // it belongs to the tenant an unauthenticated connection gets: dropping it
  // instead would cost the operator every room across the upgrade
  const tenant = typeof row.tenant === "string" && row.tenant.length > 0 ? row.tenant : LOCAL_TENANT;
  return { project, tenant, session, worktrees, lastSeen: row.lastSeen };
}

/** local mode: the project's own `.shape/`, exactly as every earlier version wrote it */
export function projectDirStorage(): Storage {
  return {
    // one implicit tenant on a loopback server: the layout stays as it was
    dirFor: (project) => join(project.cwd, ".shape"),
    listProjects: () => Promise.resolve([]),
    saveProject: () => Promise.resolve(),
    // nothing to audit: whoever steers here is the user sitting at the machine
    appendAudit: () => Promise.resolve(),
  };
}

/**
 * Remote mode: `<root>/tenants/<tenant>/projects/<key>/` per project, registry
 * at `<root>/projects.json`. The registry is held in memory as well as on disk
 * because a save rewrites the whole array: re-reading the file per save would
 * race every other save. Writes are serialized and atomic (tmp + rename) like
 * `GraphStore.persist`, and a failed write is the caller's to report — it must
 * not poison the writes queued behind it.
 *
 * Rows are keyed by tenant AND project key: the same repo on two tenants'
 * machines is two rooms with two graphs, and one must never overwrite the
 * other's row.
 */
export function dataDirStorage(root: string): Storage {
  const file = join(root, "projects.json");
  const tmp = `${file}.tmp`;
  const rows = new Map<string, StoredProject>();
  let loaded = false;
  let writing: Promise<void> = Promise.resolve();
  /** audit lines are appended in order, and one failing disk is reported once */
  let appending: Promise<void> = Promise.resolve();
  let auditFailed = false;

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
      rows.set(`${row.tenant}/${row.project.key}`, row);
      out.push(row);
    }
    return out;
  };

  return {
    dirFor: (project, tenant) => join(root, "tenants", tenant, "projects", project.key),
    listProjects: load,
    saveProject: async (row) => {
      // a save before any list would drop every project this server did not
      // itself attach: what is on disk is the base the upsert lands on
      if (!loaded) await load();
      rows.set(`${row.tenant}/${row.project.key}`, row);
      const text = `${JSON.stringify([...rows.values()], null, 2)}\n`;
      const done = writing.then(async () => {
        await mkdir(root, { recursive: true });
        await writeFile(tmp, text, "utf8");
        await rename(tmp, file);
      });
      writing = done.catch(() => undefined);
      return done;
    },
    appendAudit: (project, tenant, entry) => {
      // beside the graph it is about, so a project's whole history moves as one
      const dir = join(root, "tenants", tenant, "projects", project.key);
      const line = `${JSON.stringify(entry)}\n`;
      // one appendFile at a time: concurrent appends of the same line-oriented
      // file are only atomic below the pipe buffer, and a steer can be long
      appending = appending.then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, "audit.jsonl"), line, "utf8");
      });
      appending = appending.catch((err: unknown) => {
        // the record is best effort: whatever is wrong with the disk, the user
        // still gets to steer, and the operator is told once
        if (auditFailed) return;
        auditFailed = true;
        console.error(`[bridge] audit write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return appending;
    },
  };
}
