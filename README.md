# Shape

Builders don't look at code any more — they look at the *shape* of the product they are
building. Shape is that view: an agent-maintained, live picture of the system, rendered as
drillable bubbles. The agent declares the **intent** layer (what each part of the system
promises, in plain English) while it works; a **reality** layer is derived mechanically from
the code itself (workspace packages and the imports between them); where the two disagree,
**drift** is rendered on the bubble instead of quietly rotting like a README diagram. To
steer, you click a bubble or a relation and speak — or type — one sentence. Selection is the
referent, the sentence is the requirement, and the running agent gets both as an addressed
instruction.

## Independence

Shape is standalone. Voice input is just text arriving in a focused input, so any dictation
tool works — selecting a bubble focuses the steering field, whatever puts text there commits
on Enter. There is nothing vendor-specific in the code: no dependency on a particular
dictation product (Wispr Flow or otherwise) and none on a workspace manager (herdr or
otherwise). The one thing Shape does need is a coding agent behind the bridge; today that is
the `omp` harness, spoken to over its RPC mode. Optional integrations may arrive later as
configurable adapters, never as dependencies.

## Status

Early, and dogfooded daily. The v1 slice works end to end:

- Greenfield: speak an idea → the agent decomposes it into bubbles → it builds, advancing
  each bubble's phase (`idea → concept → component → building → built | failed`) as it goes.
- Product first: the first words about an empty canvas become a bubble immediately, and the
  agent spends that turn naming the product and 3 to 5 promises under it, then stops for you
  to correct the picture before anything is built. Switchable off in the empty state.
- Onboarding an existing repo: mechanical package skeleton first, then an agent survey turn
  that must anchor every bubble to real paths, then drift verification.
- Single-layer drill-down as the default view: one layer at a time, drill chip and breadcrumb,
  relations lifted to the nearest visible ancestors, liveness and drift bubbled up.
- Git worktrees as architecture variations, each with its own canvas state.
- Revision snapshots with compare: every accepted change bumps a revision, and any two
  revisions can be diffed.
- Start a new project from the canvas: folder + git + optional GitHub (public/private) in
  one form.
- Watch it work: the Canvas | Session switch (or Ctrl + backtick) shows the agent's session
  as it runs — what you asked, what it is saying, and one line per tool call. It is read-only,
  and a tab that opens it late is redrawn from the session so far. A harness with its own
  terminal shows that terminal instead; one with neither gets a shell in the project.

Known rough edges: drift UX has only been exercised on synthetic drift, the reality extractor
covers pnpm/TypeScript monorepos (other stacks degrade to a pure agent survey), and empty-state
copy can overlap reality ghosts.

## How it works

```
browser (Vite dev :5173)
   │  WebSocket  ws://127.0.0.1:4400/ws
   ▼
bridge (Node 26)  — graph store, steering composer, reality extractor
   │  JSONL over stdio (omp rpc protocol v1)
   ▼
omp --mode rpc   (spawned child, cwd = target project)
```

The bridge spawns `omp --mode rpc` in the target project and registers exactly one host tool,
`canvas`. The agent mutates the picture only through that tool (`upsert_node`, `remove_node`,
`upsert_edge`, `remove_edge`, `set_phase`); the bridge validates each op, applies it, and
broadcasts the whole document to every connected browser. Steering is delivered as `steer`
while a turn is streaming, otherwise as a fresh `prompt`. Nothing is written into the target
project at all — the canvas lives in a database beside the harness, not in the repo:

- `~/.shape/shape.db` — every project's canvas, its revisions and the project registry, in
  one SQLite file (`SHAPE_HOME` moves the home dir; `--db <file>` names another database).
  Projects are keyed per repo path, so a worktree keeps a canvas of its own.
- `<target>/.shape/config.json` — optional, and yours: which harness backend to use here.
  A `graph.json` and `revisions/` left by an older Shape are imported into the database on
  the next attach, then moved aside under `.shape/imported/`.
- `~/.shape/recents.json` — recently targeted projects.
- The bridge appends `.shape/` to the repo's `.git/info/exclude`, so a project-local config
  never lands in a commit.

