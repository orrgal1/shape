/**
 * Reality layer extraction + drift computation.
 *
 * The reality layer is the bridge's own read of the target repo: workspace
 * packages become nodes, cross-package import specifiers become edges. Drift
 * compares that against the agent-authored intent layer. Both are derived —
 * the agent never writes either.
 *
 * v1 scope (per CONTRACTS.md): pnpm/npm workspaces, TS sources, regex import
 * scan. Zero dependencies beyond node builtins.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { execFile, spawnSync } from "node:child_process";
import path from "node:path";

import type {
  DriftMap,
  GraphDoc,
  IntentNode,
  Phase,
  RealityEdge,
  RealityLayer,
  RealityNode,
} from "../../shared/src/index.ts";

// ---------------------------------------------------------------------------
// Scan limits / static tables
// ---------------------------------------------------------------------------

const SKIP_DIRS: Record<string, true> = { node_modules: true, dist: true, ".git": true };
const SOURCE_EXTS: Record<string, true> = { ".ts": true, ".tsx": true };

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

/** Phases at which a declared dependency is expected to exist in code. */
const REALIZED_PHASES: Record<Phase, boolean> = {
  idea: false,
  concept: false,
  component: false,
  building: true,
  built: true,
  failed: true,
};

interface WorkspacePkg {
  name: string;
  /** absolute dir */
  dir: string;
  /** workspace-relative, posix separators */
  rel: string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Trim `./` prefix and trailing slashes; normalize separators to posix. */
function normalizeRel(p: string): string {
  let out = (path.sep === "/" ? p : p.split(path.sep).join("/")).trim();
  while (out.startsWith("./")) out = out.slice(2);
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

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
 * What git will admit exists under the scanned directory: tracked files plus
 * untracked-but-not-ignored files. Everything ignored is absent by construction,
 * so a `node_modules`-only package dir left behind by a branch switch cannot be
 * mistaken for a part of the project. Each worktree has its own index, so a
 * worktree path indexes that branch's files with no extra work.
 *
 * Paths are posix, relative to the directory that was scanned.
 */
export interface GitFileIndex {
  /** every admitted file, for membership tests */
  files: ReadonlySet<string>;
  /** every ancestor directory of those files */
  dirs: ReadonlySet<string>;
  /** the same files, sorted — deterministic scan order */
  sorted: readonly string[];
}

const LS_FILES_ARGS = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];

/**
 * `git ls-files` with no pathspec is already scoped to the directory it runs in
 * and prints paths relative to it, which is exactly the subtree we want.
 */
function buildGitFileIndex(stdout: string): GitFileIndex {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const raw of stdout.split("\0")) {
    if (raw.length === 0) continue;
    const rel = normalizeRel(raw);
    if (rel.length === 0 || rel === "." || rel === ".." || rel.startsWith("../")) continue;
    files.add(rel);
    for (let slash = rel.lastIndexOf("/"); slash > 0; ) {
      const dir = rel.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      slash = dir.lastIndexOf("/");
    }
  }
  const sorted = [...files].sort();
  return { files, dirs, sorted };
}

/** null = not a git repo (or git unavailable) -> callers fall back to the fs walk. */
export async function gitFileIndex(cwd: string): Promise<GitFileIndex | null> {
  const { promise, resolve } = Promise.withResolvers<GitFileIndex | null>();
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
        resolve(err ? null : buildGitFileIndex(stdout));
      },
    );
  });
  return promise;
}

/**
 * Blocking twin of {@link gitFileIndex}, for the synchronous op gate. Two short
 * git reads on the survey turn's first op; the gate has no async seam to use.
 */
export function gitFileIndexSync(cwd: string): GitFileIndex | null {
  const opts = {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    encoding: "utf8" as const,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  };
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], opts);
  if (top.error !== undefined || top.status !== 0) return null;
  const listed = spawnSync("git", LS_FILES_ARGS, opts);
  if (listed.error !== undefined || listed.status !== 0 || typeof listed.stdout !== "string") {
    return null;
  }
  return buildGitFileIndex(listed.stdout);
}

/**
 * Does git admit this path? A directory counts when it contains at least one
 * admitted file. `rel` is interpreted relative to the indexed directory;
 * anything escaping that subtree is not part of the project.
 */
export function gitIndexHas(index: GitFileIndex, rel: string): boolean {
  const clean = normalizeRel(rel);
  if (clean.length === 0 || clean === ".") return index.files.size > 0;
  if (clean === ".." || clean.startsWith("../") || path.isAbsolute(clean)) return false;
  return index.files.has(clean) || index.dirs.has(clean);
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
  const clean = normalizeRel(pattern);
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
  index: GitFileIndex | null,
): Promise<WorkspacePkg | null> {
  const relRaw = normalizeRel(path.relative(root, dir));
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
  index: GitFileIndex | null,
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
 * Recursively collect .ts/.tsx files under `root`, never descending into a dir
 * owned by a different workspace package (matters for nested / root packages).
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
 */
function sourcesFromIndex(
  root: string,
  index: GitFileIndex,
  pkg: WorkspacePkg,
  foreignRels: readonly string[],
  budget: Budget,
): string[] {
  const prefix = pkg.rel === "." ? "" : `${pkg.rel}/`;
  const files: string[] = [];
  for (const rel of index.sorted) {
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

function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined && spec.length > 0) specs.push(spec);
  }
  return specs;
}

