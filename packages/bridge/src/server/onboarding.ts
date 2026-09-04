/**
 * Brownfield onboarding, server half (onboarding.md): the two prompts the model
 * answers about existing code — the survey that maps a project nobody mapped,
 * and the catch-up that brings a map the code moved under back to the code —
 * and the validation that holds both to what the project contains.
 *
 * The prompt carries the project as the mechanics read it — the seeded package
 * skeleton, the classes and functions inside its files, the infrastructure its
 * configuration names, the checks it already runs — so the survey maps a repo
 * down to the parts inside the files instead of stopping at the files. The
 * catch-up carries the same readings, narrowed to the gap: the drift notes, and
 * the code no bubble covers.
 *
 * Pure: the project is known through its `FileIndex`, never through the disk —
 * the mechanics that read files live in `agent/onboarding-fs.ts`.
 */

import { fileIndexHas, normalizeIndexPath, type FileIndex } from "../../../shared/src/fileindex.ts";
import { layerOf, symbolRefOf, unclaimedReality } from "../../../shared/src/index.ts";
import type { GraphDoc, IntentNode, RealitySymbol } from "../../../shared/src/index.ts";
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
 * Infra and correctness bubbles are held to the build bar twice over: a
 * database or a pipeline is real because a configuration file in this project
 * describes it, and a test suite or a check is real because the files that ARE
 * it are in the project, so both owe codeRefs like any part of the build
 * layer — and both owe their link to that layer too, because connection is the
 * default (user decision 2026-09-04). Infrastructure that names nothing in
 * `hosts` (`onboarding/unhosted-infra`) and a check that names nothing in
 * `verifies` (`onboarding/unattesting-correctness`) are refused for the same
 * reason an unrealized capability is: by the time the survey reaches those
 * passes the parts they should name are already on the canvas. A canvas with
 * no parts at all asks neither — there is nothing there to name.
 *
 * A codeRef may also name one part inside a file (`src/room.ts#Room`). Then
 * both halves are checked: the path against the index, the name against the
 * classes and functions the reality layer read out of that file. A file the
 * reality layer never parsed (a config file, an image, a project extracted by
 * an older bridge) has no known parts, so a name against it is accepted — the
 * gate refuses claims it can disprove, not claims it cannot check.
 *
 * The gate is created per canvas call, so build bubbles admitted earlier in the
 * SAME batch already count as real for a product, infra or correctness bubble
 * later in it.
 */
