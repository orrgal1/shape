# Session handoff (2026-08-28)

State carried over from the ideas-repo session that graduated this project. Read `vision.md` first
— it is the authoritative design document. `understand.md` / `evaluate.md` / `log.md` are the
frozen funnel record of the narrower predecessor idea (brownfield architecture map); kept for the
analysis that still applies (self-report problem, boundary test, update trigger, prior art of
codebase visualizers).

## Where things stand

- Vision, client decision (browser-first, TUI ruled out for v1), and stack
  (React Flow v12 + elkjs + Zustand) are settled — see `vision.md` §"Client decision".
- Research briefs preserved in `research/`: dictation-vendor integration ladder (historical),
  stack evaluation. Links are scout-sourced — verify before load-bearing use.
- **User said "Go"** — implementation was greenlit; nothing has been scaffolded yet.

## Decided form factor

Plugin / alternative frontend over the **omp** harness (omp already supports instruction injection
into running sessions), used *instead of* the default text interface. Not a standalone agent
runtime.

## Progress (2026-08-28, later session)

Step 1 done — integration surface mapped (omp://rpc.md is canonical). **Decision: RPC mode.**
Bridge spawns `omp --mode rpc`; `set_host_tools` exposes a `canvas` graph-mutation tool whose
handler lives in the bridge; `steer`/`prompt` deliver addressed steering; event stream gives
liveness. No SDK embed, no extension files in the target project.

Step 2 done — contracts settled in `CONTRACTS.md` + `packages/shared/src/index.ts` (types,
`applyOps`, `CANVAS_TOOL_SCHEMA`, WS protocol). Toolchain: Node 26 bridge (no Bun on this
machine), pnpm workspace, Vite 7 + React 19 + React Flow 12 + elkjs + Zustand web client.

Step 3 done — v1 slice built and proven end-to-end (2026-08-28):

- `packages/bridge` — Node 26, spawns `omp --mode rpc`, WS on 127.0.0.1:4400/ws, graph store
  persisted to `<target>/.shape/graph.json`, steering composer, reality extractor +
  drift differ. Dev smoke: `pnpm --filter @shape/bridge smoke` (24 protocol checks,
  runs against `scripts/fake-omp.mjs`).
- `packages/web` — Vite/React Flow canvas. Hierarchy renders as a tree/DAG (user decision:
  no nested bubbles), depth policy = top level + active/drifted/selected + "+N" expansion
  chips, elk-reserved edge-label space + collision sweep. `?mock=1` fixture mode (badged).
- Proven with a real model turn: idea prompt → live decomposition → agent built a pomodoro
  CLI in a temp dir, advancing bubble phases to `built` via the canvas tool as it worked.
  Deictic steering (click bubble → chip → utterance → `<canvas-steering>` injection) verified.

Step 4 done — project onboarding (design: `onboarding.md`; contract deltas in CONTRACTS.md):
mechanical skeleton from extractReality → agent survey turn under anti-diary constraints
(codeRefs-must-exist gate) → drift verification. Plus `IntentNode.status` ("what's happening
now", clears on omission) and the TLDR side panel (project mode / selected-bubble mode,
raw transcript demoted to a disclosure). Dogfood-verified by onboarding this very repo:
skeleton (bridge, web) in <1s, survey added the `shared` seam mechanics missed, 10 bubbles,
accurate relations, zero drift. Bridge smoke now 43 checks.

Step 5 done — navigation (user-directed): project switcher (`switch_project` retargets the
bridge: fresh omp child, per-project graph, recents in `~/.shape/recents.json`,
re-hello to all clients; bridge smoke now 58 checks) and single-layer drill-down as THE
default view (depth selector removed): canvas shows only the focused bubble's children,
drill chip + breadcrumb, edge lifting to visible ancestors, liveness/drift bubbling
(`packages/web/src/layer.ts`). Verified live: drilled bridge → 4 children with focus card;
switched the harness repo ↔ /tmp/vh-e2e-target with clean state reset. Fixed en route:
`.canvas-row` grid-row pin (blank canvas at root) and drill refit racing async elk.

Step 6 done — motion + register (user-directed): (a) one-choreography canvas motion
(`packages/web/src/canvas/motion.ts`) — node boxes AND viewport interpolate in a single
rAF loop with one easing; always-fit on every content change (drill, rev, activity,
resize), manual pan suspends until the next change; layer swaps dissolve out then fade in;
prefers-reduced-motion snaps. Verified by transform sampling: zero direction-reversals,
containment asserted programmatically. (b) Plain-English register: all agent-written
canvas text (labels/summaries/statuses/edge labels/notes) must be non-technical
(CONTRACTS.md §Register), enforced in preamble, survey prompt, and canvas tool
description. Bridge smoke 61 checks. NOTE: graphs onboarded before the register rule
(this repo's own map included) carry jargon summaries — re-onboard or steer to refresh.

Step 7 done — layout spread + worktrees (user-directed): (a) per-layer-shape arrangement
(`chooseArrangement`): ≤3 nodes → triangle/spread, ≥4 with a real chain → layered,
else ellipse/grid, aspect-aware; single geometry source for edges+labels
(`canvas/geometry.ts`); edge clearance is an asserted invariant (sampled paths never pass
under non-endpoint bubbles); parallel edges merge with count badges. (b) Worktrees =
architecture variations (CONTRACTS.md §Worktrees): `SessionInfo.worktrees` from
`git worktree list --porcelain`, toggle reuses `switch_project`, per-worktree
`.shape/graph.json`, bridge appends `.shape/` to git common-dir
info/exclude; UI shows a plain-English "variation" pill (worktrees ≥ 2). Compare/side-by-
side views deferred by design. Bridge smoke 68 checks. Fixed en route: zustand selector
minting fresh `[]` per snapshot (`?? []` on null session) crashed live loads — stable
module-level empties required; verify web changes once without mock.

Run: `pnpm bridge -- --cwd <target-project>` + `pnpm web`, open http://localhost:5173.
Known nit: empty-state copy overlaps reality ghosts when the reality layer is non-empty.
Next candidates: drift UX on real drift, model-role →
subtree binding, session-info repush frame (sessionName changes aren't rebroadcast),
per-language reality extractors.



## Long-term memory

Project location, form-factor decision, and design summary were retained to Mnemopi memory —
`recall "shape"` in a new session will surface them.

## 2026-09-02: rebrand + independence

Renamed to **Shape** (package `shape`, workspaces `@shape/*`, state dir `.shape/`,
user-global `~/.shape/` with `SHAPE_HOME` override).

Shape is standalone: no coupling to any dictation vendor (the vendor-specific press-and-hold
URI-scheme path is deleted) or workspace manager (herdr). Voice input is just any dictation
tool typing into the focused steering input. Future integrations arrive only as optional,
configurable adapters — never as dependencies.

**Backend neutrality (user, same day).** Shape is not coupled to any model backend either —
not omp, not any CLI agent, not any gateway. The bridge is to talk to a `Backend` interface
and the concrete backend is chosen by configuration. Two adapter families: CLI agents (omp,
opencode, Claude Code, Cursor CLI, Codex CLI, ...) and direct model access through gateway
keys (OpenRouter, Vercel AI Gateway, OpenCode Go/Zen, ...) where Shape runs the agent loop
itself. Today the bridge still hard-wires `omp --mode rpc` (packages/bridge/src/rpc.ts +
the frame switch in index.ts); that is the first adapter to extract, not the architecture.

Same day: published public at github.com/orrgal1/shape; mock target project
github.com/orrgal1/shape-playground ("Ledgerly", pnpm/TS monorepo, 9 packages, branches
`feature/reminders` (worktree), `experiment/sqlite-store`, `spike/graphql`). First real
onboarding of it surfaced and fixed: pnpm 11 forwarding `--` into the bridge argv, and the
side rail growing the shell grid row (canvas dragged offscreen by a long transcript).
