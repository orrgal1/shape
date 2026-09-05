# Cross-slice contracts (v1)

Settled 2026-08-28. `packages/shared/src/index.ts` is the machine-readable form of this
document; when they disagree, the TS file wins.

**Read-only since 2026-09-05.** Shape shows; it does not drive. The browser cannot instruct,
start, stop or type into an agent, and the bridge never launches a harness and never sends one
a prompt. Sessions report in on their own and the canvas draws them. Every frame, seam and
launcher that existed to carry an instruction is gone, not disabled — where this document still
describes one, this document is wrong.

## Topology (split 2026-09-03, docs/notes/PLAN.md Phase 0)

```
browser (Vite dev :5173)
   │  WebSocket  ws://127.0.0.1:4400/ws     ServerMsg out, a read-only ClientMsg in
   ▼
SERVER half   packages/bridge/src/server/   ProjectRoom + ShapeServer
   │  graph store, snapshots, drift, activity, the automatic map
   │  agent link: AgentToServerMsg / ServerToAgentMsg (shared/src/link.ts)
   │  local mode = memoryLinkPair() in one process; remote = WebSocket /agent (Phase 1)
   ▼
AGENT half    packages/bridge/src/agent/    AgentRuntime
   │  detection (what is installed), the project's manager tab under herdr,
   │  reality extraction, worktrees, discover, fs checks
   │  loopback link  ws://127.0.0.1:4400/link     LinkClientMsg / LinkServerMsg
   ▲                                               (omp extension, MCP server, hooks, CLI)
harness  (a REAL session in a REAL terminal someone else started: omp with the Shape
          extension, claude, anything that can call the link)   cwd = the worktree
```

`packages/bridge/src/index.ts` is local mode: one `SocketServer` (`wsserver.ts`) mounting
`/ws` for the server half and `/link` for the agent half, joined by an in-memory link.
The two halves meet ONLY in `shared/src/link.ts` and `index.ts`; `server/` never imports
`agent/`.

- Sessions are OBSERVED, never started. A harness that dials the loopback link — the omp
  extension inside omp, the link's MCP server or hook beside Claude Code, the link CLI from
  anything else — becomes the session of the worktree its `cwd` resolves to, and the agent
  registers it the first time it speaks (§Sessions are observed). One session per worktree; a
  worktree with nothing running is a normal state and the canvas says so rather than offering
  to fix it.
- The harness writes to the canvas through the loopback link and the agent forwards
  `canvas_call { id, args }` to the server, which validates + applies to the graph store,
  answers `canvas_result`, and broadcasts the new graph to browsers. That is the only path
  into the document, and it runs one way: no frame the browser sends reaches a session.
- What the agent is expected to write onto the canvas is carried by the session's own
  integration — `CANVAS_TOOL_DESCRIPTION` on the tool it registers, and the per-project
  directive file the agent writes on every project open
  (`packages/bridge/src/agent/directive.ts`) for a session started by hand. The server hands
  out no preamble and composes no prompt.
- Attach: the agent sends `attach` (project key = sha256(hostname:realpath(git common dir)),
  label, cwd, tools, targetHasCode, worktrees, sessions, realities, discovered, recents) once
  the project is open, with whatever sessions have already greeted — usually none. A second
  `attach` on the same link is a retarget (`switch_project` / `adopt` completed): the server
  persists the old store, opens the new project's, and re-hellos every browser.
- Filesystem facts the server needs are requests over the link, answered by id:
  `list_worktrees`, `discover`, `synthesize_skeleton`, `extract_reality`.
- Going to the terminal: `focus_terminal { worktree }` server → agent → the herdr agent whose
  cwd is that worktree is focused and its terminal window raised (§Views and the terminal). No
  herdr, no terminal: the session reports `terminal: "none"` and the browser offers nothing.
- The one thing left behind a seam is herdr (§Sessions are observed): nothing above it knows
  herdr's socket, and nothing anywhere knows how to start a harness, because nothing does.

## Sessions are observed (2026-09-05, issue #26)

Shape does not run coding agents; it watches them. There is no `Backend` seam, no adapter per
harness, no `Launcher.launch`, no pty and no per-project harness choice —
`agent/backend/`, `agent/launcher/pty.ts`, `agent/pty.ts`, `agent/newproject.ts`,
`shared/src/pty.ts` and the `--backend` / `--omp` / `--allow-terminal` flags are deleted.
Three parts are left: what is installed, what is running, and how to get to a terminal.

