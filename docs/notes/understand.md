# Understand

## Claim

An agent-maintained, drillable component map — rendered live beside a coding session, and accepting clicks on components and edges as steering input — restores a director's structural grip on a codebase they never read.

Falsifiable form: for a repo the user owns and cannot describe, the map's top-level nodes and edges are ≥80% correct against the code, and it omits no real top-level component. Below that bar the map is worse than nothing, because its whole purpose is to be trusted by someone who cannot check it.

## How it works

Three separable pieces, deliberately named apart because they have different difficulty and different value:

**The extractor.** Produces the graph. Two possible sources, and the choice is the whole design:
- *Agent narration* (as originally imagined): the agent describes what it built as it builds.
- *Code-derived*: mechanical extraction from the repo — workspace packages, cross-package imports, export surfaces — with the LLM only labeling and summarizing clusters it is shown.

**The renderer.** Bubbles, arrows, click-to-drill, two levels.

**The steering channel.** Click a component or an edge, say what it should be instead, and the instruction reaches the running session.

### The self-report problem

The originally-imagined version has a structural flaw worth stating in full, because it decides the design.

An agent narrating its own architecture is writing a **diary, not a survey**, and diaries fail in exactly the way that created this problem:

1. **Session amnesia.** The agent only narrates what it touched this session. Components built forty commits ago by a different session never get re-described — so map staleness is proportional to code *age*, which is precisely inverted from what the user needs. He already understands the recent work; it is the old strata he has lost.
2. **Intent–reality gap.** The agent describes what it *meant* to build. Half-finished refactors, dead paths, shortcuts wired around the abstraction it just described — the narration records the clean version. This is the same mechanism by which README architecture sections drift: nobody checks the claim against the imports.
3. **No falsifier.** The user cannot tell a wrong bubble from a right one — the entire premise is that he does not know the architecture. **A map that is 80% right and unverifiable is worse than no map**, because it manufactures false confidence in the one artifact used to steer.

The correction: derive nodes and edges from the code, and let the model only label. LLM narration *constrained to* ground-truth structure can be spot-checked. LLM narration *of* structure cannot. In a pnpm TS monorepo this is cheap — workspace globs give the packages, `@loreframe/*` import edges give the arrows, `index.ts` barrels give the export surfaces.

### The depth question, answered

Stop where a boundary is **enforced by something other than prose**. A boundary is real when a mechanism makes crossing it visible or costly: a workspace package, a directory with its own `package.json`/`tsconfig`, a module with a deliberate public export surface, a process or network boundary, a database schema, a queue. It is arbitrary when it is a folder someone made, or a cluster the model invented.

For a repo like Living Lore: **level 1 = workspace packages, level 2 = exported module surfaces within a package, stop.** That is the user's own "two levels," but derived rather than aesthetic.

Test for whether a bubble deserves to exist: *can you state what it promises to the rest of the system in one sentence, and would deleting it break a named set of importers?* If the answer is "it is just where these files live," it is not a component — merge it upward. Functions fail this test (no independent contract). Files usually fail. Packages almost never do.

Sanity bound: a 32k-LOC repo should yield **5–15 top-level nodes**. If extraction produces 40 bubbles, the clustering is wrong, not the codebase.

### The update trigger

Continuous per-turn updating is wrong on three axes: token cost on every turn, context pollution (the agent starts performing for the map instead of doing the task), and churn (a map reflowing mid-refactor displays garbage intermediate states).

Correct trigger: **structural delta at a quiet point.** After each commit, diff the mechanically-extracted graph — packages added or removed, cross-package edges added or removed, export surfaces changed. No structural delta → no update, zero LLM spend. Structural delta → re-summarize only affected nodes.

This makes cost proportional to *architectural* change rather than to activity, which matches the real information rate: ~90% of agent turns do not change the architecture. It also decouples the map from the session — it becomes a post-hoc observer of the repo, which is what makes it trustworthy per the self-report problem above.

### The steering half is a different product

The read half has provable standalone value against a named pain. The write half smuggles in three unsolved problems:

- **Instruction underspecification.** "This edge should be different" carries *less* information than typing the same thought into the chat — the agent still has to interrogate what "different" means. The click adds a referent, not a requirement.
- **Session-state coupling.** What happens when steering arrives mid-task, or when the clicked region was never in the agent's context?
- **Stale-map hazard.** Steering against a wrong map injects confidently-wrong instructions — the failure mode compounds rather than degrades.

The honest framing of the write half is **addressing**: a click resolves "which component" into concrete file paths. That is worth something, but it is a prompt-prefill feature, not a bidirectional canvas.