/** Which workspace package does this specifier point at, if any? */
function resolveSpecifier(
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

  const edges: RealityEdge[] = [];
  const seenEdges = new Set<string>();
  const budget: Budget = { left: MAX_FILES };

  for (const pkg of pkgs) {
    const foreignRels = pkgs.filter((p) => p.rel !== pkg.rel).map((p) => p.rel);
    const files =
      index === null
        ? await collectSources(
            pkg.dir,
            new Set(foreignRels.map((rel) => path.resolve(root, rel))),
            budget,
          )
        : sourcesFromIndex(root, index, pkg, foreignRels, budget);
    for (const file of files) {
      const text = await readTextFile(file, MAX_FILE_BYTES);
      if (text === null) continue;
      for (const spec of importSpecifiers(text)) {
        const target = resolveSpecifier(spec, file, byName, byDir);
        if (target === null || target.dir === pkg.dir) continue;
        const source = `r:${pkg.name}`;
        const id = `${source}--r:${target.name}`;
        if (seenEdges.has(id)) continue;
        seenEdges.add(id);
        edges.push({ id, source, target: `r:${target.name}` });
      }
    }
  }

  edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    nodes,
    edges,
    extractedAt: new Date().toISOString(),
    head: await gitHead(root),
  };
}

/**
 * Drift rule v2 — hierarchy-transparent, one note per unsatisfied edge.
 *
 * Mapping: each intent node maps to the set of reality packages its own
 * `codeRefs` cover (longest package dir wins per ref, so a nested package beats
 * its parent). A node *covers* package P if it or any descendant maps into P —
 * hierarchy is transparent, so `the service` covers whatever its child
 * `no door lock` points at.
 *
 * A. Undeclared dependency. A reality edge P->Q is satisfied when either
 *    - some intent node's own codeRefs straddle both P and Q (the dependency
 *      lives inside one bubble; there is nothing to draw), or
 *    - some intent edge of any kind runs from a node covering P to a node
 *      covering Q. Direction matters here: imports have a source and a target,
 *      so a P->Q import is not answered by a Q->P edge.
 *    An unsatisfied edge yields exactly ONE note, on the owner of P: the
 *    highest-altitude node covering P (ties: a node whose own refs map into P
 *    first, then document order). Descendants stay clean; the web bubbles drift
 *    up to visible ancestors anyway.
 *
 * B. Phantom dependency (unchanged in spirit, same evaluation). A declared
 *    `depends` edge whose ends are both `building`+ is contradicted only when no
 *    reality edge connects any package covered by the source to any package
 *    covered by the target. That test is direction-blind on purpose: a backwards
 *    declaration is already reported once by rule A, and reporting it twice
 *    would be noise. Ends that share a package are skipped — an intra-package
 *    dependency can never show up as a cross-package import.
 */
