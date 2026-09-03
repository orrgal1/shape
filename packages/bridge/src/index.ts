/**
 * Shape in local mode: the canvas server and the agent that drives the coding
 * harness, in one process, joined by the in-memory link. Same frames, same
 * `.shape/` files as remote mode — only the transport is shorter.
 *
 * Run: node src/index.ts [--cwd <dir>] [--port <n>] [--backend <id>] [--omp "<cmd ...>"]
 */

import { resolve } from "node:path";
import { BRIDGE_PORT, BRIDGE_WS_PATH } from "../../shared/src/index.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import { ShapeServer } from "./server/server.ts";
import { projectDirStorage } from "./server/storage.ts";
import { memoryLinkPair } from "./transport.ts";
import { SocketServer } from "./wsserver.ts";

interface Cli {
  cwd: string;
  port: number;
  /** `--backend <id>`: beats both config files */
  backend?: string;
  /** `--omp "<cmd ...>"`: replaces the omp adapter's command */
  ompCommand?: string[];
}

function parseArgv(argv: string[]): Cli {
  const cli: Cli = { cwd: process.cwd(), port: BRIDGE_PORT };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") continue; // pnpm 11 forwards the separator verbatim
    if (arg === "--cwd" && next !== undefined) {
      cli.cwd = resolve(next);
      i++;
    } else if (arg === "--port" && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed)) throw new Error(`--port expects a number, got ${next}`);
      cli.port = parsed;
      i++;
    } else if (arg === "--backend" && next !== undefined) {
      cli.backend = next.trim();
      i++;
    } else if (arg === "--omp" && next !== undefined) {
      cli.ompCommand = next.trim().split(/\s+/).filter((token) => token.length > 0);
      i++;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return cli;
}

// A bad --backend id or a broken config file is a startup error, not a stack
// trace: the operator needs to read what went wrong.
try {
  const cli = parseArgv(process.argv.slice(2));
  const sockets = new SocketServer({ port: cli.port });
  // local mode keeps every project's canvas in the project: <cwd>/.shape/
  const server = new ShapeServer({ sockets, storage: projectDirStorage() });
  const link = memoryLinkPair();
  server.attachAgent(link.server);
  const agent = new AgentRuntime({
    cwd: cli.cwd,
    ...(cli.backend === undefined ? {} : { backend: cli.backend }),
    ...(cli.ompCommand === undefined ? {} : { ompCommand: cli.ompCommand }),
    // local mode is the operator's own machine: the terminal pane stays on
    allowTerminal: true,
    sockets,
    link: link.agent,
    // the harness is this process's reason to exist: the browsers have already
    // been told why (`agent_exit`), so all that is left is to go
    onExit: () => setTimeout(() => process.exit(1), 50),
  });

  // The socket listens BEFORE the harness is started, and that order matters:
  // a hook-driven adapter's first event (Claude Code fires SessionStart within
  // a second of the TUI coming up) arrives over the link, and a hook that finds
  // nobody listening exits silently — the agent would never learn the session
  // id. The banner is still printed last, so "canvas at ..." means fully up.
  await sockets.listen();
  await agent.start();
  console.error(`[bridge] canvas at ${sockets.url(BRIDGE_WS_PATH)} (target ${cli.cwd})`);
} catch (err) {
  console.error(`[bridge] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
