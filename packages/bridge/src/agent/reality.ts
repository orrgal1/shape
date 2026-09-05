/**
 * Reality layer extraction: the bridge's own read of the target repo, produced
 * on the agent side because it is the half that sits on the user's disk.
 *
 * Workspace packages become nodes, cross-package import specifiers become
 * edges, the top-level classes and functions of each file become symbols
 * (`agent/symbols.ts`), and the configuration files become infra
 * (`agent/infra.ts`). The result is derived — the agent never writes it — and
 * the server compares it against the intent layer (`server/drift.ts`).
 *
 * v1 scope (per CONTRACTS.md): pnpm/npm workspaces, TS sources, regex import
 * scan, TypeScript-parser symbol scan. Zero dependencies beyond node builtins
 * and the TypeScript parser.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";

import { buildFileIndex, normalizeIndexPath, type FileIndex } from "../../../shared/src/fileindex.ts";
import type { RealityEdge, RealityLayer, RealityNode } from "../../../shared/src/index.ts";
import { extractInfra } from "./infra.ts";
import { extractSymbols } from "./symbols.ts";
import { extractVerification } from "./verification.ts";

// ---------------------------------------------------------------------------
// Scan limits / static tables
// ---------------------------------------------------------------------------

const SKIP_DIRS: Record<string, true> = { node_modules: true, dist: true, ".git": true };
/**
 * What counts as source. JavaScript is here too: plenty of real projects write
 * their server, their browser code or their scripts in plain .js/.mjs, and a
 * scan that only sees TypeScript maps half of them. The parser reads each by
 * extension, and the import regex below never cared which language it is.
 */
const SOURCE_EXTS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5000;
const GIT_TIMEOUT_MS = 5000;

/** `git ls-files` output cap: ~64 MiB of NUL-joined paths, far past any real repo. */
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * `from "x"` | `require("x")` | `import("x")` | `import "x"`.
 * Deliberately dumb: no parser, no comment stripping. Over-matching a commented
 * import costs a spurious edge, never a crash.
 */