export function onboardingOpGate(
  index: FileIndex,
  doc: Pick<GraphDoc, "nodes" | "reality">,
): OpGate {
  const admittedBuildIds = new Set<string>();
  const existing = (id: unknown): IntentNode | undefined =>
    typeof id === "string" ? doc.nodes.find((n) => n.id === id) : undefined;
  const isBuildNode = (id: string): boolean => {
    if (admittedBuildIds.has(id)) return true;
    const prior = existing(id);
    return prior !== undefined && layerOf(prior) === "build";
  };
  // nobody owes a link to a layer that is not there: a canvas with no parts at
  // all — a project whose skeleton found no package — asks an infra bubble or
  // a check for nothing, the same way `linkGapsOf` in shared/ does not
  const hasBuildNode = (): boolean =>
    admittedBuildIds.size > 0 || doc.nodes.some((n) => layerOf(n) === "build");

  /**
   * file -> names of the classes and functions the reality layer read out of
   * it, built on first use: most canvas calls carry no symbol ref at all, and
   * a big repo's symbol list is not worth walking for nothing. A document
   * stored by an older bridge has no symbols, which reads as "nothing known".
   */
  let namesByFile: Map<string, string[]> | null = null;
  const knownNames = (file: string): string[] | undefined => {
    if (namesByFile === null) {
      namesByFile = new Map<string, string[]>();
      for (const symbol of doc.reality?.symbols ?? []) {
        const bucket = namesByFile.get(symbol.file);
        if (bucket === undefined) namesByFile.set(symbol.file, [symbol.name]);
        else bucket.push(symbol.name);
      }
    }
    return namesByFile.get(file);
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
    const claimedLayer = node.layer;
    const layer =
      claimedLayer === "product" ||
      claimedLayer === "build" ||
      claimedLayer === "infra" ||
      claimedLayer === "correctness"
        ? claimedLayer
        : prior
          ? layerOf(prior)
          : "build";

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
      // every layer hears the same refusal in its own words: what it owes, and
      // what it would mean for nothing in the project to back it
      const owed =
        layer === "infra"
          ? {
              needs:
                "the configuration that describes it — during a survey you may not declare a database, a host or a pipeline this project does not configure",
              add: "add codeRefs listing the configuration files this piece of infrastructure comes from",
              drop: "drop the node if nothing in this project configures it",
            }
          : layer === "correctness"
            ? {
                needs:
                  "the files that ARE it — during a survey you may not declare a test suite, a smoke run or a check this project does not contain",
                add: "add codeRefs listing the test, script or workflow files this verification is made of",
                drop: "drop the node if nothing in this project attests it",
              }
            : {
                needs:
                  "the code it covers — during a survey you may not declare structure you cannot point at",
                add: "add codeRefs listing the workspace-relative paths this bubble covers",
                drop: "drop the node if you cannot point at its code",
              };
      return {
        code: "onboarding/no-coderefs",
        severity: "error",
        message: `onboarding survey: ${layer === "build" ? "node" : `${layer} bubble`} "${String(node.id)}" needs codeRefs naming ${owed.needs}`,
        subject,
        evidence: {},
        supportedFixes: [owed.add, owed.drop],
      };
    }
    for (const [i, ref] of refs.entries()) {
      // a ref may name one part inside a file; the path half is checked the
      // same way either way
      const symbol = symbolRefOf(ref);
      const rel = refInsideProject(symbol === null ? ref : symbol.path);
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
      if (symbol === null) continue;
      const known = knownNames(normalizeIndexPath(rel));
      // a file the reality layer never read has no known parts: nothing to
      // disprove, so the claim stands
      if (known === undefined || known.includes(symbol.name)) continue;
      return {
        code: "onboarding/unknown-symbol",
        severity: "error",
        message: `onboarding survey: node "${String(node.id)}" codeRefs "${ref}" names a part that ${rel} does not contain — that file declares no top-level class or function called ${symbol.name}`,
        subject: { ...subject, path: `/node/codeRefs/${i}` },
        evidence: { file: rel, name: symbol.name, known: known.slice(0, 20) },
        supportedFixes: [
          `name one of the classes or functions that file declares: ${known.slice(0, 20).join(", ")}`,
          `point at the whole file instead (${rel})`,
        ],
      };
    }
    // The other half of the same bar, on the other two layers (user decision
    // 2026-09-04: connection is the default). A piece of infrastructure
    // nothing runs on and a check that attests nothing are narration exactly
    // the way an unrealized capability is: by the time rules 11 and 12 run,
    // the build bubbles they should name are already on the canvas, so a
    // bubble that names none is pointing at nothing. Asked only when there is
    // a build layer to point at.
    if ((layer === "infra" || layer === "correctness") && hasBuildNode()) {
      const isInfra = layer === "infra";
      const field = isInfra ? "hosts" : "verifies";
      // the link sticks across an upsert that omits it, the same way `layer`
      // and `realizes` do, so the gate reads the prior bubble when it is absent
      const claimed = isInfra
        ? Array.isArray(node.hosts)
          ? node.hosts
          : (prior?.hosts ?? [])
        : Array.isArray(node.verifies)
          ? node.verifies
          : (prior?.verifies ?? []);
      const named = claimed.filter((r) => typeof r === "string" && r.trim().length > 0);
      const grounded = named.filter((id) => isBuildNode(id));
      if (grounded.length === 0) {
        return {
          code: isInfra ? "onboarding/unhosted-infra" : "onboarding/unattesting-correctness",
          severity: "error",
          message: isInfra
            ? `onboarding survey: infra bubble "${String(node.id)}" must name at least one build bubble in \`hosts\` that already exists on the canvas — during a survey a piece of infrastructure nothing on the build side runs on is a claim you cannot point at`
            : `onboarding survey: correctness bubble "${String(node.id)}" must name at least one build bubble in \`verifies\` that already exists on the canvas — during a survey a check that attests nothing on the build side is a claim you cannot point at`,
          subject: { ...subject, path: `/node/${field}` },
          evidence: {
            [field]: named,
            ...(named.length > 0 ? { unknown: named.filter((id) => !isBuildNode(id)) } : {}),
          },
          supportedFixes: isInfra
            ? [
                "set hosts to the ids of the build bubbles that run on or use this piece of infrastructure",
                "drop the infra bubble if nothing in this project runs on it",
              ]
            : [
                "set verifies to the ids of the build bubbles this check attests — read them off the item's covers list",
                "drop the correctness bubble if nothing on the canvas is what it checks",
              ],
        };
      }
    }
    // only build bubbles ground a product capability's `realizes`
    if (typeof node.id === "string" && layer === "build") admittedBuildIds.add(node.id);
    return null;
  };
}

