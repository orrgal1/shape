/**
 * The one `Storage` implementation: every room's graphs, revisions, registry
 * row and audit line in a single SQLite file, through Node's built-in
 * `node:sqlite` (no dependency, no server process). Local mode opens the user's
 * own database (`~/.shape/shape.db`), a remote server opens
 * `<data-dir>/shape.db`; the schema and the code path are the same, so a
 * project behaves identically wherever it is hosted.
 *
 * Canvas state is keyed `(tenant, key, worktree)` — none of the three is a
 * filter a query may forget. Two tenants may hold the very same project key
 * (the same repo path on two machines) and neither may read the other's graph;
 * within one project, every worktree is its own canvas, and the view is what
 * merges them. The registry (`projects`) is per project, not per worktree: a
 * project's worktree list and running harnesses are two columns of one row.
 *
 * `DatabaseSync` is synchronous, so the `Storage` methods' promises are already
 * settled when they are returned. That is deliberate: a graph write can no
 * longer interleave with the next one, which is what the file-backed stores
 * needed their write queues for.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { GraphDoc, GraphSnapshot, RevisionInfo } from "../../../shared/src/index.ts";
import { mainWorktreeOf, parseRow, type AuditEntry, type Storage, type StoredProject } from "./storage.ts";

/** how many newest revisions of one worktree's canvas survive a save */
const RETENTION = 50;

