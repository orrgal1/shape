# Onboarding an existing project (design, 2026-08-28)

Brownfield entry: point Shape at a repo that already exists, get a trustworthy canvas,
continue steering/building from there. This is the funnel's original brownfield idea returning as
a feature — the design decisions below are the corrections `understand.md` derived, applied.

## Principle

The agent never invents the skeleton. Mechanics produce the graph; the model produces the
meaning; drift rendering verifies the result. Survey, not diary (understand.md §self-report).

## Pipeline

### Stage 1 — mechanical skeleton (instant, zero model cost)

On `onboard`, the bridge synthesizes intent nodes from `extractReality`:

- one `component` node per workspace package: id `slug(pkgName)`, `phase: "built"`,
  `codeRefs: [pkgDir]`, label = short package name, summary = package.json `description`
  or `"Workspace package at <dir> — survey pending."`
- one `depends` intent edge per cross-package reality edge.

Level 1 = boundaries enforced by mechanism (workspace packages), per understand.md's depth
answer. The canvas fills with ground truth before the model says a word.

### Stage 2 — agent survey turn

Bridge composes an onboarding prompt (bridge/src/onboarding.ts) with these constraints:

1. **Enrich, don't invent.** Rewrite each placeholder summary as the package's one-sentence
   promise, derived from reading export surfaces, manifests, and imports — NOT from README
   or doc prose (anti-diary rule, stated to the agent explicitly).
2. **Boundary test** (verbatim from understand.md): a bubble deserves to exist iff its promise
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

**Onboarding validation mode:** for the duration of the survey turn the bridge additionally
rejects any `upsert_node` whose `codeRefs` are absent or do not resolve to existing paths under
the target cwd. The agent cannot narrate structure it cannot point at.

### Stage 3 — verification render

On terminal `agent_end` the existing reality/drift pass runs. Drift glow immediately marks every
bubble whose declared edges disagree with actual imports — the falsifiable-claim bar from
understand.md, rendered instead of asserted. The user's first steering clicks naturally go to
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

## Degradation and non-goals

- Non-pnpm/TS repos: empty skeleton → pure agent survey, still anchored by codeRefs-must-exist
  validation; no drift verification until a per-language extractor exists. Accepted v1 scope.
- No subagent fan-out per package in v1 (candidate for large monorepos later).
- Post-onboarding re-summarization on commit delta stays user-steered in v1 (click drifted
  bubble → speak); automatic re-summarization of affected nodes is the documented later step
  (understand.md §update-trigger).
