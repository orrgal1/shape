# Security policy

Shape drives real coding agents in real terminals against real repositories, so a bug in it can
be a bug in your machine. Reports are welcome and taken seriously. See the
[README](README.md) for what the components below are.

## Reporting a vulnerability

Report privately, through GitHub security advisories:

**<https://github.com/orrgal1/shape/security/advisories/new>**

Do not open a public issue for a vulnerability, and do not send a pull request that fixes one
before it has been discussed — the diff is the disclosure.

Useful reports say which component is affected, how it is reached (a browser socket, an agent
link, a harness, a repository the agent was pointed at), and what an attacker gets. A short
reproduction beats a long description.

This is a one-person project, so the honest window is: acknowledgement within a week, and an
assessment with a plan or a reason why it is not a vulnerability shortly after. If a week passes
with no answer, ping the advisory thread — it means the mail was missed, not that the report was
dismissed.

## Supported versions

There are no releases yet. Only the current `main` is supported; a fix lands there.

## Scope

The parts of Shape that face something other than their own process:

- **The bridge WebSocket server.** Local mode (`packages/bridge/src/index.ts`) and the standalone
  server (`packages/bridge/src/server-cli.ts`) both bind `127.0.0.1:4400` by default
  (`packages/bridge/src/wsserver.ts` defaults the host to `127.0.0.1`; the port is `BRIDGE_PORT`
  in `packages/shared/src/index.ts`). Browsers connect on `/ws`.
- **Auth and bind guards on the standalone server.** A non-loopback `--host` without
  `--token-file` is a startup failure by design — an unauthenticated server on a routable
  address would hand every graph and every steering channel to the network
  (`packages/bridge/src/server-cli.ts`, `isLoopbackHost` in `packages/bridge/src/server/auth.ts`).
  The token file is `[{ token, tenant }, …]`; tokens shorter than 16 characters are rejected at
  startup, a malformed file never half-loads, and token values are kept out of logs
  (`packages/bridge/src/server/auth.ts`). Every connection's tenant is decided at the upgrade and
  cannot be claimed by a frame; it selects the room key, the project list and what
  `select_project` can reach (`packages/bridge/src/server/server.ts`,
  `packages/bridge/src/wsserver.ts`). A refused upgrade is a 401 before any socket exists.
  Anything that leaks a graph, a transcript or a steer across tenants, or that gets a socket
  without a valid token, is in scope.
- **The agent link protocol on `/agent`.** How a remote agent joins a server and claims a
  project (`AGENT_WS_PATH` in `packages/shared/src/index.ts`,
  `packages/bridge/src/agent-cli.ts`, `packages/bridge/src/server/server.ts`). Every frame is
  validated at the boundary before it reaches any state — `parseAgentToServerMsg` /
  `parseServerToAgentMsg` in `packages/bridge/src/linkframes.ts`, and `parseClientMsg` in
  `packages/bridge/src/server/ws.ts` for browser frames. A frame that gets past a validator is
  in scope.
- **Terminal exposure.** A remote agent's terminal pane is a shell on the machine the agent runs
  on, so it is off unless the operator passes `--allow-terminal`; without it the capability is
  reported as `terminal: "none"` and pty frames are dropped
  (`packages/bridge/src/agent-cli.ts`, `packages/bridge/src/agent/runtime.ts`). Reaching a shell
  on an agent started without that flag is in scope.
- **The loopback link on `/link`.** What the harness-side pieces speak to the agent, validated by
  `parseLinkMsg` (`packages/bridge/src/agent/linkparse.ts`). It is loopback only.
- **The link MCP server** (`packages/link/src/mcp.ts`) — a stdio process the harness launches,
  exposing exactly one tool, `canvas`, and forwarding calls to the bridge — and **the omp
  extension** (`packages/link/src/omp-extension.ts`), which runs inside the harness process and
  holds the link socket for the session's life.
- **The `canvas` host tool.** Every op is validated and applied by `applyOps`
  (`packages/shared/src/index.ts`); a rejection comes back as a structured receipt rather than a
  partial write. Inside the target repository the canvas writes only `.shape/`, and adds that one
  line to the repository's `.git/info/exclude` so it stays out of every branch
  (`ensureGitExclude` in `packages/bridge/src/agent/worktrees.ts`). A canvas op that writes
  anywhere else in the target, or escapes `.shape/`, is in scope. (The separate "new project"
  flow, `packages/bridge/src/agent/newproject.ts`, does scaffold and commit a repository — but
  only one the user asked it to create.)
- **Stored state.** Graphs, revisions, the project registry and audit lines live in one SQLite
  database — `~/.shape/shape.db` locally, `<data-dir>/shape.db` for a server
  (`packages/bridge/src/server/sqlite.ts`). `shape login` writes the agent's server tokens to
  `~/.shape/servers.json` at mode `0600` (`packages/bridge/src/login-cli.ts`, written and read
  by `packages/bridge/src/servers.ts`). A path that widens those permissions, or reads another
  tenant's rows, is in scope.

## Out of scope

- Vulnerabilities in the harnesses themselves — [omp](https://github.com/can1357/oh-my-pi) or
  Claude Code — or in herdr. Report those to their projects. Shape launching a harness that then
  does something unsafe on its own is their bug, not Shape's; Shape handing a harness something
  it should not have is Shape's.
- Vulnerabilities in a user's own project. Shape points an agent at your repository and the agent
  writes code there; what that code does is not Shape's security boundary.
- "The agent can run commands." That is what a coding agent is. Shape's boundary is who can
  reach the agent, not what the agent is capable of once you have asked it to work.
- A loopback-bound bridge being reachable by other processes on the same machine. Local mode
  trusts the local user, which is the same trust model as the harness it drives.
- Missing hardening with no reachable impact — a header, a rate limit, a dependency advisory that
  does not apply to a code path Shape executes. Say what breaks and it becomes interesting.
