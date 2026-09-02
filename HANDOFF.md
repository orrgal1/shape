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

**Backend neutrality (user, same day, refined).** Shape is not coupled to any model backend
either — not omp, not any CLI agent. Shape does NOT own an agent loop: it runs on top of
existing harness CLIs and interacts with their sessions. The bridge talks to a `Backend`
interface (packages/bridge/src/backend/types.ts); the adapter is chosen by configuration
(`~/.shape/config.json` → `<target>/.shape/config.json` → `--backend`). Every adapter has
three channels, each with a universal fallback: canvas tool (host tool, or an MCP server Shape
ships), steer (native, else typing into the pty), events (native stream, else hooks, else
transcript tail). Two ways a session reaches the canvas: *spawn* (Shape opens the harness TUI
in its own pty) and *adopt* (discover sessions already running, resume them under Shape's
pty). Harness surfaces, source-cited: Claude Code full (per-invocation `--mcp-config`,
stream-json, hooks, UDS attach), Codex full (app-server, daemon attach), opencode full (HTTP
server), Cursor partial (no mid-turn steer); reports at agent://ClaudeCodeSurface,
agent://CodexSurface, agent://OpenCodeSurface, agent://CursorCliSurface.

Same day: published public at github.com/orrgal1/shape; mock target project
github.com/orrgal1/shape-playground ("Ledgerly", pnpm/TS monorepo, 9 packages, branches
`feature/reminders` (worktree), `experiment/sqlite-store`, `spike/graphql`). First real
onboarding of it surfaced and fixed: pnpm 11 forwarding `--` into the bridge argv, and the
side rail growing the shell grid row (canvas dragged offscreen by a long transcript).

## 2026-09-02: roadmap batch one (Opus builders, integrated + verified live)

- **Backend seam** — `packages/bridge/src/backend/{types,omp,config,index}.ts`; omp is the
  first adapter (`OmpBackend` wraps rpc.ts); `SessionInfo.backend` carries id/label/
  capabilities; steer-vs-prompt and the preamble stay in the bridge. Bridge smoke 94 checks.
- **Terminal pane** — `@lydell/node-pty` (node-pty's prebuilt spawn-helper ships mode 644 and
  fails on Node 26; lydell's prebuilt has no scripts) in `packages/bridge/src/pty.ts`, xterm in
  `packages/web/src/Terminal.tsx`, Canvas | Terminal toggle (Ctrl+`). v1 runs the login shell
  in the target cwd; retargets on switch_project. Wire types in `packages/shared/src/pty.ts`.
- **Discovery** — `packages/bridge/src/discover.ts` (`node packages/bridge/src/discover-cli.ts`):
  ps + lsof cwd + per-harness session files; `spawnedByShape` flags our own rpc child; a
  process-start gate stops mtime misattribution. Not wired into the UI yet (batch two).
- **Layout at real scale** — `?mock=playground` fixture (the real 17-bubble survey, frozen);
  reality ghosts only for packages no intent bubble claims (fully mapped project → no ghost
  band); dense layers (≥6 nodes, edges/nodes ≥1) use elk layered, four candidates scored by
  the strokes they produce; solveBow re-measures against actual blockers. Live on the
  playground: 0 ghosts, 0 offscreen, 0 overlaps, longest edge 832 px (was 3173).
- **Git-truth reality** — extraction and the onboarding codeRefs gate use
  `git ls-files --cached --others --exclude-standard`; gitignored leftovers cannot become
  bubbles (main: 9 packages; reminders worktree: 10).

Known, queued for batch two: the drift rule attributes package-level import edges to every
descendant bubble with codeRefs in that package (12 of 17 playground bubbles glow, 59 notes);
drift should be satisfied when any node mapped into P relates to any node mapped into Q,
ancestors included. Batch two also: `canvas` as an MCP server + Claude Code adapter (spawn
mode), discovery/adopt UI, then Codex/opencode adapters and live attach.

## 2026-09-02: roadmap batch two (Opus builders, integrated + verified)

- **The link** (`packages/link`, `@shape/link`): `src/mcp.ts` is a stdio MCP server exposing
  the `canvas` tool to any harness (forwards `canvas_call` over WS, result comes back on the
  same socket); `src/hook.ts` turns one harness hook payload into `agent_event` frames that
  feed the SAME `BackendEvents` the native adapter uses. Bridge side: `external.ts`, `ws.ts`
  `onMessage(msg, reply)`. Wire types in `shared/src/link.ts`. Bridge smoke 94 → 114.
- **Claude Code adapter** (`backend/claude.ts`, modes `headless` | `tui` (default)):
  headless = `claude -p --input/--output-format stream-json` + link via `--mcp-config`;
  tui = interactive `claude` in an adapter-owned pty, hooks via `--settings`, terminal pane
  attaches to it (`PtyManager.attach`), steer = bracketed-paste typing (queued, not mid-turn).
  The UDS at `/tmp/cc-socks/<pid>.sock` accepts unauthenticated injections but Claude renders
  them as untrusted "peer" messages, so it is deliberately not used for user steering.
  `smoke:claude` 42 checks against `scripts/fake-claude.mjs`. NOT yet proven with a real
  model turn: this machine's Claude OAuth is expired (`claude auth status` → loggedIn false);
  run `claude login`, then re-run the headless real check (see agent://ClaudeAdapter).
- **Discover / adopt**: hello carries `sessions` (Shape's own rpc children excluded);
  `discover` re-scans; `adopt {pid}` retargets to the session's cwd with backend = harness and
  `--resume <id>` (verified: `omp --mode rpc --resume` works; `claude --resume` wired).
  Project pop-up shows "Running sessions"; header shows the backend pill. `ctl.mjs discover|adopt`.
  `smoke:adopt` 17 checks (adopts a real omp session).
- **Drift rule v2** (reality.ts): hierarchy-transparent coverage, one note per unsatisfied
  reality edge on the top-level owner; playground 59 notes → 0. `smoke:drift` 23 checks.

Smokes: `pnpm --filter @shape/bridge run smoke|smoke:claude|smoke:adopt|smoke:drift` (must run
from the package — they resolve `src/index.ts` relative to cwd), `pnpm smoke:shared`.

Next: Codex + opencode adapters (both "full" per research; app-server / HTTP), live attach
(Codex daemon, opencode `--port`), spawn-mode UX (open the harness TUI from the canvas when
no session is running), Cursor (partial). Open question for the user: whether omp's own
interactive TUI can be driven (hub injection) so omp gets a tui mode like Claude.
