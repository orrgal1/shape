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

## 2026-09-03: declutter, harness pill, product layer, product root

- **Layer cap + quiet edges** (user: "big spaghetti"): `LAYER_CAP = 5` per layer, extras fold
  into a drillable "N more parts" bubble (`__more__:` ids); 1–5 nodes get fixed geometry
  (line/triangle/diamond/pentagon); edge labels only on hover/selection. Survey + preamble
  demand 3–5 bubbles per layer with named parent groups. Playground root: 9/18 → 5/11.
- **Harness pill**: header `HARNESS omp · <model>` + a Harness section in the side panel.
- **Product layer**: `IntentNode.layer` (absent = build) and `realizes` (product → build
  ids, the only cross-layer link); validation `op/cross-layer-parent|edge`,
  `op/bad-realizes`, `op/node-realized`, `op/second-root`; helpers `layerOf`,
  `realizersOf`, `servesOf` (ancestor rule), `productRootOf`. PRODUCT | BUILD toggle with
  per-view focus; "built by N" drills into a synthetic `__realizes__:<id>` layer of exactly
  the realizers; "serves" chips back; activity/drift roll up through realizes; unrealized
  capabilities glow. **The graph starts from one bubble**: the product root (single
  top-level product node) is the product view's focus card; capabilities are its children.
- **Survey**: build grouping pass → product pass (root first, then 3–5 capabilities each
  with realizes from real user-facing surfaces). Onboarding gate: product nodes need
  realizes instead of codeRefs; the root needs neither. Composer: `Realized by:` /
  `Serves:` / `the product`.
- Verified by a real re-map of shape-playground (omp/Opus): root "Ledgerly", 5
  capabilities each realized by 4–5 build bubbles, build layer grouped into Money rules ·
  Ways in · Remembering · Reminders and chores (41 bubbles, 0 drift). Bug found on that run:
  web `parse.ts` dropped `kind`/`layer`/`realizes` on the live WS path (fixtures bypass it) —
  fixed; verify web changes once against the live bridge, not only `?mock=`.
- Smokes: bridge 126, shared 87, claude 42, adopt 17, drift 23. Fixtures `?mock=1` and
  `?mock=playground` carry a product root + capabilities.

## 2026-09-03: SQLite everywhere + start-a-new-project flow (Opus builders, integrated + verified)

- **SQLite everywhere** (user decision: including local mode). All canvas state — graph
  docs, revision snapshots, project registry, audit — lives in one `node:sqlite` database
  (`packages/bridge/src/server/sqlite.ts`, `openSqliteStorage(file)`; schema in
  CONTRACTS.md §Storage, `user_version=1`, WAL). Local: `~/.shape/shape.db` (`SHAPE_HOME`,
  `--db <file>`); remote: `<data-dir>/shape.db`. `Storage` is now a record store keyed
  (tenant, projectKey); `GraphStore`/`SnapshotStore` are constructed over it;
  `projectDirStorage`/`dataDirStorage` are gone. Per-worktree canvases survive because the
  key is sha256(host + realpath(cwd)). `<repo>/.shape/` now holds only `config.json`; a
  pre-SQLite `graph.json` + `revisions/` are imported on first attach and moved aside under
  `.shape/imported/` (`server/legacy.ts`); a pre-SQLite `--data-dir` is imported once at
  server start. Earlier build-log entries above that say `<target>/.shape/graph.json` are
  history.
