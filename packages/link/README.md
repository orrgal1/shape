# @shape/link

Everything that runs *next to* a harness and talks to Shape over the loopback
link (`ws://127.0.0.1:4400/link`, served by the agent half of the bridge).

| file | channel | who loads it |
| --- | --- | --- |
| `src/omp-extension.ts` | the whole harness layer: `canvas` tool, every event, steer/prompt delivery, abort, autonomous | omp, via `--extension` |
| `src/cli.ts` | one `canvas` call, or one reachability answer, per process | anything with a shell |
| `src/mcp.ts` | the `canvas` tool alone, over stdio MCP | any harness that speaks MCP |
| `src/hook.ts` | events alone, one process per hook payload | Claude Code hooks |
| `src/frames.ts` | no channel of its own: the frames and the pending-call correlator the extension and the CLI share | both of them |

## The omp extension

omp has no external IPC for a live interactive session, so Shape rides inside
the process. The backend launches it as:

```sh
SHAPE_LINK=ws://127.0.0.1:4400/link \
SHAPE_WORKTREE=<worktree id> \
  omp --extension /abs/path/to/packages/link/src/omp-extension.ts
```

- `--extension` takes a bare `.ts` file — no build step, no `.omp/` directory;
  omp imports it with Bun.
- `SHAPE_LINK` is the only variable the extension reads. Without it the
  extension loads, registers the `canvas` tool, says so once through
  `pi.logger`, and stays offline.
- `SHAPE_WORKTREE` is the launcher's own bookkeeping: every frame is keyed by
  `cwd` (from `ctx.cwd`), which is what the bridge resolves a worktree from.
- Add `--approval-mode yolo` for an autonomous session. The `autonomous` frame
  flips the extension's own `tool_call` gate mid-session, but that gate cannot
  open the TUI's approval prompt — only the launch flag can.

The frames it speaks are `LinkClientMsg` / `LinkServerMsg` in
`packages/shared/src/link.ts` (see CONTRACTS.md §Loopback link v2).

## The CLI

The channel for a session with no `canvas` tool at all — a plain agent in a
terminal, a script, a builder someone started by hand. It is what
`shape-directive.md` tells such a session to run:

```sh
SHAPE_LINK=ws://127.0.0.1:4400/link \
  node /abs/path/to/packages/link/src/cli.ts canvas '{"ops":[…],"note":"…"}'
node /abs/path/to/packages/link/src/cli.ts status --link ws://127.0.0.1:4400/link
```

- Run it **from inside the worktree** whose canvas you mean: it identifies
  itself with `process.cwd()` and nothing else, exactly as the extension does
  with `ctx.cwd`, and a cwd outside the project comes back refused rather than
  drawn somewhere wrong.
- The url comes from `SHAPE_LINK` or `--link`, and has no default. Neither set
  is exit 2, as is a bad JSON argument or an unknown subcommand.
- `canvas` takes either the tool argument object or a bare ops array (wrapped
  into `{ops}` for you), sends exactly one call, and prints the bridge's own
  receipt as one JSON line `{"text":…,"isError":…}` — exit 0 when the call
  applied, 1 when it did not, including when the bridge is not there.
- `status` prints one JSON line: whether the bridge answered, the url, the cwd,
  the worktree that cwd resolves to, and what the bridge says about it. Exit 0
  when reachable, 1 when not.
- It never sends `hello`. A `hello` claims to BE that worktree's harness, and
  the bridge replays such a socket's close as the `bye` the harness never sent
  — a one-shot CLI would end the real session's adapter state on exit.
- Global `WebSocket` (Node ≥ 22), no package imports at all: the directive
  hands this path to agents working in other repos.

## Smokes

```sh
pnpm --filter @shape/link selftest:omp      # the extension against a stub `pi`
pnpm --filter @shape/link smoke:link-cli    # the CLI against the extension, through real bridges
```

`selftest:omp` drives the real extension with a stub `pi` and a real WebSocket
server: the frames each omp event produces, and what each bridge frame does to
the session. It runs under `bun` when one is on PATH (the runtime omp actually
uses) and falls back to `node`, which strips the types itself.

`smoke:link-cli` is the claim that the CLI is a real channel and not an
approximation: it sends one fixture batch through the extension and the same
batch through the CLI, and diffs the receipt, the resulting graph and every
filed revision snapshot. Each path gets its own bridge, port, `SHAPE_HOME` and
identically-seeded target repo — applying the same ops twice to one graph would
give the second call a different receipt, so one bridge could not answer the
question honestly.
