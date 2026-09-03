/**
 * Brownfield onboarding, server half (onboarding.md): the survey prompt the
 * model answers, and the validation that holds it to what the project contains.
 *
 * Pure: the project is known through its `FileIndex`, never through the disk —
 * the mechanics that read files live in `agent/onboarding-fs.ts`.
 */

import { fileIndexHas, type FileIndex } from "../../../shared/src/fileindex.ts";
import { layerOf } from "../../../shared/src/index.ts";
import type { GraphDoc, IntentNode } from "../../../shared/src/index.ts";
import type { GateVeto, OpGate } from "./store.ts";

/**
 * A codeRef spelled the way the index spells paths: posix, root-relative, with
 * `.` and `..` collapsed the way resolving it against the project root would.
 * null = the ref names nothing inside the project (it is absolute, or it walks
 * out of the root), which the gate treats like a path the index never saw.
 */
function refInsideProject(ref: string): string | null {
  const clean = ref.replace(/\\/g, "/").trim();
  if (clean.length === 0 || clean.startsWith("/") || /^[A-Za-z]:\//.test(clean)) return null;
  const segments: string[] = [];
  for (const seg of clean.split("/")) {
    if (seg.length === 0 || seg === ".") continue;
    if (seg !== "..") {
      segments.push(seg);
      continue;
    }
    if (segments.pop() === undefined) return null;
  }
  return segments.join("/");
}

/** Verbatim from understand.md — the bar a bubble must clear to exist. */
const BOUNDARY_TEST =
  "can you state what it promises to the rest of the system in one sentence, and would deleting it break a named set of importers?";

/**
 * Onboarding validation mode: for the duration of the survey turn, structure the
 * agent cannot point at is rejected — and "pointing at it" means the project's
 * file index admits it. A gitignored leftover directory (a `packages/x/` holding
 * only `node_modules` after a branch switch) exists on disk but is not in the
 * index, so it cannot back a bubble.
 *
 * The index arrives from the agent side (`agent/reality.ts`), already scoped to
 * the target project: this half never touches a filesystem, so a remote project
 * is validated exactly like a local one.
 *
 * Product bubbles own no code, so codeRefs cannot ground them: what makes a
 * capability real is the build bubbles it `realizes`. One that names none is
 * vetoed the same way (`onboarding/unrealized-product`) — during a survey a
 * capability nobody built is exactly the narration this mode exists to stop.
 * The product ROOT is the exception: it is the product itself, it spans the
 * whole build layer, and shared validation already keeps it unique
 * (`op/second-root`), so it passes with an empty `realizes`.
 *
 * The gate is created per canvas call, so build bubbles admitted earlier in the
 * SAME batch already count as real for a product bubble later in it.
 */
export function onboardingOpGate(index: FileIndex, doc: Pick<GraphDoc, "nodes">): OpGate {
  const admittedBuildIds = new Set<string>();
  const existing = (id: unknown): IntentNode | undefined =>
    typeof id === "string" ? doc.nodes.find((n) => n.id === id) : undefined;
  const isBuildNode = (id: string): boolean => {
    if (admittedBuildIds.has(id)) return true;
    const prior = existing(id);
    return prior !== undefined && layerOf(prior) === "build";
  };

  return (op): GateVeto | null => {
    if (op?.op !== "upsert_node") return null;
    const node = op.node;
    if (node === null || typeof node !== "object") return null;
    const subject = {
      path: "/node/codeRefs",
      ...(typeof node.id === "string" ? { id: node.id } : {}),
      ...(typeof node.label === "string" ? { label: node.label } : {}),
    };

    // a layer sticks: an upsert that omits `layer` (or `realizes`) leaves the
    // bubble where shared validation leaves it, so the gate reads the same way
    const prior = existing(node.id);
    const layer = node.layer === "product" || node.layer === "build" ? node.layer : prior ? layerOf(prior) : "build";

    if (layer === "product") {
      // the product root (no parent) IS the product: it stands for the whole
      // build layer, so it owes no `realizes`; a capability under it still does
      if (node.parentId !== null) {
        const claimed = Array.isArray(node.realizes) ? node.realizes : (prior?.realizes ?? []);
        const realizes = claimed.filter((r) => typeof r === "string" && r.trim().length > 0);
        const grounded = realizes.filter((id) => isBuildNode(id));
        if (grounded.length === 0) {
          return {
            code: "onboarding/unrealized-product",
            severity: "error",
            message: `onboarding survey: product bubble "${String(node.id)}" must name at least one build bubble in \`realizes\` that already exists on the canvas — during a survey a capability nothing on the build side delivers is a claim you cannot point at`,
            subject: { ...subject, path: "/node/realizes" },
            evidence: { realizes, ...(realizes.length > 0 ? { unknown: realizes.filter((id) => !isBuildNode(id)) } : {}) },
            supportedFixes: [
              "set realizes to the ids of the build bubbles that make this capability real",
              "drop the product bubble if nothing in this project delivers it yet",
            ],
          };
        }
      }
      // product bubbles are exempt from codeRefs-must-exist: `realizes` grounds
      // a capability, and the root is grounded by the whole build layer under it
      return null;
    }

    const refs = Array.isArray(node.codeRefs) ? node.codeRefs.filter((r) => typeof r === "string" && r.trim().length > 0) : [];
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
      const rel = refInsideProject(ref);
      if (rel === null || !fileIndexHas(index, rel)) {
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
    if (typeof node.id === "string") admittedBuildIds.add(node.id);
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
    "make every bubble's promise true by reading code — and give the flat pile a readable shape.",
    "Everything the mechanics seeded is the BUILD layer: the parts this project is made of. Rule 9",
    "adds the second layer, PRODUCT: what the project does for the people who use it, starting from",
    "one bubble for the product itself.",
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
    "4. Altitude: 3-5 top-level bubbles, and 3-5 children under any bubble that has children.",
    "   The skeleton is flat on purpose; your first job is to group it. If this project has more",
    "   real parts than that, you MUST introduce named parent bubbles and move the mechanical",
    "   package bubbles under them (set parentId) — never flatten, never leave nine bubbles",
    "   side by side. Name a group the way you name everything else on this canvas: what the",
    '   group does for the system — "money rules", "getting the word out" — never a layer,',
    '   folder or stack name ("backend", "packages", "shared code"), and give it its own',
    "   one-sentence promise. The same rule holds at every depth: 6 or more children means that",
    "   bubble is missing a grouping, so add the missing group rather than showing the crowd.",
    "5. Splits are allowed with evidence: where one package holds several genuine seams, add child",
    "   bubbles — each MUST carry real codeRefs of its own.",
    '6. Existing code keeps phase "built". Add edges where you read the relation out of the code,',
    "   with plain-language labels; never add an edge to mean \"contains\".",
    "7. Validation is armed for this turn: every upsert_node MUST carry codeRefs that resolve to",
    "   paths that exist in this project. Ops without them are rejected with a reason. A parent",
    "   group bubble points at the paths of the parts it holds, so it satisfies this too. The one",
    "   exception is a product bubble from rule 9: it owns no code, so `realizes` grounds it",
    "   instead of codeRefs, and the product root is grounded by the whole build layer beneath it.",
    "8. Only what git tracks counts as real: a directory git ignores — typically a leftover folder",
    "   holding nothing but installed dependencies after a branch switch — is not part of this",
    "   project, so never survey it and never point codeRefs at it.",
    "9. Then the product pass, and it starts from ONE bubble: the product itself. Create that root",
    '   first — `layer: "product"` with `parentId: null`, its label the product\'s name in plain',
    "   English (take it from the package name, the README title or the repository folder, said the",
    "   way a person would say it) and its summary the one-sentence promise of the whole thing. It",
    "   is the only top-level product bubble: a second one is rejected with `op/second-root`, and",
    "   because the root stands for the entire build layer it needs no `realizes`. Then hang 3-5",
    '   capability bubbles under it (`layer: "product"`, `parentId` = the root) — one per capability',
    "   this project gives a person, each stated as a promise to that person: \"split a bill with",
    '   friends", "see who owes what". Derive them from the surfaces a user actually touches —',
    "   screens and routes, commands, the published entry points — and confirm every one against",
    "   the code. A README may name capabilities the code never grew, so a capability exists only",
    "   if you can point at the build bubbles that deliver it. Every capability under the root MUST",
    "   set `realizes` to the ids of those build bubbles: that is the only link between the two",
    "   layers, and this turn a capability without one is rejected. Product bubbles need no",
    "   codeRefs, are never a child of a build bubble, and never share an edge with one — the",
    "   layers only meet through `realizes`.",
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
