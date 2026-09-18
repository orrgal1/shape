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
import { snapshotGraph } from "../../../shared/src/delta.ts";
import { applyOps, emptyGraph } from "../../../shared/src/index.ts";
import type {
  CanvasBranchInfo,
  ControlErrorResponse,
  GraphDoc,
  GraphSnapshot,
  LiveUpdateRequest,
  LiveUpdatedResponse,
  MapCommitRequest,
  MapCommittedResponse,
  ProjectStatus,
  RevisionInfo,
} from "../../../shared/src/index.ts";
import {
  mainWorktreeOf,
  parseRow,
  type AuditEntry,
  type Storage,
  type StoredBranchState,
  type StoredProject,
} from "./storage.ts";

/** how many newest revisions of one branch's canvas survive a save */
const RETENTION = 50;

/**
 * 1 → 2 made canvases per worktree; 2 → 3 added durable project status.
 * 3 → 4 introduces repository+full-branch identity and separates the trusted
 * committed baseline/checkpoint from the visible effective graph.
 */
const SCHEMA_VERSION = 4;

const SCHEMA = `
CREATE TABLE projects (
  tenant            TEXT NOT NULL,
  key               TEXT NOT NULL,
  project           TEXT NOT NULL,
  sessions          TEXT NOT NULL,
  worktrees         TEXT NOT NULL,
  last_seen         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  status_changed_at TEXT NOT NULL,
  live_sessions     INTEGER NOT NULL DEFAULT 0,
  control_only     INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE branches (
  tenant        TEXT NOT NULL,
  key           TEXT NOT NULL,
  id            TEXT NOT NULL,
  branch        TEXT NOT NULL,
  head          TEXT,
  mapped_commit TEXT,
  live          INTEGER NOT NULL DEFAULT 0,
  path          TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  baseline      TEXT,
  effective     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant, key, id)
);
CREATE TABLE branch_live_sessions (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  branch     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, key, branch, session_id)
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

function fullBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

function shortBranchName(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

function parseGraph(raw: string): GraphDoc | null {
  const value = safeParse(raw);
  if (value === null || typeof value !== "object") return null;
  const source = value as Partial<GraphDoc>;
  if (!Array.isArray(source.nodes) || !Array.isArray(source.edges)) return null;
  const doc = emptyGraph();
  if (typeof source.rev === "number" && Number.isInteger(source.rev) && source.rev >= 0) doc.rev = source.rev;
  doc.nodes = source.nodes.map((node) =>
    (node.layer as string | undefined) === "verify" ? { ...node, layer: "correctness" } : node,
  );
  doc.edges = source.edges;
  if (source.reality !== null && typeof source.reality === "object") {
    doc.reality = {
      ...doc.reality,
      ...source.reality,
      nodes: Array.isArray(source.reality.nodes) ? source.reality.nodes : [],
      edges: Array.isArray(source.reality.edges) ? source.reality.edges : [],
      symbols: Array.isArray(source.reality.symbols) ? source.reality.symbols : [],
      infra: Array.isArray(source.reality.infra) ? source.reality.infra : [],
      verification: Array.isArray(source.reality.verification) ? source.reality.verification : [],
    };
  }
  if (source.drift !== null && typeof source.drift === "object") doc.drift = source.drift;
  if (source.surveyed !== null && typeof source.surveyed === "object") doc.surveyed = source.surveyed;
  return doc;
}

function controlError(
  requestId: string,
  code: ControlErrorResponse["code"],
  message: string,
): ControlErrorResponse {
  return { type: "control_error", requestId, code, message };
}

function documentsEqual(left: GraphDoc, right: GraphDoc): boolean {
  return JSON.stringify({ ...left, rev: 0 }) === JSON.stringify({ ...right, rev: 0 });
}

/** An unmapped branch is dirty only when it has semantic canvas content. */
function hasIntentContent(doc: GraphDoc): boolean {
  return doc.nodes.length > 0 || doc.edges.length > 0;
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
  readonly #listBranches: StatementSync;
  readonly #getBranch: StatementSync;
  readonly #putBranchMetadata: StatementSync;
  readonly #putMappedBranch: StatementSync;
  readonly #putEffectiveBranch: StatementSync;
  readonly #updateBranchGraph: StatementSync;
  readonly #strictPutRevision: StatementSync;
  readonly #putLiveSession: StatementSync;
  readonly #dropLiveSession: StatementSync;
  readonly #hasLiveSession: StatementSync;
  readonly #dropLiveSessions: StatementSync;
  readonly #listProjects: StatementSync;
  readonly #putProject: StatementSync;
  readonly #setStatus: StatementSync;
  readonly #hasProject: StatementSync;
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
  /** one broken database is reported once, not per audit line */
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
    // Live session ids describe connections in this process, never durable
    // resumable sessions. Preserve overlays, but clear stale process activity.
    this.#resetTransientLiveSessions();

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
    this.#listBranches = this.#db.prepare(
      `SELECT id, branch, head, mapped_commit, live, path, is_default
         FROM branches WHERE tenant = ? AND key = ? ORDER BY is_default DESC, branch ASC, id ASC`,
    );
    this.#getBranch = this.#db.prepare(
      `SELECT id, branch, head, mapped_commit, live, path, is_default, baseline, effective
         FROM branches WHERE tenant = ? AND key = ? AND id = ?`,
    );
    this.#putBranchMetadata = this.#db.prepare(
      `INSERT INTO branches
         (tenant, key, id, branch, head, mapped_commit, live, path, is_default, baseline, effective, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (tenant, key, id) DO UPDATE SET
         branch = excluded.branch, head = excluded.head, path = excluded.path,
         is_default = excluded.is_default,
         live = CASE WHEN branches.live = 1 OR excluded.live = 1 THEN 1 ELSE 0 END,
         updated_at = excluded.updated_at`,
    );
    this.#putMappedBranch = this.#db.prepare(
      `INSERT INTO branches
         (tenant, key, id, branch, head, mapped_commit, live, path, is_default, baseline, effective, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant, key, id) DO UPDATE SET
         branch = excluded.branch, head = excluded.head,
         mapped_commit = excluded.mapped_commit, live = 0, path = excluded.path,
         baseline = excluded.baseline, effective = excluded.effective,
         updated_at = excluded.updated_at`,
    );
    this.#putEffectiveBranch = this.#db.prepare(
      "UPDATE branches SET effective = ?, live = ?, updated_at = ? WHERE tenant = ? AND key = ? AND id = ?",
    );
    this.#updateBranchGraph = this.#db.prepare(
      "UPDATE branches SET effective = ?, live = 1, updated_at = ? WHERE tenant = ? AND key = ? AND id = ?",
    );
    this.#strictPutRevision = this.#db.prepare(
      "INSERT INTO revisions (tenant, key, worktree, rev, at, snapshot) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#putLiveSession = this.#db.prepare(
      `INSERT INTO branch_live_sessions (tenant, key, branch, session_id, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant, key, branch, session_id) DO UPDATE SET
         state = excluded.state, updated_at = excluded.updated_at`,
    );
    this.#dropLiveSession = this.#db.prepare(
      "DELETE FROM branch_live_sessions WHERE tenant = ? AND key = ? AND branch = ? AND session_id = ?",
    );
    this.#hasLiveSession = this.#db.prepare(
      "SELECT 1 FROM branch_live_sessions WHERE tenant = ? AND key = ? AND branch = ? LIMIT 1",
    );
    this.#dropLiveSessions = this.#db.prepare(
      "DELETE FROM branch_live_sessions WHERE tenant = ? AND key = ? AND branch = ?",
    );
    this.#listProjects = this.#db.prepare(
      `SELECT tenant, key, project, sessions, worktrees, last_seen, status, status_changed_at, live_sessions, control_only
         FROM projects ORDER BY last_seen ASC`,
    );
    // `status` and `status_changed_at` are inserted and then left alone: a save
    // is what a room does every time its worktrees or sessions move, and it
    // must never undo the operator's last active/inactive decision
    this.#putProject = this.#db.prepare(
      `INSERT INTO projects
         (tenant, key, project, sessions, worktrees, last_seen, status, status_changed_at, live_sessions, control_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant, key) DO UPDATE SET
         project = excluded.project, sessions = excluded.sessions,
         worktrees = excluded.worktrees, last_seen = excluded.last_seen,
         live_sessions = excluded.live_sessions, control_only = excluded.control_only`,
    );
    // `status <> ?` makes asking for the status a row already has a no-op:
    // `status_changed_at` is when the status CHANGED, not when it was last
    // confirmed. It also means `changes` cannot tell "no such row" from
    // "already there", so existence is answered separately
    this.#setStatus = this.#db.prepare(
      "UPDATE projects SET status = ?, status_changed_at = ? WHERE tenant = ? AND key = ? AND status <> ?",
    );
    this.#hasProject = this.#db.prepare("SELECT 1 FROM projects WHERE tenant = ? AND key = ? LIMIT 1");
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
    // Walk every historical step once; a v1 database first becomes v2, then
    // receives the v3 status columns, then the v4 durable branch domain.
    if (version === 1) this.#migrateToWorktrees();
    if (version <= 2) this.#migrateToStatus();
    this.#migrateToBranches();
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Live control sessions are process-local connections. A restart keeps their
   * effective overlay, clears stale session ids, and derives the durable live
   * marker solely from whether the effective graph is still uncommitted.
   */
  #resetTransientLiveSessions(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec("DELETE FROM branch_live_sessions");
      const update = this.#db.prepare(
        "UPDATE branches SET live = ? WHERE tenant = ? AND key = ? AND id = ?",
      );
      // Session ids are process-local; only semantic intent is an unmapped overlay.
      for (const row of this.#db.prepare(
        "SELECT tenant, key, id, baseline, effective FROM branches",
      ).all()) {
        const baseline = row.baseline === null ? null : parseGraph(text(row.baseline));
        const effective = parseGraph(text(row.effective));
        const live =
          effective === null ||
          (row.baseline === null
            ? hasIntentContent(effective)
            : baseline === null || !documentsEqual(effective, baseline));
        update.run(live ? 1 : 0, text(row.tenant), text(row.key), text(row.id));
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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

  /**
   * 2 → 3: a project stopped being "a room the agent brought back" and became a
   * registry row with a status. Every row that already existed is a project the
   * operator was working in, so it migrates ACTIVE — the column's default does
   * that on its own.
   *
   * `ALTER TABLE ADD COLUMN` is enough here where 1 → 2 had to rebuild the
   * tables: none of the three columns is part of a primary key, and SQLite can
   * only add a column, never change a key. `status_changed_at` is added with an
   * empty default (a NOT NULL column needs one for the rows already there) and
   * then stamped with the migration time, so the switcher's "since" is the
   * moment we learned about the status rather than the epoch.
   */
  #migrateToStatus(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
      this.#db.exec("ALTER TABLE projects ADD COLUMN status_changed_at TEXT NOT NULL DEFAULT ''");
      this.#db.exec("ALTER TABLE projects ADD COLUMN live_sessions INTEGER NOT NULL DEFAULT 0");
      this.#db.prepare("UPDATE projects SET status_changed_at = ? WHERE status_changed_at = ''").run(new Date().toISOString());
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 3 → 4: derive durable branch records only from named worktrees in the
   * registry. Detached, ambiguous and colliding history stays in the legacy
   * tables under its physical key. A migrated effective graph is explicitly
   * uncommitted: neither a baseline nor a mapped commit is invented.
   */
  #migrateToBranches(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.exec("ALTER TABLE projects ADD COLUMN control_only INTEGER NOT NULL DEFAULT 0");
      this.#db.exec(`
CREATE TABLE branches (
  tenant        TEXT NOT NULL,
  key           TEXT NOT NULL,
  id            TEXT NOT NULL,
  branch        TEXT NOT NULL,
  head          TEXT,
  mapped_commit TEXT,
  live          INTEGER NOT NULL DEFAULT 0,
  path          TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  baseline      TEXT,
  effective     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (tenant, key, id)
);
CREATE TABLE branch_live_sessions (
  tenant     TEXT NOT NULL,
  key        TEXT NOT NULL,
  branch     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant, key, branch, session_id)
);
`);
      const getGraph = this.#db.prepare(
        "SELECT doc FROM graphs WHERE tenant = ? AND key = ? AND worktree = ?",
      );
      const hasRevisionConflict = this.#db.prepare(
        `SELECT 1 FROM revisions old
           JOIN revisions current
             ON current.tenant = old.tenant AND current.key = old.key AND current.rev = old.rev
          WHERE old.tenant = ? AND old.key = ? AND old.worktree = ? AND current.worktree = ?
          LIMIT 1`,
      );
      const moveGraph = this.#db.prepare(
        "UPDATE graphs SET worktree = ? WHERE tenant = ? AND key = ? AND worktree = ?",
      );
      const moveRevisions = this.#db.prepare(
        "UPDATE revisions SET worktree = ? WHERE tenant = ? AND key = ? AND worktree = ?",
      );
      const insertBranch = this.#db.prepare(
        `INSERT INTO branches
           (tenant, key, id, branch, head, mapped_commit, live, path, is_default, baseline, effective, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
      );
      const now = new Date().toISOString();

      for (const project of this.#db.prepare("SELECT tenant, key, worktrees FROM projects").all()) {
        const tenant = text(project.tenant);
        const key = text(project.key);
        const raw = safeParse(text(project.worktrees));
        if (!Array.isArray(raw)) continue;
        const groups = new Map<string, { row: Record<string, unknown>; index: number }[]>();
        raw.forEach((value, index) => {
          if (value === null || typeof value !== "object") return;
          const row = value as Record<string, unknown>;
          if (typeof row.branch !== "string" || row.branch.length === 0) return;
          const id = fullBranchRef(row.branch);
          const rows = groups.get(id) ?? [];
          rows.push({ row, index });
          groups.set(id, rows);
        });

        for (const [id, entries] of groups) {
          const first = entries[0];
          if (first === undefined) continue;
          const only = entries.length === 1 ? first : null;
          const branch = shortBranchName(id);
          const heads = new Set(entries.map((entry) => entry.row.head).filter((head): head is string => typeof head === "string"));
          const [singleHead, ...otherHeads] = heads;
          const head = singleHead !== undefined && otherHeads.length === 0 ? singleHead : null;
          const path = only !== null && typeof only.row.path === "string" ? only.row.path : null;
          let effective = emptyGraph();
          let live = false;

          if (only !== null && typeof only.row.id === "string" && only.row.id.length > 0) {
            const source = only.row.id;
            const sourceGraph = getGraph.get(tenant, key, source);
            const targetGraph = source === id ? sourceGraph : getGraph.get(tenant, key, id);
            const conflict =
              source !== id &&
              (targetGraph !== undefined || hasRevisionConflict.get(tenant, key, source, id) !== undefined);
            if (!conflict) {
              if (source !== id) {
                moveGraph.run(id, tenant, key, source);
                moveRevisions.run(id, tenant, key, source);
              }
              const parsed = sourceGraph === undefined ? null : parseGraph(text(sourceGraph.doc));
              if (parsed !== null) {
                effective = parsed;
                live = hasIntentContent(parsed);
              }
            }
          }

          insertBranch.run(
            tenant,
            key,
            id,
            branch,
            head,
            live ? 1 : 0,
            path,
            entries.some((entry) => entry.index === 0) ? 1 : 0,
            JSON.stringify(effective),
            now,
          );
        }
      }
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  loadGraph(tenant: string, key: string, branch: string): Promise<GraphDoc | null> {
    const durable = this.#getBranch.get(tenant, key, branch);
    if (durable !== undefined) return Promise.resolve(parseGraph(text(durable.effective)));
    const row = this.#getGraph.get(tenant, key, branch);
    if (row === undefined) return Promise.resolve(null);
    const parsed = parseGraph(text(row.doc));
    if (parsed === null) console.error(`[bridge] ignoring unparseable graph for ${tenant}/${key} in ${branch}`);
    return Promise.resolve(parsed);
  }

  saveGraph(tenant: string, key: string, branch: string, doc: GraphDoc): Promise<void> {
    const stored = JSON.stringify(doc);
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#putGraph.run(tenant, key, branch, stored, now);
      const durable = this.#getBranch.get(tenant, key, branch);
      if (durable !== undefined) {
        const baseline = durable.baseline === null ? null : parseGraph(text(durable.baseline));
        const hasSession = this.#hasLiveSession.get(tenant, key, branch) !== undefined;
        const live =
          hasSession ||
          (durable.baseline === null
            ? hasIntentContent(doc)
            : baseline === null || !documentsEqual(doc, baseline));
        this.#putEffectiveBranch.run(stored, live ? 1 : 0, now, tenant, key, branch);
      }
      this.#db.exec("COMMIT");
      return Promise.resolve();
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
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

  listBranches(tenant: string, key: string): Promise<CanvasBranchInfo[]> {
    return Promise.resolve(this.#listBranches.all(tenant, key).map((row) => ({
      id: text(row.id),
      branch: text(row.branch),
      head: row.head === null ? null : text(row.head),
      mappedCommit: row.mapped_commit === null ? null : text(row.mapped_commit),
      live: Number(row.live) !== 0,
      path: row.path === null ? null : text(row.path),
      isDefault: Number(row.is_default) !== 0,
    })));
  }

  readBranch(tenant: string, key: string, branch: string): Promise<StoredBranchState | null> {
    const row = this.#getBranch.get(tenant, key, branch);
    if (row === undefined) return Promise.resolve(null);
    const effective = parseGraph(text(row.effective));
    if (effective === null) return Promise.resolve(null);
    const baseline = row.baseline === null ? null : parseGraph(text(row.baseline));
    if (row.baseline !== null && baseline === null) return Promise.resolve(null);
    return Promise.resolve({
      info: {
        id: text(row.id),
        branch: text(row.branch),
        head: row.head === null ? null : text(row.head),
        mappedCommit: row.mapped_commit === null ? null : text(row.mapped_commit),
        live: Number(row.live) !== 0,
        path: row.path === null ? null : text(row.path),
        isDefault: Number(row.is_default) !== 0,
      },
      baseline,
      effective,
    });
  }

  upsertBranch(tenant: string, key: string, info: CanvasBranchInfo): Promise<void> {
    const now = new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const before = this.#getBranch.get(tenant, key, info.id);
      this.#putBranchMetadata.run(
        tenant,
        key,
        info.id,
        info.branch,
        info.head,
        info.live ? 1 : 0,
        info.path,
        info.isDefault ? 1 : 0,
        JSON.stringify(emptyGraph()),
        now,
      );

      // A room may discover a checkout after the v4 migration ran. Adopt its
      // physical-keyed history only into a pristine, unmapped branch and only
      // when no target graph or revision would be overwritten.
      const priorEffective = before === undefined ? emptyGraph() : parseGraph(text(before.effective));
      const pristine =
        before === undefined ||
        (before.baseline === null &&
          before.mapped_commit === null &&
          priorEffective !== null &&
          priorEffective.rev === 0 &&
          priorEffective.nodes.length === 0 &&
          priorEffective.edges.length === 0);
      if (pristine && info.path !== null && info.path !== info.id) {
        const source = this.#getGraph.get(tenant, key, info.path);
        const target = this.#getGraph.get(tenant, key, info.id);
        const targetDoc = target === undefined ? null : parseGraph(text(target.doc));
        const targetIsPlaceholder =
          target === undefined || (targetDoc !== null && !hasIntentContent(targetDoc));
        const revisionConflict = this.#db.prepare(
          `SELECT 1 FROM revisions old
             JOIN revisions current
               ON current.tenant = old.tenant AND current.key = old.key AND current.rev = old.rev
            WHERE old.tenant = ? AND old.key = ? AND old.worktree = ? AND current.worktree = ?
            LIMIT 1`,
        ).get(tenant, key, info.path, info.id);
        if (targetIsPlaceholder && revisionConflict === undefined) {
          // Discovery can open an agentless room before the first attach and
          // create an empty branch graph/revision. It is only a placeholder:
          // replace it with the historical physical canvas rather than letting
          // it block the one-time migration.
          this.#dropGraph.run(tenant, key, info.id);
          this.#dropRevisions.run(tenant, key, info.id);
          this.#db.prepare("UPDATE graphs SET worktree = ? WHERE tenant = ? AND key = ? AND worktree = ?")
            .run(info.id, tenant, key, info.path);
          this.#db.prepare("UPDATE revisions SET worktree = ? WHERE tenant = ? AND key = ? AND worktree = ?")
            .run(info.id, tenant, key, info.path);
          const adopted = source === undefined ? null : parseGraph(text(source.doc));
          if (adopted !== null) {
            const live = hasIntentContent(adopted);
            this.#putEffectiveBranch.run(JSON.stringify(adopted), live ? 1 : 0, now, tenant, key, info.id);
          }
        }
      }
      this.#db.exec("COMMIT");
      return Promise.resolve();
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  mapCommit(
    tenant: string,
    request: MapCommitRequest,
    project?: StoredProject,
  ): Promise<MapCommittedResponse | ControlErrorResponse> {
    if (!request.branch.startsWith("refs/heads/") || request.branch.length === "refs/heads/".length) {
      return Promise.resolve(controlError(request.requestId, "invalid", "branch must be a full refs/heads/<name> reference"));
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.commit)) {
      return Promise.resolve(controlError(request.requestId, "invalid", "commit must be an exact hexadecimal Git object id"));
    }
    if (!Array.isArray(request.ops)) {
      return Promise.resolve(controlError(request.requestId, "invalid", "ops must be an array"));
    }
    if (project !== undefined && (project.tenant !== tenant || project.project.key !== request.repository.id)) {
      return Promise.resolve(controlError(request.requestId, "invalid", "project registration does not match the mapped repository"));
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const key = request.repository.id;
      const row = this.#getBranch.get(tenant, key, request.branch);
      const current = row === undefined ? emptyGraph() : parseGraph(text(row.effective));
      if (current === null) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(request.requestId, "invalid", "stored effective graph is unreadable"));
      }
      const mappedCommit = row === undefined || row.mapped_commit === null ? null : text(row.mapped_commit);
      if (current.rev !== request.expectedRevision || mappedCommit !== request.expectedMappedCommit) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(
          request.requestId,
          "conflict",
          `mapping changed: expected revision ${request.expectedRevision} at ${request.expectedMappedCommit ?? "no checkpoint"}`,
        ));
      }

      const storedBaseline = row === undefined || row.baseline === null ? null : parseGraph(text(row.baseline));
      if (row !== undefined && row.baseline !== null && storedBaseline === null) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(request.requestId, "invalid", "stored committed baseline is unreadable"));
      }
      if (request.mode === "incremental" && (mappedCommit === null || storedBaseline === null)) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(request.requestId, "not_mapped", "incremental mapping requires an existing committed baseline"));
      }
      if (request.mode === "initial" && mappedCommit !== null) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(request.requestId, "conflict", "initial mapping cannot replace an existing checkpoint"));
      }

      const next = structuredClone(request.mode === "incremental" ? storedBaseline as GraphDoc : emptyGraph());
      const applied = applyOps(next, request.ops);
      if (applied.rejections.length > 0) {
        this.#db.exec("ROLLBACK");
        const reasons = applied.rejections.map((rejection) => `${rejection.index}:${rejection.code}`).join(", ");
        return Promise.resolve(controlError(request.requestId, "invalid", `mapping operations rejected (${reasons})`));
      }
      next.reality = structuredClone(request.reality);
      next.drift = {};
      next.surveyed = { head: request.commit, at: new Date().toISOString() };
      next.rev = current.rev + 1;

      const now = new Date().toISOString();
      const serialized = JSON.stringify(next);
      const snapshot = snapshotGraph(next);
      const isDefault =
        row === undefined
          ? this.#db.prepare("SELECT 1 FROM branches WHERE tenant = ? AND key = ? LIMIT 1").get(tenant, key) === undefined
          : Number(row.is_default) !== 0;
      this.#strictPutRevision.run(tenant, key, request.branch, snapshot.rev, snapshot.at, JSON.stringify(snapshot));
      this.#putMappedBranch.run(
        tenant,
        key,
        request.branch,
        shortBranchName(request.branch),
        request.commit,
        request.commit,
        request.repository.path,
        isDefault ? 1 : 0,
        serialized,
        serialized,
        now,
      );
      this.#putGraph.run(tenant, key, request.branch, serialized, now);
      this.#dropLiveSessions.run(tenant, key, request.branch);
      this.#pruneRevisions.run(tenant, key, request.branch, tenant, key, request.branch);
      if (project !== undefined) {
        this.#putProject.run(
          project.tenant,
          project.project.key,
          JSON.stringify(project.project),
          JSON.stringify(project.sessions),
          JSON.stringify(project.worktrees),
          project.lastSeen,
          project.status,
          project.statusChangedAt,
          project.liveSessions,
          project.controlOnly ? 1 : 0,
        );
      }
      this.#db.exec("COMMIT");
      return Promise.resolve({
        type: "map_committed",
        requestId: request.requestId,
        projectId: key,
        branch: request.branch,
        revision: next.rev,
        mappedCommit: request.commit,
      });
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  liveUpdate(
    tenant: string,
    request: LiveUpdateRequest,
  ): Promise<LiveUpdatedResponse | ControlErrorResponse> {
    if (!request.branch.startsWith("refs/heads/") || request.branch.length === "refs/heads/".length) {
      return Promise.resolve(controlError(request.requestId, "invalid", "branch must be a full refs/heads/<name> reference"));
    }
    if (request.ops !== undefined && !Array.isArray(request.ops)) {
      return Promise.resolve(controlError(request.requestId, "invalid", "ops must be an array"));
    }

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const key = request.repository.id;
      const row = this.#getBranch.get(tenant, key, request.branch);
      if (row === undefined || row.mapped_commit === null || row.baseline === null) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(
          request.requestId,
          "not_mapped",
          "run shape map for this repository branch before starting live updates",
        ));
      }
      const effective = parseGraph(text(row.effective));
      const baseline = parseGraph(text(row.baseline));
      if (effective === null || baseline === null) {
        this.#db.exec("ROLLBACK");
        return Promise.resolve(controlError(request.requestId, "invalid", "stored branch graph is unreadable"));
      }
      const next = structuredClone(effective);
      const applied = applyOps(next, request.ops ?? []);
      if (applied.rejections.length > 0) {
        this.#db.exec("ROLLBACK");
        const reasons = applied.rejections.map((rejection) => `${rejection.index}:${rejection.code}`).join(", ");
        return Promise.resolve(controlError(request.requestId, "invalid", `live operations rejected (${reasons})`));
      }

      const now = new Date().toISOString();
      if (request.state === "stop") {
        this.#dropLiveSession.run(tenant, key, request.branch, request.sessionId);
      } else {
        this.#putLiveSession.run(tenant, key, request.branch, request.sessionId, request.state, now);
      }
      const hasSession = this.#hasLiveSession.get(tenant, key, request.branch) !== undefined;
      const live = hasSession || !documentsEqual(next, baseline);
      const serialized = JSON.stringify(next);
      this.#putEffectiveBranch.run(serialized, live ? 1 : 0, now, tenant, key, request.branch);
      this.#putGraph.run(tenant, key, request.branch, serialized, now);
      if (next.rev !== effective.rev) {
        const snapshot = snapshotGraph(next);
        this.#strictPutRevision.run(tenant, key, request.branch, snapshot.rev, snapshot.at, JSON.stringify(snapshot));
        this.#pruneRevisions.run(tenant, key, request.branch, tenant, key, request.branch);
      }
      this.#db.exec("COMMIT");
      return Promise.resolve({
        type: "live_updated",
        requestId: request.requestId,
        projectId: key,
        branch: request.branch,
        revision: next.rev,
        mappedCommit: text(row.mapped_commit),
      });
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
        liveSessions: Number(raw.live_sessions),
        status: text(raw.status),
        statusChangedAt: text(raw.status_changed_at),
        lastSeen: text(raw.last_seen),
        controlOnly: Number(raw.control_only) !== 0,
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
      row.status,
      row.statusChangedAt,
      row.liveSessions,
      row.controlOnly ? 1 : 0,
    );
    return Promise.resolve();
  }

  setProjectStatus(tenant: string, key: string, status: ProjectStatus): Promise<boolean> {
    const moved = Number(this.#setStatus.run(status, new Date().toISOString(), tenant, key, status).changes) > 0;
    // nothing moved either because the row is not there or because it already
    // reads that way; the caller asked whether the project exists, so a row
    // that was already in the asked-for status still answers true
    if (moved) return Promise.resolve(true);
    return Promise.resolve(this.#hasProject.get(tenant, key) !== undefined);
  }

  hasProject(tenant: string, key: string): Promise<boolean> {
    return Promise.resolve(this.#hasProject.get(tenant, key) !== undefined);
  }

  appendAudit(tenant: string, key: string, worktree: string, entry: AuditEntry): Promise<void> {
    try {
      this.#putAudit.run(tenant, key, worktree, entry.at, JSON.stringify(entry));
    } catch (err) {
      // the record is best effort: whatever is wrong with the database, the
      // canvas still gets its bubbles, and the operator is told once
      if (!this.#auditFailed) {
        this.#auditFailed = true;
        console.error(`[bridge] audit write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return Promise.resolve();
  }

  /**
   * Adopt every collision-free durable branch from an older repository key,
   * then the requested physical legacy row. Conflicting current branch state
   * wins and the old rows remain available under the old key.
   */
  adoptLegacyKey(tenant: string, legacyKey: string, key: string, worktree: string): Promise<boolean> {
    if (legacyKey === key) return Promise.resolve(false);
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      let moved = false;
      const legacyBranches = this.#db.prepare(
        "SELECT id FROM branches WHERE tenant = ? AND key = ? ORDER BY id ASC",
      ).all(tenant, legacyKey);
      const revisionConflict = this.#db.prepare(
        `SELECT 1 FROM revisions old
           JOIN revisions current
             ON current.tenant = old.tenant AND current.key = ? AND current.worktree = old.worktree
            AND current.rev = old.rev
          WHERE old.tenant = ? AND old.key = ? AND old.worktree = ?
          LIMIT 1`,
      );

      for (const legacyBranch of legacyBranches) {
        const id = text(legacyBranch.id);
        const currentBranch = this.#getBranch.get(tenant, key, id);
        const currentEffective =
          currentBranch === undefined ? null : parseGraph(text(currentBranch.effective));
        const protectedBranch =
          currentBranch !== undefined &&
          (currentBranch.mapped_commit !== null ||
            currentBranch.baseline !== null ||
            currentEffective === null ||
            currentEffective.nodes.length > 0 ||
            currentEffective.edges.length > 0);
        const currentGraph = this.#getGraph.get(tenant, key, id);
        const currentGraphDoc = currentGraph === undefined ? null : parseGraph(text(currentGraph.doc));
        const protectedGraph =
          currentGraph !== undefined &&
          (currentGraphDoc === null || currentGraphDoc.nodes.length > 0 || currentGraphDoc.edges.length > 0);
        if (
          protectedBranch ||
          protectedGraph ||
          revisionConflict.get(key, tenant, legacyKey, id) !== undefined
        ) {
          continue;
        }

        // An empty current placeholder may be replaced, just like the
        // historical per-worktree adoption below.
        this.#db.prepare("DELETE FROM branch_live_sessions WHERE tenant = ? AND key = ? AND branch = ?")
          .run(tenant, key, id);
        this.#db.prepare("DELETE FROM branches WHERE tenant = ? AND key = ? AND id = ?")
          .run(tenant, key, id);
        this.#dropGraph.run(tenant, key, id);
        this.#dropRevisions.run(tenant, key, id);
        this.#db.prepare("UPDATE branches SET key = ? WHERE tenant = ? AND key = ? AND id = ?")
          .run(key, tenant, legacyKey, id);
        this.#db.prepare("UPDATE graphs SET key = ? WHERE tenant = ? AND key = ? AND worktree = ?")
          .run(key, tenant, legacyKey, id);
        this.#db.prepare("UPDATE revisions SET key = ? WHERE tenant = ? AND key = ? AND worktree = ?")
          .run(key, tenant, legacyKey, id);
        this.#db.prepare("UPDATE branch_live_sessions SET key = ? WHERE tenant = ? AND key = ? AND branch = ?")
          .run(key, tenant, legacyKey, id);
        for (const audit of this.#legacyAudit.all(tenant, legacyKey, id)) {
          const entry = safeParse(text(audit.entry));
          const stamped =
            entry !== null && typeof entry === "object"
              ? JSON.stringify({ ...(entry as Record<string, unknown>), projectId: key })
              : text(audit.entry);
          this.#moveAuditLine.run(key, stamped, Number(audit.seq));
        }
        moved = true;
      }

      const legacy = this.#getGraph.get(tenant, legacyKey, worktree);
      const current = this.#getGraph.get(tenant, key, worktree);
      const currentDoc = current === undefined ? null : parseGraph(text(current.doc));
      if (
        legacy !== undefined &&
        (current === undefined || (currentDoc !== null && currentDoc.nodes.length === 0 && currentDoc.edges.length === 0))
      ) {
        this.#dropGraph.run(tenant, key, worktree);
        this.#dropRevisions.run(tenant, key, worktree);
        this.#moveGraph.run(key, tenant, legacyKey, worktree);
        this.#moveRevisions.run(key, tenant, legacyKey, worktree);
        for (const audit of this.#legacyAudit.all(tenant, legacyKey, worktree)) {
          const entry = safeParse(text(audit.entry));
          const stamped =
            entry !== null && typeof entry === "object"
              ? JSON.stringify({ ...(entry as Record<string, unknown>), projectId: key })
              : text(audit.entry);
          this.#moveAuditLine.run(key, stamped, Number(audit.seq));
        }
        moved = true;
      }

      const hasLegacyBranch = this.#db.prepare(
        "SELECT 1 FROM branches WHERE tenant = ? AND key = ? LIMIT 1",
      ).get(tenant, legacyKey);
      if (this.#countGraphs.get(tenant, legacyKey) === undefined && hasLegacyBranch === undefined) {
        // Once no unresolved canvas remains, every remaining audit line belongs
        // to the same adopted repository even if its v3 worktree key was not
        // rewritten to the v4 branch ref.
        for (const audit of this.#db.prepare(
          "SELECT seq, entry FROM audit WHERE tenant = ? AND key = ?",
        ).all(tenant, legacyKey)) {
          const entry = safeParse(text(audit.entry));
          const stamped =
            entry !== null && typeof entry === "object"
              ? JSON.stringify({ ...(entry as Record<string, unknown>), projectId: key })
              : text(audit.entry);
          this.#moveAuditLine.run(key, stamped, Number(audit.seq));
        }
        this.#dropProject.run(tenant, legacyKey);
      }
      this.#db.exec("COMMIT");
      return Promise.resolve(moved);
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
