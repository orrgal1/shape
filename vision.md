# Vision: voice-driven, canvas-first agent development interface

*Fleshed out 2026-08-28. Supersedes the narrower "map of an existing codebase" framing in
`understand.md` — this is the greenfield, primary-interface version of the same idea. Not re-gated;
recorded as vision.*

## The vision, distilled

A new kind of agent development interface that is absolutely visual and voice-driven.

- **Blank canvas start.** You speak your initial idea (Wispr Flow, deeply integrated; other voice
  modes as fallback). A harness runs behind the scenes — model architecture configurable like any
  harness, with subscription presets (e.g. Anthropic: Fable 5 for exploration/planning, Opus 5 for
  workhorse coding, Sonnet for simple tasks), combinable across providers like omp.
- **The work is represented entirely visually.** One main bubble = the idea. It branches into
  drillable sub-bubbles as the agent fleshes it out. The *same* visualization then carries
  implementation: the main bubble splits into high-level components, each into the layer beneath,
  edges describing the interactions between them.
- **Click anything, steer it.** Click a bubble or an edge and speak: "this component should do X,"
  "split this," "merge these," "this relationship is wrong." The agent is always responsible for
  keeping the visualization current as it works.
- Bubble view is one view type; alternative/custom views later.

## Why this is different from the evaluated claim

`understand.md` evaluated the brownfield read-mostly version: a code-derived map of an existing
repo, agent labels only, steering demoted to "addressing." This version is the one `evaluate.md`
explicitly held payoff at 2 over: *"the version of this that pays off big is the one where the map
becomes the primary interface for directing agents."* That is precisely this.

## What genuinely does not exist (per 2026-08-28 prior-art scan)

1. **Unified semantic zoom, brainstorm → architecture → code.** The industry is strictly
   partitioned: Miro/FigJam/Heptabase for ideation, Mermaid/PRDs for architecture, Cursor/Claude
   Code/Devin for implementation. No shipping tool carries one persistent visual artifact across
   all three phases.
2. **Agent-maintained *architecture* graph vs execution-event DAG.** Every live agent visualizer
   (agent-flow for Claude Code, LangGraph Studio, Graph-of-Trace) renders *execution traces* —
   subagent spawns, tool calls. Nobody renders the *system being built* as a live decomposition
   graph the agent maintains while coding.
3. **Deictic voice steering.** Every 2025–26 voice product (Wispr Flow, Aqua Voice, Claude Code
   voice mode) is dictation into a prompt box. Click-a-node + speak-a-restructuring, with no
   intermediate chat box, does not exist.
4. **Spatial model orchestration.** Model presets everywhere are global settings. Binding
   role→model to graph subtrees (big model at root/architecture nodes, workhorse at component
   nodes, small at leaves) and making it visible/steerable on the canvas does not exist.

Nearest neighbors, and why they miss: **Flowith** (agent spawns canvas nodes, but nodes are
generations/tasks, not the architecture of an artifact); **Devin interactive planning** (live
editable plan DAG — but a sidebar checklist, discarded once execution starts); **agent-flow /
GraphCode / Attractor** (live graphs of *agents and processes*, with some click-to-steer, not of
the *thing being built*); **FlowSteer** (research: agent-maintained editable workflow canvas —
closest in spirit, workflow-shaped not architecture-shaped); **tldraw computer / Rivet / n8n**
(user draws the graph, agent executes it — inverted authorship).

## Core design decisions

### 1. One artifact, three phases — per-branch, not global

The graph is the same object from ideation through build. A bubble's lifecycle:

    idea-fragment → fleshed concept → component with a contract → implementation in progress → built (live)

Phase is a property of a *bubble*, not of the session. One branch can be deep in implementation
while a sibling is still being fleshed out. This is the differentiator over every plan view that
gets discarded when coding starts: the plan never becomes stale documentation because the plan IS
the interface you keep using.

### 2. The steering utterance = selection + speech

A click alone is a referent with no requirement. A sentence alone is a requirement with no referent
(the agent guesses "which component"). Together they form a complete steering utterance — this
dissolves the "instruction underspecification" objection from `understand.md`. Grammar:

