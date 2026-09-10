/**
 * Shape's agent as its own process: the half that needs the target repo's
 * filesystem, git, `ps` and the user's terminal. It connects OUT to a Shape
 * server (`--server`) and serves the loopback link (`/link`) for
 * harness-side processes — hooks, the MCP sidecar, the omp extension — on
 * 127.0.0.1 only, so those never hold server credentials.
 *
 * The repo named by `--cwd` is the root runtime. A remote agent discovers
 * nothing on its own, but a directory selected through that runtime may add a
 * separate observation-only runtime on the same process. Each runtime owns a
 * separate reconnecting agent link; the shared loopback router still directs
 * harness-side callers by repository.
 *
 * Run: node src/agent-cli.ts --server ws://host:port
 *        [--token <t>] [--cwd <dir>] [--link-port <n>]
 */

import { resolve } from "node:path";
import { AGENT_WS_PATH, LINK_WS_PATH } from "../../shared/src/index.ts";
import { AgentFleet } from "./agent/fleet.ts";
import { serverOrigin, tokenForServer } from "./servers.ts";
import { connectAgentEnd } from "./transport.ts";
import { SocketServer } from "./wsserver.ts";

/** the loopback link's default port: one past the canvas server's 4400 */
const LINK_PORT = 4401;

interface Cli {
  /** the Shape server's agent endpoint, already normalized */
  server: string;
  /** `--cwd <dir>`: any worktree of the repo to watch; the project is the repo */
  cwd: string;
  /** loopback port for `/link` */
  linkPort: number;
  /** `--token <t>`: beats `SHAPE_TOKEN` and the saved credentials */
  token?: string;
}

/**
 * `ws://host:port` and `ws://host:port/agent` name the same server: the mount
 * is the protocol's business, not the operator's.
 */
function agentUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--server expects a ws:// url, got ${raw}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`--server expects a ws:// or wss:// url, got ${raw}`);
  }
  url.pathname = AGENT_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseArgv(argv: string[]): Cli {
  let server: string | null = null;
  const cli: Cli = { server: "", cwd: process.cwd(), linkPort: LINK_PORT };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    if (arg === "--server" && next !== undefined) {
      server = next.trim();
      i++;
    } else if (arg === "--cwd" && next !== undefined) {
      cli.cwd = resolve(next);
      i++;
    } else if (arg === "--link-port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) throw new Error(`--link-port expects a number, got ${next}`);
      cli.linkPort = parsed;
      i++;
    } else if (arg === "--token" && next !== undefined) {
      cli.token = next.trim();
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (server === null) throw new Error("--server <url> is required");
  cli.server = agentUrl(server);
  return cli;
}

// A bad flag is a startup error, not a stack trace: the operator needs to read
// what went wrong. A server that is merely not up yet is NOT one of those —
// the link retries.
try {
  const cli = parseArgv(process.argv.slice(2));
  // `--token`, then `SHAPE_TOKEN`, then what `shape login` saved for this
  // server. None of the three is fine: an unauthenticated server ignores it.
  const envToken = process.env.SHAPE_TOKEN?.trim();
  const token =
    cli.token ??
    (envToken !== undefined && envToken.length > 0 ? envToken : await tokenForServer(serverOrigin(cli.server)));
  const sockets = new SocketServer({ port: cli.linkPort });
  // Every runtime needs its own connection: one server-side link is bound to
  // exactly one room for its whole lifetime. Picker-created runtimes use this
  // same factory instead of retargeting the root runtime's link.
  let refused = false;
  const newLink = () =>
    connectAgentEnd(cli.server, {
      ...(token === null ? {} : { token }),
      onRefused: (reason) => {
        refused = true;
        console.error(`[bridge] startup failed: ${reason}`);
        setTimeout(() => process.exit(1), 50);
      },
    });

  const fleet = new AgentFleet({
    sockets,
    seeds: [cli.cwd],
    // the registry is the server's, on the far side of the link: this process
    // watches the repo it was pointed at and discovers nothing else
    registry: null,
    link: newLink,
  });

  // Registered before start(): Ctrl-C must work while we are still waiting for
  // a server that may never come. stop() sends `detached` so the room goes
  // agentless immediately, and it settles start()'s wait either way.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void fleet.stop().then(
        () => process.exit(0),
        () => process.exit(0),
      );
    });
  }

  // The loopback link listens BEFORE the agent attaches, and that order
  // matters: a session's first event (Claude Code fires SessionStart within a
  // second of the TUI coming up) arrives over it, and a hook that finds nobody
  // listening exits silently.
  await sockets.listen();
  await fleet.start();
  // a stop or a refused token settles the same gate: we were never attached,
  // and the process is already on its way out
  if (!stopping && !refused) {
    console.error(
      `[bridge] agent attached to ${cli.server} (target ${cli.cwd}, link at ${sockets.url(LINK_WS_PATH)})`,
    );
  }
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
