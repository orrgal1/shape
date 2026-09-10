# The automatic map of an existing project (design, 2026-08-28; read-only since 2026-09-05,
# with the narrow #35 catch-up exception)

Brownfield entry: point Shape at a repo that already exists and get a trustworthy canvas
without anyone asking for one. Two mechanical stages fill the picture and a third verifies it.
The ordinary pipeline is not a prompt — Shape sends no instruction to an observed session; the
meaning on top of the skeleton is written by whatever session is working in the repo, in the
turns it spends on real work (§Where the meaning comes from). Issue #35 adds one bounded
catch-up run for a newly watched or reactivated project whose graph is missing or stale.

## Principle

The agent never invents the skeleton. Mechanics produce the graph; the model produces the
meaning; drift rendering verifies the result. Survey, not diary
(docs/notes/understand.md §self-report).

## Pipeline

### Stage 1 — reality extraction

The server asks the agent for `extract_reality` on the worktree of a session that has just
reported in, when that worktree has no reality yet, and again whenever a session in it goes
idle on a new `HEAD`. Reality is the mechanical layer: workspace packages, the imports between
them, the infrastructure the configuration files prove, the verifications the test and smoke
files perform, the top-level classes and functions of each file
(CONTRACTS.md §Reality layer + drift). It costs no model tokens and is agent-read-only.

### Stage 2 — mechanical skeleton (instant, zero model cost)

When a worktree's reality lands and its intent layer is EMPTY, the server asks the agent for
`synthesize_skeleton` (`packages/bridge/src/agent/onboarding-fs.ts`) and applies the ops
itself:

- one `component` node per workspace package: id `slug(pkgName)`, `phase: "built"`,
  `codeRefs: [pkgDir]`, label = short package name, summary = the package's `package.json`
  `description`, or a placeholder naming the directory when it has none.
- one `depends` intent edge per cross-package reality edge.

Level 1 = boundaries enforced by mechanism (workspace packages), per
docs/notes/understand.md's depth answer. The canvas fills with ground truth before any model
says a word, and it is deliberately FLAT: mechanics know packages, not domains. The room
records the seeding as one audit line (`kind: "onboard"`, with how many ops landed) and marks
the canvas as mapped, so a project is seeded once and a canvas somebody has drawn is never
overwritten.

### Stage 3 — verification render

Reality and drift are recomputed on the same trigger as extraction. Drift glow immediately
marks every bubble whose declared edges disagree with actual imports, whose `codeRefs` point
at a file or a named part that is gone, and every package no bubble claims — the
falsifiable-claim bar from docs/notes/understand.md, rendered instead of asserted. A reader
looking at a glowing bubble is looking at the part of the map that has gone stale; refreshing
it is work for a session in the terminal, not a button on the canvas.
## Catch-up synchronization (issue #35)

The automatic map remains mechanical and never starts or prompts an ordinary session. Catch-up
is separate: when a newly watched or reactivated worktree has no stored Shape graph, or its
surveyed head differs from the current extracted reality and `HEAD`, the project exposes
`CatchUpState` instead of claiming it is current. The state is `idle`, `queued`, `running` or
`failed`; a failure keeps its reason and timestamp visible. `catchUp` aggregates the worktree
states for the project, while `caughtUp` is true only for the aggregate `idle` state.

The server pins the current extracted reality and `HEAD`, then sends one correlated catch-up
request. Exactly one OMP synchronization run may start through herdr in the selected project's
workspace. It is unfocused and is not a general launcher: the run uses Shape's extension and
the fixed read-only invocation
`-p --no-session --no-extensions --mode=text --approval-mode=yolo
--tools=read,glob,grep,canvas -e <Shape extension> <prompt>`. No other harness, tool,
extension, focus action or interactive terminal is allowed, and a current graph launches
nothing.

Canvas writes carry the matching job id. Catch-up becomes `idle` only after that job's canvas
persistence is recorded at the pinned head; a missing or stale graph, a changed head, or any
launch, canvas or persistence failure remains visible as `failed` rather than being reported
as caught up. The browser receives progress and failure state, not a launch control. Picker
registration and ordinary observation sessions remain read-only: no ordinary browser or
session path can launch, prompt or focus a coding agent.

## Where the meaning comes from

An automatic skeleton says what the parts ARE, never what they promise or what the product
does. In an ordinary session, that half is written through the `canvas` tool while the session
works in the repo. The bounded #35 catch-up run may write the same intent layer under its fixed
prompt and Shape extension; it is not a general session or an onboarding mode. For ordinary
sessions, what is expected of them is stated in exactly two places:

- `CANVAS_TOOL_DESCRIPTION` (`packages/shared/src/index.ts`), the text every channel hands the
  agent: the four layers, the three cross-layer links (`realizes`, `hosts`, `verifies`), one
  product root with its 3–5 capabilities beneath it, plain English, `codeRefs` on anything that
  owns files, `status` for what is happening right now.
- the per-project directive, `~/.shape/server/projects/<key>/shape-directive.md`
  (`packages/bridge/src/agent/directive.ts`), which a session started by hand — or a builder
  brief the manager writes — can be pointed at. Catch-up's fixed prompt does not broaden the
  ordinary browser/session boundary.

The rules that must hold whatever the agent believes are enforced by `applyOps` for every
caller, not by an onboarding mode: layer walls, one top-level product bubble
(`op/second-root`), `realizes`/`hosts`/`verifies` only on their own layer and only onto build
nodes, `codeRefs` shape. See CONTRACTS.md §`canvas` tool. The altitude rule (3–5 bubbles per
layer, named parent groups beyond that, never a flat sprawl) is advice in the tool description
and a rendering cap in the client (CONTRACTS.md §Canvas navigation), not a validation error.

## Degradation and non-goals

- Non-pnpm/TS repos: the skeleton is empty, so the canvas starts blank and stays blank until an
  agent draws it; no drift verification until a per-language extractor exists. Accepted scope.
- No subagent fan-out per package (candidate for large monorepos later).
- Re-summarization after a commit delta: reality re-extraction keeps drift honest by itself, so
  a stale bubble is always visible. Rewording it is an ordinary piece of work for a session,
  asked for where sessions are asked for things — the terminal, or the manager beside it.