/**
 * Bumped when the schema below changes in a way an older database lacks.
 *
 * 1 → 2: canvases became per worktree. `graphs`, `revisions` and `audit` gained
 * a `worktree` column (in the primary key of the first two), and `projects`
 * traded its single `session` for a `sessions` list.
 */
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE projects (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  project    TEXT NOT NULL,
  sessions   TEXT NOT NULL,
  worktrees  TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (tenant, key)
);
CREATE TABLE graphs (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  worktree   TEXT NOT NULL,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, key, worktree)
);
CREATE TABLE revisions (
  tenant   TEXT NOT NULL,
  key      TEXT NOT NULL,
  worktree TEXT NOT NULL,
  rev      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (tenant, key, worktree, rev)
);
CREATE TABLE audit (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant   TEXT NOT NULL,
  key      TEXT NOT NULL,
  worktree TEXT NOT NULL,
  at       TEXT NOT NULL,
  entry    TEXT NOT NULL
);
`;

/** Boundary validator: a snapshot row may have been written by an older bridge. */
function parseSnapshot(raw: unknown, rev: number): GraphSnapshot | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!("nodes" in raw) || !Array.isArray(raw.nodes)) return null;
  if (!("edges" in raw) || !Array.isArray(raw.edges)) return null;
  const at = "at" in raw && typeof raw.at === "string" ? raw.at : "";
  return {
    rev,
    at,
    nodes: raw.nodes as GraphSnapshot["nodes"],
    edges: raw.edges as GraphSnapshot["edges"],
  };
}

/** a TEXT column, as `node:sqlite` hands it back */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

class SqliteStorage implements Storage {
  readonly file: string;
  readonly #db: DatabaseSync;
  /** prepared once: every statement here runs on the hot path of a turn */
  readonly #getGraph: StatementSync;
  readonly #putGraph: StatementSync;
  readonly #listRevisions: StatementSync;
  readonly #getRevision: StatementSync;
  readonly #putRevision: StatementSync;
  readonly #pruneRevisions: StatementSync;
  readonly #listProjects: StatementSync;
  readonly #putProject: StatementSync;
  readonly #putAudit: StatementSync;
  /** the adoption of a legacy key: once per worktree per attach, not a hot path, but written once */
  readonly #dropGraph: StatementSync;
  readonly #dropRevisions: StatementSync;
  readonly #moveGraph: StatementSync;
  readonly #moveRevisions: StatementSync;
  readonly #legacyAudit: StatementSync;
  readonly #moveAuditLine: StatementSync;
  readonly #countGraphs: StatementSync;
  readonly #dropProject: StatementSync;
  /** one broken database is reported once, not per steer */
  #auditFailed = false;

  constructor(file: string) {
    this.file = file;
    this.#db = new DatabaseSync(file);
    // WAL so a browser reading while the agent writes never blocks, NORMAL
    // because a graph is re-derivable from the repo and worth less than a
    // fsync per op, and foreign_keys on so a later schema can rely on it
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();

    this.#getGraph = this.#db.prepare("SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?");
    this.#putGraph = this.#db.prepare(
      `INSERT INTO graphs (tenant, key, worktree, doc, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant, key, worktree) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
    );
    this.#listRevisions = this.#db.prepare("SELECT rev, at FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY rev ASC");
    this.#getRevision = this.#db.prepare("SELECT snapshot FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? AND rev = ?");
    // a rev means one graph forever: an existing row is kept, never overwritten
    this.#putRevision = this.#db.prepare(
      "INSERT OR IGNORE INTO revisions (tenant, key, worktree, rev, at, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
    );
    // retention is per worktree: a busy variation must not prune the history
    // of a quiet one it shares a project with
    this.#pruneRevisions = this.#db.prepare(
      `DELETE FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? AND rev NOT IN
         (SELECT rev FROM revisions WHERE tenant = ? AND key = ? AND worktree = ? ORDER BY rev DESC LIMIT ${RETENTION})`,
    );
    this.#listProjects = this.#db.prepare("SELECT tenant, key, project, sessions, worktrees, last_seen FROM projects ORDER BY last_seen ASC");
    this.#putProject = this.#db.prepare(
      `INSERT INTO projects (tenant, key, project, sessions, worktrees, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant, key) DO UPDATE SET
         project = excluded.project, sessions = excluded.sessions,
         worktrees = excluded.worktrees, last_seen = excluded.last_seen`,
    );
    this.#putAudit = this.#db.prepare("INSERT INTO audit (tenant, key, worktree, at, entry) VALUES (?, ?, ?, ?, ?)");
    this.#dropGraph = this.#db.prepare("DELETE FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?");
    this.#dropRevisions = this.#db.prepare("DELETE FROM revisions WHERE tenant = ? AND key = ? AND worktree = ?");
    this.#moveGraph = this.#db.prepare("UPDATE graphs SET key = ? WHERE tenant = ? AND key = ? AND worktree = ?");
    this.#moveRevisions = this.#db.prepare("UPDATE revisions SET key = ? WHERE tenant = ? AND key = ? AND worktree = ?");
    this.#legacyAudit = this.#db.prepare("SELECT seq, entry FROM audit WHERE tenant = ? AND key = ? AND worktree = ?");
    this.#moveAuditLine = this.#db.prepare("UPDATE audit SET key = ?, entry = ? WHERE seq = ?");
    this.#countGraphs = this.#db.prepare("SELECT 1 FROM graphs WHERE tenant = ? AND key = ? LIMIT 1");
    this.#dropProject = this.#db.prepare("DELETE FROM projects WHERE tenant = ? AND key = ?");
  }

  /**
   * `user_version` 0 is a database this process just created (or one from
   * before Shape kept state here at all): the schema is written whole. A
   * version this build does not know is left alone and reported — a newer
   * server's database is not ours to reshape.
   */
  #migrate(): void {
    const row = this.#db.prepare("PRAGMA user_version").get();
    const version = typeof row?.user_version === "number" ? row.user_version : 0;
    if (version === SCHEMA_VERSION) return;
    if (version > SCHEMA_VERSION) {
      throw new Error(`${this.file} was written by a newer Shape (schema ${version}, this build knows ${SCHEMA_VERSION})`);
    }
    if (version === 0) {
      this.#db.exec(SCHEMA);
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }
    this.#migrateToWorktrees();
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * 1 → 2: everything stored before worktrees existed was the canvas of ONE
   * directory — the project's `cwd`, the only place a harness ever ran. Those
   * rows become that directory's worktree, so a user who upgrades finds their
   * canvas on the main worktree instead of on a variation nobody opened.
   *
   * The id is the realpath of the `cwd` in the project's registry row, because
   * that is what a worktree id is; a project with no registry row left (a graph
   * whose row was pruned, a database hand-assembled by a smoke) has no cwd to
   * resolve, so its rows take the project key itself — an id no live worktree
   * can collide with, which keeps the canvas readable instead of merging it
   * into someone else's.
   *
   * The tables are rebuilt rather than altered: `worktree` belongs in the
   * primary key of `graphs` and `revisions`, and SQLite cannot add a column to
   * one. The single `session` of a registry row becomes a one-element
   * `sessions` list against the same main worktree when it named a resumable
   * session, and an empty list when it did not.
   */
  #migrateToWorktrees(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const legacy = this.#db.prepare("SELECT tenant, key, project, session FROM projects").all();
      /** (tenant, key) → the worktree its pre-worktree rows belong to */
      const mains = new Map<string, string>();
      /** (tenant, key) → the `sessions` JSON its single `session` becomes */
      const sessions = new Map<string, string>();
      for (const row of legacy) {
        const tenant = text(row.tenant);
        const key = text(row.key);
        const project = safeParse(text(row.project));
        const cwd =
          project !== null && typeof project === "object" && typeof (project as Record<string, unknown>).cwd === "string"
            ? (project as Record<string, unknown>).cwd as string
            : null;
        const worktree = cwd === null ? key : mainWorktreeOf(cwd);
        mains.set(`${tenant}\u0000${key}`, worktree);
        sessions.set(`${tenant}\u0000${key}`, migratedSessions(worktree, project, safeParse(text(row.session))));
      }

      this.#db.exec(`
