# @shape/link

Everything that runs *next to* a harness and talks to Shape over the loopback
link (`ws://127.0.0.1:4400/link`, served by the agent half of the bridge).

| file | channel | who loads it |
| --- | --- | --- |
| `src/omp-extension.ts` | the whole harness layer: `canvas` tool, every event, steer/prompt delivery, abort, autonomous | omp, via `--extension` |
| `src/mcp.ts` | the `canvas` tool alone, over stdio MCP | any harness that speaks MCP |
| `src/hook.ts` | events alone, one process per hook payload | Claude Code hooks |

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

## Self-test

```sh
pnpm --filter @shape/link run selftest:omp
```

Drives the real extension with a stub `pi` and a real WebSocket server: the
frames each omp event produces, and what each bridge frame does to the session.
It runs under `bun` when one is on PATH (the runtime omp actually uses) and
falls back to `node`, which strips the types itself.