- **click(bubble) + speech** → scoped instruction ("this should also handle retries")
- **click(edge) + speech** → interaction change ("make this async, queue in between")
- **drag A onto B** → merge proposal; **drawn edge** → "these should interact" — both confirmed
  by voice, executed by the agent.
- **click(bubble) + "use the big model here"** → orchestration is the same primitive.

Steering arrives mid-run as a queued, addressed instruction: the harness resolves the referent to
concrete files/context (the "addressing" reduction from understand.md — now one half of the
primitive rather than the whole feature).

### 3. Two-layer graph: intent vs reality, drift rendered

The self-report problem from `understand.md` (agent-narrated structure is a diary, not a survey)
still stands and is MORE dangerous here, because the map is the primary interface. The fix:

- **Intent layer** — agent-declared decomposition. Exists from minute zero; the only layer during
  ideation.
- **Reality layer** — mechanically code-derived (packages, import edges, export surfaces), appears
  as soon as code exists, recomputed on structural delta at commit points (never per-turn: cost
  proportional to architectural change, not activity).
- Rendered as one graph. **Drift is a first-class visual state**: a bubble whose declared contract
  diverges from its actual import/export surface glows. The map stays trustworthy precisely
  because it shows where it isn't. Greenfield softens the problem early (map and code born
  together); the reality layer keeps it honest as strata age.

### 4. Live affordances without live cost

Structural re-derivation only at quiet points, but the canvas still feels alive: bubbles pulse
while an agent works inside them, edges animate on data-contract changes, failures mark the bubble.
Presence and progress are cheap streaming events; *structure* changes only on verified delta.

## (historical, superseded 2026-09-02) Wispr Flow integration ladder (deepest → shallowest)

