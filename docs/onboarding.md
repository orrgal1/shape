# Onboarding an existing project (design, 2026-08-28)

Brownfield entry: point Shape at a repo that already exists, get a trustworthy canvas,
continue steering/building from there. This is the funnel's original brownfield idea returning as
a feature — the design decisions below are the corrections `notes/understand.md` derived, applied.

## Principle

The agent never invents the skeleton. Mechanics produce the graph; the model produces the
meaning; drift rendering verifies the result. Survey, not diary (notes/understand.md §self-report).

## Pipeline

### Stage 1 — mechanical skeleton (instant, zero model cost)

On `onboard`, the bridge synthesizes intent nodes from `extractReality`:

- one `component` node per workspace package: id `slug(pkgName)`, `phase: "built"`,
  `codeRefs: [pkgDir]`, label = short package name, summary = package.json `description`
  or `"Workspace package at <dir> — survey pending."`
- one `depends` intent edge per cross-package reality edge.

Level 1 = boundaries enforced by mechanism (workspace packages), per notes/understand.md's depth
answer. The canvas fills with ground truth before the model says a word.

### Stage 2 — agent survey turn

Bridge composes an onboarding prompt (bridge/src/onboarding.ts) with these constraints:

1. **Enrich, don't invent.** Rewrite each placeholder summary as the package's one-sentence
   promise, derived from reading export surfaces, manifests, and imports — NOT from README
   or doc prose (anti-diary rule, stated to the agent explicitly).
2. **Boundary test** (verbatim from notes/understand.md): a bubble deserves to exist iff its promise
   is stateable in one sentence and deleting it would break a named set of importers.
3. **Altitude bounds:** 3–5 bubbles per layer — top level and every set of children alike.
   6+ siblings means a grouping is missing, so the agent MUST introduce named parent bubbles
   (plain-English group names saying what the group does for the system — "money rules",
   "getting the word out" — each with its own one-sentence promise) and move the mechanical
   package bubbles under them via `parentId`, never flattening. Stage 1 stays flat on purpose:
   mechanics know packages, not domains, so grouping is the survey turn's first job. A group
   bubble's `codeRefs` are the paths of the parts it holds, which satisfies validation mode.
4. **Splits allowed with evidence.** Where the mechanical and architectural boundaries disagree
   (one package holding several genuine seams), the agent may add child bubbles — each MUST
   carry real `codeRefs`.
5. Existing code keeps `phase: "built"`. Dataflow edge labels welcome where the relation is
   read from code.
6. Optional user `focus` utterance scopes the survey.
7. **Product pass** (rule 9 of the prompt) — see §Stage 2b below.

**Onboarding validation mode:** for the duration of the survey turn the bridge additionally
rejects any `upsert_node` whose `codeRefs` are absent or do not resolve to existing paths under
the target cwd. The agent cannot narrate structure it cannot point at. Product bubbles are the
one exception, and they are held to the same bar by a different measure (§Stage 2b).

### Stage 2b — the product pass

Stages 1 and 2 survey the BUILD layer: the parts the project is made of. A canvas that stops
there tells the user how the code is arranged and never says what the thing *does*, so the
survey turn ends one layer up.

The product pass starts from ONE bubble: the product itself. The agent creates it first —
`layer: "product"`, `parentId: null`, label = the product's name in plain English (derived from
the package name, the README title or the repository folder, said the way a person would say it),
summary = the one-sentence promise of the whole thing. There is exactly one such bubble;
`applyOps` rejects a second top-level product node with `op/second-root` (CONTRACTS.md §Graph
document).

Then the capabilities, as children of that root: 3–5 bubbles (`layer: "product"`, `parentId` =
the root), each a capability said as a promise to a person ("split a bill with friends"), derived
from the surfaces a user actually touches — screens and routes, commands, published entry points
— and each cross-checked against code. Every capability MUST carry `realizes`: the ids of the
build bubbles that deliver it. That is the only link between the layers (no cross-layer
`parentId`, no cross-layer edges), and it is what makes the drill-down from a capability to its
parts possible.

**Anti-README rule, restated for the product layer.** A README names capabilities the code never
grew; the survey is not allowed to repeat them. So product bubbles are exempt from
codeRefs-must-exist (a capability owns no code of its own) but are gated instead: an
`upsert_node` with `layer: "product"` **and a non-null `parentId`** is vetoed with code
`onboarding/unrealized-product` unless at least one id in `realizes` resolves to a build node
that already exists on the canvas (a build bubble upserted earlier in the same call counts). Same
receipt shape as every other gate veto — `code` / `subject` / `evidence` / `supportedFixes`, the
fixes being "point `realizes` at the build bubbles that make this real" or "drop the bubble".
The product root is the one product bubble the gate lets through with an empty `realizes`: it
stands for the whole build layer the survey has just grounded, and uniqueness is already enforced
by `op/second-root`.

Unrealized capabilities are still a legitimate canvas state *after* onboarding — that is how the
user says "I want this next", and the client glows those bubbles. The gate only bars them from
the survey turn, where every bubble must be a reading of existing code.

### Stage 3 — verification render

On terminal `agent_end` the existing reality/drift pass runs. Drift glow immediately marks every
bubble whose declared edges disagree with actual imports — the falsifiable-claim bar from
notes/understand.md, rendered instead of asserted. The user's first steering clicks naturally go to
the glowing bubbles ("resurvey this").

## Contract deltas (v1.1)

- shared: `ClientMsg` += `{ type: "onboard", focus?: string }`
- shared: `SessionInfo` += `targetHasCode: boolean`
- bridge: run `extractReality` once at startup (reality layer present from minute zero, also
  powers `targetHasCode` for TS repos; a cheap source-file scan covers the rest)
- bridge: skeleton synthesis + onboarding prompt composer + onboarding validation mode
- web: empty-canvas state offers two paths — "Say the idea" (greenfield) and "Map this project"
  (CTA + optional focus field) when `targetHasCode` and the intent layer is empty. Survey
  progress streams like any normal turn.

Deltas from the product layer (v1.2, 2026-09-03):

- shared: `IntentNode` += `layer?: Layer` (absent = build) and `realizes?: string[]`
- bridge: survey prompt rule 9 (product pass) + gate code `onboarding/unrealized-product`
- bridge: the preamble opens greenfield work in the product layer (idea → 3–5 capabilities)
- bridge: steering composer adds `Realized by:` for a capability referent, `Serves:` for a part

Deltas from the product root (v1.3, 2026-09-03):

- shared: `productRootOf(doc)` (the single top-level product node, else `null`) + validation
  code `op/second-root`
- bridge: survey prompt rule 9 creates the root first, capabilities as its children; the gate
  applies `onboarding/unrealized-product` only to product nodes with a non-null `parentId`
- bridge: the preamble opens greenfield work by creating the product bubble, then its 3–5
  capabilities underneath it
- bridge: steering composer renders the root as `Referent: the product "<label>"`, listing its
  capabilities as neighbors instead of a `Realized by:` line
- web: the product view opens focused on the root (first breadcrumb crumb = the product name)

## Degradation and non-goals

- Non-pnpm/TS repos: empty skeleton → pure agent survey, still anchored by codeRefs-must-exist
  validation; no drift verification until a per-language extractor exists. Accepted v1 scope.
- No subagent fan-out per package in v1 (candidate for large monorepos later).
- Post-onboarding re-summarization on commit delta stays user-steered in v1 (click drifted
  bubble → speak); automatic re-summarization of affected nodes is the documented later step
  (notes/understand.md §update-trigger).
