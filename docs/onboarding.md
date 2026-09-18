# Shape onboarding

Shape has three harness skills:

1. **shape serve** — find or start the server and return the canvas URL.
2. **shape map [branch]** — create or update the committed map for a branch (`main` by default).
3. **shape live** — report the current session against its mapped branch.

## First run

Install Shape from a stable checkout, then start a new harness session in the repository you want to
map:

```text
shape serve
shape map
```

Open the URL returned by `shape serve`. For ongoing work on the currently checked-out branch:

```text
shape map feature/payments
shape live
```

Map a branch before using live reporting on it. Run `shape map <branch>` again after committing
meaningful changes.

These phrases are harness prompts. The installed skills call the checkout-local
`scripts/shape.mjs`; Shape does not install a global command.

## What Shape protects

- Mapping reads the committed tip of the requested local branch from an isolated snapshot. It does
  not switch the checkout or include dirty, staged, or untracked files.
- The first map describes the whole branch. Later maps use the commit delta when ancestry is
  trustworthy and automatically fall back to a full map after rebases or missing history.
- Binary changes remain named in `changedPaths` and appear as binary-difference markers; Shape omits
  encoded binary patch bodies so large assets cannot exhaust the mapping process's output buffer.
- A map becomes durable only after its final atomic commit. A stale or invalid update changes
  nothing.
- Live semantic changes are visibly uncommitted. They do not rewrite the committed map or advance
  its mapped-commit checkpoint.
- Repository paths shown by a remote client are labels, not permission for the server to read that
  filesystem.

## Serve and authentication

`shape serve` checks known and local endpoints before offering to start another server. A new local
server defaults to `http://127.0.0.1:4400` and runs under the harness's process supervisor.

For a remote server:

- use HTTPS/WSS behind a trusted TLS proxy, or an SSH tunnel to a loopback-bound server;
- do not put tokens in URLs, chat, or command output;
- enter a browser token in the canvas prompt when asked—saved CLI credentials do not automatically
  authenticate a new browser.

Shape itself does not terminate TLS.

## Recovery

- **Mapping stopped before finish:** ask for `shape map` again. Abandoned owned snapshots can be
  removed with `shape map abort <preparation-id>`.
- **Connection failed during finish:** do not blindly resend. Run `shape map` again so Shape can
  read the current checkpoint and reconcile whether the prior request committed.
- **Live session was interrupted:** reuse the saved session handle when stopping it; repeated stop
  is safe for a confirmed stopped handle.
- **Project was marked inactive:** restore it through **Show inactive → make active** before mapping
  or live updates.
- **Shape checkout moved:** reinstall the skills from the new location.

## State

The selected server stores committed maps, revisions, live overlays, and the project registry. The
default local database is `~/.shape/server/shape.db`. Client connections, map preparations, and live
recovery handles also live under `~/.shape`.

`SHAPE_HOME` must be absolute and changes the parent of `.shape`; for example,
`SHAPE_HOME=/srv/shape-state` stores state under `/srv/shape-state/.shape`.

Nothing in the normal map/live workflow is written into the target repository's working tree.

For exact CLI syntax use `pnpm shape --help` from the Shape checkout. Runtime and wire details live
in [`CONTRACTS.md`](../CONTRACTS.md).
