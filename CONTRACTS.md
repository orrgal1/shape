# Cross-slice contracts (v1)

Settled 2026-08-28. `packages/shared/src/index.ts` is the machine-readable form of this
document; when they disagree, the TS file wins.

## Topology

```
browser (Vite dev :5173)
   │  WebSocket  ws://127.0.0.1:4400/ws
   ▼
bridge (Node 26, packages/bridge)  — graph store, steering composer, reality extractor
   │  JSONL over stdio (rpc.md protocol v1)
   ▼
omp --mode rpc   (spawned child, cwd = target project)
```

- Bridge spawns `omp --mode rpc` in the target project directory (`--cwd` flag, default
  `process.cwd()`).
- Bridge registers ONE host tool via `set_host_tools`: `canvas` (schema below). Tool calls
  arrive as `host_tool_call` frames; bridge validates + applies to the graph store, answers
  with `host_tool_result`, and broadcasts the new graph to browsers.
- Bridge sends the graph-discipline preamble (packages/bridge/src/preamble.ts) prepended to
  the FIRST user prompt of a session.
- Steering: browser sends an utterance + optional referent; bridge composes an addressed
  instruction and delivers it via `{type:"steer"}` when `get_state().isStreaming`, else
  `{type:"prompt"}`.
- RPC client: minimal hand-rolled JSONL client per omp rpc.md, protocol v1 only (no v2
  negotiation, no rpc_chunk handling — our frames are small). Do NOT depend on
  @oh-my-pi packages.
- The omp leg is ONE adapter behind the backend seam (§Backends): the bridge itself does
  not know omp's frames.

## Backends (seam, 2026-09-02)

Shape drives a coding-agent CLI by configuration; `omp` is the first adapter, not the
assumption. `packages/bridge/src/backend/types.ts` is the whole surface:

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

`bridgeUrl` is `ws://127.0.0.1:<port>/ws` of THIS bridge, so an adapter can point the link
(§The link) at it — an MCP server for the canvas, a hook for events. `resumeSessionId` is
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
summary required and ≤ 200 chars.

## WebSocket protocol (bridge ↔ browser)

Server → client (`ServerMsg`):
- `hello` — full `GraphDoc` + `SessionInfo` + `recentProjects: string[]` +
  `sessions: DiscoveredSession[]` on connect AND after every successful `switch_project` /
  `adopt` (retarget = fresh hello to all clients)
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
- `switch_project` — `{ path: string }` retarget the bridge: abort any running turn, dispose
  the backend, re-point at `path` (per-project graph persists at
  `<path>/.shape/graph.json`), re-extract reality, re-read config, start a fresh backend
  and retarget the terminal, broadcast
  `hello`. `~` expands; non-directory paths → `error` frame, current project untouched.
  Recents persist in `~/.shape/recents.json` (most-recent first, deduped, cap 10).
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

Terminal frames live in `packages/shared/src/pty.ts` (`PtyClientMsg` / `PtyServerMsg`) and
are merged into `ClientMsg` / `ServerMsg`; the bridge answers them from `PtyManager`
(`packages/bridge/src/pty.ts`) BEFORE any agent routing, so typing in the terminal never
queues behind a turn. One shared shell per bridge, retargeted on `switch_project`, so
`pty_data` is broadcast to every attached client. `BackendCapabilities.terminal` says
whether a pane is worth showing at all.

`SessionInfo` includes `targetHasCode: boolean` (bridge runs `extractReality` once at startup;
non-TS repos fall back to a cheap source-file scan). Client shows the "Map this project" CTA
when `targetHasCode` and `nodes.length === 0`. It also carries
`backend: { id, label, capabilities }` (§Backends) — the harness this session runs on,
re-derived on every `switch_project`.

`DiscoveredSession` (shared/) is one row of the bridge's `discoverSessions()`
(`packages/bridge/src/discover.ts`): `{ harness: "omp" | "claude" | "codex" | "opencode" |
"cursor", pid, command, cwd, sessionId, sessionFile, startedAt, resumeCommand, attach:
"socket" | "daemon" | "http" | "none", spawnedByShape }`. Rows with `spawnedByShape` are
excluded from the wire: those are Shape's own harness children, and adopting one is a loop.
`attach` records what a live process would offer (Claude Code's IPC socket, Codex's
app-server daemon, opencode's HTTP port); adopting today always starts a fresh harness for
that project and resumes the session by id rather than joining the running process.

## The link (external process ↔ bridge, 2026-09-02)

Anything that is not a browser speaks two extra frames on the same socket, defined in
`packages/shared/src/link.ts` and merged into `ClientMsg` / `ServerMsg`:

- `canvas_call` — `{ id, args }` a host-tool round trip carried over the socket. The bridge
  applies the ops and answers `canvas_result` `{ id, text, isError }` to THAT socket only
  (a canvas result is nobody else's business; the `graph` broadcast is the public part).
  This is how a harness that cannot host a tool for us still writes to the canvas — Shape
  ships an MCP server (`packages/link/src/mcp.ts`, tool `canvas`) that is just a caller.
- `agent_event` — `{ event: AgentEvent }` one already-projected harness event
  (`state` | `text` | `tool_start` | `tool_end` | `turn_end` | `session`). It feeds the SAME
  `BackendEvents` object the active backend uses, so an adapter with no native event stream
  (Claude Code's hooks, a transcript tail) lights up activity, transcript and agent state
  through the bridge's normal path.

Both are routed in `packages/bridge/src/external.ts` (`isLinkMsg` → `ExternalIo.handle`),
immediately after the terminal branch and before any agent routing. The link is trusted
exactly as much as the browser: the socket is bound to 127.0.0.1 and every frame was
validated in `ws.ts`.

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

Without referent: raw text, plus the trailing canvas reminder. Delivery: `steer` if
streaming else `prompt`.

## Activity mapping

Bridge derives `activity` from RPC events: on `tool_execution_start` for file-touching
tools, map the file path against intent nodes' `codeRefs` prefixes → those nodes are
"working" until `turn_end`. No agent cooperation required.

## Reality layer + drift (bridge)

Interface (fixed): `extractReality(cwd: string): Promise<RealityLayer>` and
`computeDrift(doc: Pick<GraphDoc,"nodes"|"edges">, reality: RealityLayer): DriftMap`
in `packages/bridge/src/reality.ts`. Zero new dependencies.

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
packages/bridge/src/snapshots.ts). One file per rev, never rewritten; retention keeps the
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