/**
 * Symbols a prompt lists before the inventory stops being a map of the code and
 * starts being a dump of it. Past this the listing narrows to what the files
 * publish, and then to the first {@link SURVEY_SYMBOLS_PER_FILE} of each file:
 * rule 10 needs the names it may claim, not every name that exists. The survey
 * and the catch-up turn share both budgets — a repo is no smaller when only
 * part of it is being mapped.
 */
const SURVEY_SYMBOL_BUDGET = 400;
const SURVEY_SYMBOLS_PER_FILE = 12;

/** the budgeted listing itself, plus what the head line has to announce about it */
interface SymbolListing {
  /** one line per file, the parts it declares, exported first */
  lines: string[];
  /** how many symbols survived the publish-only narrowing */
  listed: number;
  /** how many files they are spread over */
  files: number;
  /** the listing was narrowed to what the files publish */
  exportedOnly: boolean;
  /** each file's listing stops at SURVEY_SYMBOLS_PER_FILE, with the rest counted */
  perFileCap: boolean;
}

/**
 * The inventory rule 10 works from: one line per file, the parts it declares,
 * exported ones first because those are the ones another file can import and
 * therefore the ones that most often carry a promise of their own.
 *
 * Mechanical and deliberately technical, exactly like the skeleton and the
 * infra listing: these are the names a `file#Name` codeRef must spell, and the
 * gate above refuses any other spelling with `onboarding/unknown-symbol`.
 */
function budgetSymbols(symbols: readonly RealitySymbol[]): SymbolListing {
  // a repo with thousands of parts still has to fit in a prompt: publish-only
  // first, then a per-file cap. Both are announced, so the model knows the
  // listing is narrowed rather than complete
  const exportedOnly =
    symbols.length > SURVEY_SYMBOL_BUDGET && symbols.some((s) => s.exported);
  const listed = exportedOnly ? symbols.filter((s) => s.exported) : symbols;
  const perFileCap = listed.length > SURVEY_SYMBOL_BUDGET;

  const byFile = new Map<string, RealitySymbol[]>();
  for (const symbol of listed) {
    const bucket = byFile.get(symbol.file);
    if (bucket === undefined) byFile.set(symbol.file, [symbol]);
    else bucket.push(symbol);
  }
  const files = [...byFile.keys()].sort();

  const lines: string[] = [];
  for (const file of files) {
    const bucket = byFile.get(file) ?? [];
    const ordered = [...bucket.filter((s) => s.exported), ...bucket.filter((s) => !s.exported)];
    const shown = perFileCap ? ordered.slice(0, SURVEY_SYMBOLS_PER_FILE) : ordered;
    const rest = ordered.length - shown.length;
    const parts = shown.map(
      (s) => `${s.name} (${s.kind}${s.exported ? ", exported" : ""}, line ${s.line})`,
    );
    lines.push(`- ${file}: ${parts.join(", ")}${rest > 0 ? `, … +${rest} more` : ""}`);
  }
  return { lines, listed: listed.length, files: files.length, exportedOnly, perFileCap };
}

