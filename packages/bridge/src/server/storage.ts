/**
 * Everything a room keeps between turns: its graphs, the revisions they can be
 * diffed over, the registry row a restart reopens it from, and the audit trail
 * of what was steered through it. A `Storage` is a record store, not a
 * directory: graph rows are keyed by `(tenant, projectKey, worktree)` because
 * the same repo path on two machines is two projects that must never read each
 * other's graph, and every worktree of one repo is its own canvas the view
 * merges — one project, as many graphs as it has worktrees.
 *
 * Both modes are served by the same implementation (`server/sqlite.ts`); they
 * differ only in which database file they open and in whether the server
 * reopens rooms from the registry at startup (local mode does not — the agent
 * that owns the repo is what brings the project back).
 *
 * Nothing here knows about rooms: a `Storage` answers what is stored, the
 * server decides when.
 */

import { realpathSync } from "node:fs";
import type {
  AgentProject,
  GraphDoc,
  GraphSnapshot,
  Referent,
  RevisionInfo,
  WorktreeInfo,
  WorktreeSession,
} from "../../../shared/src/index.ts";
import { parseProject, parseWorktrees, parseWorktreeSessions } from "../linkframes.ts";
import { LOCAL_TENANT } from "./auth.ts";

/** what a room needs to come back without its agent */
export interface StoredProject {
  /** the project as its agent last attached it */
  project: AgentProject;
  /** the tenant whose room this is; `local` on an unauthenticated server */
  tenant: string;
  /** every worktree of the project's repo, as the agent last listed them */
  worktrees: WorktreeInfo[];
  /**
   * the harnesses as last known, one per worktree that had one. The agent
   * replaces this wholesale when it returns; a reopened room shows them so a
   * resume can name the session that was running where.
   */
  sessions: WorktreeSession[];
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
  /**
   * The onboarding turn, whose text the server wrote: the survey of a canvas
   * nobody mapped, or (`catchUp`) the pass that brings a map the code moved
   * under back to the code. An automatic one carries no focus, because nobody
   * typed one.
   */
  | { kind: "onboard"; id: string; focus: string | null; catchUp?: boolean }
  /** autonomous mode answered a turn end for the user; `run` is its place in the stretch */
  | { kind: "auto"; id: string; run: number };

/**
 * One audit line, stamped with where it happened. `worktree` is part of the
 * record, not of the lookup key: an operator asks what was steered through a
 * project and reads which of its variations each line went to.
 */
export type AuditEntry = AuditBody & {
  at: string;
  tenant: string;
  projectId: string;
  /** the worktree whose harness this line is about */
  worktree: string;
};

export interface Storage {
  /** the database records are kept in; operator-facing messages name it */
  readonly file: string;
  /** the worktree's graph as last persisted; null when this worktree is new here */
  loadGraph(tenant: string, key: string, worktree: string): Promise<GraphDoc | null>;
  saveGraph(tenant: string, key: string, worktree: string, doc: GraphDoc): Promise<void>;
  /** every revision this worktree can be diffed over, oldest first */
  listRevisions(tenant: string, key: string, worktree: string): Promise<RevisionInfo[]>;
  loadRevision(tenant: string, key: string, worktree: string, rev: number): Promise<GraphSnapshot | null>;
  /** false when `rev` already exists (revisions are immutable); prunes to the newest 50 PER WORKTREE */
  saveRevision(tenant: string, key: string, worktree: string, snapshot: GraphSnapshot): Promise<boolean>;
  /** projects to reopen agentless at startup, across every tenant */
  listProjects(): Promise<StoredProject[]>;
  /** upsert one registry row */
  saveProject(row: StoredProject): Promise<void>;
  /**
   * Append one audit line, against the worktree it happened in. Never rejects:
   * a steer must not fail because a disk did.
   */
  appendAudit(tenant: string, key: string, worktree: string, entry: AuditEntry): Promise<void>;
  /**
   * Move one worktree's canvas from the project key an older Shape derived for
   * it onto the key this build uses, and report whether there was anything to
   * move. Graph, revisions and audit lines all travel, and the legacy registry
   * row is dropped once no graph is left under it, so the project stops
   * appearing twice in the picker.
   *
   * A canvas already stored under `(key, worktree)` is only overwritten when it
   * is empty: a graph someone has actually drawn under the current key is the
   * newer truth and wins over whatever the old key still holds.
   */
  adoptLegacyKey(tenant: string, legacyKey: string, key: string, worktree: string): Promise<boolean>;
  close(): void;
}

/**
 * The main worktree's id for a project whose only known directory is `cwd`: a
 * worktree id is the realpath of its directory, so a path that still exists is
 * resolved and one that does not (a registry row from another machine, a
 * worktree since removed) is taken exactly as it was written.
 */
export function mainWorktreeOf(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Boundary validator: a registry row was written by an older server, and a row
 * whose project or sessions no longer parse would open a room with holes in it.
 * Rows are the same shapes off the same producer as the attach frame, so they
 * are checked against the same validators.
 */
export function parseRow(value: unknown): StoredProject | null {
  if (value === null || typeof value !== "object") return null;
  // an object from JSON.parse, checked immediately above
  const row = value as Record<string, unknown>;
  const project = parseProject(row.project);
  const worktrees = parseWorktrees(row.worktrees);
  if (project === null || worktrees === null) return null;
  // a row whose sessions cannot be read still names a project worth reopening:
  // the harnesses are gone by the time it is read anyway (the room reopens
  // agentless), so a bad list costs the resume hint, never the room
  const sessions = parseWorktreeSessions(row.sessions) ?? [];
  if (typeof row.lastSeen !== "string" || row.lastSeen.length === 0) return null;
  // a row from a server that predates tenants was written unauthenticated, so
  // it belongs to the tenant an unauthenticated connection gets: dropping it
  // instead would cost the operator every room across the upgrade
  const tenant = typeof row.tenant === "string" && row.tenant.length > 0 ? row.tenant : LOCAL_TENANT;
  return { project, tenant, worktrees, sessions, lastSeen: row.lastSeen };
}