**Detection** — `packages/bridge/src/agent/detect.ts`. `detectTools()` walks PATH in process
(no `which` subprocess) for the launcher (`herdr`) and every harness Shape knows by name —
`omp`, `claude`, `codex`, `opencode`, `gemini`, `cursor-agent`, `amp`, `copilot`, the
`HarnessId` union in shared/ — then asks each one that was FOUND for `--version` with a 3 s
ceiling. A tool that will not say its version is a detected tool all the same
(`version: null`). Every entry is a `ToolInfo { id, label, path, version }` whose `label` is
plain English as the tool calls itself ("oh-my-pi", "Claude Code", "Codex", "Gemini CLI",
"Cursor Agent", "GitHub Copilot CLI"). `ProjectTools { launcher, launchers[], harnesses[] }`
is what travels: `attach.project.tools` to the server, `hello.tools` to the browser,
project-wide because one agent process sees one PATH. `launcher` is `"herdr"` or `null` — it
says where a session's terminal can be reached, not what Shape would start — and it is
re-detected on `discover`, since somebody hitting "look again" is often hoping to find a tool
they just installed. The list is inventory the browser shows; nothing branches on it to decide
what to run, because nothing runs anything.

**Observed sessions** — `packages/bridge/src/agent/runtime.ts`. The agent keeps one `Observed`
record per worktree in `#sessions`, created LAZILY the first time a loopback caller from that
worktree speaks: a `hello`, a `canvas_call`, or an `agent_event`. The record is
`{ worktree (the realpath of the directory, which is also its cwd), events (its `AgentEvents`
sink, bound to that worktree for the record's life), harness: string | null (what it called
itself in `hello`, null while only hooks or the MCP sidecar have spoken), hostTool: boolean (a
canvas call really arrived, or the `hello` said the tool is registered), session, state }` —
nothing about launching, no pty, no autonomy flag. Registering it posts
`session_started { worktree, session, backend }`; a `bye`, or the socket closing, posts
`session_stopped { worktree, reason }` and drops it. A `hello` fills in the session id, the
session file, the model and the capabilities; a caller that never says `hello` still gets a
record, because something IS working in that directory and the canvas would otherwise show
nothing. The event sink is `AgentEvents` (`agent/external.ts`): `onAgentState`,
`onAssistantText`, `onTextDelta`, `onToolStart`, `onToolEnd`, `onTurnEnd`, `onSession`, all
required — no `onCanvasCall`, because a canvas call is forwarded, not delivered to an adapter.

`BackendInfo` for an observed session is derived, not configured:

- `id` / `label` — `hello.harness` (a free string: a session may be a kind Shape has no name
  for), or `"unknown"` / `"agent"` when nothing greeted.
- `capabilities.steerMidTurn` — always `false`. Nothing is ever sent into a turn.
- `capabilities.hostTool` — what the `hello` said, and `true` regardless once a `canvas_call`
  has arrived: a session that has written to the canvas plainly has the tool.
- `capabilities.events` — `"native"` when a `hello` announced the session, `"hooks"` when the
  events arrive without one.
- `capabilities.resume` — `false`. Resuming was a launch argument.
- `capabilities.terminal` — `"external"` when this agent has a herdr, `"none"` when it does
  not. Derived per session from a project-wide fact, so in practice every session of a project
  answers the same. The union has two members now; `"pane"` went with the pty.

`attach.project.backend` is the FIRST observed session's `BackendInfo`, and null until one has
reported in.

A stale `delivered` receipt from a harness running an older build of the link is routed
nowhere and answered with nothing: it was the receipt for an instruction Shape no longer
sends, and refusing it would put an error in the transcript of a session that did nothing
wrong.

