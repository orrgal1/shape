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
   │  Backend adapter (spawn/adopt), reality extraction, worktrees, discover, pty, fs checks
   │  loopback link  ws://127.0.0.1:4400/link     LinkClientMsg / LinkServerMsg
   ▼                                               (MCP server, hooks — never the server)
harness  (omp --mode rpc child | claude TUI/headless | …)   cwd = target project
```

`packages/bridge/src/index.ts` is local mode: one `SocketServer` (`wsserver.ts`) mounting
`/ws` for the server half and `/link` for the agent half, joined by an in-memory link.
The two halves meet ONLY in `shared/src/link.ts` and `index.ts`; `server/` never imports
`agent/`.

- The agent spawns the harness in the target project directory (`--cwd`, default
  `process.cwd()`) and hands it `bridgeUrl` = the loopback link URL.
- The harness writes to the canvas through its adapter (`canvas` host tool via
  `set_host_tools` for omp) or the loopback link; either way the agent forwards
  `canvas_call { id, args }` to the server, which validates + applies to the graph store,
  answers `canvas_result`, and broadcasts the new graph to browsers.
- The server owns the graph-discipline preamble (`server/preamble.ts`) and hands it to the
  agent in `attached`; the agent prepends it to the FIRST fresh prompt of a harness session.
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
- Filesystem facts the server needs are requests over the link, answered by id:
  `list_worktrees`, `discover`, `file_index` (tracked files → the onboarding gate's
  `FileIndex`, shared/src/fileindex.ts), `synthesize_skeleton`, `extract_reality`.
- RPC client: minimal hand-rolled JSONL client per omp rpc.md, protocol v1 only (no v2
  negotiation, no rpc_chunk handling — our frames are small). Do NOT depend on
  @oh-my-pi packages.
- The omp leg is ONE adapter behind the backend seam (§Backends): nothing above the
  adapter knows omp's frames.

## Backends (seam, 2026-09-02)

Shape drives a coding-agent CLI by configuration; `omp` is the first adapter, not the
assumption. `packages/bridge/src/agent/backend/types.ts` is the whole surface:

```ts
interface Backend {
  readonly id: string; readonly label: string; readonly capabilities: BackendCapabilities;
  start(opts: { cwd, events: BackendEvents, canvasTool: { description, schema },
                resumeSessionId?: string, bridgeUrl: string }): Promise<void>;
  state(): Promise<BackendState>;                  // { streaming, sessionId, sessionName, model }
  send(message: string, mode: "prompt" | "steer"): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  terminal?(): TerminalSource | null;              // non-null ⇒ the pane shows the harness TUI
}
interface TerminalSource {
  write(data: string): void; resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void; onExit(cb: (code: number | null) => void): () => void;
}
```

`bridgeUrl` is `ws://127.0.0.1:<port>/link` — the AGENT's loopback link endpoint, never the
server — so an adapter can point the link
(§The loopback link) at it — an MCP server for the canvas, a hook for events. `resumeSessionId` is
passed only when an `adopt` named a session to continue; `capabilities.resume` says whether
the adapter can honor it. `terminal()` is the harness's own terminal surface: when it
returns non-null, `PtyManager.attach(source)` makes the terminal pane show that TUI instead
of a project shell (`pty_input`/`pty_resize` go to the source, `pty_close` is a no-op — the
agent is not closable from the pane), and the bridge calls `attach(null)` before disposing a
backend. `BackendEvents` also has an optional `onSession({ sessionId, model })` for
hook-driven adapters, whose session id reaches the bridge out of band rather than through
`state()`; the bridge merges it into `SessionInfo` and re-broadcasts `hello`.

The adapter owns everything harness-shaped: process spawn, frame decoding, coalescing text
deltas into whole assistant messages, projecting tool arguments into `{ name, paths, summary }`,
and the host-tool round trip. The bridge owns everything canvas-shaped: the graph store, the
preamble, `codeRefs` → activity mapping, the onboarding gate, and the steer-vs-prompt
decision. `BackendEvents.onCanvasCall(args)` is the one inbound call: the bridge applies the
ops and returns `{ text, isError }` for the adapter to hand back to the agent.

`BackendCapabilities` (shared/) is what the bridge and client branch on instead of sniffing
ids: `{ steerMidTurn, hostTool, events: "native" | "hooks" | "transcript" | "none", resume,
terminal: "tui" | "shell" | "none" }`. Delivery rule: `steer` when `steerMidTurn` AND
`state().streaming`, else `prompt` — and when a backend cannot be interrupted mid-turn, the
prompt still goes out and the transcript says it is queued for the next turn.

