# Plan: harness → Shape server → UI (local / on-prem / SaaS)

*Written 2026-09-03. Target topology per user vision. Supersedes §Topology of CONTRACTS.md
once Phase 1 lands; everything else in CONTRACTS.md (graph doc, canvas tool, steering
composition, drift, snapshots, navigation) is untouched by this plan.*

## The vision, as arrows

```
harness ──► Shape server (local | on-prem | SaaS) ──► UI
UI ──► steering utterance ──► Shape server ──► harness
```

Three roles. One protocol between the first two. The server never needs to be on the same
machine as the harness or the repo.

## Where we are (evidence)

`packages/bridge` is the whole server today, and it is local-only by construction:

| Concern | Today | Why it breaks the remote legs |
|---|---|---|
| Harness ownership | Bridge *spawns* the harness as a child (`omp.ts`, `claude.ts` via `Backend.start({cwd})`) | A remote server cannot spawn on the user's machine. The arrow is inverted: harness must connect *to* the server. |
| Steering outbound | `Bridge.#send` → `Backend.send(msg, mode)` on the spawned process (`index.ts:552`) | Link-connected harnesses have no inbound steer frame: `LinkServerMsg` is only `canvas_result` (`shared/src/link.ts:35`). |
| Filesystem / process | `extractReality(cwd)`, `git worktree list`, `discoverSessions()` (`ps`), `synthesizeSkeleton`/`onboardingOpGate` (fs + git index), `PtyManager` shell, `<target>/.shape/graph.json` + `revisions/` | All assume server and repo share a machine. |
| Tenancy / auth | One `Bridge`, one `#cwd`, one `#backend`, one `GraphStore`; socket bound to `127.0.0.1`; link "trusted exactly as much as the browser" | No project id on any frame, no identity, no isolation. |

What is already right and stays: the `Backend` seam (`backend/types.ts`), `BackendEvents` as
the single event sink, `applyOps`/`computeDrift`/`diffSnapshots` being pure, the browser
protocol (`ServerMsg`/`ClientMsg`), the link's `canvas_call`/`agent_event` shapes.

## Target architecture

```
┌──────────── user's machine ────────────┐        ┌────────── Shape server ──────────┐
│ harness (omp/claude/…)                 │        │  ProjectRoom[projectId]          │
│   │ native rpc | hooks | MCP           │  link  │    GraphStore + SnapshotStore     │
│   ▼                                    │  v2    │    steering composer, preamble    │
│ shape agent  (packages/agent)  ────────┼──ws───►│    drift, activity mapping        │──ws──► browsers
│   Backend adapter, spawn/adopt         │◄───────┤    onboarding orchestration       │
│   reality extract, worktrees, discover │        │  ProjectRegistry, Auth, Storage   │
│   pty, onboarding fs checks            │        └──────────────────────────────────┘
└────────────────────────────────────────┘
```

