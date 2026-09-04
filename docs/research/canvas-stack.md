# Canvas Stack Research & Recommendation (2026-08-28)

*Scout research brief; links scout-sourced, verify licenses/repo existence before lifting code.*

## Ranked recommendation

1. **`@xyflow/react` (React Flow v12) + `elkjs` + Zustand** — MIT; full React component trees inside nodes (pulse states, drift glows, voice wavebars), subflow/group nodes for compound drillable bubbles, viewport-scale LOD hook for semantic zoom.
2. **`@antv/g6` v5 + WebCola** (fallback) — multi-renderer (SVG/Canvas/WebGL), handles larger node counts; heavier runtime, less reactive React DX.

## Renderer head-to-head

| Renderer | License | Verdict for visual-harness |
|---|---|---|
| **React Flow (`@xyflow/react` v12.11.x)** | MIT (optional Pro templates) — [xyflow.com](https://xyflow.com/open-source) | **#1**: industry-standard React canvas; HTML/CSS custom nodes, subflows/nesting, reactive edge labels, LOD zoom integration. |
| **tldraw SDK (v4.x)** | Proprietary/hobby; production needs license key; non-commercial requires permanent watermark — [tldraw.dev/community/license](https://tldraw.dev/community/license) | **Avoid**: restrictive terms; whiteboard-shaped, not programmatic-graph-shaped. |
| **Cytoscape.js (v3.34.x)** | MIT — [js.cytoscape.org](https://js.cytoscape.org/) | Canvas-only, CSS-like selectors; rich React cards inside nodes require clumsy overlays. |
| **Sigma.js v3 + Graphology** | MIT — [sigmajs.org](https://www.sigmajs.org/) | Built for 50k+ node WebGL networks; wrong tool for 10–200 rich interactive bubbles. |
| **D3 + custom SVG/Canvas** | ISC/BSD — [d3js.org](https://d3js.org/) | Max flexibility, hand-roll pan/zoom/handles/edge routing/nesting. Too high maintenance. |
| **PixiJS/WebGL (Force-Graph, Cosmo)** | MIT — [pixijs.com](https://pixijs.com/) | GPU sprites, but syncing React DOM inputs with WebGL transforms adds heavy friction. |
| **`@antv/g6` v5.1.x** | MIT — [g6.antv.antgroup.com](https://g6.antv.antgroup.com/) | Viable #2; heavier, complex API, mostly Chinese-language ecosystem. |
| **Excalidraw SDK** | MIT — [excalidraw.com](https://excalidraw.com/) | Hand-drawn whiteboard metaphor; no programmatic DAG auto-layout or drill-down nodes. |

## Auto-layout

Agent-driven splits/merges must animate without edge desync. React Flow edges live in an SVG overlay derived from node coordinate state, so **CSS transitions desynchronize edges** — compute target positions off-thread, then tween `{x,y}` per frame via `requestAnimationFrame`.

- **`elkjs`** — **recommended**. Hierarchical (Sugiyama), force, and compound/nested node support (essential for sub-bubbles); async promise API, web-worker friendly. [github.com/kieler/elkjs](https://github.com/kieler/elkjs)
- **`@dagrejs/dagre`** — sync, light, feature-frozen; no compound nodes.
- **`d3-force`** — organic springs, good for freeform ideation bubbles; jitters unless cooled/tweened.
- **`webcola`** — constraint-based with non-overlap/alignment; better than raw d3-force for semi-structured graphs. [ialab.it.monash.edu/webcola](https://ialab.it.monash.edu/webcola/)

**Pairing:** elkjs + rAF tweening for the architecture hierarchy; optional WebCola mode for organic ideation phase.

## Semantic zoom pattern

Query viewport scale via `useStore((s) => s.transform[2])`; nodes swap internal representation across LOD tiers: **dot → compact badge → architecture card → detailed contract/code artboard**. Keeps 60fps at all zoom levels.

## Studyable / forkable projects

| Project | Stack | License | Reusable |
|---|---|---|---|
| [`patoles/agent-flow`](https://github.com/patoles/agent-flow) | Next.js/TS, VS Code ext, canvas visualizer | Apache-2.0 | **High** — Claude Code session detection + event-stream ingestion; pattern transfers to omp's event stream. |
| [`langgraph-gui`](https://langgraph-gui.github.io/) | Svelte 5 + SvelteFlow / React Flow + elkjs | MIT | **High** — graph↔runtime-state sync, stepping/interrupting, elkjs pipelines. |
| [`langchain-ai/open-canvas`](https://github.com/langchain-ai/open-canvas) | Next.js (Turborepo), LangGraph | MIT | **High** — dual-pane canvas/chat, agent-driven artifact mutation lifecycle. |
| [`skovalik/cognograph`](https://github.com/skovalik/cognograph) | React Flow + Zustand | — | Semantic-zoom LOD tiers nearly identical to ours (<0.2 dots → badges → cards → editors → artboard). |
| [`miltonian/cartographer`](https://github.com/miltonian/cartographer) | React Flow | — | Boundary zoom: zooming into a subsystem scopes into nested children. |
| [`scgopi/GraphCode`](https://github.com/scgopi/GraphCode) | Swift/macOS, Ghostty zmx daemons | FSL-1.1-MIT / MIT | Conceptual — daemon resilience, multi-agent coordination. |
| [`ArgaLabs/attractor-visual-builder`](https://github.com/ArgaLabs/attractor-visual-builder) | Python, Graphviz DOT, MCP | unlicensed | Conceptual — observe→guard→steer manager loop. |
| Flowith | proprietary SaaS | — | None; conceptual reference. |

## omp frontend note

omp is headless (CLI/TUI, PTY multiplexing, `xd://` tool protocol, hub messaging). No public web UI exists — visual-harness would be its first graphical client, built against the instruction-injection/steering surface.