**herdr** — `packages/bridge/src/agent/launcher/herdr.ts`, a direct client of herdr's socket
(newline JSON over `HERDR_SOCKET_PATH` ?? `~/.config/herdr/herdr.sock`). Verified against
herdr 0.8.0, whose server gives a connection ONE exchange: a plain request is answered with a
single line and then the server hangs up (a request it refuses at validation time comes back
with `id: ""`), so every call — `session.snapshot`, `workspace.*`, `tab.*`, `agent.*` — opens
its own connection, resolves on the FIRST response line on it, and treats the close that
follows as the end of the exchange; a close BEFORE the answer is the failure. The client
asserts `session.snapshot`'s `protocol` is 19 and otherwise logs and refuses rather than
guessing at a protocol it does not know. `herdr status` is shelled out once first to autospawn
the server — skipped when `HERDR_SOCKET_PATH` is set, because an operator or a test who named
a socket owns what is listening on it. What is left of the client is what a read-only Shape
needs: probe/connect, `workspaceOf` (the project's workspace by cached id, then by
`worktree.repo_root` / `checkout_path`, then by label), `tabs()`, `agents()`, `closeTab`,
`open` + `prompt` for the MANAGER tab only (§`SessionInfo.manager`), focus-by-cwd for
`focus_terminal`, and `dispose`. `launch()`, `Launched`, `type`, `interrupt`, `kill` and the
pty fallback are gone. `SHAPE_LAUNCHER` is no longer a choice between two launchers:
`herdr` forces the probe even when herdr was not found on PATH, `none` skips it, an unknown
value logs and falls through to ordinary detection — the launcher is herdr when it answers and
`null` when it does not.

**Test knobs** (read in both local and remote mode): `SHAPE_FORCE_HARNESSES="omp,claude"`
replaces the detected harnesses with stubs (empty string = none detected) and
`SHAPE_FORCE_LAUNCHERS` does the same for launchers; `HERDR_SOCKET_PATH` points the client at
`scripts/fake-herdr.mjs`; `SHAPE_MANAGER=0` skips the manager pass; `SHAPE_PICK_FOLDER` stands
in for the machine's folder chooser; `SHAPE_TERMINAL_APP` and `SHAPE_OPEN` stand in for the
window raise (§Views and the terminal). `SHAPE_LINK` is the only variable Shape now WRITES for
a harness — the manager tab's environment and `mgr config env` carry it, and the harness-side
processes read it. `SHAPE_WORKTREE` is gone with the launch env that used to set it; a frame
says which worktree it is about by its `cwd`.

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
loud in two places. (1) The canvas tool receipt: `applyCanvasCall` appends a
`{"warnings": [...]}` JSON block after the rejections block (or alone when there are none),
one `OpRejection` per gap with `severity: "warning"` and `code: "link/<gap>"`
(`link/unrealized`, `link/hosts-nothing`, …), `subject.path` = `/ops/<i>/node/realizes`,
`/hosts` or `/verifies` for the link the bubble owes itself and `/ops/<i>/node` for a
build-side gap, `subject.id` + `subject.label`, `evidence: { gap }`, and 1–3 plain-English
`supportedFixes` naming the link to write. They are computed AFTER the ops apply, only for the
bubbles the call touched, and never for a call that applied nothing; the room passes
`{ linkWarnings: false }` for the skeleton it seeds itself, whose bubbles owe no cross-layer
link yet. `isError` is unaffected: a warning is not a refusal and the op it names has landed.
`CanvasToolOutcome.warnings` carries the same list for anything else that wants it. (2) The
web draws it: a bubble carries `data-gaps`, and the side panel has a "not connected"
block listing each gap with what closes it; `unrealized` keeps the rendering it already had,
and the web's `UNREALIZED_PHASES` moved to shared as `LINKED_PHASES`.

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
"now" is worse than none). The side panel renders status; the canvas tool description asks the
agent to keep it fresh on nodes it is actively working.

**Register (user decision 2026-08-28): plain English, no jargon.** Every label, summary,
status, edge label, and note the agent writes onto the canvas is read by a non-programmer
reading the picture, not a programmer reading code. Everyday words; say what a thing does for the
system in terms of outcomes, not mechanisms. No acronyms, protocol/library/file-format
names, or code identifiers unless the bubble is literally about that thing. A smart
non-programmer must understand every sentence. `codeRefs` stay technical (they are machine
addresses, rendered as such). Stated in the canvas tool description and the per-project
directive — not mechanically validated.

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

`codeRefs` are allowed on product nodes and validated no differently: a capability owns no
files of its own, and `applyOps` has never required any.

`next` (optional, top level, never an op) is accepted and validated but read by nothing:
`applyCanvasCall` runs shared `parseNext` over it AFTER the ops have applied, reports a
malformed one as a receipt, and then DROPS it — it is not on the outcome, not rendered, never
sent back to a session in any form, and not in `GraphDoc`, a snapshot or a diff.
It stays in the contract so that a session written against the old tool description
keeps working unchanged; a session may equally omit it. Bounds are unchanged: `summary`
non-empty and ≤ 200 chars, 0–4 `choices`, `label` non-empty and ≤ 40 chars, `say` non-empty,
`question` a string or null (absent, null and blank all read as null). A malformed one is one
receipt, `op/bad-next` at `index: -1` and `subject.path: "/next"`, alongside whatever the ops
earned — the ops still land.

