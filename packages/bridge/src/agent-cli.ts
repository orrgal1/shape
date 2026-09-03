/**
 * Shape's agent as its own process: the half that needs the harness, the
 * target repo's filesystem, git, `ps` and a tty. It connects OUT to a Shape
 * server (`--server`) and serves the loopback link (`/link`) for
 * harness-side processes — hooks and the MCP sidecar — on 127.0.0.1 only, so
 * those never hold server credentials.
 *
 * Run: node src/agent-cli.ts --server ws://host:port
 *        [--cwd <dir>] [--backend <id>] [--omp "<cmd ...>"] [--link-port <n>]
 */

import { resolve } from "node:path";
import { AGENT_WS_PATH, LINK_WS_PATH } from "../../shared/src/index.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { connectAgentEnd } from "./transport.ts";
import { SocketServer } from "./wsserver.ts";

/** the loopback link's default port: one past the canvas server's 4400 */
const LINK_PORT = 4401;

interface Cli {
  /** the Shape server's agent endpoint, already normalized */
  server: string;
  cwd: string;
  /** loopback port for `/link` */
  linkPort: number;
  /** `--backend <id>`: beats both config files */
  backend?: string;
  /** `--omp "<cmd ...>"`: replaces the omp adapter's command */
  ompCommand?: string[];
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
    } else if (arg === "--backend" && next !== undefined) {
      cli.backend = next.trim();
      i++;
    } else if (arg === "--omp" && next !== undefined) {
      cli.ompCommand = next
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (server === null) throw new Error("--server <url> is required");
  cli.server = agentUrl(server);
  return cli;
}

// A bad flag, an unknown --backend id or a broken config file is a startup
// error, not a stack trace: the operator needs to read what went wrong. A
// server that is merely not up yet is NOT one of those — the link retries.
try {
  const cli = parseArgv(process.argv.slice(2));
  const sockets = new SocketServer({ port: cli.linkPort });
  // the end owns the reconnect loop and says `waiting for Shape server` itself
  // when the first connect fails; the runtime is the only listener it needs
  const link = connectAgentEnd(cli.server);

  const agent = new AgentRuntime({
    cwd: cli.cwd,
    ...(cli.backend === undefined ? {} : { backend: cli.backend }),
    ...(cli.ompCommand === undefined ? {} : { ompCommand: cli.ompCommand }),
    sockets,
    link,
    // the harness is this process's reason to exist: the room has already been
    // told why (`agent_exit`), so all that is left is to go
    onExit: () => setTimeout(() => process.exit(1), 50),
  });

  // Registered before start(): Ctrl-C must work while we are still waiting for
  // a server that may never come. stop() sends `detached` so the room goes
  // agentless immediately, and it settles start()'s wait either way.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void agent.stop().then(
        () => process.exit(0),
        () => process.exit(0),
      );
    });
  }

  // The loopback link listens BEFORE the harness starts, and that order
  // matters: a hook-driven adapter's first event (Claude Code fires
  // SessionStart within a second of the TUI coming up) arrives over it, and a
  // hook that finds nobody listening exits silently.
  await sockets.listen();
  await agent.start();
  // a stop while we waited settles the same gate: we were never attached, and
  // the process is already on its way out
  if (!stopping) {
    console.error(
      `[bridge] agent attached to ${cli.server} (target ${cli.cwd}, link at ${sockets.url(LINK_WS_PATH)})`,
    );
  }
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