const IMPORT_RE =
  /\bfrom\s*["']([^"'\n]+)["']|\brequire\s*\(\s*["']([^"'\n]+)["']|\bimport\s*\(?\s*["']([^"'\n]+)["']/g;

/** one workspace package as the scan found it; also what the verify scan groups by */
export interface WorkspacePkg {
  name: string;
  /** absolute dir */
  dir: string;
  /** workspace-relative, posix separators */
  rel: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'") && t.endsWith(q)) return t.slice(1, -1);
  }
  return t;
}

async function readTextFile(file: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(file: string): Promise<unknown> {
  const text = await readTextFile(file, MAX_FILE_BYTES);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(
    "git",
    ["rev-parse", "HEAD"],
    { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const head = stdout.trim();
      resolve(head.length > 0 ? head : null);
    },
  );
  return promise;
}

// ---------------------------------------------------------------------------
// Git truth
// ---------------------------------------------------------------------------

/**
 * `git ls-files` with no pathspec is already scoped to the directory it runs in
 * and prints paths relative to it, which is exactly the subtree we want. What
 * git admits: tracked files plus untracked-but-not-ignored ones. Each worktree
 * has its own index, so a worktree path indexes that branch's files for free.
 */
const LS_FILES_ARGS = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

/** null = not a git repo (or git unavailable): the caller has no index to work from. */
export async function gitFileIndex(cwd: string): Promise<FileIndex | null> {
  const { promise, resolve } = Promise.withResolvers<FileIndex | null>();
  const opts = { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true } as const;
  execFile("git", ["rev-parse", "--show-toplevel"], opts, (topErr) => {
    if (topErr) {
      resolve(null);
      return;
    }
    execFile(
      "git",
      LS_FILES_ARGS,
      { ...opts, maxBuffer: MAX_GIT_OUTPUT_BYTES },
      (err, stdout) => {
        resolve(err ? null : buildFileIndex(stdout.split("\0")));
      },
    );
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

/**
 * Naive `packages:` list reader for pnpm-workspace.yaml. Handles the only shape
 * that occurs in practice: a top-level `packages:` key followed by `- entry`
 * lines. Anything fancier (anchors, flow sequences) is simply not seen.
 */
function parsePnpmWorkspace(text: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim().length === 0) continue;
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item !== null) {
      const entry = item[1];
      if (entry !== undefined) patterns.push(unquote(entry));
      continue;
    }
    // dedented back to another top-level key -> list is over
    if (/^\S/.test(line)) break;
  }
  return patterns;
}

function workspacePatternsFromPackageJson(pkgJson: unknown): string[] {
  if (typeof pkgJson !== "object" || pkgJson === null || !("workspaces" in pkgJson)) return [];
  const ws = pkgJson.workspaces;
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
  if (typeof ws === "object" && ws !== null && "packages" in ws) {
    const inner = ws.packages;
    if (Array.isArray(inner)) return inner.filter((p): p is string => typeof p === "string");
  }
  return [];
}

async function workspacePatterns(root: string): Promise<string[]> {
  const yaml = await readTextFile(path.join(root, "pnpm-workspace.yaml"), MAX_FILE_BYTES);
  if (yaml !== null) {
    const patterns = parsePnpmWorkspace(yaml);
    if (patterns.length > 0) return patterns;
  }
  return workspacePatternsFromPackageJson(await readJsonFile(path.join(root, "package.json")));
}

/** Absolute candidate dirs for one workspace pattern. */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const clean = normalizeIndexPath(pattern);
  if (clean.length === 0 || clean.startsWith("!")) return [];

  const globbed = /\/\*\*?$/.test(clean);
  const base = globbed ? clean.replace(/\/\*\*?$/, "") : clean;
  // Any remaining wildcard is outside v1 scope.
  if (base.includes("*")) return [];

  const baseDir = path.resolve(root, base);
  if (!globbed) return [baseDir];

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && SKIP_DIRS[e.name] !== true)
      .map((e) => path.join(baseDir, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * A directory is a workspace package only if git admits its manifest. That is
 * the whole trap: a stale `packages/scheduler/` holding nothing but
 * `node_modules` has no admitted manifest, so it is not a package — and if a
 * gitignored `package.json` ever appeared there, it still would not be one.
 */
async function packageAt(
  root: string,
  dir: string,
  index: FileIndex | null,
): Promise<WorkspacePkg | null> {
  const relRaw = normalizeIndexPath(path.relative(root, dir));
  const rel = relRaw.length > 0 ? relRaw : ".";
  if (index !== null && !index.files.has(rel === "." ? "package.json" : `${rel}/package.json`)) {
    return null;
  }
  const manifest = await readJsonFile(path.join(dir, "package.json"));
  if (typeof manifest !== "object" || manifest === null || !("name" in manifest)) return null;
  const name = manifest.name;
  if (typeof name !== "string" || name.length === 0) return null;
  return { name, dir, rel };
}

async function discoverPackages(
  root: string,
  index: FileIndex | null,
): Promise<WorkspacePkg[]> {
  const patterns = await workspacePatterns(root);
  const candidates: string[] = [];
  for (const pattern of patterns) candidates.push(...(await expandPattern(root, pattern)));

  const pkgs: WorkspacePkg[] = [];
  const seenDirs = new Set<string>();
  const seenNames = new Set<string>();
  for (const dir of candidates) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const pkg = await packageAt(root, dir, index);
    if (pkg === null || seenNames.has(pkg.name)) continue;
    seenNames.add(pkg.name);
    pkgs.push(pkg);
  }
  pkgs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return pkgs;
}

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

interface Budget {
  left: number;
}

/**
 * Recursively collect source files (see {@link SOURCE_EXTS}) under `root`, never
 * descending into a dir owned by a different workspace package (matters for
 * nested / root packages).
 * Non-git targets only; inside a repo the index decides what exists.
 */
async function collectSources(
  root: string,
  foreignDirs: Set<string>,
  budget: Budget,
): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (budget.left > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) continue;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS[entry.name] === true) continue;
        if (foreignDirs.has(full)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SOURCE_EXTS[path.extname(entry.name)] !== true) continue;
      if (budget.left <= 0) break;
      budget.left -= 1;
      files.push(full);
    }
  }
  return files;
}

/**
 * The git-truth counterpart of {@link collectSources}: the package's own
 * admitted sources, skipping files owned by a nested workspace package.
 * `sorted` is the index's file set in deterministic scan order.
 */
