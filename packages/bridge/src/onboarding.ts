/**
 * Brownfield onboarding (onboarding.md): mechanics produce the skeleton, the
 * model produces the meaning, drift rendering verifies the result.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { CanvasOp, GraphDoc, RealityLayer } from "../../shared/src/index.ts";
import { gitFileIndexSync, gitIndexHas, type GitFileIndex } from "./reality.ts";
import type { GateVeto, OpGate } from "./store.ts";

/** Verbatim from understand.md — the bar a bubble must clear to exist. */
const BOUNDARY_TEST =
  "can you state what it promises to the rest of the system in one sentence, and would deleting it break a named set of importers?";

const SKIP_DIRS: Record<string, true> = {
  ".git": true,
  ".next": true,
  ".venv": true,
  ".shape": true,
  __pycache__: true,
  build: true,
  coverage: true,
  dist: true,
  node_modules: true,
  out: true,
  target: true,
  venv: true,
};

const SOURCE_EXTENSIONS: Record<string, true> = {
  ".go": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".py": true,
  ".rs": true,
  ".ts": true,
  ".tsx": true,
};

/** node-id slug: ^[a-z0-9][a-z0-9-]*$ */
function slug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned.length === 0 ? "pkg" : cleaned;
}

/**
 * Cheap bounded source scan — the `targetHasCode` fallback for repos the reality
 * extractor cannot describe (non-pnpm, non-TS).
 */
export async function hasSourceCode(cwd: string): Promise<boolean> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const next = queue.shift();
    if (next === undefined) break;
    visited++;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && SKIP_DIRS[entry.name] !== true) continue;
        if (SKIP_DIRS[entry.name] === true) continue;
        if (next.depth < 6) queue.push({ dir: join(next.dir, entry.name), depth: next.depth + 1 });
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot > 0 && SOURCE_EXTENSIONS[entry.name.slice(dot)] === true) return true;
    }
  }
  return false;
}

async function packageDescription(cwd: string, dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(cwd, dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || !("description" in parsed)) return null;
  const description = parsed.description;
  if (typeof description !== "string") return null;
  const oneLine = description.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}...` : oneLine;
}

/**
 * Stage 1: one `component` node per workspace package plus a `depends` edge per
 * cross-package reality edge. Ground truth before the model says a word.
 */
export async function synthesizeSkeleton(cwd: string, reality: RealityLayer): Promise<CanvasOp[]> {
  const idByRealityId: Record<string, string> = {};
  const taken = new Set<string>();
  const ops: CanvasOp[] = [];

  for (const pkg of reality.nodes) {
    const base = slug(pkg.label);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    idByRealityId[pkg.id] = id;

    const shortName = pkg.label.slice(pkg.label.lastIndexOf("/") + 1);
    const description = await packageDescription(cwd, pkg.dir);
    ops.push({
      op: "upsert_node",
      node: {
        id,
        parentId: null,
        label: shortName.length > 60 ? shortName.slice(0, 60) : shortName,
        summary: description ?? `Workspace package at ${pkg.dir} — survey pending.`,
        phase: "built",
        codeRefs: [pkg.dir],
      },
    });
  }

  const seen = new Set<string>();
  for (const edge of reality.edges) {
    const source = idByRealityId[edge.source];
    const target = idByRealityId[edge.target];
    if (source === undefined || target === undefined || source === target) continue;
    const id = `${source}--${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ops.push({ op: "upsert_edge", edge: { id, source, target, kind: "depends" } });
  }

  return ops;
}

/**
 * Onboarding validation mode: for the duration of the survey turn, structure the
 * agent cannot point at is rejected — and "pointing at it" means git tracks it.
 * A gitignored leftover directory (a `packages/x/` holding only `node_modules`
 * after a branch switch) exists on disk but is not part of the project, so it
 * cannot back a bubble. Outside a git repo, existence on disk is all we have.
 *
 * The index is read at most once per gate (i.e. once per survey turn).
 */