## WebSocket protocol (bridge ↔ browser)

Per-worktree fields (`worktree` on most frames, `hello.graphs`/`revisions`/`agents`) landed
2026-09-03 — see §Worktrees on one canvas, which wins wherever this section still reads as one
graph per project.

Server → client (`ServerMsg`):
- `hello` — full `GraphDoc` + `SessionInfo` + `recentProjects: string[]` +
  `sessions: DiscoveredSession[]` + `projects: ProjectSummary[]` (every project this server
  hosts, newest `lastSeen` first) + `projectId` (the room this socket is joined to) +
  `tools: ProjectTools` (§Sessions are observed: what is installed where the agent runs, and
  whether a terminal can be reached) on connect AND after every successful `switch_project` / `adopt`
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
- `error` — `{ message }`
- `sessions` — `{ sessions: DiscoveredSession[] }` answer to `discover` (broadcast)
- `now` — `{ worktree, text: string | null }` the sentence being written right now, folded
  from the harness's `text_delta` events: at most one frame every 150 ms, the last ≤ 120
  characters, and `null` at the end of a turn (and when the session stops). Never stored,
  never a transcript line — the `text` that follows is the message of record.

Client → server (`ClientMsg`):
- `focus_terminal` — `{ worktree }` take the user to the terminal that session runs in: the
  herdr agent whose cwd is that worktree is focused and its window raised (§Views and the
  terminal). Refused when that variation has no session, and refused with "there is no
  terminal to go to on <variation>" when its `capabilities.terminal` is `none`. It is the only
  `ClientMsg` that reaches the agent's side of a session at all, and it moves a window — it
  says nothing to the agent.
- `switch_project` — `{ path: string }` ask THIS project's agent to retarget: re-point at
  `path` (its graph is its own record, keyed by project — see §Storage), re-extract reality,
  find or open that project's manager tab, then `attach` again with whatever sessions have
  greeted there — a new project key opens a new room, and
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
  only. Agent (`runtime.ts #pickFolder`, killed on teardown):
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
- `select_project` — `{ projectId }` join another room this server hosts; answered with that
  room's `hello` to this socket only. Unknown id → `error` "unknown project <id>".
- `discover` — re-scan this machine for running agent sessions; answered with a `sessions`
  broadcast. The scan is `ps` plus a walk of each harness's session store (~150 ms), so the
  bridge also runs it inside every `hello` rather than making the client ask first.
