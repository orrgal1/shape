/**
 * Verification extraction: what in this project attests that the rest of it is
 * correct, read out of the project's own files and nothing else.
 *
 * The infra scan (`agent/infra.ts`) asks "where does this run and what does it
 * lean on"; this one asks "what proves it works". Both answer only from files
 * git admits, both name their evidence, and both refuse to invent: a project
 * with no tests, no smoke scripts and no checks reports none, because a claimed
 * verification with no file behind it is worse than an honest blank.
 *
 * The difference is `covers`. An infra item is only ever *claimed* through its
 * evidence; a verification item also has to say WHICH code it exercises, so a
 * build bubble no verify bubble names can still read as verified (the prefix
 * rule in `verificationOf`). `covers` is therefore the package or directory the
 * verification lives in plus every workspace file its files import — the import
 * regex and the package resolver are the reality scan's own, so "what this test
 * touches" is read exactly the way "what this package depends on" is.
 */

import path from "node:path";

import { normalizeIndexPath, type FileIndex } from "../../../shared/src/fileindex.ts";
import type { NodeKind, RealityVerification } from "../../../shared/src/index.ts";
import { importSpecifiers, resolveSpecifier, type WorkspacePkg } from "./reality.ts";

// ---------------------------------------------------------------------------
// Scan limits
// ---------------------------------------------------------------------------

/** test and script files read to find out what they exercise */
const MAX_IMPORT_READS = 2000;
/** manifests read for their `scripts` block */
const MAX_MANIFESTS = 200;
/** items produced; a repo past this has already said plenty */
const MAX_ITEMS = 80;
/** evidence files listed per item; the rest are the same story told again */
const MAX_EVIDENCE = 8;
/** covered paths per item: enough for a package's whole import surface */
const MAX_COVERS = 200;

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/**
 * A test file is code. Requiring one of these extensions is what keeps a
 * fixture (`__tests__/user.json`) or a note (`test/README.md`) from being
 * counted as a test.
 */
const CODE_EXTS: Record<string, true> = {
  ".ts": true,
  ".tsx": true,
  ".mts": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".cjs": true,
  ".go": true,
  ".py": true,
  ".rs": true,
  ".rb": true,
  ".java": true,
  ".kt": true,
  ".swift": true,
  ".php": true,
  ".cs": true,
};

/** a path segment with this name holds tests, whatever the files are called */
const TEST_DIRS: Record<string, true> = { __tests__: true, test: true, tests: true, e2e: true };

/**
 * Test-runner configuration, by lowercased basename. It is never an item of its
 * own — it configures a suite, it is not the suite — but it is the strongest
 * proof that the files around it really are run, so it joins that group's
 * evidence.
 */
const RUNNER_CONFIG_RE =
  /^(?:vitest\.(?:config|workspace)\.|jest\.config\.|playwright\.config\.|cypress\.(?:config\.|json$)|\.mocharc(?:$|\.))/;

/** how a relative specifier is spelled on disk, tried in this order */
const RESOLVE_EXTS: readonly string[] = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function basenameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** a lowercased extension including the dot, or "" for a name that has none */
function extensionOf(base: string): string {
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot).toLowerCase();
}

function isTestFile(rel: string): boolean {
  const base = basenameOf(rel).toLowerCase();
  const ext = extensionOf(base);
  if (CODE_EXTS[ext] !== true) return false;
  if (/\.(?:test|spec)\./.test(base)) return true;
  if (ext === ".go" && base.endsWith("_test.go")) return true;
  if (ext === ".py" && (base.startsWith("test_") || base.endsWith("_test.py"))) return true;
  if (base === "tests.rs") return true;
  const segments = rel.toLowerCase().split("/");
  segments.pop();
  return segments.some((seg) => TEST_DIRS[seg] === true);
}

function isRunnerConfig(rel: string): boolean {
  const base = basenameOf(rel).toLowerCase();
  return base === "pytest.ini" || base === "conftest.py" || RUNNER_CONFIG_RE.test(base);
}