CREATE TABLE graphs_v2 (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  worktree   TEXT NOT NULL,
  doc        TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, key, worktree)
);
CREATE TABLE revisions_v2 (
  tenant   TEXT NOT NULL,
  key      TEXT NOT NULL,
  worktree TEXT NOT NULL,
  rev      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (tenant, key, worktree, rev)
);
CREATE TABLE audit_v2 (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant   TEXT NOT NULL,
  key      TEXT NOT NULL,
  worktree TEXT NOT NULL,
  at       TEXT NOT NULL,
  entry    TEXT NOT NULL
);
CREATE TABLE projects_v2 (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  project    TEXT NOT NULL,
  sessions   TEXT NOT NULL,
  worktrees  TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (tenant, key)
);
`);

      const copyGraph = this.#db.prepare("INSERT INTO graphs_v2 (tenant, key, worktree, doc, updated_at) VALUES (?, ?, ?, ?, ?)");
      for (const row of this.#db.prepare("SELECT tenant, key, doc, updated_at FROM graphs").all()) {
        const tenant = text(row.tenant);
        const key = text(row.key);
        copyGraph.run(tenant, key, mains.get(`${tenant}\u0000${key}`) ?? key, text(row.doc), text(row.updated_at));
      }
      const copyRevision = this.#db.prepare(
        "INSERT INTO revisions_v2 (tenant, key, worktree, rev, at, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const row of this.#db.prepare("SELECT tenant, key, rev, at, snapshot FROM revisions").all()) {
        const tenant = text(row.tenant);
        const key = text(row.key);
        copyRevision.run(tenant, key, mains.get(`${tenant}\u0000${key}`) ?? key, Number(row.rev), text(row.at), text(row.snapshot));
      }
      // `seq` is copied so an operator's line numbers survive the upgrade
      const copyAudit = this.#db.prepare("INSERT INTO audit_v2 (seq, tenant, key, worktree, at, entry) VALUES (?, ?, ?, ?, ?, ?)");
      for (const row of this.#db.prepare("SELECT seq, tenant, key, at, entry FROM audit").all()) {
        const tenant = text(row.tenant);
        const key = text(row.key);
        const worktree = mains.get(`${tenant}\u0000${key}`) ?? key;
        const entry = safeParse(text(row.entry));
        // the stored line names its worktree too: it is read as a record, not
        // through the column it was filed under
        const stamped =
          entry !== null && typeof entry === "object" ? JSON.stringify({ ...(entry as Record<string, unknown>), worktree }) : text(row.entry);
        copyAudit.run(Number(row.seq), tenant, key, worktree, text(row.at), stamped);
      }
      const copyProject = this.#db.prepare(
        "INSERT INTO projects_v2 (tenant, key, project, sessions, worktrees, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const row of this.#db.prepare("SELECT tenant, key, project, worktrees, last_seen FROM projects").all()) {
        const tenant = text(row.tenant);
        const key = text(row.key);
        copyProject.run(
          tenant,
          key,
          text(row.project),
          sessions.get(`${tenant}\u0000${key}`) ?? "[]",
          migratedWorktrees(text(row.worktrees), mains.get(`${tenant}\u0000${key}`) ?? key),
          text(row.last_seen),
        );
      }

      this.#db.exec(`
