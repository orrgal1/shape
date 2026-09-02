/**
 * Git worktrees (CONTRACTS.md § Worktrees): each worktree of the target's repo is
 * an architecture variation with its own canvas state. Detection is read-only;
 * toggling a worktree is just `switch_project` to its path.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { WorktreeInfo } from "../../shared/src/index.ts";

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
 * Worktrees of the target's repo, with `current` on the one the bridge targets
 * (the deepest worktree containing the target dir). `[]` for non-git targets.
 */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const stdout = await git(cwd, ["worktree", "list", "--porcelain"]);
  if (stdout === null) return [];

  const stanzas = parsePorcelain(stdout);
  if (stanzas.length === 0) return [];

  const target = await realpathOr(resolve(cwd));
  const resolved = await Promise.all(stanzas.map((s) => realpathOr(s.path)));

  let currentIndex = -1;
  let bestLength = -1;
  resolved.forEach((path, index) => {
    const contains = path === target || target.startsWith(`${path}${sep}`);
    if (contains && path.length > bestLength) {
      bestLength = path.length;
      currentIndex = index;
    }
  });

  return stanzas.map((stanza, index) => ({
    path: resolved[index] ?? stanza.path,
    branch: stanza.branch,
    head: stanza.head,
    current: index === currentIndex,
  }));
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