Config, lowest precedence first: built-in default (`omp`), `~/.shape/config.json`
(`SHAPE_HOME` overrides the home dir), `<target>/.shape/config.json`, then CLI `--backend <id>`,
then a per-call override (an `adopt` passes the harness id it discovered).
`--omp "<cmd ...>"` still replaces the omp adapter's command (smoke uses it). Shape:

```json
{ "backend": "omp", "backends": { "omp": { "command": ["omp"], "mode": "tui", "args": [], "permissionMode": "…" } } }
```

`command` is optional (absent ⇒ the adapter's default); `mode`, `args` and `permissionMode`
are adapter-specific passthrough, validated but not interpreted by the loader.

Missing files are fine; a malformed one is a startup error naming the file, and an unknown
backend id is a startup error listing the known ids. Config is re-read per project, so
`switch_project` disposes the backend and creates the one the new target asks for.
omp adapter: `omp --mode rpc` (`--mode rpc` appended when the configured command omits it),
`set_host_tools` for `canvas`, capabilities `{ steerMidTurn: true, hostTool: true,
events: "native", resume: true, terminal: "shell" }`. Resume is real: `--resume <id>` composes
with `--mode rpc` (verified against omp 18.1.2 — the resumed session's own id and message
count come back from `get_state`), and an explicit `--resume`/`-r` already on the configured
command wins over the adopted id.

## Graph document

Two layers in one doc. The agent writes ONLY the intent layer via the `canvas` tool.
The reality layer + drift are bridge-derived and agent-read-only.

Hierarchy is `parentId` (rendered client-side as tree/DAG expansion edges — user decision
2026-08-28; NOT nested containment). Edges are exclusively non-hierarchical relations —
never emit a "contains" edge.

See `GraphDoc`, `IntentNode`, `GraphEdge`, `RealityNode`, `RealityEdge` in shared/.

**Product and build layers (user decision 2026-09-03).** The intent layer itself is split
in two by `IntentNode.layer`: `"product"` bubbles are the capabilities a person gets,
`"build"` bubbles are the parts that exist as code. `layer` is ABSENT on build nodes —
absent means build, so every graph written before this decision is already a build graph,
and the canonical snapshot omits `layer` unless it is `"product"` (`layerOf(node)` in
shared/ is the only reader). Hierarchy and edges never cross layers, so each layer is a
self-contained graph; the one link is `realizes` on a product node: the ids of the build
nodes that make that capability real (≤ 20, existing build ids, no duplicates, sorted in
canonical form). `realizersOf(doc, productId)` reads it forward; `servesOf(doc, buildId)`
reads it back and inherits down the build hierarchy — a capability realized by a parent is
realized by its children. An upsert that omits `layer` leaves an existing bubble on the
layer it already had (only a brand-new bubble defaults to build), so a status refresh
cannot teleport a bubble across layers.

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

## `canvas` tool (agent → bridge)

JSON-Schema in shared/ (`CANVAS_TOOL_SCHEMA`); args = `{ ops: CanvasOp[], note?: string }`.

Ops: `upsert_node`, `remove_node` (rejected if node has children), `upsert_edge`,
`remove_edge`, `set_phase`. Batch-applied atomically per op (per-op accept/reject, not
all-or-nothing). Tool result text: `applied N op(s); rev=R` plus one line per rejected op
with reason — the agent self-corrects from this.

Validation (shared `applyOps`): slug ids `^[a-z0-9][a-z0-9-]*$` (edges also allow `--`),
parent must exist, no parent cycles, edge endpoints must exist, labels ≤ 60 chars,
summary required and ≤ 200 chars (the boundary test applies to both layers).
Layer walls, with structured receipts in the same shape as the rest:
- `op/cross-layer-parent` — `parentId` must be on the same layer as the node.
- `op/cross-layer-edge` — both edge endpoints must be on the same layer.
- `op/bad-realizes` — `realizes` only on product nodes; every id must exist and be a build
  node; no duplicates; ≤ 20.
- `op/node-realized` — a build node still named in some product node's `realizes` can
  neither be removed nor flipped onto the product layer (fix: update that `realizes`
  first). Product nodes may be removed freely.
- `op/second-root` — the product layer has one top-level bubble; a product node upserted at
  `parentId: null` while another top-level product node exists is rejected, the receipt
  naming that root so the fix (`parentId` = root id) is mechanical. Checked after
  `op/node-realized`, so a still-realized build node flipped to product hears about the
  dangling link first.

`codeRefs` are allowed on product nodes and validated no differently (the onboarding gate,
not `applyOps`, is where product nodes stop being expected to own files).

## WebSocket protocol (bridge ↔ browser)

Server → client (`ServerMsg`):
- `hello` — full `GraphDoc` + `SessionInfo` + `recentProjects: string[]` +
  `sessions: DiscoveredSession[]` + `projects: ProjectSummary[]` (every project this server
  hosts, newest `lastSeen` first) + `projectId` (the room this socket is joined to) on
  connect AND after every successful `switch_project` / `adopt` (retarget = fresh hello to
  the room's clients) AND when an agent re-attaches to an agentless room
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
- `pty_data` / `pty_exit` / `pty_state` — terminal output and lifecycle (see below)

Client → server (`ClientMsg`):
- `utterance` — `{ referent: { kind: "node" | "edge", id: string } | null, text: string }`
- `onboard` — `{ focus?: string }` map an existing project (see onboarding.md); valid only
  while the intent layer is empty
- `switch_project` — `{ path: string }` ask THIS project's agent to retarget: abort any
  running turn, dispose the backend, re-point at `path` (per-project graph persists at
  `<path>/.shape/graph.json`), re-extract reality, re-read config, start a fresh backend
  and retarget the terminal, then `attach` again — a new project key opens a new room, and
  the browsers joined to the old room FOLLOW the agent (the old room stays, agentless).
  `~` expands; non-directory paths → `error` frame, current project untouched.
  Recents persist in `~/.shape/recents.json` on the agent's machine (most-recent first,
  deduped, cap 10).
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
  "no Shape adapter for <harness> yet". A `.shape/graph.json` with nodes in that project
  loads as usual; otherwise the client shows its "Map this project" CTA — that is the
  bootstrap path for an adopted project.

**Agentless rooms.** A room outlives its agent (link closed, agent switched away). While
`session.agentConnected` is false the server refuses `utterance`, `onboard`,
`switch_project`, `adopt`, `discover` and `abort` with `error`
"no agent is attached to this project — start `shape agent` in it", drops `pty_*` silently,
and still serves `diff`. A `deliver` the agent never receipted is re-sent when it re-attaches
(the agent dedupes by id: one backend send, identical receipt). A second agent attaching to
a key whose agent is still connected is refused with "project already has an attached
agent" and its link closed.

Terminal frames live in `packages/shared/src/pty.ts` (`PtyClientMsg` / `PtyServerMsg`) and
are merged into `ClientMsg` / `ServerMsg`; the server forwards them to the agent's `PtyManager`
(`packages/bridge/src/agent/pty.ts`) BEFORE any agent routing, so typing in the terminal never
queues behind a turn. One shared shell per bridge, retargeted on `switch_project`, so
`pty_data` is broadcast to every attached client. `BackendCapabilities.terminal` says
whether a pane is worth showing at all.

`SessionInfo` includes `targetHasCode: boolean` (bridge runs `extractReality` once at startup;
non-TS repos fall back to a cheap source-file scan). Client shows the "Map this project" CTA
when `targetHasCode` and `nodes.length === 0`. It also carries
`backend: { id, label, capabilities }` (§Backends) — the harness this session runs on,
re-derived on every `switch_project`.

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

- `canvas_call` — `{ id, args }` a host-tool round trip carried over the socket. The agent
  forwards it to the server, which applies the ops; `canvas_result` `{ id, text, isError }`
  comes back to THAT socket only (a canvas result is nobody else's business; the `graph`
  broadcast is the public part). This is how a harness that cannot host a tool for us still
  writes to the canvas — Shape ships an MCP server (`packages/link/src/mcp.ts`, tool
  `canvas`) that is just a caller.
- `agent_event` — `{ event: AgentEvent }` one already-projected harness event
  (`state` | `text` | `tool_start` | `tool_end` | `turn_end` | `session`). It feeds the SAME
  `BackendEvents` sink the active backend uses, so an adapter with no native event stream
  (Claude Code's hooks, a transcript tail) lights up activity, transcript and agent state
  through the normal path.

A frame the agent cannot parse is answered `error { message: "unparseable client message" }`
on that socket. The loopback link stays local by design: harness-side processes never hold
server credentials, and the endpoint is bound to 127.0.0.1. `SHAPE_BRIDGE_URL` overrides the
default `ws://127.0.0.1:4400/link` for both link processes.

## The agent link (agent ↔ server, 2026-09-03)

`AgentToServerMsg` / `ServerToAgentMsg` in `packages/shared/src/link.ts` is the ONLY
contract between `packages/bridge/src/agent/` and `packages/bridge/src/server/`; the doc
comments there are normative. Carried by `packages/bridge/src/transport.ts` (`ServerEnd` /
`AgentEnd`; `memoryLinkPair()` in local mode). Every frame after `attach` is scoped to its
link; the server never trusts a project id inside a frame body.

## Worktrees (user decision 2026-08-28: toggle first, compare later)

Each git worktree of the target's repo is an architecture variation with its own canvas
state (its own `<worktree>/.shape/graph.json`). `SessionInfo.worktrees` carries
`{ path, branch, head, current }[]` from `git worktree list --porcelain`, re-detected on
every hello; empty for non-git targets (client hides the switcher). Toggling a worktree IS
`switch_project` to its path — full clean retarget, no separate message. The bridge appends
`.shape/` to the repo's `.git/info/exclude` (shared common dir → covers every
worktree) so canvas state never leaks between branches via a commit. Side-by-side /
comparative views of two worktrees' GraphDocs are deferred by design.

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

**Product view (client, user decision 2026-09-03):** the header carries a `PRODUCT | BUILD`
toggle and the store keeps a `view: Layer` (default product when the doc has any product
node). All of the above — one layer at a time, edge lifting, liveness bubbling, the 5-bubble
cap — runs unchanged over the nodes of the current view only; focus and selection are kept
per view. Drilling across is the `realizes` link: a product bubble shows a "built by N" chip
that switches to the build view with focus `__realizes__:<productId>` (breadcrumb
`<label> › built by`), a synthetic layer of exactly that capability's realizing build nodes,
flat even when they sit at different depths; going back restores the product view with that
bubble selected. The side panel of a build node lists its `servesOf` product bubbles, which
jump the other way. Product bubbles roll up their realizers' activity/drift/failure, and a
product node past `concept` with no realizers renders as **unrealized** — nothing on the
build side makes it real yet. Client-only derivation; no wire changes.

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

## Activity mapping

Bridge derives `activity` from RPC events: on `tool_execution_start` for file-touching
tools, map the file path against intent nodes' `codeRefs` prefixes → those nodes are
"working" until `turn_end`. No agent cooperation required.

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

## Voice capture (web, v1)

Selecting a node/edge focuses a visible steering input; any dictation tool (or the
keyboard) types into it; Enter commits → `utterance`. No vendor-specific integration;
no mic/WebSpeech in v1.

## Revision snapshots + delta

Every accepted change bumps `rev`; the bridge then persists a canonical snapshot of the
intent layer at `<target>/.shape/revisions/<rev>.json` (`SnapshotStore` in
packages/bridge/src/server/snapshots.ts). One file per rev, never rewritten; retention keeps the
newest 50 and prunes the rest. Snapshots hold nodes + edges only — reality and drift are
re-derivable, so they stay out.

`packages/shared/src/delta.ts` is the whole comparison: `snapshotGraph` writes the canonical
form (nodes/edges sorted by id, stable key order, undefined optionals omitted, `codeRefs`
sorted), `canonicalJson` gives it a byte-stable string, and `diffSnapshots(a, b)` is a pure
`GraphDelta` — `a` is before, `b` is after, keyed by id, `changed` = same id whose canonical
form differs. No I/O, so the client can diff too.

Wire: `hello` carries `revisions: RevisionInfo[]` (ascending), and a `revisions` frame is
broadcast whenever a new snapshot lands. The client asks with `diff` `{ revA, revB }` and the
bridge broadcasts `delta` `{ delta }`; an unknown rev answers with the usual `error` frame.

## Storage (server, 2026-09-03)

`packages/bridge/src/server/storage.ts` decides where a room's `graph.json` and
`revisions/` live: `Storage { dirFor(project), listProjects(), saveProject(row) }`.
- `projectDirStorage()` — local mode (`pnpm bridge`): `<cwd>/.shape/`, no registry.
- `dataDirStorage(root)` — `shape server --data-dir` (default `~/.shape/server`, `SHAPE_HOME`
  honored): `<root>/projects/<projectId>/` per room and `<root>/projects.json`, an atomically
  written array of `StoredProject { project: AgentProject, session, worktrees, lastSeen }`
  rows upserted after every attach and detach. At startup the server restores each row as an
  agentless room (`[bridge] restored N project(s) from <root>`), so a browser is greeted
  read-only immediately and agents re-bind on reconnect. A corrupt registry is skipped with
  `[bridge] ignoring unparseable <path>`, never fatal.
