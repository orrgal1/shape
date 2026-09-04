# Prior Art: Canvas-First, Voice-Driven Agent Development Interfaces (2026-08-28)

*Scout research brief; links scout-sourced, verify before load-bearing use. Complements the
brownfield codebase-visualizer prior art (CodeViz, DeepWiki, CodeSee) in `../notes/understand.md`.*

## Taxonomy

```
                                Agent Autonomy in Graph Maintenance
                                 Low (User Builds)   High (Agent Builds)
                               +-------------------+--------------------+
         Static / Post-Hoc /   | Low-code Workflows| Execution Traces & |
         Debugger              | (n8n, Dify,       | Post-hoc Wikis     |
                               |  LangGraph Studio)| (GoT, DeepWiki)    |
Graph Mutability               +-------------------+--------------------+
& Steering Depth               | Canvas Drawing →  | TARGET: Agent-     |
         Live Bi-directional   | Execution Compiles| Maintained Semantic|
         Dynamic Steering      | (tldraw computer, | Graph + Spatial    |
                               |  FlowSteer, Rivet)| Voice Steering     |
                               +-------------------+--------------------+
```

## (a) User-authored workflow graphs the agent executes

- **[LangGraph Studio](https://www.langchain.com/blog/langgraph-studio-the-first-agent-ide)** — parses user-written LangGraph code into a DAG; state inspection, breakpoints, manual state injection. Topology is code-defined by the developer.
- **[Rivet](https://rivet.ironcladapp.com/)** — open-source canvas for wiring LLM pipelines; execution flows along user-defined wires.
- **[Dify](https://dify.ai/) / [Flowise](https://flowiseai.com/) / [n8n AI](https://n8n.io/)** — visual low-code builders; humans lay out workflows.
- **[tldraw computer](https://computer.tldraw.com/)** ([agent-template](https://github.com/tldraw/agent-template)) — infinite canvas using multimodal LLMs as compilers; users draw shapes/arrows defining logic flows the engine executes.

## (b) Agent-generated static visualizations & post-hoc traces

- **[Devin DeepWiki & Codemaps](https://docs.devin.ai/work-with-devin/deepwiki)** ([Codemaps](https://docs.devin.ai/desktop/codemaps)) — hierarchical architecture maps and wikis with static Mermaid diagrams after repo indexing; no mid-flight steering canvas.
- **[Graph of Trace](https://github.com/NeuroAIHub/Graph-of-Trace)** ([ACL 2026 demo](https://aclanthology.org/2026.acl-demo.29/)) — fine-grained agent execution traces as interactive DAG for post-run debugging.
- **[LEDGER](https://arxiv.org/abs/2608.18398)** — groups agent transcripts into drillable workflow/evidence nodes for artifact lineage audit.
- **[Builder.io /visual-plan for Claude Code](https://www.builder.io/blog/claude-code-plan)** ([skills repo](https://github.com/BuilderIO/skills)) — intercepts Claude Code text plans, renders interactive HTML task board + Mermaid dependency chart pre-execution.
- **[OpenAI Canvas](https://openai.com/index/introducing-canvas/)** ([open-canvas](https://github.com/langchain-ai/open-canvas)) — side-by-side text/code artifact editor; no structural decomposition graph.

## (c) Agent-maintained live visualizations with steering (nearest neighbors)

- **[Flowith (Agent Neo / Canvas Cowork)](https://flowith.io/)** — 2D infinite canvas where the agent spawns sub-tasks/generations/branches as visual nodes; users branch/steer sub-agents. Nodes are tasks/generations, NOT the architecture of an artifact. Proprietary.
- **[agent-flow](https://github.com/patoles/agent-flow)** ([VS Code](https://marketplace.visualstudio.com/items?itemName=simon-p.agent-flow)) — hooks Claude Code's real-time event stream into a live zoomable graph of subagents/tool calls. Execution trace, not architecture.
- **[Devin Interactive Planning](https://docs.devin.ai/work-with-devin/interactive-planning)** — live dependency DAG updated during re-planning; sidebar checklist users can edit/pause. Discarded once execution starts; not the primary surface.
- **[FlowSteer](https://arxiv.org/abs/2602.01664)** — research: agent maintains an editable workflow canvas, restructures downstream tasks, human-in-the-loop steering. Closest in spirit; workflow-shaped, not architecture-shaped.
- **[Attractor Visual Builder](https://github.com/ArgaLabs/attractor-visual-builder)** — node canvas with observe→guard→steer manager loop; inject prompt overrides into live agent graph nodes.
- **[GraphCode](https://github.com/scgopi/GraphCode)** — canvas running multiple terminal agents; clicking a node attaches to that agent's terminal.

## Voice-driven agent direction (2025–2026)

- **[Wispr Flow](https://wisprflow.ai/)** ([vibe coding post](https://wisprflow.ai/post/vibe-coding-with-wispr-flow)) — leading dictation for Cursor/Windsurf; jargon formatting, `@filename` tagging into IDE chat composers.
- **[Aqua Voice](https://aquavoice.com/)** — proprietary Avalon model tuned for code/terminal; voice injection into Claude Code CLI and VS Code.
- **Claude Code `/voice`** — native dictation in the CLI.
- **[Talon](https://talonvoice.com/) / [Serenade](https://serenade.ai/)** — grammar-based accessibility voice programming; superseded for agent steering by NL dictation.

**Crucial finding:** every mainstream voice product is speech-to-text into a text box or CLI prompt. None treat voice as a spatial/deictic steering channel (click node/edge + speak structural change, no intermediate chat box).

## Ideation-to-implementation continuity

Strictly partitioned industry: ideation (Miro AI, FigJam AI, tldraw, Heptabase) / architecture (PRDs, Mermaid, Notion AI) / implementation (Cursor, Claude Code, Devin, Factory, OpenHands). No shipping tool carries one continuous semantic-zoom artifact across all three.

## Genuinely unoccupied ground

1. **Unified semantic zoom** — brainstorm bubbles ↔ architecture modules ↔ code artifacts/runtime on one persistent canvas.
2. **Agent-maintained architecture graph** (vs execution-event DAG) — no tool where the agent maintains a live system-architecture diagram as it writes code.
3. **Spatial voice steering** — deictic selection + spoken restructuring, refactoring both the visual model and the code.
4. **Visual node-level model orchestration** — role→model presets bound to visual subtrees of the decomposition graph.
