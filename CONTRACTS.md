# Cross-slice contracts (v1)

Settled 2026-08-28. `packages/shared/src/index.ts` is the machine-readable form of this
document; when they disagree, the TS file wins.

## Topology (split 2026-09-03, PLAN.md Phase 0)

```
browser (Vite dev :5173)
   │  WebSocket  ws://127.0.0.1:4400/ws            ServerMsg / ClientMsg
   ▼
SERVER half   packages/bridge/src/server/   ProjectRoom + ShapeServer
   │  graph store, snapshots, steering composer, preamble, drift, activity, onboarding gate
   │  agent link: AgentToServerMsg / ServerToAgentMsg (shared/src/link.ts)
   │  local mode = memoryLinkPair() in one process; remote = WebSocket /agent (Phase 1)
   ▼
AGENT half    packages/bridge/src/agent/    AgentRuntime
   │  detection (what is installed), launchers (herdr tab | Shape's own pty),
   │  Backend adapter per harness, reality extraction, worktrees, discover, fs checks
   │  loopback link  ws://127.0.0.1:4400/link     LinkClientMsg / LinkServerMsg
   ▼                                               (omp extension, MCP server, hooks)
harness  (a REAL session in a REAL terminal: omp with the Shape extension,
          claude TUI, or any harness herdr can start)      cwd = the worktree
```

`packages/bridge/src/index.ts` is local mode: one `SocketServer` (`wsserver.ts`) mounting
`/ws` for the server half and `/link` for the agent half, joined by an in-memory link.
The two halves meet ONLY in `shared/src/link.ts` and `index.ts`; `server/` never imports
`agent/`.

- The agent starts the harness the way a person would: a terminal in the worktree's
  directory (a herdr tab, or a pty Shape owns) running the harness's own interactive
  command, with the loopback link URL in its environment (§Harness layer). One session per
  worktree the user opened; a worktree with no resolvable harness has none, and that is a
  normal state the browser offers to end.
- The harness writes to the canvas through the loopback link — the omp extension inside
  omp, the link's MCP server for Claude Code — and the agent forwards
  `canvas_call { id, args }` to the server, which validates + applies to the graph store,
  answers `canvas_result`, and broadcasts the new graph to browsers.
- The server owns the graph-discipline preamble (`server/preamble.ts`) and hands it to the
  agent in `attached`; the agent prepends it to the FIRST fresh prompt of a harness session.
  It opens on FOUR LAYERS — product, build, infra, correctness — and names the three links that
  cross them (`realizes` on a capability, `hosts` on a piece of infrastructure, `verifies` on a
  check), says that an infra bubble carries the configuration files that prove it in its
  `codeRefs` and a correctness bubble the files that ARE the check, states that a `built` bubble
  nothing verifies is a claim (so finishing a part means adding or extending what attests it in
  the same turn), and mentions that a `codeRefs` entry may name one part inside a file
  (`path/to/file.ts#TheName`). Same register as everything else on the canvas: plain English,
  no jargon.
- Steering: browser sends an utterance + optional referent; the server composes the
  addressed instruction (`server/steering.ts`) and sends `deliver { id, body }`; the AGENT
  decides the mode — `steer` iff `capabilities.steerMidTurn && state().streaming`, else
  `prompt` — and answers `delivered { id, mode, queued }`, from which the server writes the
  "queued for the next turn" transcript line. Only the agent has live backend state; a
  server-side state round trip per utterance would add a hop and still race the turn edge.