- **Incident during verification:** the first `smoke:adopt` run adopted the live omp session
  whose cwd is THIS repo; the bridge (on the smoke's throwaway DB) imported this repo's
  `.shape/graph.json` + `revisions/` and — as the importer then deleted after import —
  the throwaway DB took the only copy with it. This repo's own canvas is lost; re-onboard
  it. Two fixes landed: the importer moves files aside instead of deleting, and
  `smoke-adopt.mjs` backs up/restores the adopted project's `.shape/`.
- **Start a new project from the canvas.** Project menu → "start a new project": folder path
  (prefilled to the current project's parent), optional "also create it on GitHub" with
  private/public (checkbox only when `session.canPublish`: `gh auth status` ok on the agent's
  machine, probed once, binary `$SHAPE_GH`). Wire: browser `create_project {path, github}` →
  room forwards `create` under the switch guard → agent (`agent/newproject.ts`) mkdir, `git
  init -b main` unless already inside a repo, README + "Initial commit" (skipped with a
  warning when git has no identity), `gh repo create <name> --source --remote origin
  --<visibility> [--push]`, then the ordinary `switch_project` path and a `created` frame →
  one transcript line ("Started X at … — new repository, published to <url>") plus one
  `error` per warning. Only "path exists and is not a directory" rejects; everything after
  mkdir is a warning so the user still lands in the project. `ctl.mjs create-project`.
  Publishing is exercised only through `scripts/fake-gh.mjs`; no real GitHub repo was
  created during verification.
- Smokes: bridge 140 (126 + 4 legacy import + 10 new project), remote 32, auth 23, drift
  23, claude 42, adopt 17, shared 87. Live browser check of the form against a real bridge
  (fake omp) done: header retargets, transcript line visible, `.git` + one commit on disk.
- **Foot-gun fixed same day** (user clicked Create on the prefilled parent folder and got
  `~/code` git-inited and committed): the form is now folder + required project name
  (Create disabled until the name is valid; path preview underneath), and
  `createProject` refuses any existing non-empty folder before touching git
  (`create_project rejected: "<path>" already has files in it — open it with "open another"
  instead, or choose a new folder name`). Only a new or empty folder can become a project.
  Bridge smoke 143.

## 2026-09-03 (evening): product-first turn, liveness, session pane

- **Bridge is run by the session now** (user request): `hub` process `bridge` (`node src/index.ts
  --cwd <project>` from packages/bridge, port 4400), restarted after each batch lands; Vite stays
  the user's. A restart kills the running omp child, so never restart mid-batch.
- **Product-first greenfield turn** (`server/productturn.ts`): the first utterance on an empty
  canvas writes a draft root at once (`product`, "Your idea", first sentence as summary, phase
  `idea`, status "working out what this is…", activity `["product"]`), then the composed first
  prompt makes the turn product-only and a gate rejects build-layer ops / `realizes` with
  `product/first` until `turn_end` or the next utterance. `utterance.productFirst: false` opts
  out (empty-state checkbox "Start with the product picture"). Web switches to PRODUCT when a
  product node first appears; placeholder becomes `Correct the picture, or say "build it"`.
- **Liveness**: `applyCanvasCall` returns `touched`; a canvas call sets activity to the ids it
  wrote (file `tool_start` unions, `turn_end` clears). CSS: `idea` dashed/dim draft, `concept`
  dim, `building` breathing border; focus card (or the lone bubble) gets `data-thinking` while
  the agent works with nothing lit; bottom-left "now" pill shows the latest tool line.
- **Session pane**: `BackendCapabilities.terminal` += `"session"`; omp advertises it. `SessionView`
  (`agent/backend/sessionview.ts`) renders the rpc stream as read-only ANSI text (prompts, text
  deltas, tool cards, results, state rules), 64 KiB ring buffer; `pty_open` on a replayable
  source broadcasts clear + replay. Blank-terminal root cause: the client sent `pty_open` once
  and dropped it when the socket was not open; it now re-asks on every connect.
- **Prompt box** is a textarea: grows to 5 lines then scrolls; Enter sends, Shift+Enter newline.
- Smokes: bridge 165, remote 32 (first utterance opts out of the product turn), auth 24, drift
  23, claude 42, adopt 17, shared OK.
- **Queued, contracts settled**: depth (classes/functions via the TypeScript parser, `file#Name`
  codeRefs, leaf drill into symbols) + infra layer (`layer: "infra"`, kinds host/database/cache/
  cdn/ci, `hosts` infra→build, mechanical extraction from compose/terraform/k8s/platform/CI/
  deps/env) — contract at the session's `local://depth-infra-contract.md`; then worktrees merged
  in one view with Shape running one harness per worktree (user decisions 2026-09-03).

## 2026-09-03 (night): four layers — depth, infra, verify

- **Shared contract** (two waves, agent://SharedContract + agent://VerifyContract): `Layer =
  product | build | infra | verify`; `NodeKind` += host/database/cache/cdn/ci and
  test/smoke/check/review/monitor; build-facing links `realizes` (product), `hosts` (infra),
  `verifies` (verify) share one `BUILD_LINKS` table driving `op/bad-*` / `op/node-*` guards;
  symbol codeRefs `file#Name` (`symbolRefOf`, `op/bad-coderefs`); helpers `hostsOf`/`runsOnOf`,
  `verifiedOf`/`verifiersOf`, `verificationOf` (intent verifier OR a reality cover, prefix rule
  both directions, ancestor codeRefs count) and `capabilityVerification` (rollup over
  realizers). Reality: `symbols`, `infra`, `verification` arrays. Shared smoke 254.
- **Bridge**: `typescript` is a runtime dependency; `agent/symbols.ts` (top-level classes/
  functions via `ts.createSourceFile`, one read pass shared with the import scan, cap 20 000);
  `agent/infra.ts` (compose/Dockerfile/platform files/terraform/k8s/CI/package deps/.env
  keys, engine table, dedupe by kind+name, ≤ 80 items, nothing for non-git targets);
  `agent/verification.ts` (test files per package + runner configs, smoke scripts, check
  scripts, CI; `covers` = package dir + what the test files import). Gate: infra/verify need
  codeRefs; `onboarding/unknown-symbol`. Drift rule C: vanished symbol. Survey rules 10–12;
  preamble FOUR LAYERS + "a built bubble nothing verifies is a claim". Bridge smoke 212,
  drift 29.
- **Web**: four tabs (PRODUCT what people get / BUILD what it is made of / INFRA where it
  runs / VERIFY what proves it works); drills `__hosts__:` and `__verifies__:` beside
  `__realizes__:`; chips runs on / runs / verified by / attests; shield pip on build bubbles
  (filled/hollow) and capabilities (filled/half/hollow); ghost columns per view (packages,
  configuration, found-in-code, and the leaf "inside" symbol listing); fixtures carry all four
  layers. Screenshots: /tmp/shape-webinfra-shots, /tmp/shape-webverify-shots.
- Not yet exercised with a real model turn on a real repo (only fake omp + fixtures): re-map
  shape-playground to see the agent produce infra/verify bubbles.

## 2026-09-03 (late): every worktree on one canvas

- **Identity**: project key = sha256(host + realpath(git common dir)) — all worktrees of a
  repo share one room; worktree id = realpath of its directory; `project.cwd` = main
  worktree. Old keys (per-directory) are adopted onto the new key on the next attach
  (`project.legacyKeys`, `Storage.adoptLegacyKey`; a non-empty canvas already under the new
  key wins). Found the hard way: the first restart stranded duck-counter's and
  shape-playground's canvases under their old keys until adoption landed.
- **Wire** (agent://WorktreeFoundations): every worktree-scoped frame carries `worktree` on
  both links and the browser; `attach { worktrees, sessions: WorktreeSession[], realities }`;
  `session_started`/`session_stopped`; `open_worktree`/`close_worktree`; hello carries
  `graphs`/`agents`/`revisions` keyed by worktree. Storage `user_version` 2: graphs/revisions/
  audit keyed (tenant, key, worktree); `smoke:wire` (200 checks) covers frames + migration.
- **Agent** (agent://AgentRuntime): `Map<worktreeId, Harness>` — one harness (omp child, pty,
  session view, preamble state) per opened worktree; `--cwd` opens the first; switch/create/
  adopt inside the same repo = open that variation, another repo = full retarget. Loopback
  link frames carry `cwd`, routed to the worktree by longest realpath prefix.
- **Room** (agent://Room): `Map<worktreeId, WorktreeState>` (store, snapshots, activity,
  agent state, session, gates) for every listed worktree, agentless ones read-only;
  utterance to a worktree with no session → `no session is running on <branch> — open it
  from the variations menu`.
- **Web** (agent://WebMerge): `doc` = merge of the filtered variations (`mergeGraphs`,
  primary = main worktree), branch pips per bubble (hollow = differs), activity rings per
  branch, variations pill = filter + open/stop, steering target chip, "where" panel section,
  per-target compare/revisions/session pane; fixtures carry two variations each.
- Smokes: bridge 233, wire 200, remote 32, auth 24, drift 29, claude 42, adopt 17, shared
  254; tsc clean in bridge, web, link. Live: duck-counter's 11-bubble canvas back after
  adoption (`[bridge] adopted the canvas of … from its previous project key`).

## 2026-09-04: next card, autonomous mode, motion v2, follow-the-work, correctness

- **Next card** (`Next { summary, choices[≤4]{label, say}, question }`): the agent ends every
  turn with `next` on the canvas call (validated `op/bad-next`, never stored); the room keeps it
  per worktree, clears it on any utterance, synthesizes one at `turn_end` when missing.
  `NextCard.tsx` in the `.steer-dock`.
- **Autonomous** (`set_autonomous { worktree, on }`): at `turn_end` with an open choice/question
  the room delivers `AUTO_CONTINUE_PROMPT` (transcript `autonomous:`, audit `auto`); nothing
  when the card is empty; cap 25 per stretch then paused; product-first gate off while on.
  Chip beside the target chip.
- **Motion v2** (web only): edge dash flow toward the lit bubble in branch colour, staggered
  double rings + breathing, phase-dot ripple, arrival ripple / dissolve, text slide-ins,
  ambient wash while working, shimmering now-pill, staggered alive-wash while thinking.
- **Follow the work**: `following()` in web store — an activity/graph frame whose ids all sit on
  one other layer switches the view unless the user pinned a view in the last 20 s
  (`viewPinnedAt`, stamped by every deliberate switch/drill).
- **Rename** layer `verify` → `correctness` (tab CORRECTNESS, "what proves it works");
  `verifies`/helpers/codes/kinds unchanged; load-time mapping in bridge `store.ts` and web
  `parse.ts`; the wire rejects `"verify"`.
- Smokes: bridge 255+, wire 210, remote 32, auth 24, drift 29, claude 42, adopt 17, shared 264+.
- **Next (contract written, `local://harness-layer-contract.md`)**: Shape as a layer over the
  real harness — launchers (herdr socket API / own pty), omp via `--extension` (canvas tool,
  events, `sendUserMessage` steer over the loopback link), harness detection + per-project
  chooser, "Go to terminal" replacing the Canvas|Session toggle, rpc-mode omp + the read-only
  session view deleted. Facts: agent://OmpExtensionMap, agent://HerdrMap.

## 2026-09-04: Shape as a layer over the real harness (landed)

- **Launchers** (`agent/launcher/`): `herdr` (socket API — ONE request per connection, the
  server hangs up after each answer and does not echo ids on refusals; subscriptions are the
  only long-lived connections; `pane.agent_status_changed` needs a `pane_id`, subscribed per
  launched pane; global `pane.exited`/`pane.closed`) and `pty` (own pty, terminal drawer in the
  browser). Chosen at startup: herdr when detected and answering `session.snapshot`
  (protocol 19), else pty; `SHAPE_LAUNCHER` forces.
- **Adapters**: omp = interactive TUI + `--extension packages/link/src/omp-extension.ts`
  (canvas tool, events incl. `text_delta`, `deliver`/`delivered` steer via
  `pi.sendUserMessage`, `abort` → `ctx.abort()`, `autonomous` → tool_call allow), session
  counted started on the loopback `hello`; claude = TUI through the launcher (MCP + hooks);
  generic = any other detected harness under herdr (status from herdr, steer by typing, no
  canvas tool). Deleted: rpc mode, `sessionview.ts`, `terminal: "session"`, claude headless.
- **Detection** (`agent/detect.ts`): herdr + omp/claude/codex/opencode/gemini/cursor-agent/
  amp/copilot on PATH with versions → `hello.tools`. Resolution per worktree: explicit >
  `<cwd>/.shape/config.json` > `~/.shape/config.json` > `--backend` > exactly one detected >
  NONE (attached, no session; the web shows the Start card: harness radio, Autonomous,
  Remember → `open_worktree { path, backend, autonomous, remember }`).
- **Web**: Canvas|Session toggle gone; header "Go to terminal <branch>" → `focus_terminal`
  (herdr focuses the tab; pty opens the drawer); `now { worktree, text }` types the live
  assistant text into the pill.
- Proven: real omp 18.1.2 under the pty launcher (hello, deliver visible in omp's session
  file, `now` frames, state), real herdr probe (`herdr 0.8.0 (protocol 19) will host the
  sessions`), fakes `fake-omp-tui.mjs` / `fake-herdr.mjs` / rewritten `fake-claude.mjs`.
  Smokes: bridge 266, wire 333, herdr 24, remote 32, auth 24, drift 29, claude 39, adopt 17,
  shared OK, link selftest 69. NOT yet done: a real session launched into a real herdr tab
  from the browser (the user's next click does exactly that).

## 2026-09-04 (later): herdr+omp only, workspace per project, sessions on demand

- **Bug**: the first real launch from the browser failed `open_worktree failed for main:
  herdr refused: invalid_request (missing field pane_id)` — herdr 0.8.0's `AgentStartParams`
  is `{ name, kind, pane_id, args?, timeout_ms? }`; the launcher sent `pane`/`timeout`. Fixed
  in `launcher/herdr.ts`; `fake-herdr.mjs` now refuses the old spelling the way herdr does.
- **Placement**: `LaunchSpec.project { path, label }` (and `BackendStart.project`, passed
  through by every adapter; the runtime fills it from the main worktree). `HerdrLauncher`
  keeps one herdr workspace per project (cached id → `worktree.repo_root`/`checkout_path` →
  label → `workspace.create`, whose answer's root tab hosts the first session) and one tab
  per variation (`tab.create { workspace_id }`; `workspace_not_found` → recreate once).
  `HerdrRefusal` carries herdr's error code.
- **Only herdr+omp for now**: `resolveBackend` never answers NONE — step 6 is `omp`. A
  project attaches WITH a session (startup/switch/create/adopt); `#openHarness` returns
  `Harness`; the "needs to know which harness" refusal is gone. pty launcher and
  claude/generic adapters kept for the smokes and later.
- **Typing opens a session**: room `utterance`/`onboard` use `#variationOf` (no session
  gate; `abort`/`focus_terminal`/`set_autonomous` keep `#steerable`); the agent's `#deliver`
  calls `#openVariation` when no harness runs there → `session_started` then `delivered`, or
  `error open_worktree failed …` and no `delivered`. Web: steering bar/target chip offer every
  on-canvas variation (dot off = no session, hint "starts a session on <branch>…"), empty
  state is "Say the idea" with the StartCard as the explicit switches-first path; mock mirrors
  the ordering. `AgentProject.backend` is null only after every harness left.
- Smokes: bridge OK, wire 333, herdr 30, claude 39, adopt 17, remote 32, drift 29, auth 24,
  shared OK. Live: `HerdrLauncher.launch` against real herdr 0.8.0 started omp in
  duck-counter and closed its tab; the hub `bridge` process (restart it after bridge-side
  changes: `hub restart bridge`) came up with `herdr started omp … in pane w1S:pA`.

## 2026-09-04 (later still): Go to terminal raises the app, map goes down to functions

- **Go to terminal** did nothing visible: `agent.focus` switched herdr's tab but Ghostty stayed
  behind Chrome. `HerdrLauncher.probe()` now finds the terminal app hosting the herdr client
  (`ps -axo pid,ppid,command` → `terminalAppOf`/`isHerdrClient`, first `.app` ancestor;
  `SHAPE_TERMINAL_APP` overrides) and `focus()` runs `open <bundle>` (`SHAPE_OPEN` knob) after
  the tab focus; nothing raisable ⇒ `terminal: "none"` and the button is hidden (web unchanged).
  Live: `ctl.mjs focus-terminal` → `ok`, herdr tab flipped to `w1Z:t1`.
- **Restart hygiene**: combined mode (`index.ts`) had no SIGINT/SIGTERM handler, so a hub
  restart left the predecessor's omp tab in herdr and the next start died with
  `agent_name_taken`. Now `agent.stop()` runs on both signals (tabs closed, herdr drops the
  emptied workspace), and `launch()` retries `agent.start` past `agent_name_taken` with the
  next `shape-<slug>-<n>` (≤ 20). Proven: two consecutive restarts, one tab each time.
- **Finer mapping**: rule 10 of the survey is REQUIRED and the prompt carries the symbol
  inventory (bounded 400 / 12 per file); `SOURCE_EXTS` +`.js .jsx .mjs .cjs`; preamble tells the
  harness to keep `path#Name` children for classes/major functions it writes. Onboarding is
  refused once a canvas has bubbles, so the live proof was an utterance to the running
  duck-counter session: 11 → 88 bubbles, `path#Name` down to `public/app.js#viewCount`.
- Smokes: bridge OK (+6), wire 340 (+7), herdr 31 (+1), claude 39, adopt 17, drift 29, web tsc
  OK. Open: `api` and `server` bubbles overlap on `src/server.ts` (the model's grouping).

## 2026-09-04 (evening): Open with nothing typed = native folder chooser

- `ClientMsg pick_folder` → `ServerToAgent pick_folder` → agent shows the machine's chooser →
  `AgentToServer folder_picked { path | null }` → `ServerMsg folder_picked` to the ASKING
  browser only; the web fills the box and sends `switch_project`. Room slot + 10-min timer
  (`#picking`, `PICK_TIMEOUT_MS`), refusals prefixed `pick_folder`. Test knob
  `SHAPE_PICK_FOLDER` (smoke.mjs final block, 6 checks; wire +10).
- macOS: AppleScript `choose folder` from the bridge opens BEHIND everything (osascript is a
  UIElement; `tell me to activate` does nothing — a panel sat unseen 10 min), and going via
  Finder needs an Automation grant (system prompt). Landed: JXA `NSOpenPanel` with
  `setActivationPolicy(Regular)` + `activateIgnoringOtherApps(true)` — verified frontmost
  (`lsappinfo front` = osascript). A stale panel is killed and replaced by the next ask.
- Web: Open enabled on an empty box (`picking…` while waiting), Enter does the same, hint
  "Open with nothing typed asks this machine for a folder"; mock refuses with its own text.
- NOT yet proven: a human picking a folder in the real panel and the switch that follows —
  the panel was up and frontmost twice, nobody answered within the timer. Everything up to
  the click is covered by smokes with the stand-in command.
- Also: `browser.relay` turned OFF in `~/.omp/agent/config.yml`; the browser rule (headless,
  `app: { relay: false }`, never touch the user's tabs) lives in `~/.claude/CLAUDE.md`.

## 2026-09-04 (last): connection is the default across the layers

- **The decision**: whatever can be connected to something in another layer should be. A
  capability names the parts that realize it, an infra bubble names what runs on it, a check
  names what it attests, and a part should be reached by all three once it exists. Nothing in
  the data model moved: still `realizes` / `hosts` / `verifies`, hierarchy and edges still
  never cross layers.
- **One reader**: `linkGapsOf(doc, id)` in shared/ answers "what is this bubble not connected
  to" for everyone — `LinkGap` = `unrealized | unserved | unhosted | unattested |
  hosts-nothing | attests-nothing`, asked only at `LINKED_PHASES`
  (`component | building | built`; the web's `UNREALIZED_PHASES` moved here) and only when the
  other side exists to link to. The product root is never asked.
- **Receipt warnings** (`store.ts`): the canvas tool result gains a `{"warnings": [...]}` block
  after the rejections one, `code: "link/<gap>"`, `severity: "warning"`, `subject.path` the
  field to write (`/ops/<i>/node/realizes|hosts|verifies`, or `/ops/<i>/node` for a build-side
  gap), `evidence: { gap }`, plain-English fixes. Computed after apply, only for the bubbles
  the call touched, never for a call that applied nothing, and never on the product-first turn
  (`applyCanvasCall(args, gate, { linkWarnings: false })`, passed by room `#canvasCall` off
  `state.productTurn`). `isError` unchanged — a warning is not a refusal.
  `CanvasToolOutcome.warnings` carries the list.
- **Survey vetoes** (`onboarding.ts`): `onboarding/unhosted-infra` and
  `onboarding/unattesting-correctness` beside `onboarding/unrealized-product`, same shape and
  same same-call rule (a build bubble admitted earlier in the batch grounds them), asked only
  when the canvas has a build layer. Rules 9, 11 and 12 now say the default outright and the
  prompt closes on it as a checklist.
- **Said everywhere else**: the preamble states the default and names the `link/...` warning it
  comes back as; steering adds one `Missing link:` line per gap of the bubble the user clicked
  (the root gets none, and a capability's own "Realized by: nothing yet" line is its
  `unrealized`).
- Smokes: bridge 277 (+13, `node scripts/smoke.mjs` — SMOKE OK). Watch out for a leftover
  smoke bridge holding port 4409 from a killed run: the next run then fails with `timeout
  waiting for bridge listening`.