/** The survey's own inventory block: the head line that frames it, then the listing. */
function surveySymbolLines(symbols: readonly RealitySymbol[]): string[] {
  if (symbols.length === 0) {
    return [
      "Classes and functions found in the code: none — the parts are files, and rule 10 stops at them.",
    ];
  }
  const listing = budgetSymbols(symbols);

  const head = `Classes and functions found in the code (${
    listing.exportedOnly
      ? `${listing.listed} exported, of ${symbols.length}, in ${listing.files} file(s)`
      : `${listing.listed} in ${listing.files} file(s)`
  }) — the inventory rule 10 works from${
    listing.exportedOnly
      ? "; this project has more parts than a prompt can hold, so only the ones its files publish are listed"
      : ""
  }${listing.perFileCap ? `, and each file stops at ${SURVEY_SYMBOLS_PER_FILE} with the rest counted` : ""}:`;

  return [head, ...listing.lines];
}

/**
 * Stage 2: the survey prompt. Carries the mechanical readings the rules work
 * from — the seeded skeleton, the classes and functions inside its files
 * (rule 10), the infrastructure its configuration names (rule 11), the checks
 * it already runs (rule 12).
 */
export function composeSurveyPrompt(doc: GraphDoc, focus: string | undefined): string {
  const skeleton = doc.nodes.map((n) => {
    const refs = n.codeRefs === undefined ? "" : ` codeRefs: ${n.codeRefs.join(", ")}`;
    return `- ${n.id} "${n.label}" — "${n.summary}"${refs}`;
  });
  const edges = doc.edges.map((e) => `- ${e.id} [${e.kind}] ${e.source} -> ${e.target}`);
  // the mechanical infra listing rule 11 works from: what the configuration
  // says, in the extractor's own technical words, with the files behind it
  const infra = doc.reality.infra.map(
    (i) => `- ${i.label} — ${i.hint} (evidence: ${i.evidence.join(", ")})`,
  );
  // and the listing rule 12 works from. `covers` is the half rule 11 has no
  // equivalent of: it says which code each verification exercises, which is
  // what lets the agent fill in `verifies` without guessing
  const verification = doc.reality.verification.map(
    (v) =>
      `- ${v.label} — ${v.hint} (evidence: ${v.evidence.join(", ")}; covers: ${v.covers.length > 0 ? v.covers.join(", ") : "nothing it could name"})`,
  );
  // and the inventory rule 10 works from: the parts inside the files, so the
  // survey has the names it may claim instead of being told to go find them
  const symbols = surveySymbolLines(doc.reality.symbols);

  const lines = [
    "<onboarding-survey>",
    "Map this existing project onto the canvas the user is watching. The canvas has just been",
    "seeded MECHANICALLY: one bubble per workspace package, real codeRefs, phase \"built\". None of",
    "it is your invention, and none of the placeholder summaries are trustworthy yet. This turn you",
    "make every bubble's promise true by reading code — and give the flat pile a readable shape.",
    "The map goes down to the classes and major functions inside those files: rule 10 turns the",
    "ones that carry a promise of their own into child bubbles, working from the inventory below.",
    "Everything the mechanics seeded is the BUILD layer: the parts this project is made of. Rule 9",
    "adds the PRODUCT layer: what the project does for the people who use it, starting from one",
    "bubble for the product itself. Rule 11 adds the INFRA layer: where the code runs and what it",
    "leans on outside itself, read out of this project's own configuration. Rule 12 adds the",
    "CORRECTNESS layer: what shows the parts are correct rather than merely written.",
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
    "   An infra bubble from rule 11 clears the same bar with the configuration files it comes from,",
    "   and a correctness bubble from rule 12 with the files that ARE the check.",
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
    "   Connection is the default on this canvas, not an extra: a capability whose realizers you",
    "   cannot name is one the survey does not create.",
    "10. Go down to the parts inside the files. Every leaf build bubble whose files declare classes",
    "   or functions — the inventory below — gets child bubbles for the ones that carry a promise",
    "   of their own: every class, every exported function, every request handler, command or",
    "   route, and any other top-level function another file imports. Each child carries",
    '   `codeRefs: ["<file>#<Name>"]` naming that one part of the code, plus a plain-English label',
    "   and promise like everything else on this canvas. 3-5 children per part; 6 or more means the",
    "   part is missing a grouping — add a named child group (its codeRefs the files or",
    "   `file#Name`s it holds) and hang them under it, never flatten. Small helpers stay inside",
    "   their parent. The file half must be a path git tracks and the name half must be in the",
    "   inventory below, or the op comes back with `onboarding/unknown-symbol`.",
    "11. Then the infra pass: where this thing runs and what it leans on. The block below says what",
    "   this project's configuration contains — a database, a host, a pipeline, a service someone",
    "   else runs — with the files each was read from. Turn them into bubbles with",
    '   `layer: "infra"`, named in the same plain English as everything else ("the main database",',
    '   "where the app runs", "the build-and-test pipeline"), `codeRefs` = the configuration files',
    "   listed as that item's evidence, and `hosts` = the ids of the build bubbles that run on it",
    "   or use it. 3-5 at the top level, and group the rest under named parent bubbles like any",
    "   other layer. An infra bubble is never a child of a build or product bubble and never shares",
    "   an edge with one: `hosts` is the only link between the layers here, the way `realizes` is",
    "   the only one above. Never invent infrastructure with no file behind it — if the block below",
    "   is empty, this project configures none and you create none.",
    "   And `hosts` is not optional: connection is the default, so an infra bubble that names no",
    "   build bubble is rejected with `onboarding/unhosted-infra` — name what runs on it, or drop",
    "   the bubble.",
    "12. Last, the correctness pass: what shows the parts are correct rather than merely written.",
    "   The last block below says what this project already contains that attests it — test suites,",
    "   smoke and end-to-end runs, checks like typechecking and linting, the checks a pipeline runs",
    "   on every push — with the files each was read from and, under \"covers\", the code each one",
    '   exercises. Turn them into bubbles with `layer: "correctness"`, named in the same plain',
    '   English as everything else ("the protocol checks", "checks that run on every push"),',
    "   `codeRefs` = the files listed as that item's evidence, and `verifies` = the ids of the",
    "   build bubbles it attests: read them off that item's covers list and match those paths",
    "   against the codeRefs of the bubbles above. 3-5 at the top level, and group the rest under",
    "   named parent bubbles like any other layer. A correctness bubble is never a child of a",
    "   build, product or infra bubble and never shares an edge with one: `verifies` is the only",
    "   link between the layers here, the way `hosts` and `realizes` are above. Never invent",
    "   verification with no file behind it — if the block below is empty, nothing in this project",
    "   attests anything yet and you create none.",
    "   `verifies` is not optional either: a check that names no build bubble is rejected with",
    "   `onboarding/unattesting-correctness`, because a check that attests nothing is the same",
    "   empty claim as a capability nothing realizes.",
    "",
    skeleton.length > 0 ? `Mechanical skeleton (${doc.nodes.length} bubble(s)) — package names and placeholder summaries below are machine-generated and deliberately technical; replace every one of them with a plain-English promise:` : "No workspace packages were detected — build the skeleton yourself from what you read, under the same codeRefs and plain-English rules.",
    ...skeleton,
    ...(edges.length > 0 ? ["Mechanical edges:", ...edges] : []),
    "",
    ...symbols,
    "",
    infra.length > 0
      ? `Infrastructure found in the code (${infra.length} item(s)) — read out of this project's configuration files and deliberately technical, exactly like the skeleton above; rule 11 turns them into plain-English infra bubbles:`
      : "Infrastructure found in the code: none. This project's configuration names no database, host, pipeline or outside service, so rule 11 creates no infra bubbles.",
    ...infra,
    "",
    verification.length > 0
      ? `Verification found in the code (${verification.length} item(s)) — read out of this project's own test files, scripts and pipelines, deliberately technical like the skeleton above; rule 12 turns them into plain-English correctness bubbles, and each item's covers list is what its \`verifies\` should name:`
      : "Verification found in the code: none. Nothing in this project tests, smoke-checks or statically checks itself, so rule 12 creates no correctness bubbles.",
    ...verification,
  ];

  if (focus !== undefined && focus.trim().length > 0) {
    lines.push("", `User focus for this survey: "${focus.trim()}"`);
  }

  lines.push(
    "",
    // the default said once more at the end, as a checklist: this is the shape
    // the survey is finished in, and the three cross-layer links are what make
    // the picture one canvas instead of four (user decision 2026-09-04)
    "When this turn is done, everything on the canvas is connected to the layers around it: every",
    "capability names the parts that realize it, every infra bubble names what runs on it, every",
    "check names what it attests, and every top-level build group is reached by a capability, by",
    "the infrastructure it runs on and by something that checks it. A top-level group nothing names",
    "is a gap, and closing it is part of this survey rather than something to leave for later.",
    "",
    "Read first, then call the canvas tool with the corrected bubbles. Work in batches so the user",
    "watches the map become true.",
    "</onboarding-survey>",
  );
  return lines.join("\n");
}