/** the same two pipeline files the infra scan reads, read here for what they check */
function isWorkflow(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (lower === ".gitlab-ci.yml" || lower === ".gitlab-ci.yaml") return true;
  return lower.startsWith(".github/workflows/") && (lower.endsWith(".yml") || lower.endsWith(".yaml"));
}

/**
 * A hand-written smoke or end-to-end run: `smoke*` inside a `scripts` folder.
 * The folder may be the repo's or a package's — in a monorepo the runs live
 * beside the package they exercise, and that is exactly the file whose imports
 * say what it covers.
 */
function isSmokeScript(rel: string): boolean {
  const slash = rel.lastIndexOf("/");
  if (slash < 0) return false;
  const parent = rel.slice(0, slash);
  if (parent !== "scripts" && !parent.endsWith("/scripts")) return false;
  return rel.slice(slash + 1).toLowerCase().startsWith("smoke");
}

/** a script name says what it is: `smoke:drift` and `lint:web` are read by their first word */
function scriptBase(name: string): string {
  const colon = name.indexOf(":");
  return (colon < 0 ? name : name.slice(0, colon)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Grouping and resolution
// ---------------------------------------------------------------------------

/**
 * The directory one item groups under: the workspace package the file belongs
 * to, else its top-level directory, else `""` for a file lying at the repo
 * root. One item per group is the whole point of the test scanner — a hundred
 * test files under one package are one fact about that package, not a hundred
 * bubbles.
 *
 * A workspace package at the repo ROOT is deliberately not a group: its dir is
 * the empty prefix, so covering it would mark every bubble in the project
 * verified. Files under such a package fall back to their top-level directory.
 */
function groupOf(rel: string, pkgsLongestFirst: readonly WorkspacePkg[]): string {
  for (const pkg of pkgsLongestFirst) {
    if (pkg.rel.length === 0) continue;
    if (rel === pkg.rel || rel.startsWith(`${pkg.rel}/`)) return pkg.rel;
  }
  const slash = rel.indexOf("/");
  return slash < 0 ? "" : rel.slice(0, slash);
}

/**
 * A relative import as a file the index admits: the specifier as written, then
 * the extensions a TypeScript or Node project spells it with, then the
 * directory's index file. The `.js` -> `.ts` swap is the one rewrite worth
 * knowing, because an ESM TypeScript project imports `./a.js` and ships `a.ts`.
 * null = the specifier points at nothing this project tracks.
 */
function resolveRelativeFile(spec: string, fromRel: string, index: FileIndex): string | null {
  const joined = normalizeIndexPath(path.posix.join(path.posix.dirname(fromRel), spec));
  if (joined.length === 0 || joined.startsWith("..")) return null;
  const bases = joined.endsWith(".js")
    ? [joined, joined.slice(0, -3)]
    : joined.endsWith(".mjs") || joined.endsWith(".cjs")
      ? [joined, joined.slice(0, -4)]
      : [joined];
  for (const base of bases) {
    for (const ext of RESOLVE_EXTS) {
      if (index.files.has(base + ext)) return base + ext;
    }
    for (const ext of RESOLVE_EXTS) {
      if (ext !== "" && index.files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * One reading of one thing. `name` is the dedupe key within a kind — the group
 * for a suite, the script name for a run, the file for a pipeline — so the
 * `scripts/smoke.mjs` file and the `"smoke"` script that runs it are ONE item
 * carrying both files, exactly as one database carries every file that names it.
 * `rank` decides whose words survive that merge: the lower reading wins.
 */
interface Finding {
  kind: NodeKind;
  name: string;
  label: string;
  hint: string;
  rank: number;
  evidence: string[];
  covers: string[];
}

/** the file that IS the run beats the manifest line that merely names it */
const RANK_TEST_FILES = 0;
const RANK_SCRIPT_FILE = 1;
const RANK_PACKAGE_SCRIPT = 2;
const RANK_WORKFLOW = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the project's verification out of its own files.
 *
 * `index` is the git file index `extractReality` already built and `pkgs` are
 * the workspace packages it already found, so this pass adds no discovery of
 * its own; `readSource` is the same reader, so a file the reality scan already
 * read is read the same way, under the same byte cap. A `null` index means the
 * target is not a git repo: without git there is nothing to tell a real test
 * file from a leftover one, so the answer is an empty list — the same silence
 * `extractInfra` keeps.
 */
export async function extractVerification(
  cwd: string,
  index: FileIndex | null,
  pkgs: readonly WorkspacePkg[],
  readSource: (file: string) => Promise<string | null>,
): Promise<RealityVerification[]> {
  if (index === null) return [];
  const root = path.resolve(cwd);

  const pkgsLongestFirst = [...pkgs].sort((a, b) => b.rel.length - a.rel.length);
  const byName = [...pkgs].sort((a, b) => b.name.length - a.name.length);
  const byDir = [...pkgs].sort((a, b) => b.dir.length - a.dir.length);

  // deterministic scan order, so the same repo always yields the same items in
  // the same order with the same evidence
  const sorted = [...index.files].sort();

  const testsByGroup = new Map<string, string[]>();
  const configsByGroup = new Map<string, string[]>();
  const smokeScripts: string[] = [];
  const manifests: string[] = [];
  const workflows: string[] = [];
  for (const rel of sorted) {
    if (isTestFile(rel)) {
      const group = groupOf(rel, pkgsLongestFirst);
      const bucket = testsByGroup.get(group);
      if (bucket === undefined) testsByGroup.set(group, [rel]);
      else bucket.push(rel);
      continue;
    }
    if (isWorkflow(rel)) {
      workflows.push(rel);
      continue;
    }
    if (isSmokeScript(rel)) {
      smokeScripts.push(rel);
      continue;
    }
    if (isRunnerConfig(rel)) {
      const group = groupOf(rel, pkgsLongestFirst);
      const bucket = configsByGroup.get(group);
      if (bucket === undefined) configsByGroup.set(group, [rel]);
      else bucket.push(rel);
      continue;
    }
    if (basenameOf(rel) === "package.json") manifests.push(rel);
  }

  /**
   * What one file exercises: every workspace file it imports, plus the dir of
   * every workspace package it imports by name. Reads are budgeted across the
   * whole pass, so a repo of tests cannot turn extraction into a full read of
   * itself.
   */
  let reads = 0;
  const coversOf = async (rel: string): Promise<string[]> => {
    if (reads >= MAX_IMPORT_READS) return [];
    reads++;
    const text = await readSource(path.join(root, rel));
    if (text === null) return [];
    const out: string[] = [];
    const fromFile = path.join(root, rel);
    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith(".")) {
        const file = resolveRelativeFile(spec, rel, index);
        if (file !== null && file !== rel && !out.includes(file)) out.push(file);
        continue;
      }
      const pkg = resolveSpecifier(spec, fromFile, byName, byDir);
      if (pkg !== null && pkg.rel.length > 0 && !out.includes(pkg.rel)) out.push(pkg.rel);
    }
    return out;
  };

  const findings: Finding[] = [];

  // --- test suites: one item per package or top-level dir -------------------
  for (const [dir, files] of [...testsByGroup.entries()].sort()) {
    // the config first: when a group has more test files than the evidence cap,
    // the file that configures the runner is the one a reader wants to see
    const configs = configsByGroup.get(dir) ?? [];
    const where = dir.length > 0 ? dir : "the project root";
    const covers = dir.length > 0 ? [dir] : [];
    for (const file of files) {
      for (const cover of await coversOf(file)) if (!covers.includes(cover)) covers.push(cover);
    }
    const many = files.length === 1 ? "" : "s";
    const config = configs[0];
    const runner = config === undefined ? "" : `, run by ${basenameOf(config)}`;
    findings.push({
      kind: "test",
      name: dir.length > 0 ? dir : "root",
      label: `Tests in ${where} (${files.length} file${many})`,
      hint: `${files.length} test file${many} under ${where}${runner}`,
      rank: RANK_TEST_FILES,
      evidence: [...configs, ...files],
      covers,
    });
  }

  // --- smoke and end-to-end scripts ----------------------------------------
  for (const rel of smokeScripts) {
    const base = basenameOf(rel);
    const ext = extensionOf(base);
    const name = ext === "" ? base : base.slice(0, base.length - ext.length);
    const dir = groupOf(rel, pkgsLongestFirst);
    const covers = dir.length > 0 ? [dir] : [];
    for (const cover of await coversOf(rel)) if (!covers.includes(cover)) covers.push(cover);
    findings.push({
      kind: "smoke",
      name,
      label: `Smoke checks: ${name}`,
      hint: `an end-to-end smoke run, in ${rel}`,
      rank: RANK_SCRIPT_FILE,
      evidence: [rel],
      covers,
    });
  }

  // --- what the manifests say the project runs ------------------------------
  let manifestsRead = 0;
  for (const rel of manifests) {
    if (manifestsRead >= MAX_MANIFESTS) break;
    const text = await readSource(path.join(root, rel));
    if (text === null) continue;
    manifestsRead++;
    let scripts: unknown = null;
    try {
      const parsed: unknown = JSON.parse(text);
      scripts = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>).scripts : null;
    } catch {
      continue;
    }
    if (scripts === null || typeof scripts !== "object") continue;
    // the package the manifest belongs to is what its scripts check; a root
    // manifest covers nothing on its own, because the empty prefix is everything
    const dir = rel === "package.json" ? null : rel.slice(0, rel.length - "/package.json".length);
    const covers = dir === null ? [] : [dir];
    const where = dir === null ? "this project" : dir;
    for (const name of Object.keys(scripts as Record<string, unknown>)) {
      const base = scriptBase(name);
      if (base.startsWith("smoke") || base.startsWith("e2e")) {
        findings.push({
          kind: "smoke",
          name,
          label: `Smoke checks: ${name}`,
          hint: `an end-to-end smoke run ${where} runs as its "${name}" script`,
          rank: RANK_PACKAGE_SCRIPT,
          evidence: [rel],
          covers,
        });
        continue;
      }
      if (base === "typecheck" || base === "lint" || base === "tsc" || base.startsWith("check")) {
        findings.push({
          kind: "check",
          name,
          label: `Static checks: ${name}`,
          hint: `a check on the code itself, run as the "${name}" script of ${where}`,
          rank: RANK_PACKAGE_SCRIPT,
          evidence: [rel],
          covers,
        });
      }
    }
  }

  // --- the pipeline: whatever it runs, it runs on every change --------------
  const everyPackage = pkgs.map((p) => p.rel).filter((rel) => rel.length > 0).sort();
  for (const rel of workflows) {
    findings.push({
      kind: "check",
      name: rel,
      label: `Checks run on every push (${rel})`,
      hint: `the checks this project runs on every change, from ${rel}`,
      rank: RANK_WORKFLOW,
      evidence: [rel],
      covers: everyPackage,
    });
  }

  // One item per (kind, thing): the first reading writes the label, every later
  // one only adds its files — the same merge the infra scan does. The name is
  // slugged BEFORE it becomes the key, so `scripts/smoke-drift.mjs` and the
  // `"smoke:drift"` script that runs it are one thing said twice.
  const byKey = new Map<string, RealityVerification & { rank: number }>();
  for (const f of findings) {
    const name = f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const key = `${f.kind}|${name}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      if (byKey.size >= MAX_ITEMS) continue;
      byKey.set(key, {
        id: `v:${f.kind}-${name}`,
        label: f.label,
        kind: f.kind,
        evidence: f.evidence.slice(0, MAX_EVIDENCE),
        hint: f.hint,
        covers: f.covers.slice(0, MAX_COVERS),
        rank: f.rank,
      });
      continue;
    }
    if (f.rank < seen.rank) {
      seen.label = f.label;
      seen.hint = f.hint;
      seen.rank = f.rank;
    }
    for (const file of f.evidence) {
      if (!seen.evidence.includes(file) && seen.evidence.length < MAX_EVIDENCE) seen.evidence.push(file);
    }
    for (const cover of f.covers) {
      if (!seen.covers.includes(cover) && seen.covers.length < MAX_COVERS) seen.covers.push(cover);
    }
  }

  return [...byKey.values()]
    .map(({ rank: _rank, ...item }) => ({
      ...item,
      evidence: [...item.evidence].sort(),
      covers: [...item.covers].sort(),
    }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}