export function computeDrift(
  doc: Pick<GraphDoc, "nodes" | "edges">,
  reality: RealityLayer,
): DriftMap {
  const drift: DriftMap = {};
  const note = (nodeId: string, text: string): void => {
    const list = drift[nodeId];
    if (list === undefined) {
      drift[nodeId] = [text];
    } else if (!list.includes(text)) {
      list.push(text);
    }
  };

  // Longest dir first so a nested package wins over its parent; a root package
  // (dir ".") swallows every path, so it is always the last resort.
  const realityByDir = [...reality.nodes]
    .map((n) => ({ node: n, dir: normalizeRel(n.dir) }))
    .sort((a, b) => {
      if ((a.dir === ".") !== (b.dir === ".")) return a.dir === "." ? 1 : -1;
      return b.dir.length - a.dir.length;
    });

  const intentById = new Map<string, IntentNode>();
  for (const node of doc.nodes) intentById.set(node.id, node);

  /** intent node id -> packages its OWN codeRefs land in */
  const ownPkgs = new Map<string, Set<string>>();
  for (const node of doc.nodes) {
    const refs = node.codeRefs;
    if (refs === undefined || refs.length === 0) continue;
    let pkgs: Set<string> | undefined;
    for (const raw of refs) {
      const ref = normalizeRel(raw);
      if (ref.length === 0) continue;
      for (const cand of realityByDir) {
        if (cand.dir === "." || ref === cand.dir || ref.startsWith(cand.dir + "/")) {
          if (pkgs === undefined) pkgs = new Set<string>();
          pkgs.add(cand.node.id);
          break;
        }
      }
    }
    if (pkgs !== undefined) ownPkgs.set(node.id, pkgs);
  }

  /** Depth in the parentId tree; unknown/cyclic parents stop the walk. */
  const depthOf = new Map<string, number>();
  const depth = (id: string): number => {
    const memo = depthOf.get(id);
    if (memo !== undefined) return memo;
    let d = 0;
    const seen = new Set<string>([id]);
    let cur = intentById.get(id)?.parentId ?? null;
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      d += 1;
      cur = intentById.get(cur)?.parentId ?? null;
    }
    depthOf.set(id, d);
    return d;
  };

  /** intent node id -> packages covered by it or any descendant */
  const covers = new Map<string, Set<string>>();
  const addCover = (id: string, pkg: string): void => {
    const bucket = covers.get(id);
    if (bucket === undefined) covers.set(id, new Set<string>([pkg]));
    else bucket.add(pkg);
  };
  for (const [id, pkgs] of ownPkgs) {
    for (const pkg of pkgs) {
      addCover(id, pkg);
      // Lift to every ancestor; the seen-set doubles as the cycle guard.
      const seen = new Set<string>([id]);
      let cur = intentById.get(id)?.parentId ?? null;
      while (cur !== null && !seen.has(cur)) {
        seen.add(cur);
        addCover(cur, pkg);
        cur = intentById.get(cur)?.parentId ?? null;
      }
    }
  }

  /** package -> node ids covering it, in document order */
  const coveringNodes = new Map<string, string[]>();
  for (const node of doc.nodes) {
    const pkgs = covers.get(node.id);
    if (pkgs === undefined) continue;
    for (const pkg of pkgs) {
      const bucket = coveringNodes.get(pkg);
      if (bucket === undefined) coveringNodes.set(pkg, [node.id]);
      else bucket.push(node.id);
    }
  }

  /** The top-level bubble that owns a package, or null if nothing covers it. */
  const ownerOf = (pkg: string): string | null => {
    const candidates = coveringNodes.get(pkg);
    if (candidates === undefined || candidates.length === 0) return null;
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    let bestOwn = false;
    for (const id of candidates) {
      const d = depth(id);
      const own = ownPkgs.get(id)?.has(pkg) === true;
      if (d < bestDepth || (d === bestDepth && own && !bestOwn)) {
        best = id;
        bestDepth = d;
        bestOwn = own;
      }
    }
    return best;
  };

  const realityLabel = new Map<string, string>();
  for (const n of reality.nodes) realityLabel.set(n.id, n.label);

  // A. undeclared dependency: code imports it, the canvas does not say so.
  for (const edge of reality.edges) {
    if (edge.source === edge.target) continue;
    if (!coveringNodes.has(edge.source) || !coveringNodes.has(edge.target)) continue;

    let satisfied = false;
    for (const pkgs of ownPkgs.values()) {
      if (pkgs.has(edge.source) && pkgs.has(edge.target)) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      for (const e of doc.edges) {
        if (
          covers.get(e.source)?.has(edge.source) === true &&
          covers.get(e.target)?.has(edge.target) === true
        ) {
          satisfied = true;
          break;
        }
      }
    }
    if (satisfied) continue;

    const owner = ownerOf(edge.source);
    if (owner === null) continue;
    const targetPkg = realityLabel.get(edge.target) ?? edge.target;
    const targetOwner = ownerOf(edge.target);
    const targetLabel = targetOwner === null ? null : intentById.get(targetOwner)?.label ?? null;
    note(
      owner,
      targetLabel === null
        ? `code imports ${targetPkg} but no edge is declared`
        : `code imports ${targetPkg} (node "${targetLabel}") but no edge is declared`,
    );
  }

  // B. phantom dependency: the canvas declares it, the code has no such import.
  for (const edge of doc.edges) {
    if (edge.kind !== "depends") continue;
    const source = intentById.get(edge.source);
    const target = intentById.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (!REALIZED_PHASES[source.phase] || !REALIZED_PHASES[target.phase]) continue;
    const from = covers.get(edge.source);
    const to = covers.get(edge.target);
    if (from === undefined || to === undefined) continue;
    // Same package on both ends can never show a cross-package import.
    let shared = false;
    for (const p of from) {
      if (to.has(p)) {
        shared = true;
        break;
      }
    }
    if (shared) continue;
    let realized = false;
    for (const re of reality.edges) {
      if (
        (from.has(re.source) && to.has(re.target)) ||
        (from.has(re.target) && to.has(re.source))
      ) {
        realized = true;
        break;
      }
    }
    if (realized) continue;
    note(
      edge.source,
      `declared dependency on "${target.label}" has no corresponding import in code`,
    );
  }

  return drift;
}