DROP TABLE graphs;
DROP TABLE revisions;
DROP TABLE audit;
DROP TABLE projects;
ALTER TABLE graphs_v2 RENAME TO graphs;
ALTER TABLE revisions_v2 RENAME TO revisions;
ALTER TABLE audit_v2 RENAME TO audit;
ALTER TABLE projects_v2 RENAME TO projects;
`);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  loadGraph(tenant: string, key: string, worktree: string): Promise<GraphDoc | null> {
    const row = this.#getGraph.get(tenant, key, worktree);
    if (row === undefined) return Promise.resolve(null);
    try {
      // the caller shape-checks what comes back; this only has to be JSON
      return Promise.resolve(JSON.parse(text(row.doc)) as GraphDoc);
    } catch {
      console.error(`[bridge] ignoring unparseable graph for ${tenant}/${key} in ${worktree}`);
      return Promise.resolve(null);
    }
  }

  saveGraph(tenant: string, key: string, worktree: string, doc: GraphDoc): Promise<void> {
    this.#putGraph.run(tenant, key, worktree, JSON.stringify(doc), new Date().toISOString());
    return Promise.resolve();
  }

  listRevisions(tenant: string, key: string, worktree: string): Promise<RevisionInfo[]> {
    const rows = this.#listRevisions.all(tenant, key, worktree);
    return Promise.resolve(rows.map((row) => ({ rev: Number(row.rev), at: text(row.at) })));
  }

  loadRevision(tenant: string, key: string, worktree: string, rev: number): Promise<GraphSnapshot | null> {
    const row = this.#getRevision.get(tenant, key, worktree, rev);
    if (row === undefined) return Promise.resolve(null);
    try {
      return Promise.resolve(parseSnapshot(JSON.parse(text(row.snapshot)), rev));
    } catch {
      console.error(`[bridge] ignoring unparseable revision ${rev} for ${tenant}/${key} in ${worktree}`);
      return Promise.resolve(null);
    }
  }

  /**
   * Insert and prune as one transaction: a reader must never see a worktree
   * whose newest revision has been filed but whose oldest is still there to be
   * dropped, and a failed prune must not leave the insert behind.
   */
  saveRevision(tenant: string, key: string, worktree: string, snapshot: GraphSnapshot): Promise<boolean> {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const inserted =
        Number(this.#putRevision.run(tenant, key, worktree, snapshot.rev, snapshot.at, JSON.stringify(snapshot)).changes) > 0;
      if (inserted) this.#pruneRevisions.run(tenant, key, worktree, tenant, key, worktree);
      this.#db.exec("COMMIT");
      return Promise.resolve(inserted);
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  listProjects(): Promise<StoredProject[]> {
    const out: StoredProject[] = [];
    for (const raw of this.#listProjects.all()) {
      const row = parseRow({
        tenant: text(raw.tenant),
        project: safeParse(text(raw.project)),
        sessions: safeParse(text(raw.sessions)),
        worktrees: safeParse(text(raw.worktrees)),
        lastSeen: text(raw.last_seen),
      });
      // one unreadable row costs its own project, not every other room
      if (row === null) {
        console.error(`[bridge] ignoring unparseable project row ${text(raw.tenant)}/${text(raw.key)}`);
        continue;
      }
      out.push(row);
    }
    return Promise.resolve(out);
  }

  saveProject(row: StoredProject): Promise<void> {
    this.#putProject.run(
      row.tenant,
      row.project.key,
      JSON.stringify(row.project),
      JSON.stringify(row.sessions),
      JSON.stringify(row.worktrees),
      row.lastSeen,
    );
    return Promise.resolve();
  }

  appendAudit(tenant: string, key: string, worktree: string, entry: AuditEntry): Promise<void> {
    try {
      this.#putAudit.run(tenant, key, worktree, entry.at, JSON.stringify(entry));
    } catch (err) {
      // the record is best effort: whatever is wrong with the database, the
      // user still gets to steer, and the operator is told once
      if (!this.#auditFailed) {
        this.#auditFailed = true;
        console.error(`[bridge] audit write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return Promise.resolve();
  }

  /**
   * The rows are re-keyed rather than copied: one `UPDATE` per table keeps the
   * docs and snapshots byte-identical, and doing it inside one transaction
   * means a reader either sees the canvas under the old key or under the new
   * one, never twice and never nowhere.
   *
   * Whatever sits under the new key is dropped first (its graph is empty by the
   * time we get here, and its revisions are revisions of that empty canvas), but
   * its AUDIT lines stay: they record steering that really went through this
   * project and are not the canvas's to overwrite. The moved audit lines are
   * re-stamped with the new project id so an operator reading the record is not
   * shown a key nothing answers to any more.
   */
  adoptLegacyKey(tenant: string, legacyKey: string, key: string, worktree: string): Promise<boolean> {
    if (legacyKey === key) return Promise.resolve(false);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const legacy = this.#getGraph.get(tenant, legacyKey, worktree);
      // nothing was ever drawn under the old key for this worktree
      if (legacy === undefined) {
        this.#db.exec("COMMIT");
        return Promise.resolve(false);
      }
      const current = this.#getGraph.get(tenant, key, worktree);
      // a canvas already drawn under the current key is the newer truth: the
      // legacy rows are left where they are rather than thrown away
      if (current !== undefined && !isEmptyGraph(text(current.doc))) {
        this.#db.exec("COMMIT");
        return Promise.resolve(false);
      }

      this.#dropGraph.run(tenant, key, worktree);
      this.#dropRevisions.run(tenant, key, worktree);
      this.#moveGraph.run(key, tenant, legacyKey, worktree);
      this.#moveRevisions.run(key, tenant, legacyKey, worktree);
      for (const row of this.#legacyAudit.all(tenant, legacyKey, worktree)) {
        const entry = safeParse(text(row.entry));
        const stamped =
          entry !== null && typeof entry === "object"
            ? JSON.stringify({ ...(entry as Record<string, unknown>), projectId: key })
            : text(row.entry);
        this.#moveAuditLine.run(key, stamped, Number(row.seq));
      }
      // the legacy registry row is what makes the project show up twice in the
      // picker; it goes as soon as it has no canvas of its own left
      if (this.#countGraphs.get(tenant, legacyKey) === undefined) this.#dropProject.run(tenant, legacyKey);
      this.#db.exec("COMMIT");
      return Promise.resolve(true);
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}

/** a JSON column that may predate this build; `parseRow` rejects the leftovers */
function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * A stored graph nobody has drawn on: the row a fresh attach writes for a
 * worktree it has never seen. Zero nodes is the test — an edge cannot exist
 * without them, and a rev counter that has moved on its own says nothing about
 * whether there is a canvas to lose. An unreadable doc counts as empty: it is
 * not a canvas anyone can be shown.
 */
function isEmptyGraph(doc: string): boolean {
  const parsed = safeParse(doc);
  if (parsed === null || typeof parsed !== "object") return true;
  const nodes = (parsed as Record<string, unknown>).nodes;
  return !Array.isArray(nodes) || nodes.length === 0;
}

/**
 * A v1 registry row's single `session`, as the v2 `sessions` list: the harness
 * that was running was running in the project's main worktree, and nowhere
 * else. A row that named no session at all (and one whose project no longer
 * parses, so there is no backend to attribute it to) migrates to an empty
 * list rather than to a session nothing can resume.
 */
function migratedSessions(worktree: string, project: unknown, session: unknown): string {
  if (project === null || typeof project !== "object" || session === null || typeof session !== "object") return "[]";
  const backend = (project as Record<string, unknown>).backend;
  const sessionId = (session as Record<string, unknown>).sessionId;
  if (backend === null || typeof backend !== "object" || typeof sessionId !== "string" || sessionId.length === 0) return "[]";
  return JSON.stringify([{ worktree, session, backend, state: "idle" }]);
}

/**
 * A v1 worktree list, as v2 reads it: every row gains the `id` that addresses
 * it (the realpath of its `path`) and loses `current`, which no longer means
 * anything now that a project has no single current worktree. `main` stands in
 * for a row whose `path` is unusable, and a list that is not a list at all
 * migrates to the main worktree alone — the one worktree a project is certain
 * to have.
 */
function migratedWorktrees(stored: string, main: string): string {
  const parsed = safeParse(stored);
  if (!Array.isArray(parsed)) return JSON.stringify([{ id: main, path: main, branch: null, head: null }]);
  const out = [];
  for (const row of parsed as unknown[]) {
    if (row === null || typeof row !== "object") continue;
    const w = row as Record<string, unknown>;
    const path = typeof w.path === "string" && w.path.length > 0 ? w.path : main;
    out.push({
      id: mainWorktreeOf(path),
      path,
      branch: typeof w.branch === "string" ? w.branch : null,
      head: typeof w.head === "string" ? w.head : null,
    });
  }
  return JSON.stringify(out);
}

/**
 * Open (creating if need be) the database every room in this process stores
 * into. The parent directory is made first: `~/.shape/` may not exist on a
 * first run, and neither may an operator's fresh `--data-dir`.
 */
export function openSqliteStorage(file: string): Storage {
  mkdirSync(dirname(file), { recursive: true });
  return new SqliteStorage(file);
}
