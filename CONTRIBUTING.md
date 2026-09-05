# Contributing to Shape

Start with the [README](README.md) for what Shape is and how the pieces fit; the
[architecture section](README.md#architecture) is the map this document assumes you have read.
Security problems do not belong in a pull request or a public issue — see [SECURITY.md](SECURITY.md).
Everyone taking part is covered by the [code of conduct](CODE_OF_CONDUCT.md).

Shape is a small project. The point of the rules below is that a change can be verified by
someone who did not write it, on a laptop, in a few minutes.

## Dev setup

Node 26 and pnpm 11. The version is pinned in two places and both are authoritative:
`.nvmrc` (`26`) and `packageManager` in the root `package.json` (`pnpm@11.6.0`).

```sh
nvm use                          # or any tool that reads .nvmrc
corepack enable                  # pnpm comes from packageManager, do not install it globally
pnpm install --frozen-lockfile   # the lockfile is the source of truth; a diff in it is a review item
```

Two processes, two terminals:

```sh
pnpm bridge   # the bridge: canvas host tool, session observation, graph store, WebSocket on 127.0.0.1:4400
pnpm web      # the canvas: Vite dev server on http://127.0.0.1:5173
```

The bridge starts nothing: it watches. `pnpm bridge` runs with no harness installed, and the
canvas fills in as sessions in that repo report in over the link. For work on the canvas itself
you do not need a session at all: open
<http://127.0.0.1:5173/?mock=1> and the web app runs with no bridge at all, on a hand-built graph
that exercises every visual state (`packages/web/src/mock.ts`). `?mock=1&empty=1` is the
brownfield entry state (code present, intent layer empty), and `?mock=playground` is a frozen
real graph kept as the layout regression target (`packages/web/src/fixtures/playground.ts`).
The mock badge in the header is deliberately loud: the sample graph is fiction and has been
mistaken for a real project's architecture.

## Branches and worktrees

`main` is never worked on directly. Every change lives on a topic branch in its own git
worktree, so several changes — and several agent sessions — can be in flight without sharing a
working tree:

```sh
git worktree add -b <topic> ../shape-<topic> main
cd ../shape-<topic>
pnpm install --frozen-lockfile
```

To land: merge `main` into your branch, re-run the checks on the merged tip, and only then move
`main` forward by fast-forward.

```sh
git merge main            # in the worktree
pnpm typecheck && pnpm smoke:shared && pnpm smoke:wire   # plus whatever your change touches
git -C ../shape merge --ff-only <topic>
git worktree remove ../shape-<topic>
```

A merge commit on `main` is not wanted here; the fast-forward rule keeps the history a readable
sequence of branches. Commit as you go on the branch — do not leave a worktree with
uncommitted work in it.

## Checks

Shape has no unit test framework. The smokes *are* the test suite: each one runs real code —
usually the real bridge — against a fake harness or a fixture, and asserts the contract other
parts of the tree depend on. Read the header comment of the script before changing what it
covers; each says what it asserts and why.

| Command | What it proves | Time |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit` for every package that has a `typecheck` script — bridge, link and web; each of their tsconfigs also compiles `packages/shared/src` | ~5s |
| `pnpm smoke:shared` | `applyOps`, the layer walls, verification rules and symbol refs, in-process | ~2s |
| `pnpm smoke:wire` | every wire frame in both directions, the SQLite store and its migrations, and the fakes themselves | ~3s |
| `pnpm --filter @shape/bridge smoke:drift` | `computeDrift` against a frozen real graph — pure, no sockets | ~2s |
| `pnpm --filter @shape/link selftest:omp` | the real omp extension against a real WebSocket server and a stub `pi` (runs under Bun when Bun is installed, Node otherwise) | ~5s |
| `pnpm smoke:link-cli` | the link CLI and the omp extension produce indistinguishable canvas calls, each through its own real bridge | ~3s |
| `pnpm --filter @shape/bridge smoke` | the real bridge against `fake-omp-tui.mjs` — a fake omp that dials the link on its own and shows up as an observed session — driven over WebSocket; also the automatic map (reality extraction + skeleton seeding) | ~20s |

All seven are what CI runs on every push and pull request. Four more are local-only by nature:

| Command | Why it is not in CI |
| --- | --- |
| `pnpm smoke:remote` | runs `server-cli` and `agent-cli` as separate processes on real TCP ports |
| `pnpm smoke:auth` | same, plus `login-cli`, two tenants and real token files |
| `pnpm smoke:herdr` | models a herdr terminal tab over a unix socket (`fake-herdr.mjs`): the manager tab and `focus_terminal` |
| `pnpm --filter @shape/bridge smoke:adopt` | scans the *real* agent sessions running on your machine, so its result depends on what you happen to have open |

Run `smoke:remote` and `smoke:auth` locally before a PR that touches split mode or auth;
`smoke:herdr` before one that touches the herdr client; `smoke:adopt` before one that touches
discovery or adopt. The full local set, on a laptop, is under two minutes.

## Code conventions

These are in force, not aspirations — the tree is consistent about them today.

- **TypeScript is run, not built.** The bridge, shared and link packages have no build step:
  `node src/index.ts`. Imports therefore carry the real extension (`../../shared/src/index.ts`),
  and the tsconfigs set `allowImportingTsExtensions` with `noEmit`. Only the web package is
  bundled, by Vite. Do not add a build step to escape a type error.
- **`packages/link/src/omp-extension.ts` must stay Bun-loadable.** omp loads extensions with
  Bun, straight from the checkout, so that file uses the global `WebSocket` and imports nothing
  from `node:` and nothing from `node_modules`. Keep it that way; `selftest:omp` runs it under
  Bun when Bun is present.
- **No new dependencies without a reason in the PR body.** The bridge stores graphs in
  `node:sqlite` and speaks WebSocket through `ws`; that is close to the whole dependency budget.
  Say what the dependency does that the platform cannot.
- **Comments explain why, not what.** A comment that restates the line below it will be asked
  about in review. The ones worth writing record the constraint that made the code look odd.
- **`packages/shared/src/index.ts` is the contract, `CONTRACTS.md` is its prose form.** Both
  halves of Shape import the former; the latter is what a human reads first. Change them in the
  same commit. When they disagree the TypeScript wins, which is exactly the situation to avoid.
- **A new observable contract gets a check in the relevant smoke.** Plumbing does not. If a
  change alters what a frame carries, what an op does, or what the store keeps, the smoke that
  owns that surface should fail before your change and pass after it.
- **Strictness stays on.** Every tsconfig sets `strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`; bridge and link add
  `exactOptionalPropertyTypes`, and web adds `noUnusedLocals` / `noUnusedParameters`. Do not
  relax a compiler option to make a diff smaller.

## Pull requests

- Read your own diff before asking anyone else to. Most review comments are things the author
  would have caught.
- One PR per issue, and close it from the body: `Closes #N`.
- The body says three things: **what changed**, **how it was verified** — with the smoke output
  pasted, not summarised — and **what you assumed**. An assumption written down is cheap to
  correct; one left implicit is not.
- Unrelated cleanups go in their own PR. A rename mixed into a behaviour change hides the
  behaviour change.

## Issues

Use the forms under `.github/ISSUE_TEMPLATE/`. Their **Summary**, **Acceptance** and **Notes**
fields are not decoration: they are the issue format the
[manager skill](https://github.com/orrgal1/manager-skill) reads and writes, so an issue filed by
a human and an issue filed by the manager look the same and can be picked up the same way.
Acceptance is a checkbox list of observable outcomes — "the canvas shows X", not "refactor Y".
If the work depends on another issue, end the body with `Blocked by: #12, #15`.