Scout-verified 2026-08 (links in research brief, agent://WisprIntegration):

1. **Voice Interface API** — official WebSocket streaming (`platform-api.wisprflow.ai`), partial
   transcripts, and crucially **context injection**: `selected_text`, `application.type`,
   `content_text/html`, screenshots, chat history. Deep integration means: on bubble-click, feed
   the selected component name, its neighbors, and edge labels as context — dictation comes back
   with your component names spelled right, formatted for the graph. Enterprise-gated today
   (access via request); the API shape is exactly what deictic steering needs.
2. **URI scheme control** — `wispr-flow://start-hands-free` / `stop-hands-free` drives the user's
   stock desktop Wispr install: press-and-hold on a bubble starts capture, release commits.
   Works today, no partnership needed.
3. **Focused-input capture** — canvas focuses a hidden input on selection; Wispr types into it.
   Shallowest, final-text only, works with any dictation tool — this is the universal fallback.
4. **Non-Wispr voice** — Deepgram Nova-3 / OpenAI Realtime / whisper.cpp streaming for users
   without Wispr; Web Speech API as zero-dependency floor.

## Open questions (the honest risk list)

1. **Does clicking a bubble beat typing a sentence?** Still the unproven core bet. The deictic
   utterance is *more* information than either channel alone — but the whole interface stands or
   falls on this feeling faster than a chat box, not just richer.
2. **Steering delivery.** Injecting an addressed instruction into a running session needs harness
   cooperation (omp has hub/steering; most CLIs don't expose it). Building on a harness that
   already supports mid-run steering is close to mandatory.
3. **Decomposition quality is the product.** If the agent's bubbles are wrong-altitude (40 bubbles
   for a 30k-LOC system), the interface amplifies the error. The boundary test from understand.md
   (a bubble deserves to exist iff its promise is stateable in one sentence and deleting it breaks
   named importers) has to be enforced by the harness, not hoped for.
4. **Reality-layer coverage beyond TS monorepos.** Mechanical extraction is cheap for pnpm
   workspaces; other ecosystems need per-language extractors. Scope v1 to one ecosystem.
5. **Wispr API access is enterprise-gated.** Tier 2 (URI scheme) is the realistic v1; Tier 1 is
   the partnership ask.

## Plausible v1 slice

Canvas (browser, React Flow — see client decision below) + omp harness underneath + Tier-2/3
Wispr capture:
speak an idea → agent produces the ideation graph live → click+speak refines it → cross the
build threshold on one branch → components gain execution state while the agent builds → reality
layer appears at first commit and drift renders. One ecosystem (TS monorepo), one view type
(bubbles), model presets hardcoded to one provider first.

## Graduation notes (2026-08-28, user)

- **Steering delivery: resolved.** omp already supports instruction injection into a running
  session — the risk-list item 2 above is answered. The build target is integration with our own
  harness.
- **Form factor: an omp plugin / alternative frontend.** Start by building this as a plugin over
  the harness — an interface people use *instead of* the default text interface, not a separate
  product with its own agent runtime.
- **Decision: graduated out of the ideas funnel** to a standalone project at
  `~/code/shape`. Funnel record (understand/evaluate/log) travels with this directory;
  the ideas repo retains the history in git.
- **Rebrand + independence (2026-09-02, user).** The project is **Shape** — builders look at the
  shape of the product, and Shape is that view. It is standalone: no coupling to any dictation
  vendor (the ladder above is history) or workspace manager (herdr). Voice input is any dictation
  tool typing into the focused steering input; integrations may return later only as optional,
  configurable adapters, never as dependencies. The same holds for the model backend: Shape
  is not coupled to omp or any other agent CLI or gateway — the bridge talks to a `Backend`
  interface and configuration picks the adapter (CLI agents such as omp, opencode, Claude
  Code, Cursor CLI, Codex CLI; or gateway keys such as OpenRouter, Vercel AI Gateway,
  OpenCode Go/Zen).

## Client decision (2026-08-28): browser first, TUI later at most

**TUI ruled out as first client.** A terminal can render a drillable *tree* well (outline view,
collapse/expand, status glyphs — fine as a later ambient monitor). The product, though, is a
spatial bubble graph: edge routing at character resolution degrades into noise past ~10 nodes,
labels compete with structure for the same cells, split/merge animation is janky, and click
targets are coarse exactly where deixis needs precision (edges). The core bet is "this feels
better than a chat box" — a TUI rendition handicaps the bet before it is tested.

**Stack (scout-sourced 2026-08, brief at agent://CanvasStackScout):**

- **Renderer: `@xyflow/react` (React Flow v12, MIT).** Full React component trees inside nodes
  (pulse rings, drift glow, voice wavebar, action buttons), subflows/group nodes for drillable
  hierarchy, SVG edge routing with interactive edge labels as steering click-targets.
- **Layout: `elkjs` (hierarchical + compound/nested nodes), positions tweened via rAF** — CSS
  transitions desync React Flow's SVG edges, so layout computes targets off-thread and JS
  interpolates. Optional WebCola mode for organic ideation-phase bubbles.
- **State: Zustand** holding the two-layer graph (intent + reality) and viewport-zoom → LOD tier.
- **Semantic zoom as LOD tiers** keyed to viewport scale: dot → badge → architecture card →
  detailed contract/code artboard.
- **Rejected:** tldraw SDK (v4 licensing/watermark terms, whiteboard-shaped not graph-shaped),
  Cytoscape/Sigma (canvas/WebGL rendering blocks rich React nodes), Excalidraw (no programmatic
  auto-layout), D3-custom (hand-rolling pan/zoom/edges). Second choice if React Flow hits a wall:
  AntV G6 v5.

**Studyable prior projects** (verify licenses/existence before lifting code): `patoles/agent-flow`
(Apache-2.0 — Claude Code event-stream → live graph ingestion), `langgraph-gui` (MIT — React
Flow/SvelteFlow + elkjs runtime-state sync), `langchain-ai/open-canvas` (MIT — dual-pane
canvas/chat), `skovalik/cognograph` (React Flow + Zustand semantic-zoom LOD tiers),
`miltonian/cartographer` (React Flow boundary-zoom codebase viz).

**omp note:** no public web frontend exists; Shape would be its first graphical client,
speaking to the harness's instruction-injection/steering surface.
