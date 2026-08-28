# Evaluate

Posture: **compete** (`kind: tool`) — this would be built and run here, against a category with 86k-install incumbents.

## credibility

**3** — The claim is true where it matters and the evidence is in the room. The pain is first-party and specific: sole author of a 164-commit, 31,671-LOC monorepo who cannot name its components. The mechanism is not speculative either — a pnpm workspace with `@loreframe/*` imports yields the node set and edge set mechanically, no inference required; a two-minute grep already produced the real cross-package graph. What is *not* credible is the version as originally imagined (agent narrates as it builds), for the three self-report reasons in `understand.md`. Scoring the corrected version, not the original.

## novelty

**1** — Barely survives its own veto. The read half is a commodity: **CodeViz** ships multi-level architecture→function diagrams, click-to-code, query→diagram, regenerate-architecture, at 86,715 installs and $19/mo — *and* ships one-click LLM prompt generation, which is the addressing reduction of the steering half already in market. **DeepWiki** ships import-graph-grounded architecture diagrams free, auto-refreshing, MCP-exposed. Half a dozen others (GitDiagram, ProductMap, Zevo, Codalogy, Swark, AgentDoc, OpenVisio) crowd the same ground. And **CodeSee is the cautionary datapoint**: it proved demand, shut down Feb 2024, and was absorbed by GitKraken — this category has killed a funded company already.

The nameable differentiator is real but thin, and it is *only* the two things nobody does: (a) the map as a steering surface into a **live** session — everyone does diagram→source, nobody does diagram→prompt-into-running-agent; (b) **commit-delta-triggered** incremental re-summarization tied to an agent's own cadence rather than manual refresh or PR hooks. Not a 0 — a differentiator exists and can be stated in one sentence. Not a 2 — it is a feature-shaped gap in someone else's product, not a product.

## fit

**2** *(provisional — the user should overwrite)* — Unusually strong on assets, unproven on intent. The test repo is the user's own, the pain is his, and he is the only user who has to be satisfied for v1 to be worth having. The `ideas` funnel is next door. Against: this is explicitly framed as *"an internal thing for myself at this point"*, which caps payoff at personal utility unless that changes, and the honest cheap path (install CodeViz, point it at `~/code/livinglore`, read the output) is not a build at all. Fit is high **as a tool for himself**, unestablished **as a product**.

## payoff

**2** — The read half's payoff is capped by substitutes: if CodeViz or DeepWiki answers "what are the components and how do they interact" adequately, the payoff of building it is roughly zero and the correct move is a $19/mo subscription. The residual payoff sits almost entirely in the steering channel and the delta trigger — genuinely unserved, but narrow, and blocked on assumption 4 (no agent CLI exposes a supported inject-into-running-session API, so the mechanism may not exist yet). Held at 2 rather than 3 because the version of this that pays off big is the one where the map becomes the primary interface for directing agents, and nothing yet shows that clicking a bubble beats typing a sentence.

## POC cost

**4 hours** — and the first 30 minutes are not building.

**Step 0 (free, do it first):** install CodeViz, point it at `~/code/livinglore`, and separately run DeepWiki. Read both. If either already produces a map he trusts, the read half is answered by a purchase and only the steering residual survives — which per `understand.md` is not a product yet. This step can kill the whole idea before any code exists, which is why it is step 0.

**Step 1 (~4h, only if step 0 disappoints):** mechanical extraction over the pnpm workspace — packages as level-1 nodes, `@loreframe/*` imports as edges, `index.ts` export surfaces as level 2 — plus one LLM labeling pass constrained to that structure, rendered static. No live session, no steering, no watcher. The point is to test correctness of a *derived* map, nothing else.