## Prior art

Searched: `live architecture diagram auto-updating codebase agent`, `CodeViz VS Code interactive C4`, `DeepWiki Cognition repository architecture`, `CodeSee shutdown GitKraken`, `living documentation AI 2026`, `AgentDoc MCP C4`.

**Manual-authorship notation — solves rendering, not the user's problem** (he will not write docs): C4 model, Structurizr, arc42, Mermaid-in-repo.

**Mechanical extraction, right data / wrong altitude** — file-granularity dependency graphs with no semantic labels: `madge`, `dependency-cruiser`, IDE dependency graphs.

**The direct incumbents — repo → labeled interactive diagram is solved several times over:**

- **CodeViz** — https://www.codeviz.ai/ and https://marketplace.visualstudio.com/items?itemName=CodeViz.codeviz — **86,715 installs**, YC-backed (EdisonLabs), $19/mo individual. Ships nearly the entire read half as specified: *"Multi-Level Code Visualization — from high level architecture down to function calls,"* click-to-code navigation, natural-language query→diagram, `CodeViz: Regenerate Architecture`, Mermaid/draw.io export. Also ships **"Create LLM Prompts: one-click prompts to provide codebase-wide context to any LLM"** — which is precisely the *addressing* reduction of the steering half, already shipped. Local static analysis and embeddings.
- **DeepWiki** (Cognition, makers of Devin) — https://deepwiki.com — swap `github.com`→`deepwiki.com`. 50k+ public repos pre-indexed. Builds a structural model from directory layout, manifests and **import graphs** before generating; emits architecture diagrams, module summaries linked to source, and a grounded Q&A. Private repos via a Devin org. Steerable through `.devin/wiki.json`. Auto-refreshes on updates. Exposed to coding agents over MCP.
- **CodeSee** — proved the demand and died on it: shut down commercial operations Feb 22 2024, acquired by **GitKraken** May 14 2024, folded into the DevEx platform as "code and function maps." The most important prior-art datapoint in the list, because it is the one that says this category is hard to monetize standalone.
- Also live in the space: GitDiagram, ProductMap AI, Zevo.ai, Codalogy, Swark (LLM→Mermaid from local code), AgentDoc/McpDoc (MCP server generating C4-style docs by walking the tree), OpenVisio (codebase map exposed to agents over MCP), Popsa's agentic doc pipeline (code changes open documentation-update PRs).

**What genuinely does not exist:**
1. The map as a **steering surface into a live agent session** — everyone does diagram→source navigation; nobody does diagram→prompt-into-running-session.
2. **Delta-triggered incremental re-summarization tied to an agent's own commit cadence** rather than manual refresh or PR hooks.

That is a thin residual. **The novel part of this idea is the part the user himself flagged as unclear; the clear part is a commodity.**

## What would have to be true

1. **A code-derived map of Living Lore is actually correct.** Testable today, for free, on the maximally favorable case: sole author, recent code, motivated reader. If it fails here it fails everywhere.
2. **The existing tools do not already answer the question.** Untested and cheap to test — point CodeViz (VS Code, local analysis, free tier) at `~/code/livinglore` and read the result. If it satisfies him, the read half is a wrapper and only the thin residual remains.
3. **Package granularity is the right altitude for this repo.** Living Lore has 7 libs + 2 apps = 9 top-level nodes, inside the 5–15 sanity bound. But `libs/conduct` holds three distinct model seams (`narrator/`, `manager/`, `mind/`) that are arguably peer components to the packages around them — meaning the mechanical boundary and the *architectural* boundary already disagree in the very first repo tested. If package-granularity misses that, level 1 needs a semantic pass and the extractor is harder than described.
4. **The steering channel has a delivery mechanism.** No agent CLI currently exposes a supported "inject a steering message into a running session" API. Without one this is polling a file the agent may never read, or a restart — which is not steering.
5. **A map is the right artifact at all.** The competing hypothesis is that the user does not need a *diagram*, he needs an **answerable index** — "what happens when a beat resolves," "who writes to state" — which DeepWiki-style grounded Q&A already delivers and which does not require a rendering layer at all. The diagram may be a solution shaped by how the problem *feels* rather than by what it costs.
6. **The docs are not already the map.** Living Lore carries `docs/design/` (six authoritative documents, a nine-domain map) and `docs/plan/README.md` (a built/next table). The stated pain is real, but its cause may be that these are prose rather than that they are absent — in which case the product is a renderer over existing docs, a much smaller thing.