- Attach: the agent sends `attach` (project key = sha256(hostname:realpath(cwd)), label,
  cwd, backend info, targetHasCode, session, reality, worktrees, sessions, recents) AFTER
  its backend started, so the first hello carries the harness session; loopback frames that
  arrive earlier (a hook's SessionStart) queue until `attached`. A second `attach` on the
  same link is a retarget (`switch_project` / `adopt` completed): the server persists the old
  store, opens the new project's, and re-hellos every browser.
- Starting a project: `create { path, github }` server → agent; the agent makes the folder,
  puts it under version control, optionally publishes it, then does its own `switch` and
  reports `created { path, repo, github, warnings }`. That frame travels the ordinary
  outbox, so it lands in the room the NEW project opened, after its `attached`.
- Filesystem facts the server needs are requests over the link, answered by id:
  `list_worktrees`, `discover`, `file_index` (tracked files → the onboarding gate's
  `FileIndex`, shared/src/fileindex.ts), `synthesize_skeleton`, `extract_reality`.
- Going to the terminal: `focus_terminal { worktree }` server → agent → `launched.focus()`.
  A herdr tab is brought forward where it lives; a pty Shape owns answers
  `terminal { worktree, open: true }` and the browser opens the drawer over the canvas
  (§WebSocket protocol).
- Every harness leg is ONE adapter behind the backend seam (§Backends) and one launcher
  behind the launcher seam (§Harness layer): nothing above them knows omp's extension
  frames, Claude Code's hooks, or herdr's socket.

## Backends (seam, 2026-09-02; launcher-based since 2026-09-04)

Shape drives a coding harness by configuration and never assumes which one. An adapter no
longer spawns anything either: it composes an argv and hands it to the `Launcher` the agent
chose (§Harness layer), so every session is a real terminal session someone could have
started by hand. `packages/bridge/src/agent/backend/types.ts` is the whole surface:

```ts
interface Backend {
  readonly id: string; readonly label: string; readonly capabilities: BackendCapabilities;
  start(opts: { launcher: Launcher, worktree: string, cwd: string, linkUrl: string,
                autonomous: boolean, events: BackendEvents,
                resumeSessionId?: string }): Promise<Launched>;
  session(): { sessionId: string | null; model: { provider, id } | null };
  send(message: string, mode: "prompt" | "steer"): Promise<void>;
  abort(): Promise<void>;
  setAutonomous(on: boolean): Promise<void>;       // throws when the harness cannot, mid-session
  dispose(): Promise<void>;
  // only a harness ON the loopback link ever sends these (§Loopback link v2)
  onHello?(hello: LinkHello, send: (msg: LinkServerMsg) => void): void;
  onDelivered?(receipt: { id, mode, queued }): void;
  onBye?(reason: string): void;
}
```

`start` resolves when the session is USABLE — for a harness on the link, when it has
greeted; for one driven by typing, when the launcher says it is up — and answers the
launcher's `Launched` handle, which is what `focus_terminal` and `dispose` act on.
`linkUrl` is `ws://127.0.0.1:<port>/link`, the AGENT's loopback endpoint and never the
server, so a harness (or its MCP sidecar, or its hooks) can reach the agent that owns it.
`resumeSessionId` is passed only when an `adopt` named a session to continue;
`capabilities.resume` says whether the adapter can honor it. There is no `canvasTool`
argument and no `state()`: the tool is registered by the harness's own integration (the omp
extension, the link's MCP server), and what the session is DOING is whatever its events
last said — the runtime tracks that per worktree, so the canvas and the delivery decision
can never disagree. `BackendEvents` gained `onTextDelta(delta)` for the live "now" line
(never stored) alongside `onSession({ sessionId, model })` for adapters whose session id
arrives out of band.

The adapter owns everything harness-shaped: the launch line, how an utterance gets in, how
a turn's end is recognized. The bridge owns everything canvas-shaped: the graph store, the
preamble, `codeRefs` → activity mapping, the onboarding gate, and the steer-vs-prompt
decision. `BackendEvents.onCanvasCall(args)` is the one inbound call: the bridge applies the
ops and returns `{ text, isError }` for the caller to hand back to the agent.

`BackendCapabilities` (shared/) is what the bridge and client branch on instead of sniffing
ids: `{ steerMidTurn, hostTool, events: "native" | "hooks" | "transcript" | "none", resume,
terminal: "external" | "pane" | "none" }`. `terminal` comes from the LAUNCHER — `external`
for a herdr tab (Shape can only focus it), `pane` for a pty Shape owns (the browser can
open its drawer over the canvas), `none` for a remote agent started without
`--allow-terminal` — and a harness on the link refines `steerMidTurn`/`hostTool` from its
`hello`. Delivery rule: `steer` when `steerMidTurn` AND the worktree's last state was
streaming (or compacting), else `prompt` — and when a harness cannot be interrupted
mid-turn, the prompt still goes out and the transcript says it is queued for the next turn.

Config is one file per layer, `<target>/.shape/config.json` over `~/.shape/config.json`
(`SHAPE_HOME` overrides the home dir); the full resolution order for WHICH harness runs is
in §Harness layer. `--omp "<cmd ...>"` names the omp executable and its leading args (the
smokes point it at `scripts/fake-omp-tui.mjs`). Shape:

```json
{ "backend": "omp", "backends": { "omp": { "command": ["omp"], "args": [], "permissionMode": "…" } } }
```

`command` is optional (absent ⇒ the harness's own name on PATH); `args` and `permissionMode`
are adapter-specific passthrough, validated but not interpreted by the loader. There is no
`mode` key any more — a harness runs as itself, interactively, or not at all.

Missing files are fine; a malformed one is a startup error naming the file, and an unknown
harness id is an error listing the ones Shape can start. Config is re-read per project, so
`switch_project` disposes every session and resolves again for the new target.

## Harness layer (launchers and adapters, 2026-09-04)

User decision: "Shape does not presume to be its own harness. When it launches a session it
should launch a real terminal with a real session. Detect what is installed (herdr, omp,
claude code, codex…) and ask what to use for this project." Three parts: what is installed,
how a session gets a terminal, and which harness a project runs.

**Detection** — `packages/bridge/src/agent/detect.ts`. `detectTools()` walks PATH in process
(no `which` subprocess) for the launchers (`herdr`) and every harness Shape can start —
`omp`, `claude`, `codex`, `opencode`, `gemini`, `cursor-agent`, `amp`, `copilot`, the
`HarnessId` union in shared/ — then asks each one that was FOUND for `--version` with a 3 s
ceiling. A tool that will not say its version is a detected tool all the same
(`version: null`). Every entry is a `ToolInfo { id, label, path, version }` whose `label` is
plain English as the tool calls itself ("oh-my-pi", "Claude Code", "Codex", "Gemini CLI",
"Cursor Agent", "GitHub Copilot CLI"). `ProjectTools { launcher, launchers[], harnesses[] }`
is what travels: `attach.project.tools` to the server, `hello.tools` to the browser,
project-wide because one agent process sees one PATH. Re-detected on `discover` — somebody
hitting "look again" is often hoping to find a harness they just installed.
Discovery's older `Harness` union (§Storage, adopt) spells Cursor's CLI `cursor`;
`harnessIdFor` maps it onto `cursor-agent`.

**Launchers** — `packages/bridge/src/agent/launcher/`. One per agent process, chosen at
startup: herdr when it is installed AND its socket answers, else Shape's own pty.

```ts
interface LaunchSpec { cwd; worktree; kind: HarnessId; argv: string[]; env; label }
interface Launched {
  readonly handle: string;                          // herdr pane id, or the worktree
  focus(): Promise<void>; kill(): Promise<void>;
  onExit(cb: (code: number | null) => void): () => void;
  onStatus?(cb: (s: "idle"|"working"|"blocked"|"done"|"unknown") => void): () => void;
  type?(text: string): Promise<void>;               // as if the user had typed it
  interrupt?(): Promise<void>;                      // Escape
}
interface Launcher { id: "herdr" | "pty"; label; terminal: "external" | "pane";
                     launch(spec): Promise<Launched>; dispose(): void }
```

- `herdr` is a direct client of herdr's socket (newline JSON over `HERDR_SOCKET_PATH` ??
  `~/.config/herdr/herdr.sock`). Verified against herdr 0.8.0, the real server gives a
  connection ONE exchange: a plain request is answered with a single line and then the
  server hangs up (and a request it refuses at validation time comes back with `id: ""`), so
  every call — `session.snapshot`, `tab.create`, `agent.*`, `tab.*` — opens its own
  connection, resolves on the FIRST response line on it, and treats the close that follows
  as the end of the exchange; a close BEFORE the answer is the failure. Only
  `events.subscribe` connections stay open: they answer `{type:"subscription_started"}` and
  then stream `{event, data}`. `pane.exited` / `pane.closed` are subscribed globally on one
  connection that reconnects itself with backoff (0.5 s doubling to 30 s, logged once per
  outage), while `pane.agent_status_changed` REQUIRES a `pane_id` — herdr's subscription
  schema refuses it without one — so each launched pane gets its own events connection,
  opened as soon as `tab.create` names the pane (herdr already reports status DURING
  `agent.start`) and closed when the pane is gone. The client asserts `session.snapshot`'s
  `protocol` is 19 and otherwise logs and refuses (Shape falls
  back to the pty rather than guessing at a protocol it does not know). `herdr status` is
  shelled out once first to autospawn the server — skipped when `HERDR_SOCKET_PATH` is set,
  because an operator or a test who named a socket owns what is listening on it. PLACEMENT
  (2026-09-04): one herdr WORKSPACE per project, one TAB per session (variation). A launch
  carries `project { path, label }` (the main worktree and its basename); the launcher finds
  the project's workspace by, in order, its cached id still present in `workspace.list`,
  a workspace whose `worktree.repo_root`/`checkout_path` is the project path, a workspace
  whose `label` is the project's — else `workspace.create { cwd, label, env, focus: false }`,
  whose answer already holds the first tab + root pane, so the FIRST session of a fresh
  workspace runs in that root tab (renamed to the session label). Otherwise
  `tab.create { workspace_id, cwd, label, env, focus: false }` (never steal the terminal the
  user is in); a `workspace_not_found` refusal drops the cache and creates once. Then
  `agent.start { name: shape-<slug>-<n>, kind, pane_id: root_pane, args: argv.slice(1),
  timeout_ms }` — herdr's `AgentStartParams` names the pane `pane_id`, and refuses
  `invalid_request: missing field pane_id` for anything else. A failed start closes the tab
  so no dead shell is left behind. `focus` = `agent.focus`
  with `tab.focus` as the fallback (a pane whose harness exited is still the right thing to
  show), `kill` = `tab.close`, `type` = `agent.prompt`, `interrupt` = `agent.send_keys esc`.
  Pane ids are the durable handle; herdr agent names follow whoever occupies the pane.
- `pty` spawns the harness in a pseudo-terminal Shape owns and attaches it to that
  worktree's `PtyManager` (§Terminal), so the browser's drawer IS the session. `focus` is the
  one thing a pty cannot do for itself — there is no window to raise — so it posts
  `terminal { worktree, open: true }` and the browser opens the drawer. `type` is a
  bracketed paste plus Return; `interrupt` is a bare `\x1b`. Under the herdr launcher a
  worktree gets NO `PtyManager` at all and every `pty_*` frame for it is dropped: Shape must
  not offer a second, different terminal for the same session.

**Adapters** — one per integration, all launcher-driven (§Backends):

- `omp`: `<omp> --extension <abs packages/link/src/omp-extension.ts>` [`--approval-mode
  yolo` when autonomous] [`--resume <id>`], env `SHAPE_LINK` + `SHAPE_WORKTREE`. Everything
  else rides the loopback link (§Loopback link v2): the session counts as STARTED on the
  `hello` whose cwd maps to this worktree (60 s ceiling, then the session is killed and the
  open fails), session id and model come from it, `capabilities.hostTool`/`steerMidTurn` are
  its `capabilities.tool`/`.steer`, `send` is a `deliver` resolved by its `delivered`
  receipt (30 s ceiling), `abort` and `setAutonomous` are `abort`/`autonomous` frames, and a
  `bye` — or the socket simply closing — is the session ending.
- `claude`: the real TUI through the launcher with `--mcp-config` (the link's MCP server for
  the canvas tool), `--settings` (the link's hooks for events), `--allowedTools
  mcp__shape__canvas`, `--dangerously-skip-permissions` when autonomous else
  `--permission-mode acceptEdits`, `--resume <id>` when resuming. Steering is `type`,
  aborting is `interrupt`; `setAutonomous` throws, because Claude Code's permission mode is
  fixed at launch.
- `generic` (every other detected harness): `agent.start --kind <id>` and nothing else.
  State comes from the LAUNCHER — `working` → streaming, `idle`/`done` → idle (with a
  `turn_end` when a turn was running), `blocked` → idle plus the transcript line "waiting
  for you in the terminal", `unknown` → nothing, because it is not evidence. No canvas tool:
  the canvas stays what the user and the harnesses that do speak to Shape put there. herdr
  only — without it Shape would have to guess "is it thinking" by scraping a pty, which is
  the guessing this layer exists to avoid.

**Which harness runs** — `resolveBackend` in `agent/backend/config.ts`, highest precedence
first: (1) the `backend` an `open_worktree`/adopt named explicitly, (2)
`<cwd>/.shape/config.json`, (3) `~/.shape/config.json`, (4) `--backend`, (5) the only
harness installed, (6) `omp` — the harness Shape supports for now (herdr + omp is the ONLY
supported setup as of 2026-09-04; the pty launcher and the claude/generic adapters stay for
the smokes and for later). Resolution never ends in NONE: a project attaches WITH a session
on its primary variation (startup, `switch`, `create`, adopt), and the only way past that is
a harness that fails to start, which is a startup error / `open_worktree failed`. A project
that wrote down its choice keeps it even on a machine whose flags say otherwise. The
"start a session" card (harness radio, "autonomous", "remember for this project") remains the
explicit way to start one with switches decided up front; `remember: true` writes
`<cwd>/.shape/config.json` with the choice merged into whatever is already in that file — it
is the user's file — and it is written BEFORE the session starts, because the user asked to
remember the choice, not to remember it if it worked. A session ending never ends the agent:
the project stays attached with its canvas — and SAYING SOMETHING to a variation with no
session opens one: the room forwards `utterance`/`onboard` without a session gate (`abort`,
`focus_terminal`, `set_autonomous` keep it), the agent's `deliver` path opens the variation
on demand under the same serialization as every other open, posts `session_started` BEFORE
`delivered`, and on failure posts `error "open_worktree failed for <label>: …"` and no
`delivered` at all. The web offers every on-canvas variation in the target chip (running or
not) and never refuses typing for lack of a session.

**Test knobs** (read in both local and remote mode, by `detect.ts` and the launcher
registry): `SHAPE_FORCE_HARNESSES="omp,claude"` replaces the detected harnesses with stubs
(empty string = none detected), `SHAPE_FORCE_LAUNCHERS` the same for launchers, and
`SHAPE_LAUNCHER=herdr|pty` forces the choice (a forced herdr whose socket does not answer
still falls back, rather than leaving the agent unable to start anything). The smokes use
`scripts/fake-omp-tui.mjs` under the pty launcher and `scripts/fake-herdr.mjs` for the herdr
path.

## Graph document

Two layers in one doc. The agent writes ONLY the intent layer via the `canvas` tool.
The reality layer + drift are bridge-derived and agent-read-only.

Hierarchy is `parentId` (rendered client-side as tree/DAG expansion edges — user decision
2026-08-28; NOT nested containment). Edges are exclusively non-hierarchical relations —
never emit a "contains" edge.

See `GraphDoc`, `IntentNode`, `GraphEdge`, `RealityNode`, `RealityEdge`, `RealitySymbol`,
`RealityInfra`, `RealityVerification` in shared/.

**Product, build, infra and correctness layers (user decisions 2026-09-03).** The intent layer
itself is split in four by `IntentNode.layer`: `"product"` bubbles are the capabilities a
person gets, `"build"` bubbles are the parts that exist as code, `"infra"` bubbles are where
it runs and what it leans on outside the code, `"correctness"` bubbles are what proves the parts
correct. `layer` is ABSENT on build nodes — absent means build, so every graph written
before this decision is already a build graph, and the canonical snapshot omits `layer`
unless it is `"product"`, `"infra"` or `"correctness"` (`layerOf(node)` in shared/ is the only
reader). Hierarchy and edges never cross layers, so each layer is a self-contained graph;
the cross-layer links are exactly three, one per pair with build: `realizes` on a product
node names the build nodes that make that capability real (≤ 20, existing build ids, no
duplicates, sorted in canonical form), `hosts` on an infra node names the build nodes that
run on / use that piece of infrastructure (≤ 40, same rules), and `verifies` on a correctness
node names the build nodes that verification attests (≤ 40, same rules).
`realizersOf(doc, productId)`, `hostsOf(doc, infraId)` and `verifiedOf(doc, verifyId)` read
them forward; `servesOf(doc, buildId)`, `runsOnOf(doc, buildId)` and
`verifiersOf(doc, buildId)` read them back and inherit down the build hierarchy — a
capability realized by a parent is realized by its children, infra that runs a parent runs
its children, and a check that attests a parent attests its children. An upsert that omits
`layer` leaves an existing bubble on the layer it already had (only a brand-new bubble
defaults to build), so a status refresh cannot teleport a bubble across layers; `realizes`,
`hosts` and `verifies` are likewise sticky across an upsert that omits them, and are dropped
outright when the resolved layer is not the one that owns them.

**The infra layer (user decision 2026-09-03).** Infra bubbles are the databases, hosting,
caches, queues, third-party services and build pipelines a running product needs — said in
plain English ("the main database", "where the app runs", "the build-and-test pipeline"),
with `kind` out of the same `NODE_KINDS` list (`host`, `database`, `cache`, `cdn`, `ci` were
added for them; any layer may use any kind) and `codeRefs` pointing at the configuration
files that prove the thing exists. The infra layer has NO root requirement: several
top-level infra bubbles are normal, and `op/second-root` stays product-only.

**The correctness layer (user decision 2026-09-03).** Correctness bubbles are what attests the
build layer is correct rather than merely written: test suites, smoke and end-to-end runs,
static checks (typecheck, lint), review passes a person does, and production monitoring — said
in plain English ("the protocol checks", "checks that run on every push"), with `kind` out of
the same `NODE_KINDS` list (`test`, `smoke`, `check`, `review`, `monitor` were added for
them) and `codeRefs` pointing at the files that ARE the verification. Like infra it has NO
root requirement, several top-level correctness bubbles are normal, and `verifies` is its only
link to build. A finished build bubble nothing attests is a claim, which is what the canvas
says out loud with a hollow shield.

**Verification status (user decision 2026-09-03).** `verificationOf(doc, buildId)` in
shared/ answers `"verified" | "unverified"` for a build bubble and is the only reader of
that question (canvas shield, side panel, drift). Verified means EITHER half: some correctness
bubble's `verifies` names the node or an ancestor of it (`verifiersOf`), OR some
`reality.verification[i].covers` path MEETS the node's own or an ancestor's `codeRefs`.
"Meets" is the prefix rule in BOTH directions, because the two sides are written at
different altitudes: a cover of `packages/x/src` verifies a bubble owning
`packages/x/src/a.ts`, and a cover of `packages/x/src/a.ts` verifies a bubble owning
`packages/x`; a `file#Name` codeRef stands for its file here. A bubble that owns no code and
that no correctness bubble names is unverified. `capabilityVerification(doc, productId)` rolls
that up over `realizersOf`: `verified` (every realizer), `partial` (some), `unverified`
(none of them), `none` (no realizers at all — nothing to roll up, which the unrealized
rendering already covers). The mechanical half is `RealityVerification` (`v:<slug>`, label,
`kind`, `evidence` files it was read from, one plain-English `hint`, and `covers`: the
root-relative files and directories the verification exercises) in
`RealityLayer.verification`, bridge-derived and agent-read-only like the rest of the reality
layer; a missing array reads as `[]`.

**Connection is the default (user decision 2026-09-04).** Whatever can be connected to
something in another layer should be connected: a capability names the build parts that
realize it, a piece of infrastructure names the parts that run on it, a check names the parts
it attests, and a part should be reached by all three — a capability that delivers it, the
infrastructure it runs on and, once it is finished, something that attests it. A bubble left
unconnected is a **link gap**, and the ONE place that question is answered is
`linkGapsOf(doc, id)` in shared/: the bridge and the web both call it, neither re-derives it.
`LinkGap` is `"unrealized" | "unserved" | "unhosted" | "unattested" | "hosts-nothing" |
"attests-nothing"`, and `linkGapsOf` returns one node's gaps in that fixed order — `[]` for an
unknown id, for a node whose phase is not in `LINKED_PHASES` (`["component", "building",
"built"]`: an idea or a concept may stand alone, and `failed` is never asked) and for a bubble
that is fully connected. A gap is only ever raised when the other side exists to link to, so
nobody owes infra links in a graph with no infra:
- product, except `productRootOf(doc)` (the root spans the whole build layer and is never
  asked): `unrealized` when `realizersOf` is empty.
- build: `unserved` when `servesOf` is empty and some product node other than the root
  exists; `unhosted` when `runsOnOf` is empty and some infra node exists; `unattested` when
  the phase is `built` and `verificationOf` reads `"unverified"` — a finished part nothing
  attests is a claim. The ancestor rule already lives in `servesOf` / `runsOnOf` /
  `verifiersOf`, so a child of a connected parent has no gap.
- infra: `hosts-nothing` when `hostsOf` is empty and some build node exists.
- correctness: `attests-nothing` when `verifiedOf` is empty and some build node exists.

Nothing about the data model changes: the three links stay `realizes` / `hosts` / `verifies`,
and hierarchy and `edges` still never cross layers. What changes is that a gap is said out
loud in three places. (1) The canvas tool receipt: `applyCanvasCall` appends a
`{"warnings": [...]}` JSON block after the rejections block (or alone when there are none),
one `OpRejection` per gap with `severity: "warning"` and `code: "link/<gap>"`
(`link/unrealized`, `link/hosts-nothing`, …), `subject.path` = `/ops/<i>/node/realizes`,
`/hosts` or `/verifies` for the link the bubble owes itself and `/ops/<i>/node` for a
build-side gap, `subject.id` + `subject.label`, `evidence: { gap }`, and 1–3 plain-English
`supportedFixes` naming the link to write. They are computed AFTER the ops apply, only for the
bubbles the call touched, never for a call that applied nothing, and never during the
product-first turn (`applyCanvasCall(args, gate, { linkWarnings: false })` — the layers a link
points at are exactly what that turn may not draw). `isError` is unaffected: a warning is not
a refusal and the op it names has landed. `CanvasToolOutcome.warnings` carries the same list
for anything else that wants it. (2) The onboarding survey, where the other side already
exists, vetoes instead of warning: `onboarding/unhosted-infra` and
`onboarding/unattesting-correctness` join `onboarding/unrealized-product` (§Onboarding gate).
(3) The web draws it: a bubble carries `data-gaps`, and the side panel has a "not connected"
block listing each gap with what closes it; `unrealized` keeps the rendering it already had,
and the web's `UNREALIZED_PHASES` moved to shared as `LINKED_PHASES`. Steering says it too —
the `<canvas-steering>` block adds one `Missing link:` line per gap of the bubble the user
clicked (the product root gets none, and `unrealized` is already what that capability's
"Realized by: nothing yet" line says).

**The product root (user decision 2026-09-03).** The product layer has exactly ONE
top-level bubble: the product itself. Its label is the product's name, its summary the
one-sentence promise of the whole thing, and every capability is a child of it (deeper
capabilities below those). `productRootOf(doc)` in shared/ returns it, and `null` both when
no product node exists and when several top-level product nodes do — a legacy graph written
before this decision, which still renders (flat, focus `null`) instead of crashing.
`applyOps` keeps new graphs at one: an `upsert_node` that creates or moves a product node to
`parentId: null` while a different top-level product node exists is rejected with
`op/second-root`, whose evidence names the root (`rootId`/`rootLabel`) and whose supported
fix is to set `parentId` to it. The root stands for the whole build layer, so `realizes` on
it is optional (allowed, never required); every capability under it still needs one. The
build layer is unchanged — it keeps its 3–5 top-level groups.

Node phase lifecycle: `idea → concept → component → building → built | failed`.
Boundary test (enforced by bridge validation): every node MUST have a non-empty
one-sentence `summary` — its promise. Reject ops that omit it.

`summary` (stable promise) vs `status` (optional ≤ 140-char "what's happening here NOW",
agent-refreshed while building a node; an upsert that omits `status` clears it — stale
"now" is worse than none). The side panel renders status; the preamble instructs the agent
to keep it fresh on nodes it is actively working.

**Register (user decision 2026-08-28): plain English, no jargon.** Every label, summary,
status, edge label, and note the agent writes onto the canvas is read by a person steering
by voice, not a programmer reading code. Everyday words; say what a thing does for the
system in terms of outcomes, not mechanisms. No acronyms, protocol/library/file-format
names, or code identifiers unless the bubble is literally about that thing. A smart
non-programmer must understand every sentence. `codeRefs` stay technical (they are machine
addresses, rendered as such). Enforced via the preamble, the survey prompt, and the canvas
tool description — not mechanically validated.

**Symbol refs in `codeRefs` (user decision 2026-09-03).** A `codeRefs` entry is either a
workspace-relative path prefix (unchanged) or a symbol ref `"<file>#<Name>"` naming ONE
top-level class or function inside that file — how a small bubble claims one part of a
bigger file. `applyOps` requires at most one `#` with both sides non-empty
(`op/bad-coderefs`); the path part is validated no differently than before, and
`symbolRefOf(ref)` in shared/ returns `{ path, name }` for a symbol ref and `null` for a
plain path or a malformed one. The reality half is `RealityLayer.symbols`
(`RealitySymbol`: file, name, class|function, exported, line, package) and
`RealityLayer.infra` (`RealityInfra`: label, kind, evidence files, one plain-English hint);
both are bridge-derived and agent-read-only like the rest of the reality layer.

## `canvas` tool (agent → bridge)

JSON-Schema in shared/ (`CANVAS_TOOL_SCHEMA`); args = `{ ops: CanvasOp[], note?: string, next?: Next }`.

Ops: `upsert_node`, `remove_node` (rejected if node has children), `upsert_edge`,
`remove_edge`, `set_phase`. Batch-applied atomically per op (per-op accept/reject, not
all-or-nothing). Tool result text: `applied N op(s); rev=R`, then the refusals as a
`{"rejections": [...]}` block and the links the bubbles it wrote still owe as a
`{"warnings": [...]}` block (§Connection is the default) — the agent self-corrects from this.

Validation (shared `applyOps`): slug ids `^[a-z0-9][a-z0-9-]*$` (edges also allow `--`),
parent must exist, no parent cycles, edge endpoints must exist, labels ≤ 60 chars,
summary required and ≤ 200 chars (the boundary test applies to every layer).
Layer walls, with structured receipts in the same shape as the rest:
- `op/cross-layer-parent` — `parentId` must be on the same layer as the node.
- `op/cross-layer-edge` — both edge endpoints must be on the same layer.
- `op/bad-realizes` — `realizes` only on product nodes; every id must exist and be a build
  node; no duplicates; ≤ 20.
- `op/node-realized` — a build node still named in some product node's `realizes` can
  neither be removed nor flipped off the build layer (fix: update that `realizes`
  first). Product nodes may be removed freely.
- `op/bad-hosts` — `hosts` only on infra nodes; every id must exist and be a build node; no
  duplicates; ≤ 40.
- `op/node-hosted` — a build node still named in some infra node's `hosts` can neither be
  removed nor flipped off the build layer (fix: update that `hosts` first). Checked after
  `op/node-realized`, so a build node held by both links hears about the product side
  first. Infra nodes may be removed freely.
- `op/bad-verifies` — `verifies` only on correctness nodes; every id must exist and be a build
  node; no duplicates; ≤ 40.
- `op/node-verified` — a build node still named in some correctness node's `verifies` can
  neither be removed nor flipped off the build layer (fix: update that `verifies` first). The
  three links that point at build are one table in shared/ (`BUILD_LINKS`), walked product,
  infra, correctness, so both the removal and the layer-flip guard check them in that order and a
  build node held by several hears about the product side first. Correctness nodes may be
  removed freely.
- `op/second-root` — the product layer has one top-level bubble; a product node upserted at
  `parentId: null` while another top-level product node exists is rejected, the receipt
  naming that root so the fix (`parentId` = root id) is mechanical. Checked after
  `op/node-realized`, so a still-realized build node flipped to product hears about the
  dangling link first. Product-only: neither the infra nor the correctness layer has a root
  requirement.
- `op/bad-coderefs` — a `codeRefs` entry that reaches for a symbol and misses: more than one
  `#`, or an empty path or name around it (`"#Name"`, `"file.ts#"`, `"a#b#c"`).

`codeRefs` are allowed on product nodes and validated no differently (the onboarding gate,
not `applyOps`, is where product nodes stop being expected to own files).

`next` (optional, top level, never an op) is how a turn ends —
`{ summary, choices: [{ label, say }], question: string | null }`. `applyCanvasCall` validates
it with shared `parseNext` AFTER the ops have applied and returns it on the outcome: it never
touches the graph, is not in `GraphDoc`, not in a snapshot and not diffable. Bounds: `summary`
non-empty and ≤ 200 chars, 0–4 `choices`, `label` non-empty and ≤ 40 chars, `say` non-empty
(the exact utterance a click sends), `question` a string or null (absent, null and blank all
read as null). A malformed one is one receipt, `op/bad-next` at `index: -1` and
`subject.path: "/next"`, alongside whatever the ops earned — the ops still land, and the call
offers no card. See §Next and autonomy.

## WebSocket protocol (bridge ↔ browser)

Per-worktree fields (`worktree` on most frames, `hello.graphs`/`revisions`/`agents`,
`open_worktree` / `close_worktree`) landed 2026-09-03 — see §Worktrees on one canvas, which
wins wherever this section still reads as one graph per project.

Server → client (`ServerMsg`):
- `hello` — full `GraphDoc` + `SessionInfo` + `recentProjects: string[]` +
  `sessions: DiscoveredSession[]` + `projects: ProjectSummary[]` (every project this server
  hosts, newest `lastSeen` first) + `projectId` (the room this socket is joined to) +
  `tools: ProjectTools` (§Harness layer: what is installed where the agent runs, and which
  launcher it chose) on connect AND after every successful `switch_project` / `adopt`
  (retarget = fresh hello to the room's clients) AND when an agent re-attaches to an
  agentless room
- `session` — `{ session: SessionInfo }` session facts changed without the graph changing:
  the agent attached/detached (`agentConnected`), or the harness reported its session id
  late. The client replaces `session` only — no selection/transcript reset.
- `projects` — `{ projects }` broadcast to every socket whenever a room opens or an agent
  attaches/detaches
- `graph` — full `GraphDoc` after every change (graphs are small; no patch protocol in v1)
- `agent` — `{ state: "idle" | "streaming" | "compacting" }`
- `activity` — `{ nodeIds: string[] }` currently-working intent nodes (pulse rendering)
- `transcript` — `{ role, text }` appended lines for the side panel (assistant text deltas
  coalesced per message_end; tool lines summarized)
- `next` — `{ worktree, next: Next | null }` where that variation's turn left things; `null`
  takes the card down. `hello` carries `nexts: Record<worktree, Next | null>`.
- `autonomous` — `{ worktree, on }` that variation is (or is no longer) deciding for itself.
  `hello` carries `autonomous: Record<worktree, boolean>`.
- `error` — `{ message }`
- `sessions` — `{ sessions: DiscoveredSession[] }` answer to `discover` (broadcast)
- `terminal` — `{ worktree, open }` the pty launcher asking the browser to show (or hide)
  the terminal drawer: the answer to `focus_terminal` when Shape owns the pty. A harness in
  the user's own terminal is focused there and sends nothing here.
- `now` — `{ worktree, text: string | null }` the sentence being written right now, folded
  from the harness's `text_delta` events: at most one frame every 150 ms, the last ≤ 120
  characters, and `null` at the end of a turn (and when the session stops). Never stored,
  never a transcript line — the `text` that follows is the message of record.
- `pty_data` / `pty_exit` / `pty_state` — terminal output and lifecycle (see below)

Client → server (`ClientMsg`):
- `utterance` — `{ referent: { kind: "node" | "edge", id: string } | null, text: string }`
- `onboard` — `{ focus?: string }` map an existing project (see onboarding.md); valid only
  while the intent layer is empty
- `set_autonomous` — `{ worktree, on: boolean }` hand that variation over to itself, or take
  it back; refused with the usual reason when it has no session. See §Next and autonomy.
- `open_worktree` — `{ path, backend?, autonomous?, remember? }` run a harness in a worktree
  of THIS project. `backend` names the harness and beats every configured default; absent,
  the agent resolves one (§Harness layer). `autonomous` starts it deciding for itself, which
  for most harnesses means launching with approval turned off — it can only be chosen here,
  because that is the only moment it can be passed. `remember` writes the chosen harness to
  `<path>/.shape/config.json`. Answered with `session_started`, or an `error` frame.
- `close_worktree` — `{ worktree }` stop that variation's harness; its canvas stays on the view.
- `focus_terminal` — `{ worktree }` take the user to the harness's terminal: focused in their
  own terminal (herdr), or answered with a `terminal` frame that opens the drawer (pty).
  Refused like any other harness frame when that variation has no session, and refused with
  "there is no terminal to go to on <variation>" when its `capabilities.terminal` is `none`.
- `switch_project` — `{ path: string }` ask THIS project's agent to retarget: abort any
  running turn, dispose the backend, re-point at `path` (its graph is its own record, keyed
  by project — see §Storage), re-extract reality, re-read config, start a fresh backend
  and retarget the terminal, then `attach` again — a new project key opens a new room, and
  the browsers joined to the old room FOLLOW the agent (the old room stays, agentless).
  `~` expands; non-directory paths → `error` frame, current project untouched.
  Recents persist in `~/.shape/recents.json` on the agent's machine (most-recent first,
  deduped, cap 10).
- `pick_folder` — `{}` (2026-09-04) put the machine's OWN folder chooser in front of the
  user and answer `folder_picked { path: string | null }` to THE BROWSER THAT ASKED — a reply,
  never a broadcast; `null` = cancelled. The web's "open another" **Open** button sends it when
  the box is empty (title "pick a folder on this machine", label `picking…` until the answer)
  and, on a path, fills the box and sends `switch_project` — the agent never switches by
  itself. The dialog lives on the AGENT side because no web API yields an absolute path.
  Room: one chooser at a time (`pick_folder rejected: a folder chooser is already open`),
  agentless → `pick_folder rejected: no agent is attached to this project`, a 10-minute
  timer (`PICK_TIMEOUT_MS`) answers `pick_folder failed: the chooser did not answer` and frees
  the slot; an agent `error` starting `pick_folder` settles the slot and goes to the asker
  only. Agent (`runtime.ts #pickFolder`, off the deliver chain, killed on teardown):
  `$SHAPE_PICK_FOLDER` (whitespace-split command; stdout = path, exit 1 = cancel — smokes)
  else macOS `osascript -l JavaScript` running an `NSOpenPanel` after
  `setActivationPolicy(Regular)` + `activateIgnoringOtherApps` — AppleScript's `choose folder`
  from a background process opens BEHIND every window and `tell application "Finder"` needs
  an Automation grant, both seen live; linux `zenity --file-selection --directory` (ENOENT →
  "install zenity"); win32 PowerShell `FolderBrowserDialog`; else `pick_folder failed: no
  folder chooser on <platform>`. A silent exit 1 is a cancel, stderr on exit 1 is a failure;
  one trailing `/` is stripped. An ask that reaches the agent while a panel is still up (only
  possible after the room's timer) kills that panel — its answer is dropped — and puts up a
  fresh one.
- `create_project` — `{ path: string, github: { visibility: "public" | "private" } | null }`
  start a NEW project and retarget onto it. The path must be somewhere with nothing in it:
  it either does not exist yet, or is an EMPTY directory. The agent expands `~`, creates the
  folder (`mkdir -p`), and — unless the path is already inside a repo — runs
  `git init -b main`, writes `README.md` and commits it as "Initial commit". With `github`
  set it runs `gh repo create <basename> --source <path> --remote origin --<visibility>`
  (plus `--push` when there is a commit); the binary is `$SHAPE_GH ?? "gh"`. Then it is
  exactly a `switch_project` to that path. Only "nowhere to stand" is a rejection, and both
  kinds are refused BEFORE any git command runs, current project untouched: a path that
  exists and is not a directory → `error`
  "create_project rejected: \"<path>\" exists and is not a directory", and a directory that
  already holds anything → `error` "create_project rejected: \"<path>\" already has files in
  it — open it with \"open another\" instead, or choose a new folder name" (taking over a
  folder with work in it is `switch_project`'s job, never this one's). Everything after the
  folder exists (no git identity, `gh` refusing, an origin already set) is a warning: the
  user lands in the new project and reads the warnings as `error` frames next to a
  `transcript` (role `tool`) line
  "Started <name> at <path> — new repository|existing repository[, published to <url>]".
  Two creates or a create racing a switch → "create_project rejected: a project switch is
  already in progress". The canvas asks for the folder and the project name as two separate
  fields and sends `<folder>/<name>`, so a create is never one click away from a directory
  that is already full.
- `select_project` — `{ projectId }` join another room this server hosts; answered with that
  room's `hello` to this socket only. Unknown id → `error` "unknown project <id>".
- `abort`
- `pty_open` / `pty_input` / `pty_resize` / `pty_close` — terminal input and geometry
- `discover` — re-scan this machine for running agent sessions; answered with a `sessions`
  broadcast. The scan is `ps` plus a walk of each harness's session store (~150 ms), so the
  bridge also runs it inside every `hello` rather than making the client ask first.
- `adopt` — `{ pid: number }` take over a session someone else started. The pid is resolved
  in a FRESH scan (the client's list is as old as its last hello), then it is a
  `switch_project` to that session's `cwd` with the backend forced to `session.harness`
  (harness ids ARE backend ids) and `resumeSessionId` = `session.sessionId` when it has one.
  Unknown pid → `error` "adopt rejected: no running agent session with pid <n>"; unreadable
  cwd → `error` naming the pid; a harness with no adapter → `error`
  "no Shape adapter for <harness> yet". A stored graph with nodes for that project
  loads as usual; otherwise the client shows its "Map this project" CTA — that is the
  bootstrap path for an adopted project.

**Agentless rooms.** A room outlives its agent (link closed, agent switched away). While
`session.agentConnected` is false the server refuses `utterance`, `onboard`,
`switch_project`, `create_project`, `adopt`, `discover` and `abort` with `error`
"no agent is attached to this project — start `shape agent` in it", drops `pty_*` silently,
and still serves `diff`. A `deliver` the agent never receipted is re-sent when it re-attaches
(the agent dedupes by id: one backend send, identical receipt). A second agent attaching to
a key whose agent is still connected is refused with "project already has an attached
agent" and its link closed.

Terminal frames live in `packages/shared/src/pty.ts` (`PtyClientMsg` / `PtyServerMsg`) and
are merged into `ClientMsg` / `ServerMsg`; the server forwards them to the agent's `PtyManager`
(`packages/bridge/src/agent/pty.ts`) BEFORE any agent routing, so typing in the terminal never
queues behind a turn. One terminal per worktree, so `pty_data` is broadcast to every attached
client. Shape does not render a harness any more — it launches a real session in a real
terminal (§Harness layer) — so `BackendCapabilities.terminal` says WHERE that terminal is,
and there are three answers:

- `"pane"` — the harness runs in a pty Shape owns (the `pty` launcher), so the browser can
  open a drawer over the canvas on it. `pty_state.shell` is `"agent"`, keystrokes reach the
  TUI, and `pty_close` is a no-op — the session Shape is steering is not closable from the
  drawer. `focus_terminal` is answered with `terminal { open: true }`.
- `"external"` — the harness runs in a terminal that belongs to the user (a herdr tab). There
  is nothing to draw and no drawer: `focus_terminal` brings that tab forward where it lives
  and answers with no frame at all, and the browser hides the drawer entirely.
- `"none"` — there is no terminal to reach: a remote agent started without `--allow-terminal`
  (§Auth and tenancy). `pty_*` is dropped, and `focus_terminal` is refused with a reason.

A pty the launcher opened is attached to the pane (`PtyManager.attach(source)`), which
announces `pty_state { open: true, shell: "agent" }` as soon as the harness is up; a
`pty_open` from a browser joins the running terminal at that browser's geometry rather than
spawning anything. Scrollback belongs to the program in the terminal: there is no replay
frame, and a drawer that opens late sees the session from wherever it is now.

`SessionInfo` includes `targetHasCode: boolean` (bridge runs `extractReality` once at startup;
non-TS repos fall back to a cheap source-file scan). Client shows the "Map this project" CTA
when `targetHasCode` and `nodes.length === 0`. It also carries
`backend: { id, label, capabilities }` (§Backends) — the harness this session runs on,
re-derived on every `switch_project`.

`SessionInfo.canPublish: boolean` — the agent's machine has `gh` AND `gh auth status` exits
0, probed once per agent process. False ⇒ the canvas's new-project form offers the folder
only; the field also travels on `AgentProject`, so a registry row remembers what the
machine that wrote it could do (a row written without the field parses as `false`).

`DiscoveredSession` (shared/) is one row of the bridge's `discoverSessions()`
(`packages/bridge/src/agent/discover.ts`): `{ harness: "omp" | "claude" | "codex" | "opencode" |
"cursor", pid, command, cwd, sessionId, sessionFile, startedAt, resumeCommand, attach:
"socket" | "daemon" | "http" | "none", spawnedByShape }`. Rows with `spawnedByShape` are
excluded from the wire: those are Shape's own harness children, and adopting one is a loop.
`attach` records what a live process would offer (Claude Code's IPC socket, Codex's
app-server daemon, opencode's HTTP port); adopting today always starts a fresh harness for
that project and resumes the session by id rather than joining the running process.

## The loopback link (harness-side process ↔ agent, 2026-09-02; moved to `/link` 2026-09-03)

Anything that runs next to the harness and is not the harness itself speaks two frames
over `ws://127.0.0.1:<port>/link`, served by the AGENT half (`packages/bridge/src/agent/link.ts`),
defined in `packages/shared/src/link.ts` as `LinkClientMsg` / `LinkServerMsg`:

- `canvas_call` — `{ cwd, id, args }` a host-tool round trip carried over the socket. The
  agent forwards it to the server, which applies the ops; `canvas_result` `{ id, text, isError }`
  comes back to THAT socket only (a canvas result is nobody else's business; the `graph`
  broadcast is the public part). This is how a harness that cannot host a tool for us still
  writes to the canvas — Shape ships an MCP server (`packages/link/src/mcp.ts`, tool
  `canvas`) that is just a caller.
- `agent_event` — `{ cwd, event: AgentEvent }` one already-projected harness event
  (`state` | `text` | `tool_start` | `tool_end` | `turn_end` | `session`). It feeds the SAME
  `BackendEvents` sink the active backend uses, so an adapter with no native event stream
  (Claude Code's hooks, a transcript tail) lights up activity, transcript and agent state
  through the normal path.

`cwd` is REQUIRED on both and is how the frame finds its harness: Shape runs one per
worktree, and the cwd is the only thing that says which. The MCP server sends
`process.cwd()`; the hook sends the payload's `cwd`, falling back to its own. The agent
CANONICALIZES what it is given before matching — `process.cwd()` is already a realpath, but
a payload's `cwd` or a `$PWD` carries whatever the user typed, and on macOS every `/tmp`
path is a symlink to `/private/tmp` — then maps it to the DEEPEST worktree containing it,
so a subdirectory routes like its worktree. Canonicalization resolves the deepest EXISTING
ancestor, so a path whose leaf is gone still routes by the part of it that is real (the
match stops at a worktree root regardless). There is deliberately no default: a frame that
silently landed on the main worktree would write one variation's transcript into another's
canvas, and nothing about it would look wrong.

A frame the agent cannot parse — including one with no `cwd` — is answered
`error { message: "unparseable client message" }` on that socket. A cwd outside the repo, or
in a variation with no harness, is refused with the reason: an `error` frame, or for
`canvas_call` a `canvas_result` with `isError: true`, because the harness is BLOCKED on that
tool result and has to hear why. The loopback link stays local by design: harness-side
processes never hold server credentials, and the endpoint is bound to 127.0.0.1.
`SHAPE_BRIDGE_URL` overrides the default `ws://127.0.0.1:4400/link` for both link processes.

## Loopback link v2 (the harness itself on the link, 2026-09-04)

A harness that can run Shape's own code inside itself — omp, through
`packages/link/src/omp-extension.ts` — is not "something next to the harness": it IS the
session. Three client frames and three server frames make the same socket carry a session
instead of only its side effects. Every client frame still carries `cwd`, and is still
refused without one.

Client → agent:

- `hello` — `{ cwd, harness, sessionId, sessionFile, model, capabilities: { steer, tool } }`,
  the FIRST frame of a session-bearing client. `harness` is a free string, not the closed
  `Harness` union: a launcher can host kinds Shape has no adapter for. `sessionId` /
  `sessionFile` / `model` are `null` while the harness has not resolved them. `capabilities`
  is what the session will accept — both flags are REQUIRED, since a session that will not
  say what it can do is not one Shape can drive. Hooks and the MCP sidecar never send one:
  they forward, they have no session to announce.
- `delivered` — `{ cwd, id, mode: "prompt" | "steer", queued }`, the receipt for one
  `deliver`. `queued` means it landed mid-turn and waits its turn.
- `bye` — `{ cwd, reason }`, the session is going away (the user quit the TUI, the harness
  exited). The reason is what the user reads.

Agent → client (only a client that said `hello` is ever sent these):

- `deliver` — `{ id, body, mode: "prompt" | "steer" }`: put this utterance into the session,
  as a fresh prompt or into the running turn. Answered by `delivered`.
- `abort` — stop the running turn.
- `autonomous` — `{ on }`: while on, the harness approves its own tool calls (best effort).

`AgentEvent` gains two kinds. `text_delta` `{ delta }` is one fragment of the message being
written right now: NEVER stored — the room folds it into the live "now" line and the `text`
that follows is the message of record, so an adapter with no streaming surface simply does
not take them (`BackendEvents.onTextDelta` is optional). `session` gains an optional
`sessionFile`, because only a harness that logs to disk has one to name; absent and `null`
are the same answer and the validator normalizes to `null`.

Two fakes stand in for the real thing in the smokes, both plain Node with no deps.
`packages/bridge/scripts/fake-omp-tui.mjs` is a harness ON the link: `SHAPE_LINK` (ws url,
required), `SHAPE_WORKTREE` (the `cwd` every frame carries, default `process.cwd()`),
`FAKE_OMP_LOG` (JSONL of every frame with a `__dir` of `out`/`in`, plus `__start`/`__exit`
markers, default `<cwd>/fake-omp.log`), `FAKE_OMP_TURN_HOLD_MS` (hold a turn open so a test
can steer or abort inside it), `FAKE_OMP_SESSION_DIR`, and `--resume <id>` echoed as
`hello.sessionId`. It types like a TUI, not like a protocol: `{"type":"typed","text"}` on
stdin runs a turn with no receipt, and it reports `{"type":"ready",…}` /
`{"type":"status","status":"working"|"idle"}` on stdout so a supervisor can see turn
boundaries without scraping a terminal. `packages/bridge/scripts/fake-herdr.mjs` is that
supervisor: a unix socket (`HERDR_SOCKET_PATH`, default `<tmpdir>/fake-herdr.sock`, log
`FAKE_HERDR_LOG`) speaking newline-delimited `{id, method, params}` → `{id, result}` /
`{id, error: { code, message }}`, implementing `session.snapshot` (protocol 19, booting with
ONE workspace that is no project's — label "scratch", focused — so a smoke can prove Shape
created its own), `workspace.list` / `workspace.create` (answer carries the first tab and
root pane) / `workspace.close`, `tab.create` (honours `workspace_id`, refuses an unknown one
`workspace_not_found`; invents a tab and root pane, remembers cwd/label/env, spawns nothing),
`tab.rename`, `agent.start` (`pane_id` required — refused `invalid_request` without it, the
way herdr does; spawns `fake-omp-tui.mjs` with that env and waits for its `ready`
line), `agent.prompt` (types into its stdin), `agent.focus`, `tab.focus`, `tab.close` (kills
the child) and `events.subscribe` (streams `pane.agent_status_changed` from the child's own
status lines to whoever subscribed THAT pane, and `pane.exited` globally). It keeps the real
server's connection lifetimes, which is the point of the stub: a plain request is answered
with one line and the connection is then CLOSED, an `events.subscribe` connection is
answered `{type:"subscription_started"}` and stays open, and subscribing
`pane.agent_status_changed` without a `pane_id` is refused
`invalid_request` the way herdr's schema refuses it. Its log records the connection a call
came on (`__call.conn`) and the connections each event was delivered to (`__event.to`), so
`smoke:herdr` can assert one connection per call and per-pane delivery. `smoke:wire` covers
both fakes, and every frame the fakes send is read back through the real `parseLinkMsg`.

The real client of v2 is `packages/link/src/omp-extension.ts`, loaded by
`omp --extension <abs path>` with `SHAPE_LINK` (the only variable it reads; `SHAPE_WORKTREE`
is the launcher's bookkeeping, since frames are keyed by `ctx.cwd`) — omp has no external
IPC for a live interactive session, so the harness layer runs INSIDE the process and dials
out. It registers `canvas` through `pi.registerTool` with `CANVAS_TOOL_SCHEMA` translated
into `pi.zod` (a registered tool needs a callable schema, and translating rather than
hand-mirroring keeps the shared enums from drifting), and `execute` is one `canvas_call`
round trip: the AbortSignal answers "canvas call aborted" and a closed link answers
"Shape server unreachable" rather than hanging the turn. It says `hello` on `session_start`
(session id and file from `ctx.sessionManager`, model from `ctx.models.current()`,
`capabilities { steer: true, tool: true }`) and re-says it on every reconnect — one managed
`ctx.setInterval` tick with 1→8 s backoff, managed because a raw timer that throws tears the
session down. omp events project as `agent_start`→state streaming, terminal `agent_end`
(`isTerminal !== false`)→`turn_end` + idle, `message_update` text deltas→`text_delta`,
`message_end`→`text` but ONLY for `role: "assistant"` (omp ends the user's own messages and
its injected reminders through the same event; taking them made the delivered prompt look
like the agent's answer), `tool_execution_start`/`_end`→`tool_start`/`tool_end` (same path-token
projection the rpc adapter used), compaction start→compacting and its end→streaming
mid-turn or idle otherwise, `session_shutdown`→`bye`. Inbound, `deliver` is
`pi.sendUserMessage(body, mode === "steer" ? { deliverAs: "steer" } : {})` — which prompts
when idle and steers mid-turn on its own, so the receipt is never `queued` — `abort` is
`ctx.abort()`, and `autonomous` flips a `tool_call` handler that returns `{}`; that allows a
call but CANNOT open the TUI's approval prompt, which is a separate stage, so an autonomous
session is still launched with `--approval-mode yolo`.
`pnpm --filter @shape/link run selftest:omp` drives the real extension against a stub `pi`
and a real socket (frames per event, delivery, abort, the canvas round trip, reconnect).

## The agent link (agent ↔ server, 2026-09-03)

`AgentToServerMsg` / `ServerToAgentMsg` in `packages/shared/src/link.ts` is the ONLY
contract between `packages/bridge/src/agent/` and `packages/bridge/src/server/`; the doc
comments there are normative. Carried by `packages/bridge/src/transport.ts` (`ServerEnd` /
`AgentEnd`; `memoryLinkPair()` in local mode). Every frame after `attach` is scoped to its
link; the server never trusts a project id inside a frame body.

## Worktrees (user decision 2026-08-28: toggle first, compare later) — SUPERSEDED

**Superseded on 2026-09-03 by §Worktrees on one canvas.** Everything below describes the
one-worktree-at-a-time model: a worktree was its own project key, and toggling one was a
retarget. It is kept for the history of the decision only; the wire, the storage and the
view now merge every worktree of a repo into one canvas.

Each git worktree of the target's repo is an architecture variation with its own canvas
state: a worktree is its own path, so it is its own project key and its own set of records
(see §Storage). `SessionInfo.worktrees` carries
`{ path, branch, head, current }[]` from `git worktree list --porcelain`, re-detected on
every hello; empty for non-git targets (client hides the switcher). Toggling a worktree IS
`switch_project` to its path — full clean retarget, no separate message. The bridge appends
`.shape/` to the repo's `.git/info/exclude` (shared common dir → covers every
worktree) so a project-local `config.json` never lands in a commit. Side-by-side /
comparative views of two worktrees' GraphDocs are deferred by design.

## Worktrees on one canvas (2026-09-03)

User decision: per-worktree canvases stay (a worktree is still a variation), but the VIEW
merges them. Shape runs one harness per worktree the user opens, every write carries the
worktree it is about, and the default view is all worktrees with a filter to a subset.

**Identity.** A worktree id is the realpath of its directory. `WorktreeInfo` (shared) is
`{ id, path, branch: string | null, head: string | null }` — `current` is gone: a project
has no single current worktree. Every worktree of one repo shares the project key, which is
what lets one canvas merge them; `AgentProject.cwd` is the MAIN worktree's path.
`WorktreeSession` (`packages/shared/src/link.ts`) is one running harness:
`{ worktree, session: AgentSession, backend: BackendInfo, state: AgentState }`.

**Agent link** (`packages/shared/src/link.ts`, validated field by field in
`packages/bridge/src/linkframes.ts`). Every frame about ONE harness carries
`worktree: string`; an empty one is a malformed frame.
- `attach { project, worktrees: WorktreeInfo[], sessions: WorktreeSession[],
  realities: Record<worktreeId, RealityLayer>, discovered: DiscoveredSession[],
  recentProjects }`. `sessions` may be empty (the room opens with nothing running);
  `discovered` is the adopt picker's list, renamed off `sessions`. Reality is per worktree
  because HEADs differ; an unreadable entry costs that worktree's reality, not the attach.
  `project.legacyKeys` names the key each worktree was stored under before the common-dir
  key — see **Adopting a canvas off an older project key** below.
- Agent → server: `session_started { worktree, session, backend }`,
  `session_stopped { worktree, reason }` (unsolicited), and `worktree` on `agent_event`,
  `canvas_call`, `reality`, `delivered`, `skeleton_result`, `file_index`, `pty_data`,
  `pty_exit`, `pty_state`. `worktrees`, `sessions`, `recents`, `agent_error`, `agent_exit`,
  `detached` and `created` stay project-wide.
- Server → agent: `worktree` on `deliver`, `abort`, `extract_reality`,
  `synthesize_skeleton`, `file_index`, `pty_open`, `pty_input`, `pty_resize`, `pty_close`;
  new `open_worktree { path, backend?, resumeSessionId? }` (answered by `session_started`
  or `agent_error` — by PATH, because the id is the realpath the agent resolves) and
  `close_worktree { worktree }`. `switch`/`create`/`adopt` mean "retarget the WHOLE agent"
  only for another repo — see **Agent runtime** below.

**Browser wire** (`ServerMsg` / `ClientMsg`, validated in `packages/bridge/src/server/ws.ts`).
- `hello` carries `graphs: Record<worktreeId, GraphDoc>`,
  `revisions: Record<worktreeId, RevisionInfo[]>`, `agents: Record<worktreeId, AgentState>`
  and the usual `session`, `projects`, `projectId`, `recentProjects`, `sessions`
  (discovered). The single `graph`/`agent`/`revisions` are gone.
- `SessionInfo` is `{ cwd (main worktree), targetHasCode, worktrees, sessions:
  WorktreeSession[], agentConnected, canPublish }`; `sessionId`/`sessionName`/`model`/
  `backend` moved into `sessions`, one per worktree.
- Server → browser: `worktree` on `graph`, `agent`, `activity`, `transcript`, `revisions`,
  `delta` and every `pty_*`; new `session_started { worktree, session, backend }` and
  `session_stopped { worktree, reason }`. `session`, `projects`, `sessions` and `error`
  stay project-wide.
- Browser → server: `worktree` on `utterance`, `onboard`, `diff`, `abort` and every
  `pty_*`; new `open_worktree { path }` and `close_worktree { worktree }`.

**Storage** (`packages/bridge/src/server/{storage,sqlite}.ts`, schema `user_version` 2).
`loadGraph` / `saveGraph` / `listRevisions` / `loadRevision` / `saveRevision` /
`appendAudit` take `(tenant, key, worktree, …)`: `graphs` and `revisions` have a
`worktree TEXT NOT NULL` column inside their primary key, `audit` carries it as a column
(and inside the stored entry), and revision retention (50) is per worktree. `GraphStore`
and `SnapshotStore` are constructed with the worktree they belong to. The `projects`
registry stays one row per project: its `session` column became `sessions` (a
`WorktreeSession[]`) beside the existing `worktrees` list.

**Migration 1 → 2.** Everything stored before worktrees existed was the canvas of one
directory, so its rows are assigned the realpath of the `cwd` in that project's registry
row (`mainWorktreeOf`); a graph whose registry row is gone has no cwd to resolve and takes
the project key itself, an id no live worktree collides with. The v1 `session` becomes a
one-element `sessions` list against that same main worktree when it named a resumable
session, the v1 worktree list gains `id`s and loses `current`, and old audit lines keep
their `seq`. Legacy `.shape/` imports (`server/legacy.ts`) land on the main worktree too.
Covered by `pnpm --filter @shape/bridge run smoke:wire`.

**Adopting a canvas off an older project key.** The key used to be
`sha256(hostname():realpath(cwd))` — one project per DIRECTORY — so every canvas drawn
before the common-dir key is stored under a key nothing now derives, and a first attach
would open an empty canvas beside it. So `attach`'s project carries
`legacyKeys: Record<worktreeId, string>` — for each worktree the agent lists,
`legacyProjectKey(worktree.id)` = the old key for that directory (missing ⇒ `{}`: an older
agent, or a stored registry row) — and the room, before it loads a worktree's graph, calls
`Storage.adoptLegacyKey(tenant, legacyKey, key, worktree)`. In one transaction that moves
the `(legacyKey, worktree)` graph, revisions and audit lines onto `(key, worktree)`
(audit entries re-stamped with the new `projectId`, their own lines under the new key kept),
drops the legacy `projects` row once no graph is left under it, and returns whether anything
moved; the room logs `[bridge] adopted the canvas of <worktree> from its previous project
key` when it did. Rows already under `(key, worktree)` are replaced ONLY when their graph
has zero nodes: a canvas someone has actually drawn under the current key wins, and the
legacy rows are then left untouched rather than discarded. Adoption is idempotent, runs
ahead of the `.shape/` import so the newer of the two is never overwritten by the older,
and NEVER runs in `restore()` — an agentless room has no agent to name the old keys.
Covered by `smoke:wire` (the storage rule) and `smoke` (seeded before the bridge starts,
adopted on the attach that switches onto that project).

**Agent runtime** (`packages/bridge/src/agent/runtime.ts`). One agent serves one REPO and
runs a `Map<worktreeId, Harness>`; a `Harness` is `{ cwd, backend, backendInfo, events, pty,
session, state, promptSent }`. The project key is
`sha256(hostname():realpath(git common dir))` — every worktree of a repo agrees on the
common dir, which is what puts them on one canvas — and `realpath(cwd)` for a non-git
target, which is still reported as exactly one `WorktreeInfo` so a session never names a
worktree the browser has not seen. `project.cwd` is the main worktree: the first entry of
`git worktree list --porcelain`, which is the one owning the common dir. Every path the
agent reports is a realpath, never the spelling the frame asked for.

- ONE `BackendEvents` sink per harness, bound to its worktree for the harness's life:
  everything it emits is stamped with that worktree, and the loopback link feeds the sink
  of the worktree its caller's cwd resolved to.
- The `--cwd` worktree gets the first harness (announced by `attach`, not a frame);
  `open_worktree` starts another (config is re-read per worktree, so a variation may name a
  different backend) and answers `session_started`; `close_worktree` disposes one and
  answers `session_stopped`. Both then push an unsolicited `worktrees`. A harness that dies
  on its own also sends `session_stopped`; only the LAST one leaving is an `agent_exit`.
- SAME-REPO RULE: `switch`, `create` and `adopt` resolve their path first. Inside the
  current repo it is a VARIATION — `open_worktree` semantics on that worktree, no retarget,
  no re-`attach`, and an already-running one is answered with the `session_started` it
  already earned (an adopt replaces its harness). Another repo is the real switch: every
  harness is disposed, the new project is opened and re-`attach`ed.
- Per worktree: the preamble (once per harness), reality re-extraction on its own HEAD
  change when its harness goes idle, `file_index` / `synthesize_skeleton` / `extract_reality`
  (which work on a variation with no harness too — a directory is a directory), and one
  `PtyManager`, created and disposed with the harness. Deliver receipts are kept per ROOM,
  keyed by deliver id, so a variation that is closed and reopened cannot make a replayed id
  look fresh.

### The merged view (web, 2026-09-03)

The browser never switches between variations; it reads them as one canvas.
- STORE: `graphs: Record<worktreeId, GraphDoc>`, `agents`, `activity`, `revisions` and
  `ptys` are all worktree-keyed; transcript entries carry their `worktree`. `doc` is the
  MERGE of the filtered variations, so every existing selector, layout pass and panel is
  still written against one document.
- MERGE (`web/src/layer.ts` `mergeGraphs({ graphs, filter, main })`): nodes and edges
  unioned by id; the drawn copy (the primary) is the main worktree's when it is in the
  filter, else the first filtered id in codepoint order. `rev`, `reality` and `drift` are
  the primary's — a rev counted across variations names no snapshot, and extracted code
  describes one HEAD. Each merged node id maps to `where: Array<{ worktree, differs }>`,
  `differs` = `canonicalJson(canonicalNode(copy))` against the primary's (hence
  `canonicalNode` is now exported from `shared/src/delta.ts`). One variation on screen ⇒
  the primary doc is passed through and no marks are produced.
- FILTER: `filter: Set<worktreeId> | null` (null = all), persisted per project in
  `localStorage` under `shape.variations.<projectId>`; a stored id that no longer names a
  worktree is dropped, and "all of them" normalises back to null.
- TARGET: every write frame (`utterance`, `onboard`, `diff`, `abort`, `pty_*`) carries the
  target worktree. `selectTarget` = the reader's pinned pick while it is on screen, else
  the only filtered variation with a session, else the filtered variation that lit the
  selected bubble most recently, else the main worktree. The last case can name a variation
  with no harness: that is fine — saying something to it opens a session there (§Harness
  layer, "Which harness runs"), and the chip says so instead of refusing.
- DRAWING: one pip per variation holding a bubble (colour `--wt-0…5` by id order, hollow
  where that copy differs), one activity ring per variation working in it, one "now" line
  per working variation prefixed with its branch, the header variations pill as the filter
  (checkbox + running dot per variation, `open_worktree` / `close_worktree` actions), a
  target chip on the steering bar, and a "where" section on a selected bubble listing each
  variation's phase and status WHEN THEY DISAGREE. Revisions, comparison and the terminal
  pane are the target variation's; switching target clears the pane's scrollback.
- The word "worktree" never reaches the screen: a variation is its branch name (its folder
  when detached).

## Canvas navigation (client-side, user decision 2026-08-28)

Default view shows ONE layer: the children of a focus node (focus = null → top-level
components). Drill down into a bubble to make it the focus; breadcrumb navigates up.
Two invariants keep the single layer honest:
- **Edge lifting** — a relation touching a hidden descendant renders between the nearest
  visible ancestors (deduped; self-lifts dropped).
- **Liveness bubbling** — activity, drift, and `failed` phase on hidden descendants mark
  their visible ancestor.
No wire changes; pure rendering policy over `GraphDoc`.

**Layer cap (client, user feedback 2026-09-03):** a layer shows at most 5 bubbles. Beyond that
the top 4 by rank (has children, then degree over the visible layer's lifted edges, then kind
weight, then document order) stay and the rest fold into one synthetic bubble
`__more__:<focusId|root>` labelled "N more parts", whose summary lists the folded labels and
whose phase is the most advanced among them. Drilling into it shows exactly the folded nodes as
a layer (breadcrumb "more parts"); it has no referent, so selecting it steers the whole project.
Edges touching a folded node lift onto the more-bubble (self-lifts dropped, merged parallels keep
their count badge) and liveness/drift/`failed` bubbling counts folded nodes. Edge labels are
hidden until an endpoint bubble or the edge itself is selected or hovered; strokes always show.
This cap is a SAFETY NET, not the structure: the agent is instructed to keep 3–5 bubbles per
layer and to introduce named parent bubbles when there are more real parts (onboarding.md
§Stage 2), and that grouping is the real structure. No wire changes; the fold is pure rendering.

**Views (client, user decision 2026-09-03; third view 2026-09-03; fourth view 2026-09-03):** the
header carries a `PRODUCT | BUILD | INFRA | CORRECTNESS` toggle (tooltips "what people get" /
"what it is made of" / "where it runs" / "what proves it works") and the store keeps a `view:
Layer` (default product when the doc has any product node, else build — never infra and never
correctness: both answer a question about parts the reader has not met yet, and bubbles arriving
on either layer later never switch the view). A tab whose layer is empty is shown but disabled.
All of the above — one layer at a time, edge lifting, liveness bubbling, the 5-bubble cap — runs
unchanged over the nodes of the current view only; focus and selection are kept per view
(`parked: Record<Layer, ViewPlace>`), and a view emptied out from under the reader falls back to
build, the one layer with no precondition. Neither the infra nor the correctness layer has a
root bubble: their top level is every parentless node of that layer, capped and folded like build.

**The canvas follows the work (client, user feedback 2026-09-04):** the view is chosen and it is
also followed. An `activity` frame names exactly the bubbles the call that produced it touched
(§Activity mapping); when those ids all sit on ONE layer of that variation's canvas, that layer
is not the one on screen, the variation is in the current filter and nothing is being compared
(`delta === null`), the canvas switches to it — through the same code path a tab click uses
(`switched` in `packages/web/src/store.ts`), so the arriving layer's parked focus and selection
are restored exactly as a click would restore them. A `graph` frame that ADDS bubbles is read the
same way over the added ids only, which is how "now let's build it" reaches the build view as the
first parts are written; a status refresh on bubbles already on screen adds no ids and moves
nobody. This supersedes the clause above that bubbles arriving on the infra or correctness layer
never switch the view — work happening on a layer is what brings that layer up. The reader still
outranks the rule: every deliberate switch — a layer tab, Backspace out of a cross-layer drill, a
"built by" / "runs N parts" / "attested by" drill, or following a chip into another layer —
stamps `viewPinnedAt`, and for the next 20 seconds (`VIEW_PIN_MS`) nothing follows anywhere. Work
spread over two layers at once names no single place to be and is ignored. Client-only; no wire
changes. `?mock=playground` re-announces its two lit build bubbles every 1.5 s, unchanged, so the
rule can be watched from the product view without anything on the canvas moving.

Drilling across is a layer link, and there are three. `realizes`: a product bubble shows a
"built by N" chip that switches to the build view with focus `__realizes__:<productId>`
(breadcrumb `<label> › built by`), a synthetic layer of exactly that capability's realizing
build nodes, flat even when they sit at different depths. `hosts`: an infra bubble shows a
"runs N parts" chip that switches to the build view with focus `__hosts__:<infraId>`
(breadcrumb `where it runs › running on <label>`), a synthetic layer of exactly `hostsOf`.
`verifies`: a correctness bubble shows a "verifies N parts" chip that switches to the build view
with focus `__verifies__:<verifyId>` (breadcrumb `what proves it works › attested by <label>`),
a synthetic layer of exactly `verifiedOf`. All three share the flatness, the fold namespace and
the ‹ / Backspace behaviour, which returns to the layer the drill was entered from with that
bubble selected. The side panel reads every link from whichever end is selected: a build node
lists its `servesOf` capabilities, its `runsOnOf` infrastructure ("runs on" chips that jump to
the infra view focused on that bubble) and what attests it (below), a capability lists its
realizers and their infrastructure rolled up (a promise runs wherever the parts keeping it run),
a piece of infrastructure lists the parts running on it, a verification lists the parts it
attests. Product bubbles roll up their realizers' activity/drift/failure, and a product node
past `concept` with no realizers renders as **unrealized** — nothing on the build side makes it
real yet. Client-only derivation; no wire changes.

**The shield (client, 2026-09-03):** whether anything attests a bubble is a pip in the bubble's
meta row, next to the phase word — not in the head, where the phase dot and the drift flag
already compete, and never a frame effect, which is the drift glow's. A build bubble's pip is
`verificationOf`: filled ("something attests this works") or hollow ("nothing attests this
yet"). A capability's is `capabilityVerification` over its realizers: filled, half ("only some
of what is behind this is attested") or hollow; `"none"` — no realizers at all, which
**unrealized** already says — draws no pip. Infra bubbles, correctness bubbles and the fold have
no pip: the ground a project stands on is not a claim about correctness, a check that checked
itself would prove nothing, and one shield over a mixed fold would be a claim about none of it.
Hidden at `min` tier and in a comparison, where what moved is the whole story. The side panel's
**verified by** section gives both halves of a filled shield: the authored verifications as
chips that jump to the correctness view, and the extracted `reality.verification` whose `covers`
reach the bubble's own or an ancestor's `codeRefs` as dim evidence rows (label, hint, the files
they were read from) — nobody wrote those down, so they are not links. A capability gets a
**verified** rollup line naming the realizers nothing attests. Because the meta row can now
carry six things, which one gives way is stated in CSS rather than left to flexbox: the chip,
the phase word and the shield keep their size, a badge ellipsises, and `1 failed inside`
shrinks a quarter as fast as the softer badges. Before this the row simply drew past the card's
edge onto the canvas.

**The code column (client, 2026-09-03):** one dim, inert column of code-derived cards sits
beside the layer, headed by a caption, and says the same thing in four places — here is
something the code contains that the canvas has not accounted for. In the build view: reality
packages no bubble's `codeRefs` claim (prefix rule; a `file#Name` ref claims its file's
package too). In the infra view: `reality.infra` items no INFRA bubble's `codeRefs` claim, as
label + one plain-English hint, captioned "found in the configuration". In the correctness view:
`reality.verification` items no CORRECTNESS bubble's `codeRefs` claim, same shape, captioned
"found in the code" — the claim is over `evidence` (where a verification lives), never over
`covers` (what it exercises), which is the shield's business. Drilled into a leaf build bubble:
that bubble's mechanical "inside" — the top-level classes and functions of the files its OWN
`codeRefs` cover, minus any symbol some bubble already names with a `file#Name` ref, exported
first then file then line, with a kind sigil and `file:line` in dim mono. The column obeys the
layer cap with an inert "N more inside" card; the side panel's **inside** section lists every
symbol with its line. A leaf with symbols therefore has a drill chip ("N in code") where it
would otherwise have none; a leaf with none shows the ordinary empty layer. The product view
has no column.

**Product view starts from the root bubble (user decision 2026-09-03):** the product view
opens with focus `null`, whose layer is the product layer's top level — exactly one bubble,
the product root, rendered louder than a capability (`data-root`) with a "N capabilities"
drill chip. Drilling into it shows the capabilities under a focus card styled as the product;
crumbs read `product › <name>`; Backspace / ‹ return to the lone bubble. A legacy graph with
several top-level product bubbles simply renders them flat — never a crash.

## Steering composition (bridge)

With referent, bridge resolves node/edge + immediate neighbors and sends:

```
<canvas-steering>
Referent: component "auth-service" — "Handles login and session issuance." (phase: building)
Neighbors: api-gateway [depends], user-db [dataflow "credentials"]
User said: "this should also handle token refresh"
Apply the change and keep the canvas current via the canvas tool.
</canvas-steering>
```

The referent line names what was clicked: `component` for a build node, `product
capability` for a product node, and `the product "<label>"` for the product root. A
capability also gets a `Realized by:` line (or the explicit "nothing yet" sentence) and a
build node a `Serves:` line; the root gets neither — it stands for the whole build layer,
and its capabilities are listed among its `Neighbors` as `<id> "<label>" [capability]`.

Without referent: raw text, plus the trailing canvas reminder. Delivery: `steer` if
streaming else `prompt`.

**First utterance on an empty canvas (user decision 2026-09-03):** composed by
`composeFirstUtterance`, not `composeUtterance`, and the referent is ignored — there is
nothing on the canvas to have clicked. It always opens by handing the agent the draft root
the server just wrote (id `product`): upsert THAT id with the real name, never a second root
bubble. With the product-first turn armed it is a `<canvas-steering>` block that also spends
the turn on the picture — name the product, 3 to 5 capability bubbles under it, then stop and
let the user look, no files and no build bubbles — and asks for one short panel sentence
inviting the user to correct it or say "build it". With it off, the handover plus the raw text
plus the usual reminder.

## Product-first turn (bridge, user decision 2026-09-03)

`ClientMsg utterance` carries `productFirst?: boolean` (absent = on). It is only read when
the canvas is empty as the utterance lands; every later utterance ignores it.

On such an utterance the room, before delivering anything:

1. Writes the draft root through `store.applyCanvasCall({ ops, note: "a first sketch from
   your words" })` — `{ id: "product", parentId: null, layer: "product", label: "Your idea",
   summary: <first sentence of the utterance, ≤ 200 chars>, phase: "idea", status: "working
   out what this is…" }` — so it snapshots, persists and broadcasts `graph` like any other
   change, and sets `activity` to `["product"]`. The canvas is never blank behind a streaming
   agent.
2. Arms product-first validation unless `productFirst === false`. While armed, an
   `upsert_node` whose resolved layer is `build`, or which sets `realizes`, is vetoed with
   code `product/first` and the reason: *product picture first: this turn is the product layer
   only — name the product, give it 3 to 5 capabilities, then stop and let the user look*.
   Other ops pass. Disarmed by `turn_end`, by any later utterance, and by a retarget.
   An onboarding survey turn wins: its gate is stricter and already product-and-parts.

Client side: the empty state offers "Start with the product picture" (checked by default) and
the flag rides on that first utterance only. A `graph` frame that turns a zero-node canvas
into one with a product node switches the view to `product`.

## Next and autonomy (bridge + web, user feedback 2026-09-04)

Two halves of one problem: a turn that ends says nothing about what happens now, and a user
who does not want to answer every turn had no way to say so. Both are per worktree, both live
in `ProjectRoom`, and neither ever touches a `GraphDoc`.

**The card (`Next`).** `{ summary, choices: [{ label, say }], question }` (shared/, validated
by `parseNext` — bounds in §`canvas` tool). It is ephemeral state of one worktree, not part of
the document: never stored, never snapshotted, never diffed.

- Set from an accepted `canvas` call that carried `next`, the moment that call lands, and
  broadcast as `{ type: "next", worktree, next }`.
- Cleared (`next: null`) by any `utterance` to that worktree, before the delivery goes out —
  a card about work that has moved on is worse than no card. Also cleared when the harness
  stops (`session_stopped`, agent gone) and when autonomous mode answers it.
- At `turn_end` with no `next` set during that turn, the room synthesizes one:
  `{ summary: <first sentence of the last assistant text of that turn, else "The agent
  finished its turn.">, choices: [{ "Keep going", "Keep going with the plan." },
  { "What changed?", "Summarize what you changed and what is left." }], question: null }`
  (`steering.ts#synthesizeNext`). So every turn ends on a card, whatever the agent did.
- The preamble tells the agent to end every turn by calling `canvas` with `next`; autonomous
  mode is never described to it there, only in the auto-continue prompt.

Client: `NextCard.tsx` sits in `.steer-dock` between the canvas and the steering bar and shows
the TARGET worktree's card (`selectNext`) — one at a time, because two variations offering
four buttons each is a menu, not a call to action. A choice sends
`utterance { worktree, referent: null, text: choice.say }`; the question is its own emphasised
line; a card with no choices reads as "nothing waiting on you". Hidden while comparing
versions or when the target has no session. The dock publishes its live height as `--dock-h`
on the document root, which is what the "now" pill clears.

**Autonomous mode.** `ClientMsg set_autonomous { worktree, on }` → per-worktree flag,
broadcast as `{ type: "autonomous", worktree, on }`. While on, at every `turn_end`:

- if the turn's card has ≥ 1 choice or a question, the room clears the card and delivers, as
  an ordinary prompt, `steering.ts#AUTO_CONTINUE_PROMPT`: *Autonomous mode is on. Decide for
  yourself: take the option you would recommend, answer your own open question with the safest
  reasonable choice, and keep going until the work is finished. Do not stop to ask.* The
  transcript records it as role `user`, prefixed `autonomous: `, and the audit as
  `{ kind: "auto", id, run }`.
- if the card has no choices and no question, the agent is saying the work is finished, and
  nothing is sent.
- Cap: 25 consecutive auto-continues per stretch, reset by any human utterance. At the cap the
  room turns the flag off (`autonomous` frame) and says so in the panel as a `tool` line —
  "autonomous mode paused after 25 turns without you — say something to continue" — never an
  `error` frame.
- Autonomous on takes the product-first gate off that worktree (that gate exists to stop and
  let the user look, which is the one thing this mode is asked not to do), and a harness that
  stops turns the flag off.

Client: an `autonomous` chip in the steering bar next to the target chip, per target worktree,
pulsing while on ("autonomous — it decides and keeps going", click to pause), disabled with the
no-session or offline hint when it cannot be sent.

## Activity mapping

Bridge derives `activity` from two things, and both are "where the agent is working".

1. An accepted `canvas` call sets it to exactly the nodes that call created or updated
   (`upsert_node`, `set_phase`), replacing whatever was lit before — the canvas is what the
   reader watches, so the bubbles just written are the truest answer, and they are the only
   answer there is before any file is touched.
2. On `tool_execution_start` for file-touching tools, map the file path against intent
   nodes' `codeRefs` prefixes → those nodes JOIN the lit set. A ref that names one part
   inside a file (`"<file>#<Name>"`) is matched on its path half: an agent editing the file
   is working on the bubble that claims a part of it.

Either way the nodes stay "working" until `turn_end`, which clears. No agent cooperation
required.

Phase is also how finished a bubble looks: `idea` is drawn as a draft (dashed edge, words at
two-thirds strength), `concept` firms up to four-fifths, `component` and later are drawn at
full strength, and `building` breathes. While the agent is streaming or compacting with
nothing lit, one bubble — the layer's focus card, or the single root when the layer is one
bubble — carries a breathing halo, and the canvas shows the agent's latest tool line in a
small pill at its bottom-left corner.

## Reality layer + drift (bridge)

Interface (fixed): `extractReality(cwd: string): Promise<RealityLayer>` and
`computeDrift(doc: Pick<GraphDoc,"nodes"|"edges">, reality: RealityLayer): DriftMap`
— `extractReality` in `packages/bridge/src/agent/reality.ts` (agent: needs the repo),
`computeDrift` in `packages/bridge/src/server/drift.ts` (server: pure over the doc). Zero new
dependencies.

Trigger: on terminal `agent_end` (`isTerminal !== false`), if `git rev-parse HEAD` in the
target cwd changed since last extraction (or first run with any commit). v1 scope: pnpm/TS
monorepos — packages = workspace globs' dirs with package.json; edges = cross-package
import specifiers (regex scan of .ts/.tsx sources, workspace-name and relative imports).
Drift rule v2 (attribution): each intent node maps to the reality packages its own
`codeRefs` cover (longest package dir wins per ref, so a nested package beats its parent);
a node *covers* P if it or any descendant maps into P — hierarchy is transparent. A reality
edge P→Q is satisfied when some intent edge of any kind runs from a node covering P to a
node covering Q (direction matters: a Q→P edge does not answer a P→Q import), or when one
node's own refs straddle both P and Q (the dependency lives inside a single bubble). An
unsatisfied edge produces exactly ONE note, on the highest-altitude node covering P (ties:
a node whose own refs map into P first, then document order) — descendants stay clean and
the client's liveness bubbling carries the glow up. The reverse rule is evaluated the same
way: a declared `depends` edge whose ends are both `building`+ is contradicted only when no
reality edge connects any package covered by its source to any package covered by its
target; that test is direction-blind (a backwards declaration is already reported once by
the forward rule) and ends that share a package are skipped.

**Parts of a file (`symbols`, user decision 2026-09-03).** The same pass that reads imports
also parses each admitted source file with the TypeScript parser
(`packages/bridge/src/agent/symbols.ts`, `extractSymbols`) and records its TOP-LEVEL classes
and functions: `ClassDeclaration`, `FunctionDeclaration` (including `export default
function`), and a `const` whose initialiser is an arrow function or a function expression
(kind `function`). Nothing nested, nothing inferred. `exported` is true for an `export`
modifier, `export default`, or a later `export { X }` in the same file; `line` is the 1-based
line of the name; `pkg` is the reality package whose dir contains the file, or null; `id` is
`s:<file>#<name>`. Duplicate names in one file (overload signatures) collapse to the FIRST
declaration, so a `"<file>#<Name>"` ref always resolves to one place. Caps: the existing scan
budget (1 MiB per file, 5 000 files) plus 20 000 symbols in total, at which point extraction
stops and logs one line. The file is read ONCE for both passes — `extractSymbols` takes the
reader from `extractReality`, which hangs its import scan off the same read.

Drift rule C (vanished part): a `"<file>#<Name>"` ref on a `building`+ bubble, whose file the
reality layer DID read but which no longer declares that class or function, yields the note
`names a part of the code that is no longer there: <Name> in <file>` — on the claiming bubble
itself, not on an ancestor, because a ref that precise is that bubble's own business. A file
reality never parsed (a config file, an image, a document extracted by an older bridge) says
nothing either way and produces no note. Infra ghosts are not drift.

**Infrastructure (`infra`, user decision 2026-09-03).** `extractInfra(cwd: string, index:
FileIndex | null): Promise<RealityInfra[]>` in `packages/bridge/src/agent/infra.ts`, called by
`extractReality` with the index it already built and returned as `reality.infra`. It reads the
project's own configuration and nothing else: no network, no new dependencies, and no guesses.
A `null` index (not a git repo) yields `[]` — without git there is nothing to tell a real
config file from a leftover one, and inventing infrastructure is worse than reporting none.

What is read, and what each reading means:

| file | read | becomes |
| --- | --- | --- |
| `docker-compose*.y(a)ml`, `compose.y(a)ml` | `services:` names + each service's `image:` | the image's engine (below), or `host` for a service that builds its own image |
| `Dockerfile*`, `*.Dockerfile` | the file name | `host` ("runs as a container image it builds itself") |
| `fly.toml`, `vercel.json`, `netlify.toml`, `render.y(a)ml`, `railway.json`, `app.yaml`, `Procfile`, `serverless.y(a)ml`, `wrangler.toml` | the file name | `host`, named after the platform |
| `*.tf` | `resource "<type>" "<name>"` headers | by type: `rds`/`database`/`dynamodb`/`spanner`/`firestore` → `database`, `elasticache`/`memorystore`/`redis` → `cache`, `s3`/`bucket`/`storage` → `store`, `sqs`/`sns`/`pubsub`/`kinesis`/`servicebus` → `queue`, `cloudfront`/`cdn` → `cdn`, `instance`/`ecs`/`lambda`/`cloud_run`/`app_service`/`container`/`kubernetes`/`compute` → `host`; anything else is skipped |
| any other `*.y(a)ml` with `apiVersion:` | `kind: Deployment\|StatefulSet\|DaemonSet\|CronJob\|Job`, `metadata.name`, container `image:` | `host` for the workload, plus the images' engines |
| `.github/workflows/*.y(a)ml`, `.gitlab-ci.yml` | the file name (nothing inside) | `ci`, called a deployment pipeline when the name says deploy/release/publish, else build and test |
| every `package.json` | `dependencies` keys | `pg`/`postgres`/`mysql2`/`mongoose`/`better-sqlite3`/`prisma`/`drizzle-orm` → `database`, `redis`/`ioredis` → `cache`, `bullmq`/`amqplib`/`kafkajs` → `queue`, `@aws-sdk/client-s3` → `store`, `stripe`/`twilio`/`sendgrid`/`openai`/`@anthropic-ai/*` → `external` |
| `.env.example`, `.env.sample` | keys, and the value when it names an engine | `POSTGRES_*`/`DATABASE_URL` → `database`, `REDIS_URL` → `cache`, `S3_*`/`AWS_S3_*` → `store` |

Engines are matched on the whole lowercased image reference, dependency name or connection
string: postgres/postgresql/pgvector/timescaledb, mysql, mariadb, mongo → `database`;
redis/valkey, memcached → `cache`; rabbitmq, kafka, nats → `queue`.

One item per (kind, thing): `id` is `i:` + a slug of the kind and that thing's normalized name,
so the same Postgres named by a compose service, a `pg` dependency and a `DATABASE_URL` is ONE
`database` carrying all three files in `evidence` (≤ 8, sorted). The scanners are ordered —
compose, platform, terraform, Dockerfile, pipeline, manifest, package.json, environment — and
the first one to name a thing writes its `label` and `hint`; later readings only add evidence.
`label` says what it is followed by where it was read from ("Postgres database
(docker-compose.yml: db)", "Runs on Fly.io (fly.toml)", "Build and test pipeline
(.github/workflows/ci.yml)"); `hint` is one plain-English line. The list is sorted by kind then
label, so it never shuffles under the user between extractions. Bounds: ≤ 200 configuration
files read (in that scanner order, so the definite signals are read first), 1 MiB per file
(256 KiB for a maybe-a-manifest YAML), ≤ 80 items. A reality infra item is *claimed* when some
infra bubble's `codeRefs` cover one of its evidence files — the same prefix rule as packages —
and an unclaimed one is a ghost, never drift.

**Verification (`verification`, user decision 2026-09-03).** `extractVerification(cwd: string,
index: FileIndex | null, pkgs: readonly WorkspacePkg[], readSource: (file: string) =>
Promise<string | null>): Promise<RealityVerification[]>` in
`packages/bridge/src/agent/verification.ts`, called by `extractReality` with the index and the
workspace packages it already found and the same reader the symbol pass uses (never the
edge-scanning one, which would turn a test's imports into package edges), returned as
`reality.verification`. Like `extractInfra` it reads the project's own files and nothing else,
and a `null` index yields `[]`.

What is read, and what each reading means:

| read | becomes |
| --- | --- |
| test files by name — `*.test.*`, `*.spec.*`, anything under a `__tests__`/`test`/`tests`/`e2e` directory segment, `*_test.go`, `test_*.py`, `*_test.py`, `tests.rs` — grouped ONE item per workspace package, else per top-level directory | `test`, "Tests in `<dir>` (N files)" |
| runner configs (`vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `cypress.config.*`/`cypress.json`, `.mocharc*`, `pytest.ini`, `conftest.py`) | further evidence of that group's `test` item, listed FIRST so it survives the evidence cap; never an item of its own, because a config with no test files around it configures a suite this scan could not find |
| `smoke*` inside any `scripts` directory (the repo's or a package's) | `smoke`, "Smoke checks: `<file name without extension>`" |
| `package.json` scripts whose first word is `smoke*` or `e2e*` | `smoke`, "Smoke checks: `<script name>`" |
| `package.json` scripts whose first word is `typecheck`, `lint`, `tsc` or `check*` | `check`, "Static checks: `<script name>`" |
| `.github/workflows/*.y(a)ml`, `.gitlab-ci.yml` | `check`, "Checks run on every push (`<file>`)", sharing its evidence file with the infra `ci` item |

A file is only a test file if its extension is code (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs`, `.cjs`, `.go`, `.py`, `.rs`, `.rb`, `.java`, `.kt`, `.swift`, `.php`, `.cs`),
which is what keeps a fixture or a note inside `__tests__/` from counting. A plain `test`
script in a manifest is NOT an item: the test files are the evidence that tests exist.

`covers` is the half `infra` has no equivalent of — the root-relative paths a verification
exercises, and the reason a build bubble nothing names can still read as verified
(`verificationOf`). For a per-package suite it is the package dir PLUS every workspace file its
test files import; for a script, the dir it groups under plus the files it imports; for a
manifest script, the package dir (a ROOT manifest covers nothing, because the empty prefix is
the whole project); for a pipeline, every package dir. Imports are resolved with `reality.ts`'s
own `importSpecifiers` regex and `resolveSpecifier`, both exported for this: a relative
specifier becomes the file the index admits (as written, then `.ts`/`.tsx`/`.mts`/`.cts`/
`.js`/`.jsx`/`.mjs`/`.cjs`, then that directory's `index.*`, with the `.js` → `.ts` swap an ESM
TypeScript project needs), and a workspace-name specifier becomes that package's dir.

One item per (kind, thing), merged exactly as `infra` merges: `id` is `v:<kind>-<slug of the
name>`, and the name is slugged BEFORE it becomes the key, so `scripts/smoke-drift.mjs` and the
`"smoke:drift"` script that runs it are one item carrying both files. The file that IS the run
outranks the manifest line that merely names it, so its `label` and `hint` win the merge;
`hint` is one plain-English line. Sorted by kind then label, so the list never shuffles under
the user. Bounds: ≤ 2 000 test and script files read for their imports, ≤ 200 manifests read,
≤ 8 evidence files and ≤ 200 covered paths per item, ≤ 80 items. A verification item is
*claimed* when some correctness bubble's `codeRefs` cover one of its evidence files, exactly as
an infra item is, and an unclaimed one is a ghost. There is no drift note for an unverified
bubble: the shield pip is the signal, and a correctness bubble whose files vanish is already
caught by the existing codeRefs rules.

Wire: `parseReality` (`packages/bridge/src/linkframes.ts`) validates `symbols`, `infra` and
`verification` field by field, including `kind` against `NODE_KINDS` and, for a verification
row, `covers` (a row that cannot say what it exercises is not a usable row). A missing array is
an older agent (or a row stored before any of them existed) and reads as `[]`; a malformed
ENTRY is dropped on its own, because one bad row must never cost a whole extraction.
`GraphStore.load()` hydrates all three the same way for a row stored before they existed.

## Onboarding gate (server, 2026-09-03)

`onboardingOpGate(index: FileIndex, doc: Pick<GraphDoc,"nodes"|"reality">)` in
`packages/bridge/src/server/onboarding.ts`, armed for the survey turn only (`onboard` until
the next idle). It receives the project's file index AND the document, because a claim on one
part of a file is checked against `reality.symbols`. Codes, all with the standard
`code`/`severity`/`subject`/`evidence`/`supportedFixes` receipt shape:
- `onboarding/unrealized-product` — a product bubble with a non-null `parentId` naming no
  existing build bubble in `realizes`. The product root is exempt.
- `onboarding/unhosted-infra` (2026-09-04) — an infra bubble naming no existing build bubble
  in `hosts`. The survey's half of "connection is the default": by the time rule 11 runs the
  parts that run on it are already on the canvas, so a bubble naming none is pointing at
  nothing. Asked only when the canvas has a build layer to point at, exactly like
  `linkGapsOf`.
- `onboarding/unattesting-correctness` (2026-09-04) — the same for a correctness bubble's
  `verifies`: a check that attests nothing is the same empty claim as a capability nothing
  realizes. Both are checked AFTER the `codeRefs` codes, so a bubble that points at nothing
  hears about that first.
- `onboarding/no-coderefs` — a build, infra or correctness bubble with no usable `codeRefs`.
  Each layer hears the same refusal in its own words: a database, a host or a pipeline this
  project does not configure is not real either, and neither is a test suite, a smoke run or a
  check no file in the project performs. The message names the layer ("infra bubble",
  "correctness bubble"; a build bubble is just "node").
- `onboarding/unknown-coderef` — the path (for a symbol ref, its path half) is outside the
  project or absent from the file index.
- `onboarding/unknown-symbol` — the path exists, but the file declares no top-level class or
  function by that name. Evidence: `file`, `name`, and `known` (that file's symbol names,
  ≤ 20), which the fixes echo so the agent can pick a real one. A file the reality layer
  never parsed has no known parts, so a name against it is ACCEPTED: the gate refuses claims
  it can disprove, not claims it cannot check.

Only bubbles admitted on the BUILD layer count as ground for a later product, infra or
correctness bubble's `realizes`, `hosts` or `verifies` in the same call; an infra or
correctness bubble admitted in the same batch does not.

## Onboarding survey prompt (server, 2026-09-03)

`composeSurveyPrompt(doc, focus)` (`packages/bridge/src/server/onboarding.ts`) is the survey
turn's whole instruction: the numbered rules, then the mechanical material they work from.
Rules 1–8 are the build pass and rule 9 is the product pass (unchanged). Three rules were
added, and the numbering of the existing ones is fixed — a rule number is quoted in receipts
and in the smoke, so rules are appended, never renumbered:

- **Rule 10 (depth, REQUIRED since 2026-09-04).** Every LEAF build bubble whose files
  declare classes or functions gets child bubbles for the ones that carry a promise of their
  own — every class, every exported function, every handler/command/route, any top-level
  function another file imports — each with `codeRefs: ["<file>#<Name>"]`; 3–5 per part, six
  or more means a named child group is missing; small helpers stay inside their parent. The
  inventory IS in the prompt now: "Classes and functions found in the code (N in M file(s))",
  one line per file, exported names first, bounded (`SURVEY_SYMBOL_BUDGET` = 400 symbols —
  past it only exported names are listed and the header says so; `SURVEY_SYMBOLS_PER_FILE` =
  12 with "… +N more"). `reality.symbols` covers `.ts .tsx .js .jsx .mjs .cjs` (top-level
  `class`, `function`, and `const|let|var NAME = arrow|function expression`; methods and nested
  functions are not parts). A name the file does not declare comes back as
  `onboarding/unknown-symbol`. The preamble carries the same depth for ongoing work: a class or
  major function written or changed gets its `path#Name` child bubble in the same call, a
  deleted one loses it. Onboarding is refused once the canvas has bubbles ("steer them instead
  of remapping"), so deepening an existing map is an utterance — proven live on duck-counter:
  11 → 88 bubbles, `src/db.ts#openDb`, `public/app.js#viewCount`, grouped 3–5 per level.
- **Rule 11 (infra pass).** After the product pass. The mechanical infra listing IS in
  the prompt, as an "Infrastructure found in the code (N item(s))" block, one line per
  `RealityInfra`: `- <label> — <hint> (evidence: <files>)`. The agent turns those into bubbles
  with `layer: "infra"` in plain English ("the main database", "where the app runs"),
  `codeRefs` = that item's evidence files, `hosts` = the ids of the build bubbles that run on
  it or use it; 3–5 at the top level, grouped under named parents beyond that. Infra bubbles
  never parent or edge across layers — `hosts` is the only link, as `realizes` is above. An
  empty listing is stated as such ("Infrastructure found in the code: none"), with the
  instruction to create no infra bubbles: infrastructure with no file behind it is a guess.
- **Rule 12 (correctness pass).** Last, after the infra pass. The mechanical verification listing
  IS in the prompt, as a "Verification found in the code (N item(s))" block, one line per
  `RealityVerification`: `- <label> — <hint> (evidence: <files>; covers: <paths>)` — covers is
  what rule 11's block has no equivalent of, and it is how the agent fills in `verifies`
  without guessing (match those paths against the codeRefs of the bubbles above). The agent
  turns the items into bubbles with `layer: "correctness"` in plain English ("the protocol
  checks", "checks that run on every push"), `codeRefs` = that item's evidence files, `verifies`
  = the ids of the build bubbles it attests; 3–5 at the top level, grouped under named parents
  beyond that. Correctness bubbles never parent or edge across layers — `verifies` is the only
  link, as `hosts` and `realizes` are above. An empty listing is stated as such ("Verification
  found in the code: none"), with the instruction to create none: verification with no file
  behind it is a guess.

The intro paragraph names all four layers (build = what the mechanics seeded, product =
rule 9, infra = rule 11, correctness = rule 12), and rule 7 (validation is armed) notes that an
infra bubble clears the codeRefs bar with the configuration files it comes from and a
correctness bubble with the files that ARE the check.

Rules 9, 11 and 12 each say the default outright (2026-09-04): a capability whose realizers
you cannot name is one the survey does not create, `hosts` is not optional
(`onboarding/unhosted-infra`), `verifies` is not optional
(`onboarding/unattesting-correctness`). The prompt closes on the same thing as a checklist —
when the turn is done every capability names the parts that realize it, every infra bubble
names what runs on it, every check names what it attests, and every top-level build group is
reached by all three; a top-level group nothing names is a gap the survey closes rather than
leaves.

## Voice capture (web, v1)

Selecting a node/edge focuses a visible steering input; any dictation tool (or the
keyboard) types into it; Enter commits → `utterance`. No vendor-specific integration;
no mic/WebSpeech in v1.

## Revision snapshots + delta

Every accepted change bumps `rev`; the bridge then stores a canonical snapshot of the intent
layer as one row per `rev` (`SnapshotStore` in packages/bridge/src/server/snapshots.ts, over
the `revisions` table). A rev is immutable — an existing row is never rewritten — and
retention keeps the newest 50 per project, pruning the rest in the same transaction as the
insert. Snapshots hold nodes + edges only — reality and drift are re-derivable, so they stay
out.

`packages/shared/src/delta.ts` is the whole comparison: `snapshotGraph` writes the canonical
form (nodes/edges sorted by id, stable key order, undefined optionals omitted, `codeRefs`
sorted), `canonicalJson` gives it a byte-stable string, and `diffSnapshots(a, b)` is a pure
`GraphDelta` — `a` is before, `b` is after, keyed by id, `changed` = same id whose canonical
form differs. No I/O, so the client can diff too.

Wire: `hello` carries `revisions: RevisionInfo[]` (ascending), and a `revisions` frame is
broadcast whenever a new snapshot lands. The client asks with `diff` `{ revA, revB }` and the
bridge broadcasts `delta` `{ delta }`; an unknown rev answers with the usual `error` frame.

## Storage (server, 2026-09-03)

All server-side canvas state lives in one SQLite database, through Node's built-in
`node:sqlite` (`DatabaseSync`, zero dependencies). `packages/bridge/src/server/storage.ts`
declares the record store; `packages/bridge/src/server/sqlite.ts` is the only
implementation (`openSqliteStorage(file)`), and both modes use it:
- local mode (`pnpm bridge`, `shape` with no subcommand): `$SHAPE_HOME`-or-`~/.shape/shape.db`,
  overridable with `--db <file>`. Nothing is written into the repo any more; a project's
  `.shape/config.json` (backend choice) is the only file Shape still reads from it.
- `shape server --data-dir <dir>` (default `~/.shape/server`, `SHAPE_HOME` honored):
  `<data-dir>/shape.db`.

`Storage { file, loadGraph(tenant, key, worktree), saveGraph(tenant, key, worktree, doc),
listRevisions(tenant, key, worktree), loadRevision(tenant, key, worktree, rev),
saveRevision(tenant, key, worktree, snapshot), listProjects(), saveProject(row),
appendAudit(tenant, key, worktree, entry),
adoptLegacyKey(tenant, legacyKey, key, worktree), close() }`. Canvas records are keyed
`(tenant, projectKey, worktree)` — none of the three is a filter a query may forget: the
tenant because two machines may hold the same project key, the worktree because every
variation of a repo is its own canvas (§Worktrees on one canvas) — over four tables:
`projects` (registry rows, one per project), `graphs`, `revisions`, `audit`.
`PRAGMA user_version` is the schema version (2); a database from a newer build is a startup
error, never reshaped, and 1 → 2 migrates in place (see §Worktrees on one canvas).

`saveRevision` returns false when that rev already exists, which is how a room knows not to
broadcast a snapshot twice; retention (newest 50) is per worktree. `saveProject` upserts
`StoredProject { tenant, project: AgentProject, worktrees, sessions: WorktreeSession[],
lastSeen }` after every attach and detach (a pre-tenant row reads as `local`); at startup a
remote server restores each row as an agentless room
(`[bridge] restored N project(s) from <data-dir>`), so a browser is greeted read-only
immediately and agents re-bind on reconnect. Local mode never restores: the agent that owns
the repo is what brings a project back. An unreadable row is skipped with `[bridge] ignoring
unparseable project row <tenant>/<key>`, never fatal. Audit entries `{ at, tenant,
projectId, worktree, kind: "deliver" | "delivered" | "onboard", … }` are appended per
steering delivery, receipt and survey; a failed append is logged once as `[bridge] audit
write failed: <message>` and never fails the steer.

One-shot import (`packages/bridge/src/server/legacy.ts`): the first time local mode opens a
project that has no graph row, a `<cwd>/.shape/graph.json` and `<cwd>/.shape/revisions/` left
by an older Shape are read into the database, then moved aside under `<cwd>/.shape/imported/`
(a second import lands under a timestamped sibling, never over the first) — `config.json` and
the directory itself stay (`[bridge] imported <cwd>/.shape into <db file> (files kept under
…)`). Never deleted: a bridge on a throwaway `--db` imports just the same, and the only copy
of a canvas must survive that; the imported canvas is the MAIN worktree's. A remote server does the same
once at startup for a pre-SQLite `--data-dir`: rows from `<root>/projects.json` and the
graphs and revisions under `<root>/tenants/<tenant>/projects/<key>/` are imported and the
registry is renamed to `projects.json.imported`. Anything unparseable is skipped with a line
on stderr, never thrown.

## Auth and tenancy (server, 2026-09-03)

Authentication happens at the WebSocket upgrade, never inside a frame (`attach` carries no
token). `packages/bridge/src/server/auth.ts`:
- `shape server --token-file <path>` loads a JSON array of `{ token (≥ 16 chars), tenant
  (^[a-z0-9][a-z0-9-]*$) }`; malformed → startup failure `token file <path>: <reason>`.
- Agents send `Authorization: Bearer <token>` on the `/agent` upgrade; browsers send
  `?token=<token>` on the `/ws` URL (the web client persists `?token=`/`?server=` page params
  in localStorage and strips them from the address bar). Either form is accepted on either
  path. Missing/unknown token on an authenticated server → HTTP 401, no socket.
- Without a token file the server is unauthenticated: every connection is tenant `local`,
  and `--host` outside loopback is refused: `refusing to listen on <host> without --token-file`.
- One token ⇒ one tenant. Rooms are keyed `(tenant, projectKey)`; `projects`, the default
  room, `select_project` and storage are all tenant-scoped, so the same project key under two
  tenants is two rooms and a cross-tenant `select_project` is `unknown project <id>`.
- The agent resolves its token as `--token`, then `SHAPE_TOKEN`, then
  `~/.shape/servers.json[<ws://host:port>]` written by `shape login <server-url> <token>`
  (mode 0600, `[bridge] saved token for <origin> in <path>`). A 401 is final: the agent does
  not retry and exits with `Shape server refused the token (401)`.
- Terminal gating: `shape agent --allow-terminal` is off by default; a gated agent advertises
  `capabilities.terminal: "none"` and ignores `pty_*`, and the server drops `pty_*` for any
  room advertising `"none"`. Local mode keeps the terminal on.

## Views and the terminal (web, 2026-09-04)

Shape is a layer over a real harness in a real terminal, so the browser has exactly ONE
view — the canvas — and a way over to where the session actually runs. The canvas|terminal
switch and its `Ctrl+\`` shortcut are GONE, along with `terminal: "session"` (the read-only
rendering of a session) and everything that read it.

**Go to terminal** (`App.tsx` `TerminalButton`, header, replacing the old view switch).
About the TARGET variation, because that is the session a person means while looking at
this canvas. It reads `capabilities.terminal` of that variation's running harness:

- no session there ⇒ shown DISABLED ("nothing is running on `<branch>` yet"). The door is
  visible before there is anything to go through it to.
- `"none"` ⇒ hidden entirely: a remote agent started without `--allow-terminal`, OR a herdr
  whose window Shape cannot raise (not macOS, or no herdr client of this machine runs inside
  a `.app` — ssh, tmux, a bare console). The launcher decides this at probe time and logs
  `herdr's terminal window cannot be raised from here (<why>) — "Go to terminal" is not
  offered`.
- otherwise ⇒ click sends `ClientMsg focus_terminal { worktree }`.
  - `"external"` (herdr): `agent.focus` (fallback `tab.focus`) switches herdr's tab, THEN the
    terminal application is brought forward — the herdr client's parent chain is walked
    (`ps -axo pid,ppid,command`) to the first `/…​.app/Contents/MacOS/` ancestor
    (`terminalAppOf`, `isHerdrClient`: argv0 basename `herdr` whose first argument is not
    `server`/`api`/`status`) and raised with `open <bundle>`. `SHAPE_TERMINAL_APP` names the
    bundle outright; `SHAPE_OPEN` replaces the `open` binary (smokes set `true`). A raise that
    fails re-probes once, then the focus throws "herdr's tab is focused, but its terminal
    window could not be brought forward: …" and the room reports it. NOTHING changes on this
    screen, so the click says so — a 2-second notice, "opened in your
    terminal" (`store.notify` / `.notice` in `StageTools`, `NOTICE_TTL_MS = 2000`).
  - `"pane"` (Shape's own pty): the server answers `ServerMsg terminal { worktree, open }`
    and the drawer opens. The frame is applied ONLY when its worktree is the current target
    — it is broadcast to every tab, and a tab reading another branch must not have a drawer
    thrown over its canvas.

The same action is a row in the variations menu, per RUNNING variation whose terminal is
not `"none"`. It sets the steering target to that variation first: the drawer shows the
target's shell, and reading one branch while typing at another is how a sentence lands in
the wrong checkout.

**The terminal drawer** (`Terminal.tsx`, `.term`). The same single xterm as before, still
created on FIRST SHOW (an xterm opened inside `display:none` measures 0×0) and never torn
down while the app lives (hiding is a CSS change, so scrollback survives). What changed:
it is an overlay on the BOTTOM of the stage, clearing the steering dock via `--dock-h`,
rather than a second view covering the canvas; it is always interactive (`pty_input` /
`pty_resize` / `pty_open` for the target worktree, exactly as before); and it is dismissed
by Esc — both from inside xterm (`attachCustomKeyEventHandler` swallows the key) and from
the window — or by the × in its header. `store.setTerminal(open)` is the only writer;
`hello` closes it, because another project's shell is not this one's.

**Start a session** (`App.tsx` `StartCard`). Shown when the TARGET variation has no
session, in exactly one place at a time: it IS the empty state on a canvas with no bubbles,
and otherwise it takes the end-of-turn card's place in the steering dock. Contents:

- "Start a session on `<branch>`".
- one radio per `hello.tools.harnesses` entry, by `label`; the FIRST is preselected (the
  hello carries no remembered backend — a project that has one comes up with a session
  already running, so this card never appears for it). With none detected the radios are
  replaced by "no coding agent found on this machine — install omp or Claude Code" and
  Start is disabled.
- **Autonomous** (off) and **Remember for this project** (on) checkboxes.
- a line saying where it will run, from `hello.tools.launcher`: "runs in herdr" or "runs in
  Shape's own terminal".
- Start sends `ClientMsg open_worktree { path, backend, autonomous, remember }`.

The steering bar's refusal for a variation with no session now points at that card
("start one in the card above") instead of the variations menu.

**The now pill** also folds `ServerMsg now { worktree, text }`: while `text` is non-null it
is what the pill says for that branch (trimmed to the LAST 80 characters — the words
arriving are the ones worth reading), and `null` falls back to the last tool line. Live
lines keep ONE identity (`selectNow` returns `NowLine { key, text }`), so the words change
in place and read as typing instead of re-animating on every frame; a tool line's key is
its text, so a different tool really is a new line and rises in.
