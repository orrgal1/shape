# Session handoff (2026-08-28)

State carried over from the ideas-repo session that graduated this project. Read `vision.md` first
— it is the authoritative design document. `understand.md` / `evaluate.md` / `log.md` are the
frozen funnel record of the narrower predecessor idea (brownfield architecture map); kept for the
analysis that still applies (self-report problem, boundary test, update trigger, prior art of
codebase visualizers).

## Where things stand

- Vision, client decision (browser-first, TUI ruled out for v1), and stack
  (React Flow v12 + elkjs + Zustand) are settled — see `vision.md` §"Client decision".
- Research briefs preserved in `research/`: Wispr integration ladder, canvas/voice prior art,
  stack evaluation. Links are scout-sourced — verify before load-bearing use.
- **User said "Go"** — implementation was greenlit; nothing has been scaffolded yet.

## Decided form factor

Plugin / alternative frontend over the **omp** harness (omp already supports instruction injection
into running sessions), used *instead of* the default text interface. Not a standalone agent
runtime.

## Immediate next steps (where the previous session stopped)

1. **Map omp's integration surface.** Read harness docs (`omp://` in an omp session), most
   relevant: `rpc.md`, `sdk.md`, `extensions.md`, `extension-loading.md`, `custom-tools.md`,
   `hooks.md`, `mcp-server-tool-authoring.md`, `ttsr-injection-lifecycle.md`. Determine: how a
   frontend attaches to / spawns a session, how to observe the event stream, and the supported
   way to inject a steering instruction mid-run.
2. **Settle the cross-slice contracts before fanning out implementation:**
   - **Graph document schema** — nodes: id, parentId, label, summary, phase
     (idea | concept | component | building | built | failed), layer (intent | reality), status,
     drift flag, modelRole; edges: id, source, target, label, kind. Two-layer graph per vision.
   - **Mutation protocol** the agent emits (upsert_node / remove_node / upsert_edge /
     remove_edge / set_status …) — likely exposed to the agent as a custom tool or MCP server.
   - **Steering message format** — { referent: {type: node|edge, id}, utterance } composed into
     an addressed instruction injected into the session.
   - **Transport** — WebSocket server ↔ browser; server ↔ agent via the omp surface found in
     step 1.
3. **Scaffold** — web client (Vite + React + @xyflow/react + elkjs + Zustand), bridge server
   (Bun), agent-side graph-maintenance skill/tool, voice capture (Tier-4 focused input + Tier-2
   `wispr-flow://` URI scheme first).
4. **v1 slice** (vision.md §"Plausible v1 slice"): speak/type an idea → live ideation graph →
   click+speak steering → one branch crosses into build with execution state → reality layer at
   first commit, drift rendered.

## Long-term memory

Project location, form-factor decision, and design summary were retained to Mnemopi memory —
`recall "visual-harness"` in a new session will surface them.