- **Agent** (`packages/agent`, today's `bridge/` minus the canvas): everything that needs
  the harness, the repo's filesystem, git, `ps`, or a tty. Connects *out* to a server URL.
  Keeps a loopback link endpoint for harness-side processes (`link/mcp.ts`, `link/hook.ts`)
  so those never need server credentials.
- **Server** (`packages/server`): everything canvas-shaped. Holds N `ProjectRoom`s; each
  room has at most one connected agent and any number of browsers. Never touches a repo.
- **Local mode** = agent + server in one process over an in-memory transport, same code
  paths, same `.shape/` files as today. `shape` with no args stays exactly this.
- **On-prem / SaaS** = `shape server` somewhere, `shape agent --server wss://… --token …` next
  to each harness, browsers at the server's URL.

The harness itself never speaks to the server. The adapter (agent) is the harness's proxy;
that is what "harness → server" means concretely for CLIs that own their own process.

### Ownership split (module by module)

| Module (today in `bridge/src`) | Goes to | Note |
|---|---|---|
| `backend/*` (omp, claude, config, types) | agent | unchanged API; `bridgeUrl` becomes the agent's loopback link URL |
| `discover.ts`, `worktrees.ts`, `reality.ts` `extractReality` | agent | results shipped as frames |
| `pty.ts` | agent | frames already exist; gated remotely (§Security) |
| `onboarding.ts` `hasSourceCode`, `synthesizeSkeleton`, `gitFileIndex`, path gate | agent | server asks via request frames |
| `external.ts` (link endpoint) | agent | harness-side callers hit the agent |
| `store.ts`, `snapshots.ts`, `steering.ts`, `preamble.ts`, `reality.ts` `computeDrift`, onboarding prompt composition, activity mapping | server | pure over `GraphDoc` + events |
| `recents.ts` | agent (local list of paths) + server (project registry) | recents are per machine; the registry is per tenant |
| `ws.ts` (browser hub) | server | plus a second listener for agents |
| `index.ts` `Bridge` | split: `ProjectRoom` (server) + `AgentRuntime` (agent) | the refactor in Phase 0 |

### Link v2 (agent ↔ server) — `packages/shared/src/link.ts`

Every frame after `attach` is implicitly scoped to the socket's project; the server never
trusts a project id in a frame body.

Agent → server:

- `attach` `{ token?, project: { key, label, cwd, harness, capabilities: BackendCapabilities, targetHasCode }, session: { sessionId, sessionName, model } }` — first frame. `key` is agent-derived and stable (`sha256(machineId + realpath(cwd))`); the server maps it to a `projectId` in the registry (creating one) and answers `attached { projectId }`. A second agent attaching to a room the first still holds is refused (`error`).
- `agent_event` — as today (`state | text | tool_start | tool_end | turn_end | session`).
- `canvas_call { id, args }` → `canvas_result` — as today; the agent forwards its harness's host-tool calls and its loopback link's calls through this.
- `reality { layer: RealityLayer, head }` — after each extraction (startup, post-turn on HEAD change).
- `worktrees { worktrees: WorktreeInfo[] }`, `sessions { sessions: DiscoveredSession[] }` — answers to server requests, also pushed on change.
- `delivered { id, mode: "prompt" | "steer", queued: boolean }` — receipt for `deliver`.
- `paths_result { id, missing: string[] }`, `skeleton_result { id, ops: CanvasOp[] }` — onboarding answers.
- `pty_data | pty_exit | pty_state` — as today.
- `detached { reason }` before a clean close; server marks the room agentless.

Server → agent:

- `attached { projectId }` / `error { message }`.
- `deliver { id, body, preamble: string | null }` — the composed utterance. **Delivery rule moves to the agent** because only it has live `Backend.state()`: `steer` iff `capabilities.steerMidTurn && streaming`; else `prompt`. It prepends `preamble` iff sending a fresh prompt and none has been sent this harness session (`#promptSent` becomes agent state). Server composes; agent delivers; `delivered` closes the loop and drives the transcript line "queued for the next turn".
- `abort`.
- `switch { path, backend?, resumeSessionId? }` — today's `switch_project`/`adopt` body; the agent re-targets, then sends a fresh `attach` (a switch is a new room from the server's view).
- `discover`, `extract_reality`, `list_worktrees` — requests.
- `file_index { id }`, `synthesize_skeleton { id }` — onboarding requests (fs lives with the agent). The agent answers `file_index` with every tracked file (or a bounded walk for a non-git target); the server builds a `FileIndex` (shared/src/fileindex.ts) from it ONCE per onboarding and the gate stays synchronous inside `applyCanvasCall`. (Replaces the per-call `check_paths` round trip first drafted here.)
- `pty_open | pty_input | pty_resize | pty_close` — as today.

