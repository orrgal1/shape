/**
 * The project's file index: what a scan admitted exists under one root.
 *
 * Built on the agent side from `git ls-files` (tracked plus untracked-but-not-
 * ignored) and consumed on the server side, so it is a pure data structure with
 * no node imports — it travels over the link as easily as it is used in-process.
 * Everything git ignores is absent by construction, so a `node_modules`-only
 * package dir left behind by a branch switch cannot be mistaken for a part of
 * the project.
 *
 * Paths are posix, relative to the indexed root.
 */

export interface FileIndex {
  /** every admitted file, for membership tests */
  files: ReadonlySet<string>;
  /** every ancestor directory of those files */
  dirs: ReadonlySet<string>;
}

/** posix-absolute, or a windows drive path — either way, outside the root */
const ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[/\\])/;

/** Trim `./` prefix and trailing slashes; normalize separators to posix. */
export function normalizeIndexPath(p: string): string {
  let out = p.replace(/\\/g, "/").trim();
  while (out.startsWith("./")) out = out.slice(2);
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Index a listing of root-relative paths. Anything escaping the root is dropped:
 * the index describes one subtree and nothing else.
 */
export function buildFileIndex(paths: Iterable<string>): FileIndex {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const raw of paths) {
    if (raw.length === 0) continue;
    const rel = normalizeIndexPath(raw);
    if (rel.length === 0 || rel === "." || rel === ".." || rel.startsWith("../")) continue;
    if (ABSOLUTE_RE.test(rel)) continue;
    files.add(rel);
    for (let slash = rel.lastIndexOf("/"); slash > 0; ) {
      const dir = rel.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      slash = dir.lastIndexOf("/");
    }
  }
  return { files, dirs };
}

/**
 * Does the index admit this path? A directory counts when it contains at least
 * one admitted file. `rel` is interpreted relative to the indexed root; anything
 * escaping that subtree is not part of the project.
 */
export function fileIndexHas(index: FileIndex, rel: string): boolean {
  const clean = normalizeIndexPath(rel);
  if (clean.length === 0 || clean === ".") return index.files.size > 0;
  if (clean === ".." || clean.startsWith("../") || ABSOLUTE_RE.test(clean)) return false;
  return index.files.has(clean) || index.dirs.has(clean);
}
