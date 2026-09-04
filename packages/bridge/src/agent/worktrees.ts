/**
 * Git worktrees (CONTRACTS.md § Worktrees on one canvas): every worktree of the
 * target's repo is an architecture variation with its own canvas state, and all
 * of them live on one canvas because they share one project key.
 *
 * This module is the producer of the two identities everything else keys on:
 * the worktree id (the realpath of a worktree directory) and the repo identity
 * (the common dir the project key is derived from, plus the main worktree the
 * project is labelled and stored under). Detection is read-only.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { WorktreeInfo } from "../../../shared/src/index.ts";

const EXCLUDE_LINE = ".shape/";

/** Run git, resolving to null on any failure (missing git, not a repo, ...). */
function git(cwd: string, args: string[]): Promise<string | null> {
  const { promise, resolve: settle } = Promise.withResolvers<string | null>();
  execFile("git", args, { cwd }, (err, stdout) => settle(err !== null ? null : stdout));
  return promise;
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

interface Stanza {
  path: string;
  branch: string | null;
  head: string | null;
}

function parsePorcelain(stdout: string): Stanza[] {
  const stanzas: Stanza[] = [];
  let current: Stanza | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) {
      if (current !== null) stanzas.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current !== null) stanzas.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("HEAD ")) {
      const sha = line.slice("HEAD ".length).trim();
      // unborn branches report "(unborn)" or an all-zero sha depending on git version
      current.head = sha === "(unborn)" || /^0+$/.test(sha) ? null : sha;
      continue;
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      continue;
    }
    // "detached", "bare", "locked", "prunable": nothing to record
  }
  if (current !== null) stanzas.push(current);
  return stanzas;
}

/**
 * Every worktree of the target's repo, in git's own order — the main worktree
 * (the one owning the common dir) first. `[]` for non-git targets.
 *
 * `id` is the realpath of the worktree directory: the same directory reached
 * through a symlink, a relative path or `/private/var` vs `/var` has to be ONE
 * worktree, or its canvas would be stored twice.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const stdout = await git(cwd, ["worktree", "list", "--porcelain"]);
  if (stdout === null) return [];

  const stanzas = parsePorcelain(stdout);
  if (stanzas.length === 0) return [];

  const resolved = await Promise.all(stanzas.map((s) => realpathOr(s.path)));

  return stanzas.map((stanza, index) => ({
    id: resolved[index] ?? stanza.path,
    path: resolved[index] ?? stanza.path,
    branch: stanza.branch,
    head: stanza.head,
  }));
}

/** What one repo is, whichever of its worktrees the agent was pointed at. */
export interface RepoIdentity {
  /**
   * Realpath of the repository's common dir (the `.git` of the main worktree).
   * Every worktree of the repo reports the same one, which is why the project
   * key is derived from it. Null for a non-git target.
   */
  commonDir: string | null;
  /**
   * Realpath of the main worktree — the project's `cwd`, its label and the
   * primary copy when the canvas merges variations. For a non-git target it is
   * just the target directory.
   */
  main: string;
}

/**
 * Resolve the repo `cwd` belongs to. Git reports the common dir relative to
 * the worktree for a plain checkout and absolute for a linked one, so it is
 * resolved against `cwd` either way; the main worktree is the first entry git
 * lists, which is the one that owns that common dir.
 */
export async function repoIdentity(cwd: string): Promise<RepoIdentity> {
  const target = await realpathOr(resolve(cwd));
  const raw = await git(cwd, ["rev-parse", "--git-common-dir"]);
  const trimmed = raw === null ? "" : raw.trim();
  if (trimmed.length === 0) return { commonDir: null, main: target };

  const commonDir = await realpathOr(resolve(cwd, trimmed));
  const worktrees = await listWorktrees(cwd);
  const main = worktrees[0]?.id;
  return { commonDir, main: main ?? target };
}

/**
 * The project key: sha256 of this machine's name and the repo's common dir, so
 * every worktree of one repo lands on one canvas and two checkouts at the same
 * path on two laptops stay two projects. A non-git target has no common dir and
 * is keyed by its own directory instead.
 */
export function projectKey(identity: RepoIdentity): string {
  return createHash("sha256")
    .update(`${hostname()}:${identity.commonDir ?? identity.main}`)
    .digest("hex");
}

/**
 * The key a Shape from before `repoIdentity` existed would have derived for the
 * worktree at `path`: machine + the DIRECTORY, one project per checkout. Kept
 * verbatim because every canvas drawn before the common-dir key is stored under
 * one of these, and the server adopts them onto `projectKey` (CONTRACTS.md
 * § Worktrees on one canvas). `path` is already a worktree id, i.e. a realpath.
 */
export function legacyProjectKey(path: string): string {
  return createHash("sha256").update(`${hostname()}:${path}`).digest("hex");
}

/**
 * Keep per-worktree canvas state out of every branch: `.shape/` goes in
 * the repo's shared `info/exclude` (common dir → covers every worktree). Silent
 * no-op outside a repo or when the file cannot be written.
 */
export async function ensureGitExclude(cwd: string): Promise<void> {
  const stdout = await git(cwd, ["rev-parse", "--git-common-dir"]);
  if (stdout === null) return;
  const commonDir = stdout.trim();
  if (commonDir.length === 0) return;

  const infoDir = join(resolve(cwd, commonDir), "info");
  const excludeFile = join(infoDir, "exclude");
  try {
    let existing = "";
    try {
      existing = await readFile(excludeFile, "utf8");
    } catch {
      await mkdir(infoDir, { recursive: true });
    }
    if (existing.split("\n").some((line) => line.trim() === EXCLUDE_LINE)) return;
    const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
    await writeFile(excludeFile, `${prefix}${EXCLUDE_LINE}\n`, "utf8");
  } catch {
    // exclude hygiene is best effort; never block startup on it
  }
}