Transport: WebSocket at `/agent` (distinct path from the browser's `/ws`), JSON frames,
same validation discipline as `ws.ts`. Local mode swaps in an in-memory `Transport`
implementing the same two-directional interface; no serialization in-process.

### Browser protocol changes (`ServerMsg`/`ClientMsg`)

Minimal and additive:

- `hello` gains `projects: ProjectSummary[]` (`{ projectId, label, cwd, harness, agentConnected, lastSeen }`) and `projectId`. `recentProjects` (paths) stays for local mode and is empty remotely.
- New `select_project { projectId }` — join a room. Remotely this replaces `switch_project`; locally the client sends `switch_project` (path) as today and the server forwards it as `switch` to the local agent.
- `SessionInfo` gains `agentConnected: boolean`; the canvas is read-only (steering input disabled with a reason) while it is false.
- Everything else unchanged. `graph`, `activity`, `transcript`, `delta`, `revisions` flow exactly as now, per room.

### Storage

`GraphStore`/`SnapshotStore` get a `Storage` interface: `{ loadGraph(projectId), saveGraph(projectId, doc), listRevisions, loadRevision, saveRevision, prune }`.

- `FsStorage(root)` — local mode keeps today's layout by resolving `root = <cwd>/.shape` per project (the agent tells the server the cwd; in-process it is the same machine). On-prem uses `SHAPE_DATA_DIR/<projectId>/`.
- `DbStorage` (SaaS) — Postgres/SQLite, same interface, one table per record type, JSON columns. Not in the first three phases.

Reality and drift are never stored (re-derivable), same as today.

### Identity, auth, tenancy

- **Local:** loopback, no auth, one implicit tenant. Nothing changes for today's user.
- **On-prem / SaaS:** server issues bearer tokens. `shape login <server>` stores one under `~/.shape/servers.json`; the agent sends it in `attach`; the browser sends it on the `/ws` upgrade (cookie or `Authorization`). One token ⇒ one tenant; rooms are per tenant. TLS is the reverse proxy's job; the server binds `0.0.0.0` only when `--token-file`/auth is configured, otherwise refuses to bind non-loopback.
- Users/orgs/roles: out of scope until SaaS phase; token = tenant is enough for on-prem.

### Security notes specific to the split

- **PTY over the network is remote shell.** Remote agents default `terminal: "none"` unless started with `--allow-terminal`; the server also refuses `pty_*` for rooms whose agent did not advertise it.
- **Link loopback stays local.** `link/mcp.ts` and `link/hook.ts` keep connecting to `127.0.0.1:<agent port>`; harness-spawned processes never hold server tokens.
- **Server never sees raw repo paths as authority.** `codeRefs` and `cwd` are labels; every fs check is a request to the agent that owns them.

## Phases

Each phase ships working software; the local experience never regresses.

### Phase 0 — In-process split (no wire change) — DONE 2026-09-03

Landed as directories inside `packages/bridge` (`src/server/`, `src/agent/`, joined only by
`shared/src/link.ts` + `src/transport.ts` + `src/index.ts`), not as separate packages: both
halves share `ws`, and the only dependency worth isolating (`node-pty`, agent-only) matters
at SaaS packaging time, not before. The loopback link moved from `/ws` to `/link`
(`LINK_WS_PATH`); local mode serves both paths on one port via `src/wsserver.ts`. The
preamble travels once in `attached`, not per `deliver`. All smokes pass unchanged in what
they assert (only endpoints and import paths moved).

Refactor `Bridge` into `ProjectRoom` (server side: store, snapshots, composer, preamble
decision, drift, activity, onboarding orchestration, browser hub) and `AgentRuntime` (agent
side: backend lifecycle, reality/worktrees/discover, pty, fs onboarding helpers, loopback
link), joined by a `Transport` pair with the Link v2 frame types as its vocabulary — but
implemented in-memory. Move the delivery rule and `#promptSent` into `AgentRuntime`.

Acceptance: existing smoke (`--omp` fake) and all bridge tests pass unchanged; `hello`,
steering, onboarding, switch/adopt, pty, revisions behave identically; no new deps.

### Phase 1 — Real transport, two binaries

- `packages/shared/src/link.ts` becomes Link v2 (frames above), validated in a shared
  `validateLinkFrame`.
- `packages/server`: `shape server --port --data-dir` — browser hub on `/ws`, agent listener
  on `/agent`, `ProjectRegistry` (in-memory + `FsStorage`), one `ProjectRoom` per attached agent.
- `packages/agent`: `shape agent --server <url> [--cwd] [--backend] [--allow-terminal]` —
  today's CLI flags, connects out, reconnects with backoff, re-`attach`es after reconnect.
- `shape` (no subcommand) = both in one process via the in-memory transport.
- Browser: `projects` in `hello`, `select_project`, read-only state when the agent is absent.

Acceptance: (a) `shape` unchanged for the local flow; (b) `shape server` on machine A,
`shape agent` on machine B (or two ports on one machine), browser on A: onboarding, click+
speak steer (`delivered` receipt visible in transcript), canvas updates from the harness,
revisions/diff, worktree switch; (c) kill the agent → canvas goes read-only with a reason,
restart → resumes without browser reload.

### Phase 2 — Multi-room and registry

Multiple agents per server, project picker in the client replacing the local recents pop-up
when remote, `lastSeen`/`agentConnected` per project, room GC (agentless rooms persist
graphs; nothing runs). `FsStorage` under `SHAPE_DATA_DIR`. Browser can watch a room whose
agent is gone (history/diff only).

Acceptance: two agents attached, two browsers each on a different room, no cross-talk in
`graph`/`transcript`/`pty_data`; restart the server → rooms reload from storage.

### Phase 3 — Auth for on-prem

Bearer tokens (`shape server --token-file`, `shape login`), tenant = token, non-loopback bind
refuses to start without auth, `pty_*` gating, structured audit log of steering deliveries
per room.

Acceptance: unauthenticated agent/browser rejected at upgrade; token A cannot see token B's
projects; terminal pane absent unless the agent allowed it.

### Phase 4 — SaaS

`DbStorage`, users/orgs on top of tokens, hosted web build served by the server, agent
auto-update channel. Designed but not scheduled; nothing in Phases 0–3 blocks it.

## Decisions taken in this plan (flag if you disagree)

1. **Delivery mode decided by the agent, composition by the server.** The alternative — a
   `state` round trip before every utterance — adds a network hop to the hottest path and
   still races the turn boundary. The receipt (`delivered`) keeps the server's transcript honest.
2. **Harness-side processes (MCP, hooks) talk to the agent, not the server.** Keeps
   credentials out of harness config files and keeps the link endpoint loopback-only.
3. **A switch is a new room.** Simplest model: rooms are keyed by (tenant, project key); the
   agent re-attaches. No "move an agent between rooms" op.
4. **Local mode keeps `<cwd>/.shape/` on disk.** No migration for existing projects; the
   storage abstraction is what lets on-prem/SaaS choose otherwise.
5. **Browser protocol stays; additive only.** The client work is a project picker and a
   read-only state, not a rewrite.

## Risks

- **Reconnect semantics.** An agent reconnecting mid-turn must not double-deliver; `deliver`
  ids are idempotent on the agent (dedupe last N ids) and the server re-sends only
  unacknowledged deliveries.
- **Onboarding round trips.** Resolved in Phase 0: the file index is fetched once when
  onboarding arms, so the gate stays synchronous; no per-call hop.
- **Clock/ordering.** `agent_event` and `canvas_call` share one socket, so per-agent order is
  preserved; cross-room order is irrelevant.
- **Latency on steer.** Browser→server→agent→harness adds one hop over today; well under the
  harness's own response time. Measured in Phase 1 acceptance.

## Non-goals

Multi-agent per room, collaborative multi-user editing of one canvas, harness-native
network protocols (we always go through the adapter), voice vendor integrations.