export function onboardingOpGate(cwd: string): OpGate {
  let index: GitFileIndex | null | undefined;
  const resolvesInProject = (ref: string): boolean => {
    if (index === undefined) index = gitFileIndexSync(cwd);
    if (index === null) return existsSync(resolve(cwd, ref));
    return gitIndexHas(index, relative(cwd, resolve(cwd, ref)));
  };

  return (op): GateVeto | null => {
    if (op?.op !== "upsert_node") return null;
    const node = op.node;
    if (node === null || typeof node !== "object") return null;
    const refs = Array.isArray(node.codeRefs) ? node.codeRefs.filter((r) => typeof r === "string" && r.trim().length > 0) : [];
    const subject = {
      path: "/node/codeRefs",
      ...(typeof node.id === "string" ? { id: node.id } : {}),
      ...(typeof node.label === "string" ? { label: node.label } : {}),
    };
    if (refs.length === 0) {
      return {
        code: "onboarding/no-coderefs",
        severity: "error",
        message: `onboarding survey: node "${String(node.id)}" needs codeRefs naming the code it covers — during a survey you may not declare structure you cannot point at`,
        subject,
        evidence: {},
        supportedFixes: [
          "add codeRefs listing the workspace-relative paths this bubble covers",
          "drop the node if you cannot point at its code",
        ],
      };
    }
    for (const [i, ref] of refs.entries()) {
      if (!resolvesInProject(ref)) {
        return {
          code: "onboarding/unknown-coderef",
          severity: "error",
          message: `onboarding survey: node "${String(node.id)}" codeRefs path "${ref}" does not exist in this project — git tracks no file there (a leftover ignored directory does not count)`,
          subject: { ...subject, path: `/node/codeRefs/${i}` },
          evidence: { ref },
          supportedFixes: [
            "use a path git tracks under the target project (workspace-relative)",
            "drop the node if its code does not exist",
          ],
        };
      }
    }
    return null;
  };
}

/** Stage 2: the survey prompt. */
export function composeSurveyPrompt(doc: GraphDoc, focus: string | undefined): string {
  const skeleton = doc.nodes.map((n) => {
    const refs = n.codeRefs === undefined ? "" : ` codeRefs: ${n.codeRefs.join(", ")}`;
    return `- ${n.id} "${n.label}" — "${n.summary}"${refs}`;
  });
  const edges = doc.edges.map((e) => `- ${e.id} [${e.kind}] ${e.source} -> ${e.target}`);

  const lines = [
    "<onboarding-survey>",
    "Map this existing project onto the canvas the user is watching. The canvas has just been",
    "seeded MECHANICALLY: one bubble per workspace package, real codeRefs, phase \"built\". None of",
    "it is your invention, and none of the placeholder summaries are trustworthy yet. This turn you",
    "make every bubble's promise true by reading code.",
    "",
    "Rules for this survey turn:",
    "",
    "1. Enrich, don't invent. Rewrite each summary as that part's one-sentence promise, derived",
    "   from its export surface, manifest and imports — NOT from README or doc prose. Documentation",
    "   describes intentions; you are surveying what the code actually guarantees.",
    "2. PLAIN ENGLISH, NO JARGON. The person reading this canvas steers by voice and does not read",
    "   code. Every label, summary, status, edge label and note must use everyday words and say what",
    "   the part does for the whole in terms of outcomes, not mechanisms — no acronyms, no protocol,",
    "   library or file-format names, no code identifiers, unless the part is literally about that",
    "   thing. A smart non-programmer must understand every sentence.",
    '     BAD:  "Minimal JSONL RPC client, protocol v1, id-correlated request()"',
    '     GOOD: "Talks to the coding agent: sends it instructions and listens to everything it does"',
    "   Only codeRefs stay technical — they are machine addresses.",
    `3. Boundary test, verbatim: "${BOUNDARY_TEST}" If the answer is "it is just where these files`,
    '   live", it is not a component — merge it upward.',
    "4. Altitude: 5-15 top-level bubbles. If the repo has more packages than that, group them under",
    "   domain parent bubbles (parentId) instead of flattening. Go one level deeper only for",
    "   deliberate export seams; stop there.",
    "5. Splits are allowed with evidence: where one package holds several genuine seams, add child",
    "   bubbles — each MUST carry real codeRefs of its own.",
    '6. Existing code keeps phase "built". Add edges where you read the relation out of the code,',
    "   with plain-language labels; never add an edge to mean \"contains\".",
    "7. Validation is armed for this turn: every upsert_node MUST carry codeRefs that resolve to",
    "   paths that exist in this project. Ops without them are rejected with a reason.",
    "8. Only what git tracks counts as real: a directory git ignores — typically a leftover folder",
    "   holding nothing but installed dependencies after a branch switch — is not part of this",
    "   project, so never survey it and never point codeRefs at it.",
    "",
    skeleton.length > 0 ? `Mechanical skeleton (${doc.nodes.length} bubble(s)) — package names and placeholder summaries below are machine-generated and deliberately technical; replace every one of them with a plain-English promise:` : "No workspace packages were detected — build the skeleton yourself from what you read, under the same codeRefs and plain-English rules.",
    ...skeleton,
    ...(edges.length > 0 ? ["Mechanical edges:", ...edges] : []),
  ];

  if (focus !== undefined && focus.trim().length > 0) {
    lines.push("", `User focus for this survey: "${focus.trim()}"`);
  }

  lines.push(
    "",
    "Read first, then call the canvas tool with the corrected bubbles. Work in batches so the user",
    "watches the map become true.",
    "</onboarding-survey>",
  );
  return lines.join("\n");
}
