# Shape

Builders don't look at code any more — they look at the *shape* of the product they are
building. Shape is that view: an agent-maintained, live picture of the system, rendered as
drillable bubbles. The agent declares the **intent** layer (what each part of the system
promises, in plain English) while it works; a **reality** layer is derived mechanically from
the code itself (workspace packages, the imports between them, the infrastructure its config
files prove, the checks that attest it); where the two disagree, **drift** is rendered on the
bubble instead of quietly rotting like a README diagram. To steer, you click a bubble or a
relation and speak — or type — one sentence. Selection is the referent, the sentence is the
requirement, and the running agent gets both as an addressed instruction.

![Shape canvas](docs/shape-canvas.png)

## Requirements

- **Node 26 or newer.** Shape has no build step for the bridge, the shared contract or the
  link: Node runs the TypeScript sources directly (`node src/index.ts`), which needs Node's
  built-in type stripping.
- **pnpm 11.** Pinned by `packageManager` in `package.json`, so `corepack enable` is enough
  to get the right version.
- **A coding harness**, one or both of:
  - `omp` — [oh-my-pi](https://github.com/can1357/oh-my-pi); Shape loads its own extension
    into the session.
  - `claude` — Claude Code; Shape wires it from the outside with an MCP server and hooks.
- **herdr — optional, recommended.** A terminal multiplexer: with it installed, the harness
  session runs in a tab of your own terminal, which you can look at and type into; without it
  Shape owns a pty and the browser renders the session for you.
- **`gh`, authenticated — optional.** Used by "start a new project → publish to GitHub" from
  the canvas, and by manager mode (see below).

## Quick start

```bash
git clone https://github.com/orrgal1/shape.git
cd shape
pnpm install
pnpm bridge -- --cwd <target-project>   # local mode: server + agent in one process
pnpm web                                # canvas dev server
```

Then open http://localhost:5173. The bridge points at one project at a time; `--cwd` may name
any worktree of it. Two URL variants run the canvas with no bridge at all, which is the
quickest way to see what it looks like: `?mock=1` renders a hand-built graph that exercises
every visual state, and `?mock=playground` renders
`packages/web/src/fixtures/playground.json`, a real agent-written document from a mock
project.

Canvas state is kept beside the harness, never in your repo: `~/.shape/shape.db`, one SQLite
file holding every project's canvas, its revisions and the project registry (`SHAPE_HOME`
moves the home directory, `--db <file>` names another database).

An existing repo is better mapped through the `visualize` skill than by hand — next section.

## Onboard an existing repo

Install the `visualize` skill once per machine, from this checkout:

```bash
ln -s "$PWD/skills/visualize" ~/.claude/skills/
```

Then, from any repo, say "onboard this repo to Shape". The skill starts (or reuses) the bridge
and web server, retargets the bridge at that repo, triggers the onboarding survey, and hands
back the canvas URL. See [`skills/visualize/SKILL.md`](skills/visualize/SKILL.md) for what it
does step by step, and [`docs/onboarding.md`](docs/onboarding.md) for the pipeline itself:
a mechanical package skeleton first, then an agent survey turn that must anchor every bubble
to real paths, then drift verification.

## Architecture

```
browser (Vite dev :5173)
   │  WebSocket  ws://127.0.0.1:4400/ws
   ▼
server half   packages/bridge/src/server/
   │  graph + revision store, steering composer, graph-discipline preamble,
   │  drift, activity, onboarding gate
   │  agent link: in-memory in local mode, ws://<host>:4400/agent when split
   ▼
agent half    packages/bridge/src/agent/
   │  harness detection, launcher (herdr tab | Shape's own pty), backend adapter
   │  per harness, reality extraction, worktrees
   ▼
harness  — a real interactive session in a real terminal, cwd = the worktree
   omp:     omp --extension packages/link/src/omp-extension.ts
   claude:  claude --mcp-config <the link's MCP server> --settings <the link's hooks>
   │  loopback link  ws://127.0.0.1:4400/link
   └───────────────────────────────► back up to the agent half
```

