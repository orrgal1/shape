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
- `hello` — full `GraphDoc` + `SessionInfo` + `recentProjects: string[]` on connect AND
  after every successful `switch_project` (retarget = fresh hello to all clients)
- `graph` — full `GraphDoc` after every change (graphs are small; no patch protocol in v1)
- `agent` — `{ state: "idle" | "streaming" | "compacting" }`
- `activity` — `{ nodeIds: string[] }` currently-working intent nodes (pulse rendering)
- `transcript` — `{ role, text }` appended lines for the side panel (assistant text deltas
  coalesced per message_end; tool lines summarized)
- `error` — `{ message }`

Client → server (`ClientMsg`):
- `utterance` — `{ referent: { kind: "node" | "edge", id: string } | null, text: string }`
- `onboard` — `{ focus?: string }` map an existing project (see onboarding.md); valid only
  while the intent layer is empty
- `switch_project` — `{ path: string }` retarget the bridge: abort any running turn, dispose
  the omp child, re-point at `path` (per-project graph persists at
  `<path>/.shape/graph.json`), re-extract reality, spawn a fresh omp, broadcast
  `hello`. `~` expands; non-directory paths → `error` frame, current project untouched.
  Recents persist in `~/.shape/recents.json` (most-recent first, deduped, cap 10).
- `abort`

`SessionInfo` includes `targetHasCode: boolean` (bridge runs `extractReality` once at startup;
non-TS repos fall back to a cheap source-file scan). Client shows the "Map this project" CTA
when `targetHasCode` and `nodes.length === 0`.

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
Drift rule v1: an intent node whose `codeRefs` map into package P gets a drift note for
every reality edge P→Q with no corresponding intent edge (and vice versa for declared
intent `depends` edges with no reality counterpart once both ends are `building`+).

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