Packages:

- `packages/bridge` — Node process: omp RPC client, `canvas` host tool, graph + snapshot
  stores, steering composer, reality/drift extractor, WebSocket server on 127.0.0.1:4400.
- `packages/web` — Vite + React + React Flow canvas: layer policy, layout and motion, side
  panel, steering bar, project/worktree switcher, session pane.
- `packages/shared` — the contract both sides import: types, `applyOps` validation, the
  `canvas` tool schema, the WebSocket message shapes, and revision diffing.

## Requirements

- Node 26 (the bridge runs TypeScript sources directly).
- pnpm 11.6.
- The `omp` CLI on `PATH` — [oh-my-pi](https://github.com/can1357/oh-my-pi).

## Run

```bash
pnpm install
pnpm bridge -- --cwd <target-project>   # local mode: server + agent in one process
#   add --db <file> to keep the canvases somewhere other than ~/.shape/shape.db
pnpm web                                # canvas dev server
```

Then open http://localhost:5173. Append `?mock=1` to render a fixture graph without a bridge.

Split mode — the Shape server on one machine, an agent next to each harness/repo:

```bash
pnpm server -- --port 4400                                   # browsers on /ws, agents on /agent
pnpm agent -- --server ws://<server-host>:4400 --cwd <repo>  # reconnects, re-attaches; --link-port 4401 for MCP/hooks
```

On-prem (anything but loopback needs tokens):

```bash
pnpm server -- --host 0.0.0.0 --port 4400 --token-file tokens.json --data-dir /var/lib/shape
#   tokens.json: [{ "token": "<16+ chars>", "tenant": "acme" }, …]
pnpm login -- ws://<server-host>:4400 <token>                # stores it in ~/.shape/servers.json (0600)
pnpm agent -- --server ws://<server-host>:4400 --cwd <repo> [--allow-terminal]
```

Browsers open `http://<web-host>:5173/?server=<server-host>:4400&token=<token>` once; the
client keeps both in localStorage and strips them from the address bar. The canvas turns
read-only ("agent offline") while a project's agent is away and resumes when it re-attaches.
See `PLAN.md` for the deployment roadmap and `CONTRACTS.md` for the wire.

Smoke tests:

```bash
pnpm --filter @shape/bridge smoke   # protocol checks against a fake omp child (local mode)
pnpm smoke:remote                   # server + agent on separate ports, detach/re-attach, select_project
pnpm smoke:auth                     # tokens, tenants, bind guard, terminal gating, login, audit
pnpm smoke:shared                   # validation + revision-diff checks
```

## Onboard an existing repo

Install the `visualize` skill once per machine, from this checkout:

```bash
ln -s "$PWD/skills/visualize" ~/.claude/skills/
```

Then, from any repo, say "onboard this repo to Shape". The skill starts (or reuses) the bridge
and web server, retargets the bridge at that repo, triggers the onboarding survey, and hands
back the canvas URL. See `skills/visualize/SKILL.md` for what it does step by step.

## Docs

- `vision.md` — the design document: what this is for and why it is shaped this way.
- `CONTRACTS.md` — the authoritative cross-package contracts (topology, graph document,
  `canvas` tool, WebSocket protocol, drift, revisions). `packages/shared/src/index.ts` is its
  machine-readable form and wins on disagreement.
- `onboarding.md` — the brownfield pipeline: mechanical skeleton, survey turn, verification.
- `HANDOFF.md` — build log and current state, step by step.

## Third-party

- `packages/web/src/canvas/vendor/archify-geometry.ts` — geometry helpers (edge-anchor port
  spread, label placement, label/route clearance) vendored from
  [archify](https://github.com/tt-a1i/archify) @ `5de7275`
  (`renderers/shared/geometry.mjs`), ported to TypeScript. MIT; the upstream notice is kept
  verbatim at the top of the file.
- `packages/web/src/canvas/kind.tsx` — glyph path data adapted from the same project
  (`renderers/shared/utils.mjs`), MIT, attributed in the file header.

Runtime dependencies are declared in each package's `package.json`.

## License

MIT — see [LICENSE](LICENSE).