function sourcesFromIndex(
  root: string,
  sorted: readonly string[],
  pkg: WorkspacePkg,
  foreignRels: readonly string[],
  budget: Budget,
): string[] {
  const prefix = pkg.rel === "." ? "" : `${pkg.rel}/`;
  const files: string[] = [];
  for (const rel of sorted) {
    if (budget.left <= 0) break;
    if (!rel.startsWith(prefix)) continue;
    if (SOURCE_EXTS[path.posix.extname(rel)] !== true) continue;
    const segments = rel.slice(prefix.length).split("/");
    if (segments.slice(0, -1).some((seg) => SKIP_DIRS[seg] === true)) continue;
    if (foreignRels.some((foreign) => rel.startsWith(`${foreign}/`))) continue;
    budget.left -= 1;
    files.push(path.resolve(root, rel));
  }
  return files;
}

/**
 * Every module specifier a file mentions. Exported because the verification
 * scan reads "what does this test touch" with the same regex that reads "what
 * does this package depend on" — one definition of what an import looks like.
 */
export function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined && spec.length > 0) specs.push(spec);
  }
  return specs;
}

/**
 * Which workspace package does this specifier point at, if any? Exported for
 * the verification scan, which resolves a test's imports the same way.
 */
export function resolveSpecifier(
  spec: string,
  fromFile: string,
  byNameLongestFirst: readonly WorkspacePkg[],
  byDirLongestFirst: readonly WorkspacePkg[],
): WorkspacePkg | null {
  if (spec.startsWith(".")) {
    const abs = path.resolve(path.dirname(fromFile), spec);
    for (const pkg of byDirLongestFirst) {
      if (abs === pkg.dir || abs.startsWith(pkg.dir + path.sep)) return pkg;
    }
    return null;
  }
  for (const pkg of byNameLongestFirst) {
    if (spec === pkg.name || spec.startsWith(pkg.name + "/")) return pkg;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function extractReality(cwd: string): Promise<RealityLayer> {
  const root = path.resolve(cwd);
  const index = await gitFileIndex(root);
  const pkgs = await discoverPackages(root, index);

  const nodes: RealityNode[] = pkgs.map((p) => ({ id: `r:${p.name}`, label: p.name, dir: p.rel }));

  const byName = [...pkgs].sort((a, b) => b.name.length - a.name.length);
  const byDir = [...pkgs].sort((a, b) => b.dir.length - a.dir.length);

  // sorted once here: the scan below walks it per package
  const sorted = index === null ? [] : [...index.files].sort();
  const budget: Budget = { left: MAX_FILES };

  // Which package owns each admitted source file. Collected first so the read
  // that follows happens exactly once per file and serves both passes: the
  // import scan that makes edges, and the symbol parse that makes the parts.
  const files: string[] = [];
  const pkgByFile = new Map<string, WorkspacePkg>();
  for (const pkg of pkgs) {
    const foreignRels = pkgs.filter((p) => p.rel !== pkg.rel).map((p) => p.rel);
    const owned =
      index === null
        ? await collectSources(
            pkg.dir,
            new Set(foreignRels.map((rel) => path.resolve(root, rel))),
            budget,
          )
        : sourcesFromIndex(root, sorted, pkg, foreignRels, budget);
    for (const file of owned) {
      if (pkgByFile.has(file)) continue;
      pkgByFile.set(file, pkg);
      files.push(file);
    }
  }

  const edges: RealityEdge[] = [];
  const seenEdges = new Set<string>();
  const symbols = await extractSymbols(
    root,
    files,
    (file) => {
      const pkg = pkgByFile.get(file);
      return pkg === undefined ? null : `r:${pkg.name}`;
    },
    async (file) => {
      const text = await readTextFile(file, MAX_FILE_BYTES);
      const pkg = pkgByFile.get(file);
      if (text === null || pkg === undefined) return text;
      for (const spec of importSpecifiers(text)) {
        const target = resolveSpecifier(spec, file, byName, byDir);
        if (target === null || target.dir === pkg.dir) continue;
        const source = `r:${pkg.name}`;
        const id = `${source}--r:${target.name}`;
        if (seenEdges.has(id)) continue;
        seenEdges.add(id);
        edges.push({ id, source, target: `r:${target.name}` });
      }
      return text;
    },
  );

  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes,
    edges,
    symbols,
    infra: await extractInfra(root, index),
    // the same reader, so a test file already read for its symbols is read the
    // same way here — and never through the edge-scanning reader above, which
    // would turn a test's imports into package edges
    verification: await extractVerification(root, index, pkgs, (file) => readTextFile(file, MAX_FILE_BYTES)),
    extractedAt: new Date().toISOString(),
    head: await gitHead(root),
  };
}