The agent half starts the harness the way a person would — a terminal in the worktree running
the harness's own interactive command — and the harness talks back over the loopback link.
Both integrations register exactly one tool, `canvas`, and the agent only ever mutates the
picture through it (`upsert_node`, `remove_node`, `upsert_edge`, `remove_edge`, `set_phase`):
the server validates each op, applies it, and broadcasts the whole document to every connected
browser. Steering is delivered as `steer` when the harness can accept mid-turn input and a
turn is streaming, otherwise as a fresh `prompt`, and the transcript says honestly when an
utterance is queued for the next turn.

Packages:

- `packages/bridge` — the Node process: both halves above, plus the WebSocket server on
  127.0.0.1:4400 and the SQLite graph/revision store. Also ships the `server`, `agent` and
  `login` CLIs for split mode.
- `packages/web` — Vite + React + React Flow canvas: layer policy, layout and motion, side
  panel, steering bar, project/worktree switcher, session pane.
- `packages/shared` — the contract both sides import: types, `applyOps` validation, the
  `canvas` tool schema, the WebSocket and link message shapes, and revision diffing.
  `packages/shared/src/index.ts` is the machine-readable form of `CONTRACTS.md` and wins on
  disagreement.
- `packages/link` — what runs *inside* the harness: the omp extension
  (`src/omp-extension.ts`, loaded by omp's Bun), the canvas tool as an MCP server
  (`src/mcp.ts`, for any harness that can load one), and a hook that reports agent activity
  (`src/hook.ts`, for a harness with no event stream).

Every bubble sits on one of **four layers**: `product` (the capabilities a person gets, no
file names), `build` (the parts that exist as code — the default), `infra` (where it runs and
what it leans on outside the code), `correctness` (what proves it works: tests, checks,
reviews, monitoring). Three links cross the layers: `realizes` on a capability, `hosts` on a
piece of infrastructure, `verifies` on a check. A `built` bubble nothing verifies is a claim,
and the canvas says so.

Intent, reality and drift are three different things, and keeping them apart is the point:

- **Intent** is written by the agent through the `canvas` tool — labels, summaries, phases,
  `codeRefs`, the cross-layer links.
- **Reality** is derived by the bridge from the checkout — workspace packages and the imports
  between them, infrastructure its configuration files prove, verifications its test and
  smoke files perform. Agent-read-only.
- **Drift** is the disagreement: a relation the code has that the picture doesn't, a
  `codeRef` pointing at a file or a named part that is gone, a package nothing claims. It is
  rendered on the bubble, not swept up.

Where state lives:

- `~/.shape/shape.db` — every project's canvas, revisions and the project registry. Projects
  are keyed per repo path, so a worktree keeps a canvas of its own.
- `~/.shape/recents.json` — recently targeted projects; `~/.shape/servers.json` — tokens
  saved by `pnpm login` (mode 0600).
- `<target>/.shape/config.json` — optional, and yours: which harness backend to use here.
- The bridge appends `.shape/` to the target repo's `.git/info/exclude`, so a project-local
  config never lands in a commit. Nothing else is written into the target project.

## Integrations

- **Harnesses.** `omp` and Claude Code are the two supported harnesses, each behind one
  adapter (`packages/bridge/src/agent/backend/`). Any other detected harness gets the generic
  adapter, which watches the session instead of talking to it.
- **herdr — optional launcher, recommended.** When herdr is installed and its socket answers,
  every session becomes a tab in your own terminal
  (`packages/bridge/src/agent/launcher/herdr.ts`) and Shape is plainly a layer over a normal
  workflow. Otherwise Shape's own pty carries the session and the browser renders it.
  `SHAPE_LAUNCHER=herdr|pty` forces the choice; a forced `herdr` that does not answer still
  falls back rather than leaving the agent unable to start anything.
- **The manager skill — optional adapter**, see below.
- **Dictation — nothing vendor-specific.** Selecting a bubble focuses the steering field;
  anything that types text there commits on Enter. Wispr Flow works, so does any other
  dictation tool, so does a keyboard. There is no dictation dependency in the code.

## Manager mode

Shape is meant to hand work off the canvas to the [manager
skill](https://github.com/orrgal1/manager-skill), which uses GitHub issues as the board and
runs one builder session per issue, each in its own herdr tab and its own git worktree: a
bubble you point at becomes an issue, and that issue becomes a session you can watch. It needs
`gh` installed and authenticated. The coupling is real work in progress, not a shipped
feature: finding or opening the manager tab when a project opens
([#3](https://github.com/orrgal1/shape/issues/3)), making in-flight builders and an existing
manager shape-aware ([#5](https://github.com/orrgal1/shape/issues/5)), dispatching canvas work
through the manager instead of Shape's own harness
([#6](https://github.com/orrgal1/shape/issues/6)) and the manager panel on the canvas — board,
quota, priority and cap ([#8](https://github.com/orrgal1/shape/issues/8)) are all still open.
Until they land, run the manager skill yourself and keep Shape as the picture beside it.

## Split and on-prem modes

The Shape server on one machine, an agent next to each harness and repo:

```bash
pnpm server -- --port 4400                                   # browsers on /ws, agents on /agent
pnpm agent -- --server ws://<server-host>:4400 --cwd <repo>  # reconnects, re-attaches; --link-port 4401 for MCP/hooks
```

On-prem — anything but loopback needs tokens:

```bash
pnpm server -- --host 0.0.0.0 --port 4400 --token-file tokens.json --data-dir /var/lib/shape
#   tokens.json: [{ "token": "<16+ chars>", "tenant": "acme" }, …]
pnpm login -- ws://<server-host>:4400 <token>                # stores it in ~/.shape/servers.json (0600)
pnpm agent -- --server ws://<server-host>:4400 --cwd <repo> [--allow-terminal]
```

Browsers open `http://<web-host>:5173/?server=<server-host>:4400&token=<token>` once; the
client keeps both in localStorage and strips them from the address bar. The canvas turns
read-only ("agent offline") while a project's agent is away and resumes when it re-attaches.
`CONTRACTS.md` has the wire; the smoke tests that exercise these modes are listed in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

Early, and dogfooded daily. The v1 slice works end to end:

- Greenfield: speak an idea → the agent decomposes it into bubbles → it builds, advancing
  each bubble's phase (`idea → concept → component → building → built | failed`) as it goes.
- Product first: the first words about an empty canvas become a bubble immediately, and the
  agent spends that turn naming the product and 3 to 5 promises under it, then stops for you
  to correct the picture before anything is built. Switchable off in the empty state.
- Onboarding an existing repo: mechanical package skeleton, then an agent survey turn anchored
  to real paths, then drift verification.
- Single-layer drill-down as the default view: one layer at a time, drill chip and breadcrumb,
  relations lifted to the nearest visible ancestors, liveness and drift bubbled up.
- Git worktrees as architecture variations, each with its own canvas state.
- Revision snapshots with compare: every accepted change bumps a revision, and any two
  revisions can be diffed.
- Start a new project from the canvas: folder + git + optional GitHub (public/private) in
  one form.
- Watch it work: the Canvas | Session switch (or Ctrl + backtick) shows the agent's session as
  it runs — what you asked, what it is saying, and one line per tool call. It is read-only,
  and a tab that opens it late is redrawn from the session so far. A harness with its own
  terminal shows that terminal instead.

Known rough edges: drift UX has only been exercised on synthetic drift, the reality extractor
covers pnpm/TypeScript monorepos (other stacks degrade to a pure agent survey), empty-state
copy can overlap reality ghosts, and manager mode is partly wired (above).

## Docs

- [`CONTRACTS.md`](CONTRACTS.md) — the authoritative cross-package contracts: topology, graph
  document, `canvas` tool, WebSocket and link protocols, drift, revisions.
  `packages/shared/src/index.ts` is its machine-readable form and wins on disagreement.
- [`docs/vision.md`](docs/vision.md) — the design document: what this is for and why it is
  shaped this way.
- [`docs/onboarding.md`](docs/onboarding.md) — the brownfield pipeline: mechanical skeleton,
  survey turn, verification.
- [`docs/research/`](docs/research/) — the background reading behind the canvas stack, the
  voice/canvas prior art, and dictation integration.
- [`docs/notes/`](docs/notes/) — historical session and idea-funnel notes, kept for
  archaeology and not maintained.
- [`skills/visualize/SKILL.md`](skills/visualize/SKILL.md) — the onboarding skill, step by
  step.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to run the checks and open a change.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — the ground rules.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md): dev setup, the smokes that stand in for a test
suite, the code conventions in force, and how to open an issue or a pull request.

Work happens on a branch in a git worktree, never on `main` directly — `main` moves only by
fast-forward, and a dirty primary checkout blocks everyone else's merge.

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