- `adopt` — `{ pid: number }` look at the project a session someone else started is working
  in. The pid is resolved in a FRESH scan (the client's list is as old as its last hello) and
  it is then exactly a `switch_project` to that session's `cwd`: Shape retargets onto the
  repo and draws it. Nothing is launched and nothing is resumed — if that session is
  Shape-aware it dials the link itself and appears as a session of its worktree; if it is
  not, the canvas shows the project without it. Unknown pid → `error` "adopt rejected: no
  running agent session with pid <n>"; unreadable cwd → `error` naming the pid. A stored
  graph with nodes for that project loads as usual; otherwise the automatic map seeds one
  (§The automatic map).

**Agentless rooms.** A room outlives its agent (link closed, agent switched away). While
`session.agentConnected` is false the server refuses `switch_project`, `pick_folder`,
`adopt`, `discover` and `focus_terminal` with `error`
"no agent is attached to this project — start `shape agent` in it", and still serves `diff`
and every read. A second agent attaching to a key whose agent is still connected is refused
with "project already has an attached agent" and its link closed.

There are no terminal frames: `packages/shared/src/pty.ts` is deleted and neither `ClientMsg`
nor `ServerMsg` carries terminal output, input or geometry. `BackendCapabilities.terminal`
says only whether the session's own terminal can be REACHED — `"external"` when the agent has
a herdr, so `focus_terminal` can bring that tab forward, and `"none"` when it cannot, which
hides the action in the browser (§Views and the terminal).

`SessionInfo` includes `targetHasCode: boolean` (bridge runs `extractReality` once at startup;
non-TS repos fall back to a cheap source-file scan). There is nothing to click on an empty
canvas any more — the map seeds itself — so the flag is what the empty state reads to tell
"there is code here, the picture is coming" from "there is nothing here yet". It also carries
`backend: { id, label, capabilities }` (§Sessions are observed) — what that session says it
is, re-derived on every `switch_project`.

`SessionInfo.directivePath: string | null` — absolute path on the agent's machine of
`<SHAPE_HOME|~>/.shape/server/projects/<projectKey>/shape-directive.md`, the per-project
directive the agent writes on every project open (what Shape is, this project's link URL,
`CANVAS_TOOL_DESCRIPTION` verbatim, and the `packages/link/src/cli.ts` fallback). Null when
the write failed — the directive is a convenience, never fatal. Travels on `AgentProject`
too, so a launcher reading the registry can point a builder's brief at it; absent or empty
on the wire parses as `null`.

`SessionInfo.manager: ManagerHandle | null` — `{ paneId, tabId, workspaceId, agentName,
origin: "found" | "opened", shapeAware }`, the project's manager session in the user's herdr
as the agent found or opened it (`packages/bridge/src/agent/manager.ts`). Null when the
project's launcher is not herdr, or when the manager could not be reached — a project open
never fails over a manager. Travels on `AgentProject` too, so a stored registry row
remembers the manager the last attach saw; absent, or present without a whole handle,
parses as `null` on both ends (`linkframes.ts` `parseManager`, `packages/web/src/parse.ts`
`asManagerHandle`). The header shows it as the `manager` pill: `attached` for `found`,
`opened` for `opened`, a dimmed `none` otherwise.

`DiscoveredSession` (shared/) is one row of the bridge's `discoverSessions()`
(`packages/bridge/src/agent/discover.ts`): `{ harness: "omp" | "claude" | "codex" | "opencode" |
"cursor", pid, command, cwd, sessionId, sessionFile, startedAt, resumeCommand, attach:
"socket" | "daemon" | "http" | "none" }`. Every row travels: Shape starts no harness, so
there is no such thing as one of its own children to filter out. `attach` records what a live
process would offer (Claude Code's IPC socket, Codex's app-server daemon, opencode's HTTP
port) and is inventory only — adopting a row retargets Shape onto that session's repo and
joins nothing.

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
  `AgentEvents` sink every session uses, so an integration with no native event stream
  (Claude Code's hooks, a transcript tail) lights up activity, transcript and agent state
  through the normal path.

`cwd` is REQUIRED on both and is how the frame finds its session: Shape watches one per
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
`error { message: "unparseable client message" }` on that socket. A cwd OUTSIDE the repo is
refused with the reason: an `error` frame, or for `canvas_call` a `canvas_result` with
`isError: true`, because the harness is BLOCKED on that tool result and has to hear why. A
cwd inside the repo with no session record yet does not refuse — it CREATES the record
(§Sessions are observed): a caller from a worktree of this project is a session Shape has not
met, not an error. The loopback link stays local by design: harness-side
processes never hold server credentials, and the endpoint is bound to 127.0.0.1.
`SHAPE_BRIDGE_URL` overrides the default `ws://127.0.0.1:4400/link` for both link processes.

## Loopback link v2 (the harness itself on the link, 2026-09-04)

A harness that can run Shape's own code inside itself — omp, through
`packages/link/src/omp-extension.ts` — is not "something next to the harness": it IS the
session. Three client frames and three server frames were defined here when Shape still drove
a session; the type union still carries all six (`packages/shared/src/link.ts` is untouched
until [#27](https://github.com/orrgal1/shape/issues/27)), but the bridge now sends none of the
three server frames and reads only two of the client ones. Every client frame still carries
`cwd`, and is still refused without one.

Client → agent:

- `hello` — `{ cwd, harness, sessionId, sessionFile, model, capabilities: { steer, tool } }`,
  the FIRST frame of a session-bearing client. `harness` is a free string, not the closed
  `Harness` union: a launcher can host kinds Shape has no adapter for. `sessionId` /
  `sessionFile` / `model` are `null` while the harness has not resolved them. `capabilities`
  is what the session says it can do — both flags are REQUIRED, since a session that will not
  say what it can do is not one Shape can describe; `steer` is recorded and never acted on.
  Hooks and the MCP sidecar never send one: they forward, they have no session to announce.
- `delivered` — `{ cwd, id, mode, queued }`, the receipt an older link build still sends for a
  `deliver`. Shape sends no `deliver`, so this receipt answers nothing: it is routed nowhere
  and provokes no error, because a session running yesterday's extension did nothing wrong.
- `bye` — `{ cwd, reason }`, the session is going away (the user quit the TUI, the harness
  exited). The reason is what the user reads.

Agent → client: NOTHING. `deliver`, `abort` and `autonomous` are still in `LinkServerMsg`
(above) and the agent never emits one; the only frames it puts on a session's socket are
`canvas_result` and `error`. A session therefore cannot be prompted, interrupted or handed
autonomy by Shape at all.

`AgentEvent` gains two kinds. `text_delta` `{ delta }` is one fragment of the message being
written right now: NEVER stored — the room folds it into the live "now" line and the `text`
that follows is the message of record, so an adapter with no streaming surface simply does
not take them (`AgentEvents.onTextDelta` takes a fragment and may ignore it). `session` gains an optional
`sessionFile`, because only a harness that logs to disk has one to name; absent and `null`
are the same answer and the validator normalizes to `null`.

Two fakes stand in for the real thing in the smokes, both plain Node with no deps.
`packages/bridge/scripts/fake-omp-tui.mjs` is a harness ON the link: `SHAPE_LINK` (ws url,
required), `SHAPE_WORKTREE` (the `cwd` every frame carries, default `process.cwd()`),
`FAKE_OMP_LOG` (JSONL of every frame with a `__dir` of `out`/`in`, plus `__start`/`__exit`
markers, default `<cwd>/fake-omp.log`), `FAKE_OMP_TURN_HOLD_MS` (hold a turn open so a test
can watch a session mid-turn), `FAKE_OMP_SESSION_DIR`, and `--resume <id>` echoed as
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
`omp --extension <abs path>` with `SHAPE_LINK` (the only variable it reads; frames are keyed
by `ctx.cwd`) — omp has no external
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
mid-turn or idle otherwise, `session_shutdown`→`bye`. Its inbound half — `deliver` as
`pi.sendUserMessage`, `abort` as `ctx.abort()`, `autonomous` as a permissive `tool_call`
handler — is code with no caller: Shape sends none of those frames, and
[#27](https://github.com/orrgal1/shape/issues/27) removes it from the link package.
`pnpm --filter @shape/link run selftest:omp` drives the real extension against a stub `pi`
and a real socket (frames per event, the canvas round trip, reconnect).

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
- Agent → server: `session_started { worktree, session, backend }` and
  `session_stopped { worktree, reason }` — both unsolicited, because a session is observed
  rather than asked for — and `worktree` on `agent_event`, `canvas_call`, `reality` and
  `skeleton_result`. `worktrees`, `sessions`, `recents`, `agent_error`, `agent_exit` and
  `detached` stay project-wide.
- Server → agent: `worktree` on `extract_reality`, `synthesize_skeleton` and
  `focus_terminal`. There is no frame that starts a session, stops one, or says anything to
  one. `switch` and `adopt` mean "retarget the WHOLE agent" — see **Agent runtime** below.

**Browser wire** (`ServerMsg` / `ClientMsg`, validated in `packages/bridge/src/server/ws.ts`).
- `hello` carries `graphs: Record<worktreeId, GraphDoc>`,
  `revisions: Record<worktreeId, RevisionInfo[]>`, `agents: Record<worktreeId, AgentState>`
  and the usual `session`, `projects`, `projectId`, `recentProjects`, `sessions`
  (discovered). The single `graph`/`agent`/`revisions` are gone.
- `SessionInfo` is `{ cwd (main worktree), targetHasCode, worktrees, sessions:
  WorktreeSession[], agentConnected, directivePath, manager }`; `sessionId`/`sessionName`/`model`/
  `backend` moved into `sessions`, one per worktree.
- Server → browser: `worktree` on `graph`, `agent`, `activity`, `transcript`, `revisions`,
  `delta` and `now`; `session_started { worktree, session, backend }` and
  `session_stopped { worktree, reason }`. `session`, `projects`, `sessions` and `error`
  stay project-wide.
- Browser → server: `worktree` on `diff` and `focus_terminal`. Nothing else in `ClientMsg`
  is about one variation, because nothing else acts on one.

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
keeps `#sessions`, a `Map<worktreeId, Observed>` of the sessions that have reported in
(§Sessions are observed). The project key is
`sha256(hostname():realpath(git common dir))` — every worktree of a repo agrees on the
common dir, which is what puts them on one canvas — and `realpath(cwd)` for a non-git
target, which is still reported as exactly one `WorktreeInfo` so a session never names a
worktree the browser has not seen. `project.cwd` is the main worktree: the first entry of
`git worktree list --porcelain`, which is the one owning the common dir. Every path the
agent reports is a realpath, never the spelling the frame asked for.

- ONE `AgentEvents` sink per session, bound to its worktree for the record's life:
  everything it emits is stamped with that worktree, and the loopback link feeds the sink
  of the worktree its caller's cwd resolved to.
- A harness record appears when a loopback caller from that worktree first speaks — a
  `hello`, a `canvas_call`, or an `agent_event` — and is dropped on `bye` or when its socket
  closes; `session_started` / `session_stopped` follow. `attach` therefore carries whatever
  has already greeted, which at startup is usually nothing: an agent with no sessions is the
  normal resting state, not a failure, and a session leaving is a `session_stopped` and
  nothing else. The runtime never posts `agent_exit`; the frame stays in the wire union, and
  the agent process outlives every session it watches.
- SAME-REPO RULE: `switch` and `adopt` resolve their path first. Inside the current repo
  there is nothing to start, so it refreshes the worktree list and stops there — no
  retarget, no re-`attach`. Another repo is the real switch: the project is opened, its
  manager tab is attached, and the agent re-`attach`es.
- Per worktree: reality re-extraction on its own HEAD change when a session in it goes idle,
  and `synthesize_skeleton` / `extract_reality`, which work on a worktree with no session
  just as well — a directory is a directory.

### The merged view (web, 2026-09-03)

The browser never switches between variations; it reads them as one canvas.
- STORE: `graphs: Record<worktreeId, GraphDoc>`, `agents`, `activity` and `revisions` are all
  worktree-keyed; transcript entries carry their `worktree`. `doc` is the
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
- TARGET: the frames that are about one variation (`diff`, `focus_terminal`) carry it.
  `selectTarget` = the reader's pinned pick while it is on screen, else the only filtered
  variation with a session, else the filtered variation that lit the selected bubble most
  recently, else the main worktree, else the first shown. Nothing pins it deliberately any
  more except a variation's own "terminal" action, which sets it as a side effect; it decides
  which variation the header's harness pill, "Go to terminal", the revision/diff picker and
  the side panel's harness block speak for.
- DRAWING: one pip per variation holding a bubble (colour `--wt-0…5` by id order, hollow
  where that copy differs), one activity ring per variation working in it, one "now" line
  per working variation prefixed with its branch, the header variations pill as the filter
  (checkbox, colour swatch, branch name and a live dot reading "working here" / "no session"
  per variation, plus "show every variation", and a "terminal" row where that variation's
  session reports `terminal: "external"`), and a "where" section on a selected bubble listing
  each variation's phase and status WHEN THEY DISAGREE. Revisions and comparison are the
  target variation's.
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
a layer (breadcrumb "more parts"); no part of the system stands behind it, so what it says is
what it holds.
Edges touching a folded node lift onto the more-bubble (self-lifts dropped, merged parallels keep
their count badge) and liveness/drift/`failed` bubbling counts folded nodes. Edge labels are
hidden until an endpoint bubble or the edge itself is selected or hovered; strokes always show.
This cap is a SAFETY NET, not the structure: the agent is asked to keep 3–5 bubbles per layer
and to introduce named parent bubbles when there are more real parts
(`CANVAS_TOOL_DESCRIPTION`), and that grouping is the real structure. No wire changes; the
fold is pure rendering.

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

## The automatic map (server, 2026-09-03; mechanical only since 2026-09-05)

Nothing asks for a map and nothing is prompted to produce one. `autoMap` in
`packages/bridge/src/server/room.ts` is two mechanical steps over frames the room already
has:

1. A session starting in a worktree whose reality has never been extracted ⇒
   `extract_reality { worktree }`.
2. Reality landing on a worktree whose intent layer is EMPTY ⇒
   `synthesize_skeleton { worktree }`. The ops come back as `skeleton_result` and the room
   applies them ITSELF through `store.applyCanvasCall`, so they snapshot, persist and
   broadcast exactly like an agent's own call. Link-gap warnings are dropped — a mechanical
   skeleton owes no cross-layer links yet — the room appends one audit line
   `{ kind: "onboard", ops }`, and the canvas is marked mapped, so a project is seeded once
   and never over a canvas somebody has already drawn.

The skeleton is `synthesizeSkeleton` in `packages/bridge/src/agent/onboarding-fs.ts`: one
`component` node per workspace package (id `slug(pkgName)`, `phase: "built"`,
`codeRefs: [pkgDir]`, label = the short package name, summary = the package's own
`description` or a placeholder naming its directory) plus one `depends` intent edge per
cross-package reality edge. Deliberately flat: mechanics know packages, not domains.

There is no survey turn, no survey prompt, no file index and no onboarding validation mode.
What the agent is expected to write — four layers, three cross-layer links, one product root
with its capabilities, plain English, `codeRefs` on anything that owns files — is stated in
`CANVAS_TOOL_DESCRIPTION` and in the per-project directive
(`packages/bridge/src/agent/directive.ts`), both read by the session itself; the rules that
must hold whoever the caller is are `applyOps`' own (§`canvas` tool). See
docs/onboarding.md.

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
  overridable with `--db <file>`. Nothing is written into the repo and nothing in it is read as
  configuration; the only thing Shape still looks for there is a canvas an older Shape left
  under `.shape/` (the one-shot import below).
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
unparseable project row <tenant>/<key>`, never fatal. One kind of audit entry is left,
`{ at, tenant, projectId, worktree, kind: "onboard", ops }` — the room's own record of the
mechanical skeleton it seeded onto an empty canvas, and how many ops landed; a failed append
is logged once as `[bridge] audit write failed: <message>` and never fails the seeding.

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

## Views and the terminal (web, 2026-09-04; read-only since 2026-09-05)

Shape is a picture of sessions running in real terminals, so the browser has exactly ONE
view — the canvas — and one way over to where a session actually runs. There is no terminal
in the client: no drawer, no xterm, no pty frames, and no way to type into a session from a
browser at all.

**Go to terminal** (`App.tsx` `TerminalButton`, header). About the TARGET variation, because
that is the session a person means while looking at this canvas. It reads
`capabilities.terminal` of that variation's session:

- no session there ⇒ shown DISABLED ("nothing is running on `<branch>` yet"). The door is
  visible before there is anything to go through it to.
- `"none"` ⇒ hidden entirely: no herdr where the agent runs, or a herdr whose window Shape
  cannot raise (not macOS, or no herdr client of this machine runs inside a `.app` — ssh,
  tmux, a bare console). The launcher decides this at probe time and logs
  `herdr's terminal window cannot be raised from here (<why>) — "Go to terminal" is not
  offered`.
- `"external"` ⇒ click sends `ClientMsg focus_terminal { worktree }`. The agent finds the
  herdr agent whose cwd is that worktree (`agents()` + `tabs()`, the same matching
  `manager.ts` does), focuses it — `agent.focus`, with `tab.focus` as the fallback, since a
  pane whose harness exited is still the right thing to show — and THEN brings the terminal
  application forward: the herdr client's parent chain is walked
  (`ps -axo pid,ppid,command`) to the first `/…​.app/Contents/MacOS/` ancestor
  (`terminalAppOf`, `isHerdrClient`: argv0 basename `herdr` whose first argument is not
  `server`/`api`/`status`) and raised with `open <bundle>`. `SHAPE_TERMINAL_APP` names the
  bundle outright; `SHAPE_OPEN` replaces the `open` binary (smokes set `true`). No herdr
  agent in that worktree is an `agent_error` naming the branch, and so is a raise that fails
  after one re-probe ("herdr's tab is focused, but its terminal window could not be brought
  forward: …"). NOTHING changes on this screen, so the click says so — a 2-second notice,
  "opened in your terminal" (`store.notify` / `.notice` in `StageTools`,
  `NOTICE_TTL_MS = 2000`).

The same action is a row in the variations menu, per RUNNING variation whose terminal is not
`"none"`. It sets the target to that variation first: reading one branch while jumping to
another branch's terminal is how a person loses track of which checkout they are looking at.

**The now pill** also folds `ServerMsg now { worktree, text }`: while `text` is non-null it
is what the pill says for that branch (trimmed to the LAST 80 characters — the words
arriving are the ones worth reading), and `null` falls back to the last tool line. Live
lines keep ONE identity (`selectNow` returns `NowLine { key, text }`), so the words change
in place and read as typing instead of re-animating on every frame; a tool line's key is
its text, so a different tool really is a new line and rises in.
