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
import { execFile } from "node:child_process";
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

async function packageAt(root: string, dir: string): Promise<WorkspacePkg | null> {
  const manifest = await readJsonFile(path.join(dir, "package.json"));
  if (typeof manifest !== "object" || manifest === null || !("name" in manifest)) return null;
  const name = manifest.name;
  if (typeof name !== "string" || name.length === 0) return null;
  const rel = normalizeRel(path.relative(root, dir));
  return { name, dir, rel: rel.length > 0 ? rel : "." };
}

async function discoverPackages(root: string): Promise<WorkspacePkg[]> {
  const patterns = await workspacePatterns(root);
  const candidates: string[] = [];
  for (const pattern of patterns) candidates.push(...(await expandPattern(root, pattern)));

  const pkgs: WorkspacePkg[] = [];
  const seenDirs = new Set<string>();
  const seenNames = new Set<string>();
  for (const dir of candidates) {
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const pkg = await packageAt(root, dir);
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
  const pkgs = await discoverPackages(root);

  const nodes: RealityNode[] = pkgs.map((p) => ({ id: `r:${p.name}`, label: p.name, dir: p.rel }));

  const byName = [...pkgs].sort((a, b) => b.name.length - a.name.length);
  const byDir = [...pkgs].sort((a, b) => b.dir.length - a.dir.length);
  const allDirs = new Set(pkgs.map((p) => p.dir));

  const edges: RealityEdge[] = [];
  const seenEdges = new Set<string>();
  const budget: Budget = { left: MAX_FILES };

  for (const pkg of pkgs) {
    const foreignDirs = new Set(allDirs);
    foreignDirs.delete(pkg.dir);
    const files = await collectSources(pkg.dir, foreignDirs, budget);
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

  /** intent node id -> reality node id */
  const pkgOfNode = new Map<string, string>();
  /** reality node id -> intent node ids */
  const nodesOfPkg = new Map<string, string[]>();

  for (const node of doc.nodes) {
    const refs = node.codeRefs;
    if (refs === undefined || refs.length === 0) continue;
    let matched: RealityNode | null = null;
    for (const raw of refs) {
      const ref = normalizeRel(raw);
      if (ref.length === 0) continue;
      for (const cand of realityByDir) {
        if (cand.dir === "." || ref === cand.dir || ref.startsWith(cand.dir + "/")) {
          matched = cand.node;
          break;
        }
      }
      if (matched !== null) break;
    }
    if (matched === null) continue;
    pkgOfNode.set(node.id, matched.id);
    const bucket = nodesOfPkg.get(matched.id);
    if (bucket === undefined) nodesOfPkg.set(matched.id, [node.id]);
    else bucket.push(node.id);
  }

  const realityLabel = new Map<string, string>();
  for (const n of reality.nodes) realityLabel.set(n.id, n.label);

  const intentPairs = new Set<string>();
  for (const e of doc.edges) {
    intentPairs.add(`${e.source}\u0000${e.target}`);
    intentPairs.add(`${e.target}\u0000${e.source}`);
  }
  const realityPairs = new Set<string>();
  for (const e of reality.edges) {
    realityPairs.add(`${e.source}\u0000${e.target}`);
    realityPairs.add(`${e.target}\u0000${e.source}`);
  }

  // A. undeclared dependency: code imports it, the canvas does not say so.
  for (const edge of reality.edges) {
    const sources = nodesOfPkg.get(edge.source);
    const targets = nodesOfPkg.get(edge.target);
    if (sources === undefined || targets === undefined) continue;
    const targetPkg = realityLabel.get(edge.target) ?? edge.target;
    for (const a of sources) {
      for (const b of targets) {
        if (a === b) continue;
        if (intentPairs.has(`${a}\u0000${b}`)) continue;
        const bLabel = intentById.get(b)?.label ?? b;
        note(a, `code imports ${targetPkg} (node "${bLabel}") but no edge is declared`);
      }
    }
  }

  // B. phantom dependency: the canvas declares it, the code has no such import.
  for (const edge of doc.edges) {
    if (edge.kind !== "depends") continue;
    const source = intentById.get(edge.source);
    const target = intentById.get(edge.target);
    if (source === undefined || target === undefined) continue;
    if (!REALIZED_PHASES[source.phase] || !REALIZED_PHASES[target.phase]) continue;
    const p = pkgOfNode.get(edge.source);
    const q = pkgOfNode.get(edge.target);
    // Same package on both ends can never show a cross-package import.
    if (p === undefined || q === undefined || p === q) continue;
    if (realityPairs.has(`${p}\u0000${q}`)) continue;
    note(
      edge.source,
      `declared dependency on "${target.label}" has no corresponding import in code`,
    );
  }

  return drift;
}