/**
 * The catch-up turn: the map exists and the code moved under it. Everything the
 * room knows about that gap goes in — the drift notes it computed (bridge/src/
 * server/drift.ts: a dependency the code has and the map does not, a declared
 * one the code never had, a part a codeRef names that is gone) and the code no
 * bubble covers (`unclaimedReality`) — and the rules stay the survey's, because
 * a bubble added today has to read like the ones added when the map was drawn.
 *
 * Null when there is nothing behind: no notes, no uncovered package, no
 * uncovered file. A prompt asking a harness to fix a map that already matches
 * the code is a turn spent making something up.
 */
export function composeCatchUpPrompt(doc: GraphDoc): string | null {
  // notes in canvas order, not in whatever order the drift map was built in:
  // the bubbles are listed the way the user's canvas holds them, and a note
  // left over for a bubble that is gone is stale bookkeeping, not a claim to
  // ask a turn about
  const noted = doc.nodes
    .map((node) => ({ node, notes: doc.drift[node.id] ?? [] }))
    .filter((entry) => entry.notes.length > 0);
  const { packages, files } = unclaimedReality(doc);
  if (noted.length === 0 && packages.length === 0 && files.length === 0) return null;

  const listing = budgetSymbols(files.flatMap((entry) => entry.symbols));

  const lines = [
    "<catch-up>",
    "This project is already mapped onto the canvas the user is watching, and the code has moved",
    "since the map was drawn. This turn brings the map back to the code — and only that: you are",
    "not re-surveying the project, and a bubble nothing below mentions is a bubble that still holds.",
    "",
    "The rules of the survey hold, unchanged. The ones that decide every op you are about to write:",
    "",
    "- PLAIN ENGLISH, NO JARGON. The person reading this canvas steers by voice and does not read",
    "  code. Every label, summary, status, edge label and note says what the part does for the whole",
    "  in terms of outcomes, not mechanisms — no acronyms, no protocol, library or file-format",
    "  names, no code identifiers, unless the part is literally about that thing.",
    '    BAD:  "Minimal JSONL RPC client, protocol v1, id-correlated request()"',
    '    GOOD: "Talks to the coding agent: sends it instructions and listens to everything it does"',
    "  Only codeRefs stay technical — they are machine addresses.",
    `- Boundary test, verbatim: "${BOUNDARY_TEST}" If the answer is "it is just where these files`,
    '  live", it is not a component — merge it upward.',
    "- Altitude: 3-5 top-level bubbles, and 3-5 children under any bubble that has children. A part",
    "  you add to a bubble that already holds five children means that bubble is missing a grouping:",
    "  add the named group and hang them under it, never flatten and never show the crowd.",
    "- Depth, rule 10: a leaf build bubble whose files declare classes or functions that carry a",
    '  promise of their own gets a child bubble per part, `codeRefs: ["<file>#<Name>"]`, with a',
    "  plain-English label and promise like everything else on this canvas.",
    "- Validation is armed for this turn exactly as it is for a survey: every upsert_node MUST carry",
    "  codeRefs that resolve to paths this project has (`onboarding/unknown-coderef`), the name half",
    "  of a `file#Name` ref MUST be a part the inventory below declares",
    "  (`onboarding/unknown-symbol`), a capability MUST name the build bubbles that realize it, an",
    "  infra bubble what runs on it, and a check what it attests.",
    "",
    "What this turn does, and nothing else:",
    "",
    "1. Answer every note below. A note that says a bubble names a part of the code that is no",
    "   longer there means that codeRef is dangling: point it at the part that replaced it, or drop",
    "   the ref — and drop the bubble too when nothing is left for it to be about.",
    "2. Add what is missing. The packages and files below that no bubble covers are the parts of",
    "   this project the map does not have yet: give each one a bubble, under the parent or the",
    "   named group it belongs to, with real codeRefs and a plain-English promise. Add the group",
    "   itself when the altitude rule needs one.",
    "3. Fix the links the notes name: declare the dependency the code has and the map does not,",
    "   with a plain-language label, and remove a declared dependency the code does not have.",
    "4. Leave the rest of the map alone. This is not the turn to rewrite summaries, regroup bubbles",
    "   or add a layer nothing below asks for.",
    "",
    noted.length > 0
      ? `Notes on the map (${noted.length} bubble(s)) — what the mechanics found the map claiming that the code does not support:`
      : "Notes on the map: none — nothing the map claims contradicts the code.",
    ...noted.map(
      (entry) => `- ${entry.node.id} "${entry.node.label}": ${entry.notes.join("; ")}`,
    ),
    "",
    packages.length > 0
      ? `Packages in the code that no bubble covers (${packages.length}) — deliberately technical, like a mechanical skeleton; each one owes a plain-English bubble:`
      : "Packages in the code that no bubble covers: none.",
    ...packages.map((pkg) => `- ${pkg.id} — ${pkg.dir}`),
    "",
    files.length > 0
      ? `Files the mechanics read that no bubble covers (${listing.files} file(s), ${listing.listed} part(s)) — the parts each declares, exported first, and the names a \`file#Name\` codeRef may spell${
          listing.exportedOnly
            ? "; more parts than a prompt can hold, so only the ones the files publish are listed"
            : ""
        }${listing.perFileCap ? `, and each file stops at ${SURVEY_SYMBOLS_PER_FILE} with the rest counted` : ""}:`
      : "Files the mechanics read that no bubble covers: none — every file the mechanics read is already on the canvas.",
    ...listing.lines,
    "",
    "Read the code first, then call the canvas tool with the ops that close the gap. Work in batches",
    "so the user watches the map catch up.",
    "</catch-up>",
  ];
  return lines.join("\n");
}
